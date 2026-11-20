/**
 * ONE resolver for the path a file tool (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) will touch,
 * used by every protected file-tool rule and by the danger list (A3 review, item 2).
 *
 * The bundled Claude CLI expands `~` and `~/…` to the home folder before it writes, so a rule that
 * resolved `~/.anvil/x` against the session cwd judged a different file than the one written. Here:
 *   - `~` and `~/…`  → the daemon user's home (`os.homedir()`), exactly as the CLI does;
 *   - `~user…`       → REFUSED (another user's home is never a session's to write, and the CLI's
 *                      handling of it is not something a rule should guess at);
 *   - anything else  → resolved against the session cwd and normalised;
 * then symlinks of the nearest EXISTING ancestor are followed (the file may not exist yet).
 *
 * Comparisons are case-insensitive: macOS volumes (APFS, HFS+) are case-insensitive by default, so
 * `CAD/Plate/PART.JSON` is the same file as `cad/plate/part.json`. They also fold the way the volume
 * does for Unicode (A4 review): APFS matches `ſ` (long s) to `s`, `K` (Kelvin) to `k`, fullwidth
 * letters to ASCII and ignores normalisation, so every comparison is made after NFKC + lower-case.
 * The existing part of a path is resolved by the file system (realpath); only the NEW components (a
 * file not created yet) are folded by us — and `newComponentsSafe` lets a protected rule refuse any
 * new component outside printable ASCII outright, so no folding gap can be used to name a protected
 * file that does not exist yet.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export type ToolPath = { ok: true; abs: string } | { ok: false; reason: string };

/** The file a tool names: `file_path`, `notebook_path` or `path`. */
export function toolPathArg(input: Record<string, unknown>): unknown {
  return input.file_path ?? input.notebook_path ?? input.path;
}

/** Resolve symlinks on the deepest existing ancestor and keep the rest. */
export function realish(p: string): string {
  return splitExisting(p).abs;
}

/** `p` resolved: the deepest existing ancestor through realpath, plus the components that do not exist yet. */
export function splitExisting(p: string): { abs: string; fresh: string[] } {
  let dir = resolve(p);
  const rest: string[] = [];
  while (!existsSync(dir) && dirname(dir) !== dir) {
    rest.unshift(basename(dir));
    dir = dirname(dir);
  }
  try {
    return { abs: join(realpathSync(dir), ...rest), fresh: rest };
  } catch {
    return { abs: resolve(p), fresh: rest };
  }
}

/** Printable ASCII only (space through `~`). */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
/** True when every component of `p` that does not exist yet is printable ASCII. */
export function newComponentsSafe(p: string): boolean {
  return splitExisting(p).fresh.every((c) => PRINTABLE_ASCII.test(c));
}

/** Where a file tool's path really lands. Undefined when there is no path at all. */
export function resolveToolPath(raw: unknown, cwd: string, home: string = homedir()): ToolPath | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  if (raw.includes("\0")) return { ok: false, reason: "a path with a NUL byte" };
  let p = raw;
  if (p === "~" || p.startsWith("~/")) p = join(home, p.slice(1));
  else if (p.startsWith("~")) return { ok: false, reason: `${JSON.stringify(raw)} names another user's home folder (\`~user\`), which a session may not write` };
  return { ok: true, abs: realish(isAbsolute(p) ? p : resolve(cwd, p)) };
}

/** How the volume compares names: compatibility-normalised (NFKC: `ſ`→`s`, `K`→`K`, fullwidth→ASCII,
 *  composed accents) and lower-cased, then normalised again (lower-casing can decompose, e.g. `İ`). */
export const fold = (p: string): string => p.normalize("NFKC").toLowerCase().normalize("NFKC");

/** `p` is `dir` or inside it (case-insensitive). */
export function isUnder(p: string, dir: string): boolean {
  const a = fold(p);
  const d = fold(dir).replace(/\/+$/, "");
  return a === d || a.startsWith(d + "/");
}

/** `abs` relative to `root`, lower-cased with `/` separators, or undefined when outside it. */
export function relUnder(root: string, abs: string): string | undefined {
  if (!isUnder(abs, root)) return undefined;
  const rel = relative(fold(root), fold(abs));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split("\\").join("/");
}
