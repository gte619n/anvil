/**
 * Read-only repo access for the fleet concierge (anvil-fleet-concierge). One implementation serves
 * both sides of the feature: the hub's default chat browsing its OWN registered environments, and a
 * member daemon answering the hub's `/api/fleet/repo` calls about environments that live on it. The
 * surface is deliberately tiny — list a directory, read a file, grep — and strictly read-only: real
 * work on a member repo still happens by handing off a session to that member, never by mutating
 * through this path.
 *
 * Every op is scoped under the environment's `repoRoot`. Escapes are rejected twice: lexically (the
 * resolved path must stay under the root) and via realpath (a symlink inside the tree pointing
 * outside it resolves past the root and is refused), so a hub-relayed request can never read
 * outside the repo it names.
 */
import { promises as fsp } from "node:fs";
import { resolve, sep } from "node:path";
import { gitSpawnAsync } from "../git/spawn";

/** Directory listings are capped well past any useful size for a model-facing tool. */
const LIST_CAP = 500;
/** File reads are capped so a stray artifact can't blow up a tool result (or a REST relay). */
const READ_CAP_BYTES = 256 * 1024;
/** Grep output is capped in LINES — the model wants leads, not a full scan dump. */
const GREP_CAP_LINES = 200;
/** Grep backstop: a pathological pattern over a huge tree is killed rather than wedging a turn. */
const GREP_TIMEOUT_MS = 15_000;

export interface RepoDirEntry {
  name: string;
  kind: "dir" | "file" | "symlink" | "other";
  size?: number;
}

/** One request shape for all three ops — mirrors `rest.FleetRepoRequest` minus the routing fields. */
export interface RepoRequest {
  op: "list" | "read" | "grep";
  /** Repo-relative path: the directory to list, the file to read, or the subtree to grep. */
  path?: string;
  /** ERE pattern (grep only). */
  pattern?: string;
}

export interface RepoResult {
  ok: boolean;
  error?: string;
  /** list */
  entries?: RepoDirEntry[];
  /** read */
  text?: string;
  /** grep — `file:line:text` lines, exactly as grep emits them. */
  matches?: string[];
  /** Set when a cap trimmed the result (entries, bytes, or match lines). */
  truncated?: boolean;
}

const fail = (error: string): RepoResult => ({ ok: false, error });

/**
 * Resolve `rel` inside `root`, refusing every way out: absolute inputs, `..` walks past the root
 * (lexical), and in-tree symlinks that point outside it (realpath). Returns the resolved absolute
 * path, or null when the input escapes. The root itself is realpath'd first so the two checks
 * compare like with like (e.g. /var vs /private/var on macOS).
 */
async function resolveInside(root: string, rel: string | undefined): Promise<string | null> {
  const cleanRel = (rel ?? "").trim();
  if (cleanRel.includes("\0") || cleanRel.startsWith("/") || cleanRel.startsWith("\\")) return null;
  const realRoot = await fsp.realpath(root); // throws if the repoRoot itself is gone — caller reports it
  const target = resolve(realRoot, cleanRel === "" ? "." : cleanRel);
  if (target !== realRoot && !target.startsWith(realRoot + sep)) return null;
  // Symlink escape: realpath the target if it exists; a dangling path is fine (read/list will 404 it).
  try {
    const real = await fsp.realpath(target);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
  } catch {
    /* target doesn't exist — the per-op handler reports "not found" with context */
  }
  return target;
}

async function listDir(root: string, rel: string | undefined): Promise<RepoResult> {
  const dir = await resolveInside(root, rel);
  if (!dir) return fail(`path escapes the repo: ${rel}`);
  let names;
  try {
    names = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return fail(`can't list ${rel || "."}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const truncated = names.length > LIST_CAP;
  const entries: RepoDirEntry[] = [];
  for (const d of names.slice(0, LIST_CAP)) {
    const kind = d.isDirectory() ? "dir" : d.isSymbolicLink() ? "symlink" : d.isFile() ? "file" : "other";
    let size: number | undefined;
    if (kind === "file") {
      try {
        size = (await fsp.stat(resolve(dir, d.name))).size;
      } catch {
        /* raced away — leave size unset */
      }
    }
    entries.push({ name: d.name, kind, ...(size !== undefined ? { size } : {}) });
  }
  return { ok: true, entries, ...(truncated ? { truncated } : {}) };
}

async function readFile(root: string, rel: string | undefined): Promise<RepoResult> {
  if (!rel) return fail("read needs a path");
  const file = await resolveInside(root, rel);
  if (!file) return fail(`path escapes the repo: ${rel}`);
  let handle;
  try {
    handle = await fsp.open(file, "r");
  } catch (e) {
    return fail(`can't read ${rel}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return fail(`not a file: ${rel}`);
    const truncated = stat.size > READ_CAP_BYTES;
    const buf = Buffer.alloc(Math.min(stat.size, READ_CAP_BYTES));
    await handle.read(buf, 0, buf.length, 0);
    // Binary sniff on the first 8 KiB — a NUL byte means this isn't text worth relaying to a model.
    if (buf.subarray(0, 8192).includes(0)) return fail(`binary file (${stat.size} bytes): ${rel}`);
    return { ok: true, text: buf.toString("utf8"), ...(truncated ? { truncated } : {}) };
  } finally {
    await handle.close();
  }
}

async function grep(root: string, pattern: string | undefined, rel: string | undefined): Promise<RepoResult> {
  if (!pattern) return fail("grep needs a pattern");
  const realRoot = await fsp.realpath(root);
  const sub = await resolveInside(root, rel);
  if (!sub) return fail(`path escapes the repo: ${rel}`);
  // Relative subtree for the child process (cwd = repo root); "." when no path was given.
  const subRel = sub === realRoot ? "." : sub.slice(realRoot.length + 1);
  // Prefer `git grep` (respects the repo, fast, includes untracked-but-not-ignored files); fall back
  // to system grep for non-repo environments or when git refuses (e.g. no repo at the root).
  let r = await gitSpawnAsync(["git", "grep", "-EIn", "--no-color", "--untracked", "-e", pattern, "--", subRel], realRoot, GREP_TIMEOUT_MS);
  if (r.code !== 0 && r.code !== 1) {
    r = await gitSpawnAsync(
      ["grep", "-rEIn", "--exclude-dir=.git", "--exclude-dir=node_modules", "--exclude-dir=dist", "-e", pattern, subRel],
      realRoot,
      GREP_TIMEOUT_MS,
    );
  }
  if (r.code === 1) return { ok: true, matches: [] }; // both greps: 1 = clean "no matches"
  if (r.code !== 0) return fail(`grep failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  const lines = r.stdout.split("\n").filter((l) => l !== "");
  const truncated = lines.length > GREP_CAP_LINES;
  return { ok: true, matches: lines.slice(0, GREP_CAP_LINES), ...(truncated ? { truncated } : {}) };
}

/** Run one read-only op against `root` (an environment's repoRoot). Never throws — every failure,
 *  including a vanished root, comes back as `{ ok:false, error }` so both the REST handler and the
 *  concierge tool relay it verbatim. */
export async function repoOp(root: string, req: RepoRequest): Promise<RepoResult> {
  try {
    switch (req.op) {
      case "list":
        return await listDir(root, req.path);
      case "read":
        return await readFile(root, req.path);
      case "grep":
        return await grep(root, req.pattern, req.path);
      default:
        return fail(`unknown op: ${String((req as { op?: unknown }).op)}`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
