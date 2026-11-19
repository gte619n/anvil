/**
 * The post-step that follows every successful mutating request (agent-cad-and-browser spec §4.3,
 * §4.14 #8). It runs inside the same queue slot as the request, before the next one starts.
 *
 * STEP 1 — the script write — lives here and always runs synchronously: ask the live process for
 * its script (`execute timeline.export_script` with NO path, so SolidCraft writes nothing), and write
 * `design.json` ourselves, atomically, with sorted keys and a stable `about` block.
 *
 * ── EXTENSION POINT FOR PHASES A2 / A3 ─────────────────────────────────────────────────────────
 * Steps 2–5 (measure, gate, preview, broadcast) are the REFRESH. It is NOT part of this function:
 * it is a separate job the manager queues after step 1, debounced during a burst and always run
 * when the queue drains (see `RefreshJob` and `CadManager.setRefresh` / `forceRefresh` in
 * ./manager.ts). A later phase implements a `RefreshJob` and installs it; nothing here or in the
 * manager's queue needs restructuring. `writeScript`'s outcome (`scriptSha`, `changed`) is what a
 * refresh keys its measurement to.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpToolResult } from "./mcp-client";

export const DESIGN_FILE = "design.json";
export const CACHE_DIR = ".cache";
export const CONFLICT_FILE = "design.conflict.json";
export const DISK_CONFLICT_REASON = "design changed on disk during a change";

export interface DesignScript {
  about: Record<string, unknown>;
  commands: unknown[];
}

const sha256 = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

/** Recursively order object keys (arrays keep their order — command order is the design). */
export function sortKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(sortKeys) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out as T;
  }
  return v;
}

/** sha256 of the canonical `commands` array ONLY. `about.version` changes with every SolidCraft
 *  release and must not make a design look modified (§4.14 #8). */
export function scriptSha(commands: unknown): string {
  return sha256(JSON.stringify(sortKeys(commands ?? [])));
}

/** The exact bytes of `design.json` for a script: sorted keys, 2-space indent, trailing newline, and
 *  an `about` block whose `design` is always the part name (never SolidCraft's "Untitled"). */
export function designFileText(part: string, script: DesignScript): string {
  const about = { ...(script.about ?? {}), design: part };
  return JSON.stringify(sortKeys({ about, commands: script.commands ?? [] }), null, 2) + "\n";
}

/** sha256 of a file's bytes, or null when it does not exist. */
export function fileSha(path: string): string | null {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

/** The number in `about.format` ("solidcraft/58" → 58), or undefined when absent/unreadable. */
export function formatNumber(script: unknown): number | undefined {
  const raw = (script as { about?: { format?: unknown } } | undefined)?.about?.format;
  const m = /(\d+)\s*$/.exec(typeof raw === "string" || typeof raw === "number" ? String(raw) : "");
  return m ? Number(m[1]) : undefined;
}

/** Read `design.json` as far as it can be read: its file sha, and (when it parses) its script. */
export function readDesignFile(partDir: string): { sha: string | null; script?: DesignScript; scriptSha?: string; parseError?: string } {
  const path = join(partDir, DESIGN_FILE);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return { sha: null };
  }
  const sha = sha256(bytes);
  try {
    const doc = JSON.parse(bytes.toString("utf8"));
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.commands)) return { sha, parseError: "design.json has no `commands` array" };
    return { sha, script: doc as DesignScript, scriptSha: scriptSha(doc.commands) };
  } catch (e) {
    return { sha, parseError: e instanceof Error ? e.message : String(e) };
  }
}

/** File operations the write uses; injectable so a crash between the temp write and the rename can
 *  be simulated. */
export interface PoststepFs {
  writeFile(path: string, text: string): void;
  rename(from: string, to: string): void;
}
const realFs: PoststepFs = {
  writeFile: (p, t) => writeFileSync(p, t),
  rename: (a, b) => renameSync(a, b),
};

export interface WriteScriptInput {
  /** Call a tool on the part's live process (already inside the queue slot). */
  call: (tool: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  partDir: string;
  part: string;
  /** The sha of the `design.json` this process was started from or last wrote (null: no file). */
  expectedDiskSha: string | null;
  fs?: PoststepFs;
  /** Test seam: runs after the script is exported and before the disk check + rename. */
  beforeRename?: () => void | Promise<void>;
}

export type WriteScriptOutcome =
  | { kind: "written"; diskSha: string; scriptSha: string; steps: number; changed: boolean; omitted: unknown[] }
  /** `design.json` changed on disk while the request ran: it was NOT overwritten. */
  | { kind: "conflict"; conflictPath: string; scriptSha: string; reason: typeof DISK_CONFLICT_REASON };

let tmpCounter = 0;

/**
 * Post-step 1. Throws when the script cannot be exported (the caller reports it; `design.json` is
 * untouched). The write is temp-file + rename, so a crash at any point leaves the old script intact.
 */
export async function writeScript(input: WriteScriptInput): Promise<WriteScriptOutcome> {
  const fs = input.fs ?? realFs;
  const reply = await input.call("execute", { command: "timeline.export_script", params: {} });
  const script = reply.json?.script as DesignScript | undefined;
  if (reply.isError || !script || !Array.isArray(script.commands)) {
    throw new Error(`could not export the design script: ${reply.text.slice(0, 500) || "no script in the reply"}`);
  }
  const text = designFileText(input.part, script);
  const sha = scriptSha(script.commands);
  const target = join(input.partDir, DESIGN_FILE);

  await input.beforeRename?.();

  // The disk check, immediately before the rename (§4.2): never overwrite a file someone else changed.
  const onDisk = fileSha(target);
  if (onDisk !== input.expectedDiskSha) {
    const cache = join(input.partDir, CACHE_DIR);
    mkdirSync(cache, { recursive: true });
    const conflictPath = join(cache, CONFLICT_FILE);
    fs.writeFile(conflictPath, text);
    return { kind: "conflict", conflictPath, scriptSha: sha, reason: DISK_CONFLICT_REASON };
  }

  const newDiskSha = sha256(text);
  if (onDisk === newDiskSha) {
    // Byte-identical (a request that changed nothing, e.g. check_parameters): leave the file alone.
    return { kind: "written", diskSha: newDiskSha, scriptSha: sha, steps: script.commands.length, changed: false, omitted: reply.json?.omitted ?? [] };
  }

  // The temp file sits in .cache/ (git-excluded, same filesystem), so a crash never leaves an
  // untracked file beside design.json.
  mkdirSync(join(input.partDir, CACHE_DIR), { recursive: true });
  const tmp = join(input.partDir, CACHE_DIR, `${DESIGN_FILE}.tmp-${process.pid}-${++tmpCounter}`);
  try {
    fs.writeFile(tmp, text);
    fs.rename(tmp, target);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
  return { kind: "written", diskSha: newDiskSha, scriptSha: sha, steps: script.commands.length, changed: true, omitted: reply.json?.omitted ?? [] };
}
