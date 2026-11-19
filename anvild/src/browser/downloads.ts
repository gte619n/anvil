/**
 * The download quarantine (agent-cad-and-browser §4.12 "Downloads", §4.14 item 30).
 *
 * Playwright writes everything into one folder, `<worktree>/.anvil-browser/`: downloads under the
 * name the server suggested, next to its own page snapshots, screenshots and console logs. A REAL
 * download is one a tool result names in a `- Downloaded file <name> to "<path>"` line (it can arrive
 * one result after the click), or — the sweep at the end of a turn — a file in that folder that is
 * neither one of Playwright's own nor one the model asked for by `filename`.
 *
 * Each real download is moved into `<worktree>/.anvil-downloads/` and the limits are applied there:
 * at most 200 MB, an extension on the allow list, never a symbolic link, a cleaned-up unique name.
 * Anything else is DELETED and reported. Files in the quarantine are never executed (a protected
 * rule denies the Bash routes, and they are stored without an execute bit) and get no file card.
 *
 * Result text is page-influenced, so a "Downloaded file" line is believed only as far as "look at
 * this path": the path must be a plain file directly inside this session's `.anvil-browser/` folder.
 * A line naming anything else is ignored.
 *
 * Dependency-light on purpose (node built-ins and types only), so the file-offer code and other
 * tracks (`import_reference`, `parts_fetch`) can import it.
 */
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import type { ProtectedRule } from "../agent/protected";

export const DOWNLOADS_DIRNAME = ".anvil-downloads";
/** Playwright's output folder (the same name `preset.ts` uses; repeated here to keep this file free
 *  of the browser service's imports — a unit test pins the two together). */
const OUTPUT_DIRNAME = ".anvil-browser";

export const DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;
export const DOWNLOAD_EXTENSIONS: readonly string[] = ["step", "stp", "iges", "igs", "3mf", "stl", "pdf", "zip", "png", "jpg", "jpeg", "csv", "json", "txt"];

export function quarantineDir(worktree: string): string {
  return join(worktree, DOWNLOADS_DIRNAME);
}

/**
 * The absolute path of the quarantined file `name` in this worktree — the one way another tool reads
 * a download (Track A's `import_reference`). `name` is a bare file name as reported when the file was
 * quarantined. @throws when it is not a plain file directly inside the quarantine (a path, `..`, a
 * symbolic link, a folder, or nothing there).
 */
export function quarantinePath(worktree: string, name: string): string {
  if (typeof name !== "string" || !name || name !== basename(name) || name === "." || name === ".." || name.includes("\0") || name.includes("\\")) {
    throw new Error("a quarantined file is named by its file name alone");
  }
  const dir = quarantineDir(worktree);
  const p = join(dir, name);
  let st;
  try {
    if (!lstatSync(dir).isDirectory()) throw new Error("not a folder");
    st = lstatSync(p);
  } catch {
    throw new Error(`${name} is not in the download quarantine`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${name} is not a plain file in the download quarantine`);
  return p;
}

/** Whether `absPath` is inside this worktree's quarantine. */
export function isInQuarantine(worktree: string, absPath: string): boolean {
  const dir = quarantineDir(worktree);
  const abs = resolve(absPath);
  return abs === dir || abs.startsWith(dir + sep);
}

// ── Reading results ─────────────────────────────────────────────────────────────────────────────

const DOWNLOADED_RE = /^- Downloaded file (.+) to "([^"\n]+)"\s*$/gm;

/** Every `- Downloaded file <name> to "<path>"` line in a result's text. */
export function parseDownloadLines(text: string): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  for (const m of text.matchAll(DOWNLOADED_RE)) out.push({ name: m[1]!.trim(), path: m[2]! });
  return out;
}

/** Playwright's own files in the output folder: `page-<ISO time>.yml|png|jpeg`, `console-<ISO time>.log`. */
export function isPlaywrightOwnFile(name: string): boolean {
  return /^page-\d{4}-\d{2}-\d{2}T[\dA-Za-z.:-]*\.(yml|yaml|png|jpe?g|md)$/.test(name) || /^console-\d{4}-\d{2}-\d{2}T[\dA-Za-z.:-]*\.log$/.test(name);
}

/** A file name safe to keep: no folders, no leading dots, a short plain alphabet. */
export function sanitizeDownloadName(raw: string): string {
  let name = basename(String(raw).replace(/\\/g, "/"))
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._ -]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s_-]+/, "")
    .replace(/[.\s]+$/, "");
  if (!name) name = "download";
  if (name.length > 120) {
    const ext = extname(name).slice(0, 12);
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name;
}

const extOf = (name: string): string => extname(name).slice(1).toLowerCase();

// ── Moving one file ─────────────────────────────────────────────────────────────────────────────

export interface DownloadOutcome {
  /** The name the file arrived under. */
  name: string;
  /** Kept: its path relative to the worktree (`.anvil-downloads/<file>`), and its bare file name. */
  kept?: string;
  file?: string;
  /** Deleted: why. */
  deleted?: string;
  /** Neither kept nor deleted (a hard link): why. */
  skipped?: string;
  size?: number;
}

export interface QuarantineOptions {
  maxBytes?: number;
  /** Add `.anvil-downloads/` to the checkout's git exclude file (the browser service passes its helper). */
  exclude?: (worktree: string, entry: string) => void;
}

const fmtSize = (n: number): string => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n} bytes`);

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    try {
      rmSync(path, { force: true });
    } catch {
      /* nothing more to try */
    }
  }
}

function realOrUndefined(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

function uniqueDest(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  throw new Error("too many files with that name");
}

/**
 * Why `<worktree>/.anvil-browser/` cannot be used, or undefined when it is fine (C3 review, item 4):
 * it must be a real folder (not a symbolic link) whose real path is the worktree's real path plus
 * `.anvil-browser`. A folder that does not exist yet is fine. Never throws.
 */
export function outputDirProblem(worktree: string): string | undefined {
  const outDir = join(worktree, OUTPUT_DIRNAME);
  let st;
  try {
    st = lstatSync(outDir);
  } catch {
    return undefined; // not there yet
  }
  if (st.isSymbolicLink()) return `${OUTPUT_DIRNAME} in this worktree is a symbolic link; remove it (Anvil will create a real folder)`;
  if (!st.isDirectory()) return `${OUTPUT_DIRNAME} in this worktree is not a folder; remove it`;
  const real = realOrUndefined(outDir);
  const wt = realOrUndefined(worktree);
  if (!real || !wt || real !== join(wt, OUTPUT_DIRNAME)) return `${OUTPUT_DIRNAME} in this worktree does not resolve to a folder inside it`;
  return undefined;
}

/**
 * Take one file out of `<worktree>/.anvil-browser/`: keep it in the quarantine if it passes the
 * limits, delete it otherwise. Returns undefined — and touches nothing — when `sourcePath` is not a
 * file directly inside that folder (already handled, not there yet, or a made-up path).
 */
export function quarantineFile(worktree: string, sourcePath: string, opts: QuarantineOptions = {}): DownloadOutcome | undefined {
  const outDir = join(worktree, OUTPUT_DIRNAME);
  if (!isAbsolute(sourcePath)) return undefined;
  const src = resolve(sourcePath);
  // Directly inside the output folder, by the path as written AND with links resolved.
  const outReal = realOrUndefined(outDir);
  const parentReal = realOrUndefined(dirname(src));
  if (!outReal || !parentReal || parentReal !== outReal) return undefined;
  if (dirname(src) !== resolve(outDir) && dirname(src) !== outReal) return undefined;
  // …and the output folder itself is a real folder of this worktree, never a link out of it.
  if (outputDirProblem(worktree)) return undefined;

  let st;
  try {
    st = lstatSync(src);
  } catch {
    return undefined;
  }
  const name = basename(src);
  if (st.isSymbolicLink()) {
    remove(src); // the link itself, never what it points at
    return { name, deleted: "it is a symbolic link" };
  }
  if (!st.isFile()) return undefined;
  // A hard link shares its inode with a file somewhere else: never chmod, move or delete it.
  if (st.nlink > 1) return { name, size: st.size, skipped: "it has another name elsewhere on disk (a hard link); it was left where it is and not quarantined" };

  const clean = sanitizeDownloadName(name);
  const ext = extOf(clean);
  if (!DOWNLOAD_EXTENSIONS.includes(ext)) {
    remove(src);
    return { name, size: st.size, deleted: ext ? `.${ext} files are not allowed (allowed: ${DOWNLOAD_EXTENSIONS.join(", ")})` : `a file with no extension is not allowed (allowed: ${DOWNLOAD_EXTENSIONS.join(", ")})` };
  }
  const max = opts.maxBytes ?? DOWNLOAD_MAX_BYTES;
  if (st.size > max) {
    remove(src);
    return { name, size: st.size, deleted: `it is ${fmtSize(st.size)}, over the ${fmtSize(max)} limit` };
  }

  const dir = quarantineDir(worktree);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The quarantine must be a real folder of this worktree, not a link to somewhere else.
    if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error(`${DOWNLOADS_DIRNAME} is not a plain folder`);
    opts.exclude?.(worktree, `${DOWNLOADS_DIRNAME}/`);
    const file = uniqueDest(dir, clean);
    const dest = join(dir, file);
    try {
      renameSync(src, dest);
    } catch {
      copyFileSync(src, dest);
      remove(src);
    }
    chmodSync(dest, 0o600); // data, never a program
    return { name, size: st.size, kept: `${DOWNLOADS_DIRNAME}/${file}`, file };
  } catch (e) {
    remove(src);
    return { name, size: st.size, deleted: `it could not be put in quarantine (${e instanceof Error ? e.message : String(e)})` };
  }
}

/**
 * The end-of-turn sweep: every plain file (or link) directly inside `.anvil-browser/` that is not one
 * of Playwright's own, was not asked for by the model through a `filename` argument, and appeared
 * since `since` is treated as a download.
 */
export function sweepOutputDir(worktree: string, opts: QuarantineOptions & { requested?: ReadonlySet<string>; since?: number } = {}): DownloadOutcome[] {
  const outDir = join(worktree, OUTPUT_DIRNAME);
  const bad = outputDirProblem(worktree);
  if (bad) throw new Error(`the download sweep was refused: ${bad}`);
  let entries: string[];
  try {
    entries = readdirSync(outDir);
  } catch {
    return [];
  }
  const out: DownloadOutcome[] = [];
  for (const name of entries.sort()) {
    if (isPlaywrightOwnFile(name)) continue;
    const p = join(outDir, name);
    if (opts.requested?.has(p)) continue;
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) continue;
    if (opts.since !== undefined && st.mtimeMs < opts.since && st.ctimeMs < opts.since) continue;
    const outcome = quarantineFile(worktree, p, opts);
    if (outcome) out.push(outcome);
  }
  return out;
}

/** The paths (inside the output folder) a call asked Playwright to write through `filename`. */
export function requestedOutputFiles(worktree: string, input: unknown, depth = 0): string[] {
  if (!input || typeof input !== "object" || depth > 6) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === "filename" && typeof v === "string" && v) {
      // Playwright resolves a relative name against its output folder; some tools use the workspace
      // root. Both are remembered — neither is a download.
      out.push(resolve(worktree, OUTPUT_DIRNAME, v), resolve(worktree, OUTPUT_DIRNAME, basename(v)));
    } else if (v && typeof v === "object") out.push(...requestedOutputFiles(worktree, v, depth + 1));
  }
  return out;
}

// ── Telling the owner and the model ─────────────────────────────────────────────────────────────

/** One transcript line per outcome (Markdown). */
export function downloadNotice(o: DownloadOutcome): string {
  const name = o.name.replace(/[`*_[\]<>]/g, "");
  if (o.skipped) return `⚠️ _Download \`${name}\` was not touched: ${o.skipped}._`;
  return o.kept ? `⬇️ _Download \`${name}\` was put in quarantine at \`${o.kept}\`. It is never run and gets no download card; copy it out deliberately to use it._` : `🗑️ _Download \`${name}\` was deleted: ${o.deleted}._`;
}

/** What the model is told with its next browser call. */
export function downloadContext(outcomes: readonly DownloadOutcome[]): string {
  const lines = outcomes.map((o) =>
    o.skipped
      ? `- ${JSON.stringify(o.name)} was NOT quarantined and was left in place: ${o.skipped}. Do not use it.`
      : o.kept
      ? `- ${JSON.stringify(o.name)} was moved to ${o.kept} (it is no longer in ${OUTPUT_DIRNAME}/). Files there are never executed; copy one out deliberately if the task needs it.`
      : `- ${JSON.stringify(o.name)} was DELETED: ${o.deleted}. Do not try to fetch it again another way.`,
  );
  return `Anvil download quarantine:\n${lines.join("\n")}`;
}

// ── Never executed ──────────────────────────────────────────────────────────────────────────────

const RUNNERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "python", "python2", "python3", "node", "nodejs", "bun", "bunx", "deno", "npx", "open", "source", ".", "exec", "perl", "ruby", "osascript", "php", "java", "swift", "xattr", "installer", "hdiutil"]);
const WRAPPERS = new Set(["sudo", "env", "nohup", "time", "command", "nice", "xargs", "exec", "caffeinate", "arch"]);
const IN_QUARANTINE = /(^|[\s"'=/(:])\.anvil-downloads(\/|$|["'\s])/;

function words(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ""));
}

/**
 * Why a Bash command would EXECUTE a quarantined file, or undefined. A heuristic tripwire, not a
 * sandbox (§6): a path into `.anvil-downloads/` used as the command word, or handed to a shell, an
 * interpreter, `open` or `chmod +x`, or a command run after `cd` into the folder.
 */
export function quarantineExecProblem(command: string): string | undefined {
  if (!command.includes(DOWNLOADS_DIRNAME)) return undefined;
  const deny = `files in ${DOWNLOADS_DIRNAME}/ are downloads and are never executed (copy one out deliberately if the task needs it)`;
  let insideQuarantine = false;
  let touched = false;
  let bareInterpreter = false;
  for (const segment of command.split(/&&|\|\||[;|\n&]|\$\(|`|\(|\)/)) {
    let w = words(segment.trim());
    // Skip leading NAME=value assignments and wrappers (and the wrappers' own options).
    while (w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!) || WRAPPERS.has(basename(w[0]!)))) {
      w = w.slice(1);
      while (w.length && w[0]!.startsWith("-")) w = w.slice(1);
    }
    if (!w.length) continue;
    const cmd = w[0]!;
    const cmdName = basename(cmd);
    const args = w.slice(1);
    const touches = (s: string): boolean => IN_QUARANTINE.test(s) || s.startsWith(`${DOWNLOADS_DIRNAME}/`) || s === DOWNLOADS_DIRNAME;
    if (cmdName === "cd" || cmdName === "pushd") {
      insideQuarantine = args.some(touches);
      continue;
    }
    if (touches(cmd)) return deny;
    if (args.some(touches)) touched = true;
    // `cat .anvil-downloads/x | sh`: an interpreter reading its program from a pipe.
    if (RUNNERS.has(cmdName) && cmdName !== "open" && !args.some((a) => !a.startsWith("-"))) bareInterpreter = true;
    if (insideQuarantine && (cmd.startsWith("./") || RUNNERS.has(cmdName) || cmdName === "chmod")) return deny;
    if (RUNNERS.has(cmdName) && args.some(touches)) return deny;
    if (cmdName === "chmod" && args.some(touches) && args.some((a) => /^[ugoa]*[+=][rwst]*x/.test(a) || /^[0-7]{3,4}$/.test(a) && /[1357]/.test(a))) return deny;
  }
  if (touched && bareInterpreter) return deny;
  return undefined;
}

/** The protected rule (registered by the browser service): Bash may not execute a quarantined file. */
export const downloadsProtectedRule: ProtectedRule = (ctx) => {
  if (ctx.tool !== "Bash") return undefined;
  const problem = quarantineExecProblem(typeof ctx.input.command === "string" ? ctx.input.command : "");
  return problem ? { kind: "deny", reason: problem } : undefined;
};
