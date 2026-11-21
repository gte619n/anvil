/**
 * Where a part lives in a repo (agent-cad-and-browser spec §4.1):
 *
 *   <worktree>/cad/<part>/design.json      the SolidCraft command script — THE source of truth
 *   <worktree>/cad/<part>/.cache/          git-excluded: exports, conflict copies, temp files
 *   <worktree>/cad/<part>/release/         git-excluded: release packs (Phase A4)
 *
 * A part is addressed by NAME only. Nothing in the CAD tools takes a path from the agent: the name
 * is checked against `PART_NAME_RE` and every path is built here.
 */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const PART_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const CAD_DIR = "cad";
export const EXPORTS_DIR = join(".cache", "exports");
/** The lines the daemon keeps in the worktree's `.git/info/exclude` (never `.gitignore`). */
export const CAD_EXCLUDE_LINES = ["cad/*/.cache/", "cad/*/release/"] as const;

export function isValidPartName(part: unknown): part is string {
  return typeof part === "string" && PART_NAME_RE.test(part);
}

export class BadPartName extends Error {
  constructor(part: unknown) {
    super(
      `invalid part name ${JSON.stringify(part)}: a part is a NAME, not a path — lowercase letters, digits and hyphens, ` +
        `starting with a letter or digit, at most 40 characters (e.g. "motor-mount")`,
    );
    this.name = "BadPartName";
  }
}

export interface PartRef {
  /** `realpath(worktree) + "/cad/" + part` — the process-manager key, and the part's folder. */
  key: string;
  /** The real path of the worktree root. */
  worktree: string;
  part: string;
  /** Same as `key`: the absolute part folder, the ONLY folder SolidCraft is allowed to touch. */
  dir: string;
}

/** `cad` or `cad/<part>` is a symlink (or resolves somewhere else): the part would live outside the worktree. */
export class UnsafePartFolder extends Error {
  constructor(part: string, what: string) {
    super(`cad/${part} cannot be used: ${what}. A part folder must be a real folder inside this repo's cad/ folder, not a link.`);
    this.name = "UnsafePartFolder";
  }
}

const isSymlink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false; // does not exist yet
  }
};

/**
 * Refuse a part whose folder is not really `<realpath(worktree)>/cad/<part>`: a symlinked `cad`, a
 * symlinked `cad/<part>`, or anything that resolves elsewhere. Without this, `ln -s /outside
 * cad/evil` would have the daemon and SolidCraft read and write outside the worktree, and two names
 * linked to one folder would run two processes on one design.json. Called when a reference is built
 * and again immediately before a process is started.
 */
export function assertPartFolderSafe(ref: Pick<PartRef, "worktree" | "part" | "dir">): void {
  const cad = join(ref.worktree, CAD_DIR);
  if (isSymlink(cad)) throw new UnsafePartFolder(ref.part, "this repo's cad/ folder is a symbolic link");
  if (isSymlink(ref.dir)) throw new UnsafePartFolder(ref.part, "it is a symbolic link");
  if (existsSync(ref.dir)) {
    let real: string;
    try {
      real = realpathSync(ref.dir);
    } catch {
      throw new UnsafePartFolder(ref.part, "its real location could not be read");
    }
    if (real !== join(ref.worktree, CAD_DIR, ref.part)) throw new UnsafePartFolder(ref.part, "it resolves to a folder outside this repo's cad/ folder");
    if (!lstatSync(ref.dir).isDirectory()) throw new UnsafePartFolder(ref.part, "it is not a folder");
  }
}

/** Build a part's reference. Throws `BadPartName` for anything that is not a plain part name, and
 *  `UnsafePartFolder` when the folder is (or sits behind) a symbolic link. */
export function partRef(worktree: string, part: unknown): PartRef {
  if (!isValidPartName(part)) throw new BadPartName(part);
  const root = realpathSync(worktree);
  const dir = join(root, CAD_DIR, part);
  const ref = { key: dir, worktree: root, part, dir };
  assertPartFolderSafe(ref);
  return ref;
}

/** The part folders that exist under `<worktree>/cad/` (valid names only), sorted. */
export function listParts(worktree: string): string[] {
  try {
    return readdirSync(join(worktree, CAD_DIR), { withFileTypes: true })
      .filter((d) => d.isDirectory() && isValidPartName(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) return undefined;
    return r.stdout.toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The root of the git worktree containing `cwd` (real path), or undefined when it is not in one. */
export function gitToplevel(cwd: string): string | undefined {
  if (!cwd || !existsSync(cwd)) return undefined;
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) return undefined;
  try {
    return realpathSync(top);
  } catch {
    return undefined;
  }
}

/**
 * Make sure the worktree's `info/exclude` ignores the generated CAD folders. The path comes from
 * `git rev-parse --git-path info/exclude`, so it is right for a linked worktree too. Returns the
 * lines it added (empty when they were all there), or undefined when `worktree` is not a git repo.
 */
export function ensureCadExcludes(worktree: string): string[] | undefined {
  const raw = git(worktree, ["rev-parse", "--git-path", "info/exclude"]);
  if (!raw) return undefined;
  const path = isAbsolute(raw) ? raw : resolve(worktree, raw);
  let have = "";
  try {
    have = readFileSync(path, "utf8");
  } catch {
    /* no exclude file yet */
  }
  const lines = new Set(have.split("\n").map((l) => l.trim()));
  const missing = CAD_EXCLUDE_LINES.filter((l) => !lines.has(l));
  if (missing.length === 0) return [];
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, (have && !have.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
  return [...missing];
}
