import { type Dirent, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { DirEntry, FileContent } from "@protocol";
import type { MarkdownRenderer } from "../render/markdown";

/** Thrown when a requested path can't be located in the worktree — translated to a clean
 *  client error (not "internal error") by the supervisor. */
export class FileNotFound extends Error {}

/** Thrown when an upload targets a path that already exists — the browser refuses to clobber. */
export class FileExists extends Error {}

/**
 * Confine `userPath` to the session worktree `root` (arch §8.1). Resolves symlinks so a
 * link can't escape. This is the only boundary for fs.* (the daemon runs as the dev user).
 */
export function resolveInside(root: string, userPath: string): string {
  const abs = resolve(root, userPath || ".");
  const real = existsSync(abs) ? realpathSync(abs) : abs;
  const rootReal = realpathSync(root);
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new Error("path escapes the session tree");
  }
  return real;
}

/** Recursively collect files matching `name` (basename), worktree-relative. Bounded so a stray
 *  click can't walk a huge tree: skips .git/node_modules, caps depth and hit count. */
function findByBasename(root: string, name: string, limit = 50, maxDepth = 8): { rel: string }[] {
  const out: { rel: string }[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (out.length >= limit || depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (SKIP.has(d.name)) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(join(dir, d.name), childRel, depth + 1);
      else if (d.name === name) out.push({ rel: childRel });
      if (out.length >= limit) return;
    }
  };
  walk(root, "", 0);
  return out;
}

/** Either a single resolved file (`abs`) or, when a bare basename matched 2+ paths, the ambiguous
 *  candidates for the client to pick from (worktree-relative, sorted). */
export type Located = { kind: "file"; abs: string } | { kind: "choices"; paths: string[] };

/**
 * Resolve `userPath` to a real file inside the worktree, with a forgiving fallback: Claude often
 * names a markdown file by basename in prose (`design.md`) while it actually lives in a subdir
 * (`docs/plans/design.md`). When the literal path doesn't exist, search the worktree for a basename
 * match. If the user typed a path (with a `/`), narrow to matches ending in that suffix. A single
 * match resolves to a file; 2+ become `choices` for the client to disambiguate; none throws FileNotFound.
 */
export function locateInside(root: string, userPath: string): Located {
  const direct = resolveInside(root, userPath);
  if (existsSync(direct)) return { kind: "file", abs: direct };
  const suffix = userPath.replace(/^\.?\/+/, "");
  const all = findByBasename(root, basename(suffix));
  // A typed-out path narrows by suffix; a bare basename keeps every match (and may be ambiguous).
  const matches = suffix.includes("/") ? all.filter((m) => m.rel === suffix || m.rel.endsWith(`/${suffix}`)) : all;
  if (matches.length === 0) throw new FileNotFound(`Couldn't find ${userPath} in this session.`);
  if (matches.length === 1) return { kind: "file", abs: resolveInside(root, matches[0]!.rel) }; // re-check boundary
  return { kind: "choices", paths: matches.map((m) => m.rel).sort() };
}

const MIME: Record<string, string> = {
  md: "text/markdown", markdown: "text/markdown",
  ts: "text/typescript", tsx: "text/typescript", js: "text/javascript", jsx: "text/javascript", mjs: "text/javascript",
  json: "application/json", jsonc: "application/json", html: "text/html", css: "text/css",
  py: "text/x-python", rs: "text/x-rust", go: "text/x-go", java: "text/x-java", c: "text/x-c", h: "text/x-c",
  cpp: "text/x-c++", kt: "text/x-kotlin", swift: "text/x-swift", rb: "text/x-ruby", php: "text/x-php",
  sh: "text/x-sh", bash: "text/x-sh", zsh: "text/x-sh", yaml: "text/yaml", yml: "text/yaml", toml: "text/toml",
  sql: "text/x-sql", txt: "text/plain", log: "text/plain", env: "text/plain", gitignore: "text/plain",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", ico: "image/x-icon", pdf: "application/pdf",
};
const extOf = (p: string): string => (p.includes(".") ? p.split(".").pop()!.toLowerCase() : "");
const mimeFor = (p: string): string => MIME[extOf(p)] ?? "application/octet-stream";
const isBinary = (mime: string): boolean => mime.startsWith("image/") || mime === "application/pdf" || mime === "application/octet-stream";

// ext → Shiki language id (unknowns fall back to plain "text" in the renderer)
const LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", rs: "rust", go: "go", java: "java", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  kt: "kotlin", kts: "kotlin", swift: "swift", sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", toml: "toml", json: "json", jsonc: "jsonc", html: "html", css: "css",
  sql: "sql", diff: "diff", patch: "diff",
};
const langForExt = (ext: string): string => LANG[ext] ?? ext;
const longestBacktickRun = (s: string): number => Math.max(0, ...(s.match(/`+/g) ?? []).map((m) => m.length));

const TEXT_CAP = 256 * 1024;
const HIGHLIGHT_CAP = 100 * 1024; // above this, skip Shiki (too slow) and serve plain text
const SKIP = new Set([".git", "node_modules", ".DS_Store"]);

/** List a directory within the worktree (folders first). Paths are worktree-relative. */
export function listDir(root: string, userPath: string): { path: string; entries: DirEntry[] } {
  const dir = resolveInside(root, userPath);
  const entries: DirEntry[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(d.name)) continue;
    const rel = join(userPath, d.name).replace(/^\/+/, "");
    let size: number | undefined;
    let mtime: number | undefined;
    try {
      const st = statSync(join(dir, d.name));
      mtime = st.mtimeMs;
      if (!d.isDirectory()) size = st.size;
    } catch {
      /* ignore — a broken symlink or a race with a delete just yields no detail */
    }
    entries.push({ name: d.name, path: rel, isDir: d.isDirectory(), size, mtime });
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return { path: userPath, entries };
}

/** Write an uploaded file into the worktree at `userPath` (arch §8.1). Refuses to overwrite an
 *  existing path (the browser's drag-drop is "refuse & warn on conflict"). Returns the stored size. */
export function writeFile(root: string, userPath: string, data: Uint8Array): { path: string; size: number } {
  const abs = resolveInside(root, userPath); // symlink-safe boundary — same guard as reads/downloads
  if (existsSync(abs)) throw new FileExists(userPath);
  mkdirSync(dirname(abs), { recursive: true }); // the drop target dir already exists; harmless if so
  writeFileSync(abs, data);
  return { path: userPath.replace(/^\/+/, ""), size: data.byteLength };
}

/** Read a file as FileContent: markdown rendered, text inline (capped), binaries as a URL. */
export function readFile(
  root: string,
  userPath: string,
  renderer: MarkdownRenderer,
  binaryUrlFor: (relPath: string) => string,
): FileContent {
  const located = locateInside(root, userPath);
  if (located.kind === "choices") return { path: userPath, rev: "", mime: "", choices: located.paths };
  const file = located.abs;
  const st = statSync(file);
  const rev = `${st.mtimeMs}:${st.size}`;
  const mime = mimeFor(userPath);

  if (mime === "text/markdown") {
    return { path: userPath, rev, mime, markdown: renderer.render(readFileSync(file, "utf8")) };
  }
  if (isBinary(mime)) {
    return { path: userPath, rev, mime, binaryUrl: binaryUrlFor(userPath) };
  }
  const raw = readFileSync(file, "utf8");
  if (raw.length > TEXT_CAP) {
    return { path: userPath, rev, mime, text: raw.slice(0, TEXT_CAP), truncated: true };
  }
  // Syntax-highlight code by routing it through the markdown pipeline (Shiki) as a fenced
  // block; the fence is one backtick longer than any run in the file so it can't break out.
  if (raw.length <= HIGHLIGHT_CAP && mime !== "text/plain") {
    const fence = "`".repeat(Math.max(3, longestBacktickRun(raw) + 1));
    return { path: userPath, rev, mime, markdown: renderer.render(`${fence}${langForExt(extOf(userPath))}\n${raw}\n${fence}`) };
  }
  return { path: userPath, rev, mime, text: raw };
}
