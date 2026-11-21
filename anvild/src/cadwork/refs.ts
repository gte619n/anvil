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
 *     The same check runs again against the TRUE import — the embedded text imported alone in a
 *     throwaway process next to the design bodies' STEP exports, once before and once after them
 *     ("interference x.step as imported", ./refreplay.ts), so a reshaped live body cannot hide an
 *     overlap.
 *   - geometry: each reference measures, where it is, what its import measured
 *     (`referenceDifferences`, the fast pre-check) and IS its import's solid (`shapeDifferences`:
 *     vol(true) = vol(live) = vol(true ∩ live) within a 0.1 nm layer over its surface —
 *     `shapeTolerance`, with the measured residuals beside it); the gate's `referenceGeometryChecks`
 *     in ./refresh.ts.
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

/** The embedded STEP text of every import of `file` in a design script (in script order). */
export function embeddedStepTexts(script: DesignScript | undefined, file: string): string[] {
  const out: string[] = [];
  for (const c of Array.isArray(script?.commands) ? script!.commands : []) {
    const f = (c as { command?: unknown; params?: { feature?: Record<string, unknown> } })?.params?.feature;
    if ((c as { command?: unknown })?.command === "timeline.add" && f?.type === "import" && f.file === file && typeof f.step === "string") out.push(f.step);
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

/** Why two or more STEP imports in one design carrying the same file name fail the gate. */
export const DUPLICATE_REFERENCE = "duplicate reference import";

/**
 * Integrity of each named reference, and of EVERY STEP import embedded in the design: on disk in
 * `refs/`, embedded exactly once, and the same bytes. Two imports with one file name fail closed
 * ("duplicate reference import x.step") — each must be checked against its own `refs/` file, and one
 * file can only ever be one of them. `embedded` undefined means the design's script could not be
 * read for the script the process runs. `clean` is the file names whose single import matches its
 * `refs/` file: the only imports whose bodies count as known references.
 */
export function referenceChecks(names: string[], onDisk: (name: string) => { sha256: string } | { missing: string }, embedded: EmbeddedReference[] | undefined): { checks: GateCheck[]; unverified: boolean; clean: Set<string> } {
  const checks: GateCheck[] = [];
  const clean = new Set<string>();
  let unverified = false;
  const all = [...new Set([...names, ...(embedded ?? []).map((e) => e.file)])].sort();
  for (const name of all) {
    const id = `ref ${name}`;
    const expected = `refs/${name} is the STEP embedded in the design`;
    if (!embedded) {
      unverified = true;
      checks.push({ id, expected, measured: "the design's script could not be read for the version SolidCraft is running", ok: false, hard: true });
      continue;
    }
    const disk = onDisk(name);
    const embs = embedded.filter((e) => e.file === name);
    if ("missing" in disk) {
      checks.push({ id, expected, measured: `${disk.missing} — restore it from git, or import the reference again`, ok: false, hard: true });
    } else if (embs.length === 0) {
      checks.push({ id, expected, measured: `the design does not contain refs/${name} — import it with import_reference`, ok: false, hard: true });
    } else if (embs.length > 1) {
      const each = embs.map((e, i) => `import ${i + 1} (${e.name ?? "unnamed"}, bodies ${e.bodies.join(", ") || "none"}) ${e.sha256 === disk.sha256 ? "matches" : `holds ${e.sha256.slice(0, 12)}`}`);
      checks.push({ id, expected, measured: `${DUPLICATE_REFERENCE} ${name}: ${embs.length} imports carry this file name — ${each.join("; ")}; remove all but one`, ok: false, hard: true });
    } else if (embs[0]!.sha256 !== disk.sha256) {
      unverified = true;
      checks.push({ id, expected, measured: `${REFERENCE_CHANGED} (refs/${name} is ${disk.sha256.slice(0, 12)}, the design holds ${embs[0]!.sha256.slice(0, 12)})`, ok: false, hard: true });
    } else {
      clean.add(name);
      checks.push({ id, expected, measured: `unchanged (${disk.sha256.slice(0, 12)})`, ok: true, hard: true });
    }
  }
  return { checks, unverified, clean };
}

/** The `inspect.interference` request for the design bodies against ONE reference's bodies: every
 *  design–design and reference–reference pair is excluded, so `count` is exactly the overlaps that
 *  matter. Pass WORLD names (`far (ref-far.step:2)`, from `inspect.measure {names_only}`): a bare body
 *  name means that body's first placement only. */
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
export function interferenceCheck(name: string, reply: McpToolResult | { error: string }, opts: { asImported?: boolean } = {}): GateCheck {
  const id = opts.asImported ? `interference ${name} ${AS_IMPORTED}` : `interference ${name}`;
  const expected = opts.asImported ? `no overlap with refs/${name} ${AS_IMPORTED} (its STEP imported alone, next to the design bodies, in a throwaway process)` : `no overlap with refs/${name}`;
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

/** The must-not-touch check against the TRUE import (./refreplay.ts `makeTrueReferenceCheck`) is
 *  reported as `interference <file> as imported`. */
export const AS_IMPORTED = "as imported";

/** The total overlap volume an interference check reported (for tests and the card). */
export function overlapVolume(reply: McpToolResult): number {
  const list: any[] = Array.isArray(reply.json?.interferences) ? reply.json.interferences : [];
  return list.reduce((s, x) => s + (typeof x?.volume_mm3 === "number" ? x.volume_mm3 : 0), 0);
}

// ── where a reference sits (`component.list`, real SolidCraft 0.44.1) ──────────────────────────────
//
// `file.insert_step` makes one component per import (named after the import feature, `ref-far.step`)
// holding the import's bodies and the `BaseFeature`, placed once (`ref-far.step:1`) in the active
// component, grounded, at the identity. `import_reference` imports with the DESIGN active (it refuses
// otherwise), so a reference sits where its STEP file puts it: identity in the design, grounded. The
// STEP's bytes are checked against `refs/` (above), so where the reference is was approved with the
// file. `component.list` gives each placement's `transform` in its parent — a 4×4 matrix as 4 COLUMNS,
// the translation in the last (`[[1,0,0,0],[0,1,0,0],[0,0,1,0],[1000,0,0,1]]` after
// `occurrence.move {translate: [1000, 0, 0]}`) — its `grounded` flag, and `pending_moves` (occurrence
// ids moved with `capture: false`, whose listed transform is not where they are).

/** A placement's transform: 4 columns of 4 numbers (the translation is the last column). */
export type Matrix4 = number[][];
export const IDENTITY: Matrix4 = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

export interface LivePlacement {
  id: number;
  name: string;
  /** The component it sits in (0 is the design). */
  parent: number;
  grounded: boolean;
  transform: Matrix4;
}

export interface LiveComponent {
  id: number;
  name: string;
  bodies: string[];
  features: string[];
  /** Its placements. */
  occurrences: LivePlacement[];
}

export interface ComponentList {
  active: number;
  components: LiveComponent[];
  /** Occurrence ids with a move not yet captured. */
  pending: number[];
}

const isMatrix = (m: unknown): m is Matrix4 => Array.isArray(m) && m.length === 4 && m.every((c) => Array.isArray(c) && c.length === 4 && c.every((v) => typeof v === "number" && Number.isFinite(v)));

/** `component.list` (not compact) → the components and their placements. A reply that is not that
 *  shape throws: the gate fails closed when it cannot tell where a reference is. */
export function readComponentList(j: any): ComponentList {
  if (!Array.isArray(j?.components)) throw new Error("component.list answered no component list");
  const components = j.components.map((c: any): LiveComponent => {
    if (typeof c?.id !== "number" || typeof c?.name !== "string" || !Array.isArray(c?.bodies) || !Array.isArray(c?.features) || !Array.isArray(c?.occurrences)) {
      throw new Error(`component.list answered a component without id, name, bodies, features and placements: ${JSON.stringify(c).slice(0, 160)}`);
    }
    const occurrences = c.occurrences.map((o: any): LivePlacement => {
      if (typeof o?.id !== "number" || typeof o?.name !== "string" || typeof o?.parent !== "number" || typeof o?.grounded !== "boolean" || !isMatrix(o?.transform)) {
        throw new Error(`component.list answered a placement without id, name, parent, grounded and a 4×4 transform: ${JSON.stringify(o).slice(0, 160)}`);
      }
      return { id: o.id, name: o.name, parent: o.parent, grounded: o.grounded, transform: o.transform };
    });
    return { id: c.id, name: c.name, bodies: c.bodies.map(String), features: c.features.map(String), occurrences };
  });
  const pending = Array.isArray(j.pending_moves) ? j.pending_moves.filter((x: unknown) => typeof x === "number") : undefined;
  if (!pending || pending.length !== j.pending_moves.length) throw new Error("component.list answered no list of pending moves");
  return { active: typeof j.active === "number" ? j.active : -1, components, pending };
}

/** a·b for column-major 4×4 matrices. */
const mul = (a: Matrix4, b: Matrix4): Matrix4 => b.map((col) => [0, 1, 2, 3].map((r) => a[0]![r]! * col[0]! + a[1]![r]! * col[1]! + a[2]![r]! * col[2]! + a[3]![r]! * col[3]!));

/** Where a placement is in the world: its transform after its parent's, up to the design. Undefined
 *  when that cannot be told — a parent placed more than once (or not at all), a loop. */
export function worldTransform(list: ComponentList, p: LivePlacement, depth = 0): Matrix4 | undefined {
  if (p.parent === 0) return p.transform;
  if (depth > 64) return undefined;
  const parent = list.components.find((c) => c.id === p.parent);
  if (!parent || parent.occurrences.length !== 1) return undefined;
  const up = worldTransform(list, parent.occurrences[0]!, depth + 1);
  return up && mul(up, p.transform);
}

const isIdentity = (m: Matrix4, tol = 1e-9): boolean => m.every((col, c) => col.every((v, r) => Math.abs(v - IDENTITY[c]![r]!) <= tol));

export interface LiveReference {
  component: number;
  name: string;
  bodies: string[];
  /** Its import (BaseFeature) features, by name. */
  imports: string[];
  /** Any other feature in its component. */
  others: string[];
  placements: { id: number; name: string; grounded: boolean; pending: boolean; world?: Matrix4 }[];
}

/**
 * The reference components of the live design: every component (not the design itself) holding an
 * import feature (`BaseFeature` in the timeline) or a body one made. Found by what made them, never
 * by name, so a renamed reference is still one.
 */
export function liveReferences(list: ComponentList, timeline: readonly any[], bodies: readonly any[]): LiveReference[] {
  const importIds = new Set(timeline.filter((f) => f?.type === "BaseFeature").map((f) => f.id));
  const importNames = new Set(timeline.filter((f) => f?.type === "BaseFeature" && typeof f.name === "string").map((f) => String(f.name)));
  const importBodies = new Set(bodies.filter((b) => importIds.has(b?.feature) && typeof b?.name === "string").map((b) => String(b.name)));
  return list.components
    .filter((c) => c.id !== 0 && (c.features.some((f) => importNames.has(f)) || c.bodies.some((b) => importBodies.has(b))))
    .map((c) => ({
      component: c.id,
      name: c.name,
      bodies: c.bodies,
      imports: c.features.filter((f) => importNames.has(f)),
      others: c.features.filter((f) => !importNames.has(f)),
      placements: c.occurrences.map((o) => {
        const world = worldTransform(list, o);
        return { id: o.id, name: o.name, grounded: o.grounded, pending: list.pending.includes(o.id), ...(world ? { world } : {}) };
      }),
    }));
}

/** The gate's wording when a reference is not where its import put it. */
export const REFERENCE_MOVED = "was moved from where it was imported";
export const REFERENCE_NOT_GROUNDED = "is not grounded";

/** The name a live reference is reported by: the `refs/` file of its import, else its component. */
export function referenceLabel(r: Pick<LiveReference, "imports" | "bodies" | "name">, embedded: readonly { file: string; name?: string; bodies: string[] }[] | undefined): string {
  const e = embedded?.find((x) => x.name !== undefined && r.imports.includes(x.name)) ?? embedded?.find((x) => x.bodies.some((b) => r.bodies.includes(b)));
  return e ? e.file : `component ${r.name}`;
}

const at = (m: Matrix4 | undefined): string => {
  if (!m) return "where it is cannot be told";
  const turned = !isIdentity([m[0]!, m[1]!, m[2]!, [0, 0, 0, 1]]);
  return `its translation is [${m[3]!.slice(0, 3).map(fmt).join(", ")}]${turned ? " and it is turned" : ""}`;
};

/**
 * Every reference must sit where its import put it — identity in the design — grounded, with no move
 * pending and nothing else in its component. Hard fails: "reference far.step was moved from where it
 * was imported", "reference far.step is not grounded", "reference far.step is not placed",
 * "reference far.step was changed: … are in its component".
 */
export function referencePlacementChecks(refs: readonly LiveReference[], embedded: readonly { file: string; name?: string; bodies: string[] }[] | undefined): GateCheck[] {
  const checks: GateCheck[] = [];
  for (const r of [...refs].sort((a, b) => a.component - b.component)) {
    const label = referenceLabel(r, embedded);
    const fail = (what: string, measured: string) => checks.push({ id: `${what} ${label}`, expected: "the reference is where import_reference put it, grounded", measured, ok: false, hard: true });
    if (r.placements.length === 0) fail("where", `reference ${label} is not placed`);
    for (const p of r.placements) {
      if (p.pending || !p.world || !isIdentity(p.world)) fail("where", `reference ${label} ${REFERENCE_MOVED} (placement ${p.name}: ${p.pending ? "a move is pending" : at(p.world)})`);
      if (!p.grounded) fail("grounded", `reference ${label} ${REFERENCE_NOT_GROUNDED} (placement ${p.name})`);
    }
    if (r.others.length) fail("changed", `reference ${label} was changed: ${r.others.join(", ").slice(0, 200)} ${r.others.length === 1 ? "is" : "are"} in its component`);
  }
  return checks;
}

/**
 * A feature of the design script that names a reference body — `solid.move {bodies: ["far"]}` moves
 * the body inside its component, where no placement shows it. Every `timeline.add` that is not an
 * import is read; a string naming a reference body anywhere in it is a hard fail "reference far.step
 * is changed by feature Move1".
 */
export function referenceEditChecks(script: DesignScript | undefined, refBodies: ReadonlyMap<string, string>): GateCheck[] {
  if (refBodies.size === 0) return [];
  const checks: GateCheck[] = [];
  const names = (v: unknown, depth = 0, out = new Set<string>()): Set<string> => {
    if (typeof v === "string") {
      if (refBodies.has(v)) out.add(v);
    } else if (v && typeof v === "object" && depth < 16) for (const x of Array.isArray(v) ? v : Object.values(v)) names(x, depth + 1, out);
    return out;
  };
  for (const c of Array.isArray(script?.commands) ? script!.commands : []) {
    const cmd = c as { command?: unknown; params?: { feature?: Record<string, unknown> } };
    const f = cmd?.params?.feature;
    if (cmd?.command !== "timeline.add" || !f || f.type === "import") continue;
    const hit = [...names(f)];
    if (!hit.length) continue;
    const labels = [...new Set(hit.map((b) => refBodies.get(b)!))].sort();
    for (const l of labels) checks.push({ id: `changed ${l}`, expected: "no feature changes a reference", measured: `reference ${l} is changed by feature ${String(f.name ?? f.id ?? "?")} (it names ${hit.join(", ")})`, ok: false, hard: true });
  }
  return checks;
}

// ── what a reference measures (the gate's geometry check, the tool's after-check) ─────────────────
//
// `inspect.measure {bodies}` (real 0.44.1) answers each body in WORLD coordinates: `volume_mm3`,
// `bbox {min, max}`, `faces`, `center_of_mass` (absent on the fake). A reference must measure exactly
// what its import measured — whatever selected it (a body name, a face name, a point on a face), a
// feature that reshapes it, a suppressed or rolled-back import, or a move of its placement changes one
// of these numbers. Compared within `REFERENCE_MEASURE_REL` of its size.

/** One reference body as measured. */
export interface ReferenceBodyMeasure {
  name: string;
  volume: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  faces: number;
  /** The centre of mass, when the build reports one (the real one does). */
  centerOfMass?: [number, number, number];
}

/** A reference as imported: the sha of its STEP text and its bodies in import order. */
export interface ReferenceMeasure {
  sha256: string;
  bodies: ReferenceBodyMeasure[];
}

/** How close a reference must measure to its import: 1e-6 of its size (relative). */
export const REFERENCE_MEASURE_REL = 1e-6;
/** The gate's and the tool's wording when a reference does not measure what its import did. */
export const REFERENCE_RESHAPED = "does not match what was imported";

const isV3 = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));

/** `inspect.measure {bodies: names}` → each body's measure, in the order asked. Throws on anything
 *  else (a missing body, an error, a number that is not one): the caller fails closed. */
export function readReferenceMeasures(j: any, names: readonly string[]): ReferenceBodyMeasure[] {
  const list: any[] = Array.isArray(j?.bodies) ? j.bodies : [];
  if (list.length !== names.length) throw new Error(`inspect.measure answered ${list.length} bodies; ${names.length} were asked for`);
  return list.map((b, i) => {
    if (b?.error) throw new Error(`body ${names[i]} could not be measured: ${String(b.error)}`);
    if (typeof b?.volume_mm3 !== "number" || !Number.isFinite(b.volume_mm3) || !isV3(b?.bbox?.min) || !isV3(b?.bbox?.max) || typeof b?.faces !== "number") {
      throw new Error(`body ${names[i]} has no volume, bounding box and face count`);
    }
    return {
      name: String(b.name ?? names[i]),
      volume: b.volume_mm3,
      bbox: { min: [...b.bbox.min] as [number, number, number], max: [...b.bbox.max] as [number, number, number] },
      faces: b.faces,
      ...(isV3(b.center_of_mass) ? { centerOfMass: [...b.center_of_mass] as [number, number, number] } : {}),
    };
  });
}

/** Whether a stored record has the shape of a `ReferenceMeasure` (the lock store is JSON). */
export function isReferenceMeasure(x: any): x is ReferenceMeasure {
  return (
    !!x &&
    typeof x.sha256 === "string" &&
    Array.isArray(x.bodies) &&
    x.bodies.length > 0 &&
    x.bodies.every((b: any) => b && typeof b.name === "string" && typeof b.volume === "number" && isV3(b.bbox?.min) && isV3(b.bbox?.max) && typeof b.faces === "number" && (b.centerOfMass === undefined || isV3(b.centerOfMass)))
  );
}

const v3 = (v: readonly number[]): string => `[${v.map(fmt).join(", ")}]`;

/**
 * What differs between a reference as imported (`expected`) and as it is (`live`, the same bodies in
 * the same order), as short phrases — empty when it matches. Lengths within 1e-6 of the reference's
 * size, the volume within 1e-6 of itself, faces exactly; the centre of mass is compared whenever the
 * import recorded one (a reply that lost it is a difference).
 */
export function referenceDifferences(expected: readonly ReferenceBodyMeasure[], live: readonly ReferenceBodyMeasure[]): string[] {
  if (live.length !== expected.length) return [`${expected.length} bod${expected.length === 1 ? "y" : "ies"} → ${live.length}`];
  const out: string[] = [];
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i]!;
    const l = live[i]!;
    const who = expected.length > 1 ? `${e.name}: ` : "";
    const size = Math.max(1, ...[0, 1, 2].map((k) => Math.abs(e.bbox.max[k]! - e.bbox.min[k]!)), ...e.bbox.min.map(Math.abs), ...e.bbox.max.map(Math.abs));
    const lenTol = REFERENCE_MEASURE_REL * size;
    const near = (a: readonly number[], b: readonly number[]) => a.every((x, k) => Math.abs(x - b[k]!) <= lenTol);
    if (!(Math.abs(l.volume - e.volume) <= REFERENCE_MEASURE_REL * Math.max(1, Math.abs(e.volume)))) out.push(`${who}volume ${fmt(e.volume)} → ${fmt(l.volume)} mm³`);
    if (!near(e.bbox.min, l.bbox.min) || !near(e.bbox.max, l.bbox.max)) out.push(`${who}bounding box ${v3(e.bbox.min)}…${v3(e.bbox.max)} → ${v3(l.bbox.min)}…${v3(l.bbox.max)}`);
    if (l.faces !== e.faces) out.push(`${who}faces ${e.faces} → ${l.faces}`);
    if (e.centerOfMass && (!l.centerOfMass || !near(e.centerOfMass, l.centerOfMass))) out.push(`${who}centre of mass ${v3(e.centerOfMass)} → ${l.centerOfMass ? v3(l.centerOfMass) : "not reported"}`);
  }
  return out;
}

// ── the shape comparison's tolerance: a DEPTH, never a fraction of the volume ──────────────────────
//
// A volume fraction lets a large reference hide a deep local change: on a 600×600×10 block 1e-6 of
// its volume is 3.6 mm³, enough to grow two holes by 9 µm (and shrink two) and clear a pin that
// overlaps the true import by 0.453 mm³. So the allowance is a layer over the import's surface:
// |vol(true) − vol(live)| and vol(true) − vol(true ∩ live) may each be at most
// `area_mm2 × REFERENCE_SHAPE_DEPTH_MM + REFERENCE_SHAPE_FLOOR_MM3` (area from `inspect.measure`).
//
// MEASURED on the real 0.44.1 (planar, cylindrical, filleted, spherical and chamfered bodies, the
// 600×600×10 block with four r=3 holes, the 30×30×10 holey block): two imports of one STEP, and a
// body exported by one process and imported by another, are bit-identical — the volume, the area and
// the overlap of the two differ by exactly 0. The only noise seen anywhere is a native body against
// its own import, ≤ 6e-10 mm³ (the gate never compares those). So the depth is set by what it must
// catch, not by noise: 1e-7 mm (0.1 nm) — 0.074 mm³ on the 600×600×10 block, below what the
// as-imported interference can miss there (see below) — and the floor is 1e-6 mm³, over 1000× the
// largest float difference measured.
//
// RESIDUALS (measured, 0.44.1):
//   - `inspect.interference` drops an overlap smaller than about (d / 1000)³ mm³, d the bounding-box
//     diagonal of ONE body of the pair: the one SolidCraft takes first (native bodies before imported
//     ones, then in the order they were made). The 600×600×10 block has d = 848.6 mm, so 0.61 mm³: a
//     r = 3.006 pin in its r = 3 hole (6 µm deep, 0.453 mm³) and a 20×20 mm pad 1.5 µm into its top
//     face (0.60 mm³) were "no interference" with the block imported first; 0.62 / 0.64 mm³ were
//     caught. It is a volume, not a depth: on a 30×30×10 block (d = 43.6 mm) 0.00125 mm³ (50 nm)
//     was caught. The as-imported check (./refreplay.ts) therefore imports the true reference TWICE,
//     before and after the design bodies, so each pair is checked in both orders: it misses only an
//     overlap below (min(d_design, d_reference) / 1000)³ (8×10⁻⁷ mm³ for that pin). The live-body
//     check runs in the live process, where a native design body is first: its floor is the design
//     body's (d_design / 1000)³.
//   - Penetrations under SolidCraft's confusion tolerance (2e-5 mm) are contact: 10 nm was missed
//     natively, 50 nm caught.
// Together: a passing gate means no design body overlaps the true import by (min(d_design,
// d_reference) / 1000)³ mm³ or more (unless the overlap is under 20 nm deep), and each live reference
// body differs from its import by at most area × 0.1 nm + 1e-6 mm³ of material.

/** The shape comparison's allowance, as a depth over the import's surface (mm). */
export const REFERENCE_SHAPE_DEPTH_MM = 1e-7;
/** …plus this much volume (mm³) for float noise. */
export const REFERENCE_SHAPE_FLOOR_MM3 = 1e-6;
/** The volume (mm³) a reference of `areaMm2` surface may differ from its import by. A surface area
 *  that is not a positive number gets the floor alone (strictest). */
export const shapeTolerance = (areaMm2: number): number => REFERENCE_SHAPE_FLOOR_MM3 + (Number.isFinite(areaMm2) && areaMm2 > 0 ? areaMm2 * REFERENCE_SHAPE_DEPTH_MM : 0);

/**
 * The EXACT shape comparison of a live reference with its true import: per body, the same solid ⇔
 * vol(true) = vol(live) = vol(true ∩ live), within `shapeTolerance(trueArea)` (a 0.1 nm layer over
 * the import's surface, so whatever differs between them has no volume). Phrases as
 * `referenceDifferences`; empty when every body is the same solid. Catches what volume, bounding box,
 * faces and centre of mass cannot: two holes enlarged and two shrunk by the same material, a
 * symmetric outline turned 90°.
 */
export function shapeDifferences(shape: readonly { label: string; trueVolume: number; liveVolume: number; overlap: number; trueArea: number }[], bodyCount?: { imported: number; live: number }): string[] {
  if (bodyCount) return [`${bodyCount.imported} bod${bodyCount.imported === 1 ? "y" : "ies"} → ${bodyCount.live}`];
  const out: string[] = [];
  for (const s of shape) {
    const tol = shapeTolerance(s.trueArea);
    const who = shape.length > 1 ? `${s.label}: ` : "";
    if (Math.abs(s.liveVolume - s.trueVolume) <= tol && Math.abs(s.overlap - s.trueVolume) <= tol) continue;
    out.push(`${who}shape is not the import's: it shares ${fmt(s.overlap)} of the import's ${fmt(s.trueVolume)} mm³ (the reference is ${fmt(s.liveVolume)} mm³)`);
  }
  return out;
}
