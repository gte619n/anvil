/**
 * A read-only repository tool surface exposed to the adversarial OpenRouter models so they can inspect
 * the actual codebase (not just Claude's plan text) when critiquing a plan. The daemon executes these
 * on the model's behalf — so every path is confined to the environment's repo root, reads are size-
 * capped, and there is NO write/exec/shell tool. A malicious or confused tool call returns an error
 * STRING (fed back to the model) rather than throwing, so the agent loop keeps going.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_FILE_BYTES = 64_000; // a single read; larger files are truncated with a note
const MAX_DIR_ENTRIES = 300; // a single listing
const MAX_GREP_LINES = 100; // a single search

/** OpenAI-compatible function-tool definitions handed to the model in the chat request. */
export const REPO_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "list_dir",
      description: "List the files and subdirectories at a path within the repository. Directories end with a trailing slash.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: 'Repo-relative directory path. Defaults to the repo root ".".' } },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read the contents of a file within the repository (truncated if very large).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Repo-relative file path." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "grep",
      description: "Search tracked files in the repository for a regular expression (git grep). Returns matching lines with file:line prefixes.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "A regular expression to search for." },
          path: { type: "string", description: 'Optional repo-relative path to scope the search. Defaults to the whole repo.' },
        },
        required: ["pattern"],
      },
    },
  },
];

/** Resolve a repo-relative path and confirm it stays inside `repoRoot` (symlinks included). Throws
 *  with a model-readable message on any escape or bad input — the caller turns it into a tool result. */
function safeResolve(repoRoot: string, rel: string | undefined): string {
  const root = realpathSync(repoRoot);
  const p = (rel ?? ".").trim();
  if (isAbsolute(p)) throw new Error(`path must be repo-relative, not absolute: ${p}`);
  const target = resolve(root, p);
  // Prefix check on the lexical path first (covers non-existent paths), then a realpath check when the
  // path exists so a symlink can't point outside the repo.
  const within = (candidate: string): boolean => candidate === root || candidate.startsWith(root + sep);
  if (!within(target)) throw new Error(`path escapes the repository: ${p}`);
  if (existsSync(target)) {
    const real = realpathSync(target);
    if (!within(real)) throw new Error(`path escapes the repository via a symlink: ${p}`);
    return real;
  }
  return target;
}

function doListDir(repoRoot: string, path?: string): string {
  const dir = safeResolve(repoRoot, path);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return `not a directory: ${path ?? "."}`;
  const entries = readdirSync(dir, { withFileTypes: true })
    // Hide the noise a reviewer never wants to page through; they can still read tracked files directly.
    .filter((e) => e.name !== ".git" && e.name !== "node_modules")
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  const shown = entries.slice(0, MAX_DIR_ENTRIES);
  const more = entries.length > shown.length ? `\n… ${entries.length - shown.length} more entries (narrow the path)` : "";
  const label = relative(realpathSync(repoRoot), dir) || ".";
  return `${label}/\n${shown.join("\n")}${more}`;
}

function doReadFile(repoRoot: string, path: string | undefined): string {
  if (!path?.trim()) return "read_file requires a `path`.";
  const file = safeResolve(repoRoot, path);
  if (!existsSync(file) || !statSync(file).isFile()) return `not a file: ${path}`;
  const buf = readFileSync(file);
  if (buf.byteLength > MAX_FILE_BYTES) {
    return `${buf.subarray(0, MAX_FILE_BYTES).toString("utf8")}\n… [truncated: file is ${buf.byteLength} bytes, showed first ${MAX_FILE_BYTES}]`;
  }
  return buf.toString("utf8");
}

async function doGrep(repoRoot: string, pattern: string | undefined, path?: string): Promise<string> {
  if (!pattern?.trim()) return "grep requires a `pattern`.";
  // Validate the scope path stays in the repo before shelling out (git grep pathspec).
  let scope = ".";
  if (path?.trim()) {
    safeResolve(repoRoot, path); // throws on escape
    scope = path.trim();
  }
  // git grep over tracked files: fast and skips node_modules/.git for free. -I ignores binaries.
  const proc = Bun.spawn(["git", "grep", "-n", "-I", "-e", pattern, "--", scope], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code === 1) return "no matches.";
  if (code !== 0) return `grep failed: ${(err || out).trim().slice(0, 300) || `exit ${code}`}`;
  const lines = out.split("\n").filter(Boolean);
  const shown = lines.slice(0, MAX_GREP_LINES);
  const more = lines.length > shown.length ? `\n… ${lines.length - shown.length} more matches (narrow the pattern)` : "";
  return `${shown.join("\n")}${more}`;
}

/**
 * Execute one tool call from the model against `repoRoot`, returning a string result to feed back into
 * the conversation. Never throws — bad input / escapes / IO errors come back as an error string so the
 * agent loop can continue (and the model can correct itself).
 */
export async function executeRepoTool(repoRoot: string, name: string, argsJson: string): Promise<string> {
  let args: { path?: string; pattern?: string };
  try {
    args = argsJson ? (JSON.parse(argsJson) as typeof args) : {};
  } catch {
    return `could not parse tool arguments as JSON: ${argsJson.slice(0, 200)}`;
  }
  try {
    switch (name) {
      case "list_dir":
        return doListDir(repoRoot, args.path);
      case "read_file":
        return doReadFile(repoRoot, args.path);
      case "grep":
        return await doGrep(repoRoot, args.pattern, args.path);
      default:
        return `unknown tool: ${name}`;
    }
  } catch (e) {
    return `tool error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
