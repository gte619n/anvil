/**
 * Reference bodies (agent-cad-and-browser spec §4.4 `import_reference`, §4.14 #4 and owner item 45).
 *
 * A reference is a STEP the part must fit. `import_reference {part, file}` copies it from the session
 * worktree (the browser's download quarantine `<worktree>/.anvil-downloads/` included) into the
 * committed `cad/<part>/refs/`, then imports it as a FIXED body with `file.insert_step` — which EMBEDS
 * the whole STEP text in the design script. So `refs/x.step` is the import source and the readable
 * copy, and the design carries the bodies by itself.
 *
 * What the gate checks (see `referenceChecks`, `interferenceCheck`):
 *   - integrity: `refs/x.step`'s sha256 must equal the sha256 of the STEP text embedded for `x.step`.
 *     Different → `unverified`, "reference changed; re-import". A reference that part.json or the
 *     expectations name but that is missing from `refs/` or from the design → a hard fail.
 *   - interference: for every reference in `expectations.noInterferenceWith`, `inspect.interference`
 *     between the design bodies and that reference's bodies must report EXACTLY "no interference":
 *     `count == 0 && unchecked == [] && !budget_exceeded && !truncated` (A0 evidence). Anything else —
 *     an overlap, or a check that did not finish — is a hard fail naming the pair and the volume.
 *
 * SOURCE RULES (`resolveReferenceSource`): a path relative to the worktree root; it must stay inside
 * the worktree after resolving (no `..` out, no absolute path), be a regular file that is not a
 * symbolic link and does not sit behind one (its real path is its path), have a `.step` / `.stp`
 * extension, and be at most 50 MB. The bytes are read through a descriptor opened with O_NOFOLLOW
 * and checked again on that descriptor, so a file swapped for a link after the check is not read.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { GateCheck } from "./gate";
import type { McpToolResult } from "./mcp-client";
import type { PartRef } from "./partfolder";
import { CACHE_DIR, type DesignScript } from "./poststep";

export const REFS_DIR = "refs";
/** The browser track's download quarantine — an allowed source folder inside the worktree. */
export const QUARANTINE_DIR = ".anvil-downloads";
/** Owner item 45: a reference is capped at 50 MB. */
export const REFERENCE_MAX_BYTES = 50 * 1024 * 1024;
/** Owner item 45: the part card shows the script size once it exceeds this. */
export const SCRIPT_SIZE_NOTICE_BYTES = 5 * 1024 * 1024;
export const REFERENCE_CHANGED = "reference changed; re-import";

const sha256 = (b: string | Uint8Array): string => createHash("sha256").update(b).digest("hex");
const mb = (n: number): string => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;

export type SourceResult = { ok: true; abs: string; rel: string; bytes: Buffer; sha256: string } | { ok: false; error: string };

/**
 * Check and read a reference source named by the agent. Never follows a link, never leaves the
 * worktree. `worktree` must be a real path (a `PartRef.worktree` is).
 */
export function resolveReferenceSource(worktree: string, file: unknown, opts: { maxBytes?: number } = {}): SourceResult {
  const max = opts.maxBytes ?? REFERENCE_MAX_BYTES;
  const say = (why: string): SourceResult => ({ ok: false, error: `import_reference: ${why}` });
  if (typeof file !== "string" || !file.trim() || file.includes("\0")) return say("`file` must name a STEP file inside this repo, relative to its root (e.g. \".anvil-downloads/bracket.step\")");
  if (isAbsolute(file)) return say("`file` must be relative to the repo root, not an absolute path");
  const abs = resolve(worktree, file);
  const rel = relative(worktree, abs);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return say(`${JSON.stringify(file)} is outside this repo`);
  if (rel.split("/").includes(".git")) return say(`${JSON.stringify(file)} is inside .git`);
  if (!/\.(step|stp)$/i.test(rel)) return say(`${JSON.stringify(file)} is not a STEP file (.step or .stp)`);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return say(`${JSON.stringify(file)} does not exist`);
  }
  if (st.isSymbolicLink()) return say(`${JSON.stringify(file)} is a symbolic link; copy the real file into the repo instead`);
  if (!st.isFile()) return say(`${JSON.stringify(file)} is not a regular file`);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return say(`${JSON.stringify(file)} could not be resolved`);
  }
  if (real !== abs) return say(`${JSON.stringify(file)} sits behind a symbolic link (it really is ${real}); copy the real file into the repo instead`);
  if (st.size > max) return say(`${JSON.stringify(file)} is ${mb(st.size)}; a reference is capped at ${mb(max)}`);
  const read = readRegularFile(abs, st.ino, max);
  if (!read.ok) return say(`${JSON.stringify(file)} ${read.error}`);
  return { ok: true, abs, rel, bytes: read.bytes, sha256: sha256(read.bytes) };
}

/**
 * Read a file the caller already lstat-checked as a regular file (`ino`): through a descriptor that
 * refuses a link (O_NOFOLLOW) and never blocks on open (O_NONBLOCK — a FIFO swapped in after the check
 * would otherwise hang the daemon until something wrote to it), checked again on that descriptor.
 * O_NONBLOCK has no effect on reads of a regular file, which is all this ever reads, so it does not
 * need clearing (Node has no fcntl to clear it with).
 */
export function readRegularFile(abs: string, ino: number, max: number): { ok: true; bytes: Buffer } | { ok: false; error: string } {
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { ok: false, error: "could not be opened (a link, or unreadable)" };
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.ino !== ino) return { ok: false, error: "changed while it was being read" };
    if (fst.size > max) return { ok: false, error: `is ${mb(fst.size)}; the cap is ${mb(max)}` };
    const bytes = Buffer.alloc(fst.size);
    let at = 0;
    while (at < bytes.length) {
      const n = readSync(fd, bytes, at, bytes.length - at, at);
      if (n <= 0) break;
      at += n;
    }
    if (at !== bytes.length) return { ok: false, error: "changed while it was being read" };
    return { ok: true, bytes };
  } catch (e) {
    return { ok: false, error: `could not be read (${e instanceof Error ? e.message : String(e)})` };
  } finally {
    closeSync(fd);
  }
}

/** How many solid bodies a STEP file declares (its B-rep solid entities), or 0 when it names none —
 *  what a replacement card can say before the import runs. */
export function stepSolidCount(bytes: Buffer): number {
  return (bytes.toString("latin1").match(/=\s*(?:MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS|FACETED_BREP)\s*\(/gi) ?? []).length;
}

/** The name a reference gets in `refs/`: the source's file name, reduced to `[A-Za-z0-9._-]`, with a
 *  lower-case `.step` / `.stp` extension. Never empty, never hidden, never a path. */
export function referenceName(source: string): string {
  const base = basename(source);
  const ext = extname(base).toLowerCase() === ".stp" ? ".stp" : ".step";
  let stem = basename(base, extname(base))
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "")
    .slice(0, 64);
  if (!stem) stem = "reference";
  return `${stem}${ext}`;
}

/** The feature name an import is given (and how a later re-import finds the old one). */
export const importFeatureName = (name: string): string => `ref-${name}`;

/** Write the checked bytes to `cad/<part>/refs/<name>` (temp file + rename). Refuses a linked `refs/`. */
export function storeReference(ref: PartRef, name: string, bytes: Buffer): string {
  const dir = join(ref.dir, REFS_DIR);
  if (existsSync(dir)) {
    if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== dir) throw new Error(`cad/${ref.part}/${REFS_DIR} is a symbolic link; it must be a real folder in the part`);
  } else mkdirSync(dir, { recursive: true });
  const dest = join(dir, name);
  if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) throw new Error(`cad/${ref.part}/${REFS_DIR}/${name} is a symbolic link`);
  mkdirSync(join(ref.dir, CACHE_DIR), { recursive: true });
  const tmp = join(ref.dir, CACHE_DIR, `ref.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return dest;
}

/** One reference as the design script carries it (an import feature with its embedded STEP text). */
export interface EmbeddedReference {
  /** The file name the import was made from (`feature.file`). */
  file: string;
  /** The import feature's name. */
  name?: string;
  /** sha256 of the embedded STEP text. */
  sha256: string;
  /** The bodies the import made (`feature.body_names`). */
  bodies: string[];
  /** Bytes of the embedded text. */
  bytes: number;
}

/**
 * Every STEP import embedded in a design script: `timeline.add` steps whose `feature.type` is
 * `"import"` with the text in `feature.step` (the real SolidCraft 0.44.1 shape, A0 evidence).
 */
export function embeddedReferences(script: DesignScript | undefined): EmbeddedReference[] {
  const out: EmbeddedReference[] = [];
  for (const c of Array.isArray(script?.commands) ? script!.commands : []) {
    const cmd = c as { command?: unknown; params?: { feature?: Record<string, unknown> } };
    const f = cmd?.params?.feature;
    if (cmd?.command !== "timeline.add" || !f || f.type !== "import" || typeof f.step !== "string" || typeof f.file !== "string") continue;
    out.push({
      file: f.file,
      ...(typeof f.name === "string" ? { name: f.name } : {}),
      sha256: sha256(f.step),
      bodies: Array.isArray(f.body_names) ? f.body_names.map(String) : [],
      bytes: Buffer.byteLength(f.step),
    });
  }
  return out;
}

/** sha256 of `cad/<part>/refs/<name>`, or why it cannot be read (a link is not a reference). */
export function referenceOnDisk(ref: PartRef, name: string): { sha256: string } | { missing: string } {
  const p = join(ref.dir, REFS_DIR, name);
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink() || !st.isFile()) return { missing: `cad/${ref.part}/${REFS_DIR}/${name} is not a regular file` };
    return { sha256: sha256(readFileSync(p)) };
  } catch {
    return { missing: `cad/${ref.part}/${REFS_DIR}/${name} is missing` };
  }
}

/**
 * Integrity of each named reference: on disk in `refs/`, embedded in the design, and the same bytes.
 * `embedded` undefined means the design's script could not be read for the script the process runs.
 */
export function referenceChecks(names: string[], onDisk: (name: string) => { sha256: string } | { missing: string }, embedded: EmbeddedReference[] | undefined): { checks: GateCheck[]; unverified: boolean } {
  const checks: GateCheck[] = [];
  let unverified = false;
  for (const name of [...new Set(names)].sort()) {
    const id = `ref ${name}`;
    const expected = `refs/${name} is the STEP embedded in the design`;
    if (!embedded) {
      unverified = true;
      checks.push({ id, expected, measured: "the design's script could not be read for the version SolidCraft is running", ok: false, hard: true });
      continue;
    }
    const disk = onDisk(name);
    const emb = embedded.find((e) => e.file === name);
    if ("missing" in disk) {
      checks.push({ id, expected, measured: `${disk.missing} — restore it from git, or import the reference again`, ok: false, hard: true });
    } else if (!emb) {
      checks.push({ id, expected, measured: `the design does not contain refs/${name} — import it with import_reference`, ok: false, hard: true });
    } else if (emb.sha256 !== disk.sha256) {
      unverified = true;
      checks.push({ id, expected, measured: `${REFERENCE_CHANGED} (refs/${name} is ${disk.sha256.slice(0, 12)}, the design holds ${emb.sha256.slice(0, 12)})`, ok: false, hard: true });
    } else {
      checks.push({ id, expected, measured: `unchanged (${disk.sha256.slice(0, 12)})`, ok: true, hard: true });
    }
  }
  return { checks, unverified };
}

/** The `inspect.interference` request for the design bodies against ONE reference's bodies: every
 *  design–design and reference–reference pair is excluded, so `count` is exactly the overlaps that
 *  matter. */
export function interferenceRequest(designBodies: string[], refBodies: string[]): Record<string, unknown> {
  const pairs: [string, string][] = [];
  for (const list of [designBodies, refBodies]) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) pairs.push([list[i]!, list[j]!]);
  return { command: "inspect.interference", params: { bodies: [...designBodies, ...refBodies], ...(pairs.length ? { exclude_pairs: pairs } : {}) } };
}

const fmt = (v: number): string => String(Math.round(v * 1000) / 1000);

/**
 * The interference check for one reference from SolidCraft's reply. Passes ONLY on the exact "no
 * interference" condition of the A0 evidence; an error, an overlap, unchecked pairs, a truncated list
 * or an exhausted budget is a hard fail that says which.
 */
export function interferenceCheck(name: string, reply: McpToolResult | { error: string }): GateCheck {
  const id = `interference ${name}`;
  const expected = `no overlap with refs/${name}`;
  if ("error" in reply) return { id, expected, measured: `the interference check could not run: ${reply.error}`, ok: false, hard: true };
  const j = reply.json;
  if (reply.isError || !j || typeof j !== "object") return { id, expected, measured: `the interference check could not run: ${reply.text.slice(0, 300) || "no reply"}`, ok: false, hard: true };
  const list: any[] = Array.isArray(j.interferences) ? j.interferences : [];
  const unchecked: unknown[] = Array.isArray(j.unchecked) ? j.unchecked : ["(no unchecked list in the reply)"];
  const problems: string[] = [];
  for (const x of list) problems.push(`${String(x?.a)} overlaps ${String(x?.b)} by ${typeof x?.volume_mm3 === "number" ? fmt(x.volume_mm3) : "?"} mm³`);
  if (j.count !== 0 && list.length === 0) problems.push(`count ${JSON.stringify(j.count)}`);
  if (unchecked.length) problems.push(`${unchecked.length} pair(s) not checked: ${JSON.stringify(unchecked).slice(0, 200)}`);
  if (j.truncated !== false) problems.push("the list of overlaps was truncated");
  if (j.budget_exceeded !== false) problems.push("the check ran out of time (budget exceeded)");
  const ok = j.count === 0 && Array.isArray(j.unchecked) && j.unchecked.length === 0 && j.budget_exceeded === false && j.truncated === false;
  return { id, expected, measured: ok ? "no overlap" : problems.join("; "), ok, hard: true };
}

/** The total overlap volume an interference check reported (for tests and the card). */
export function overlapVolume(reply: McpToolResult): number {
  const list: any[] = Array.isArray(reply.json?.interferences) ? reply.json.interferences : [];
  return list.reduce((s, x) => s + (typeof x?.volume_mm3 === "number" ? x.volume_mm3 : 0), 0);
}
