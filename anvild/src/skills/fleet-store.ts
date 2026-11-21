/**
 * The fleet skill library (docs/plans/2026-11-19-fleet-skills.md).
 *
 * One library of Claude Code skills, authored/imported ONCE on the hub and replicated to every fleet
 * member, so every session on every machine can invoke `/fleet:<name>` without anyone touching each
 * project repo. On disk, under the daemon state dir (never inside a project):
 *
 *   <stateDir>/fleet-skills/index.json          { role, skills: FleetSkill[] }
 *   <stateDir>/fleet-skills/skills/<name>/…     SKILL.md + supporting files
 *
 * Roles mirror the account roster (§7.3): a daemon starts as "hub" (writable); the first replica push
 * from a hub flips it to "replica" (read-only, wholesale-replaced by every push) and that survives a
 * restart. Writes on a replica throw — the UI routes skill.* commands to the hub.
 *
 * Content limits keep a bad import from wedging replication: files are capped individually and per
 * skill, symlinks + dot-dirs (.git) are skipped, and paths can never escape the skill dir.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { FleetSkill, FleetSkillSource, rest } from "@protocol";
import { writeFileAtomic } from "../util/atomic";
import { CLONE_TIMEOUT_MS, gitSpawnAsync } from "../git/spawn";

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB per file
export const MAX_SKILL_BYTES = 5 * 1024 * 1024; // 5 MiB per skill
export const MAX_SKILL_FILES = 200;

/** One file of a skill, held in memory while importing/replicating. */
export interface SkillFile {
  path: string; // "/"-separated, relative to the skill dir
  data: Buffer;
  mode: number;
}

interface Index {
  role: "hub" | "replica";
  skills: FleetSkill[];
}

/**
 * Minimal SKILL.md frontmatter reader (no YAML dep): `name:` / `description:` as a plain or quoted
 * single-line value, or a YAML block scalar (`description: >` / `|`, optionally `>-`, followed by
 * indented lines — folded into one line, which is all the UI shows).
 */
export function parseFrontmatter(text: string): { name?: string; description?: string } | undefined {
  const t = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!t.startsWith("---")) return undefined;
  const end = t.indexOf("\n---", 3);
  if (end < 0) return undefined;
  const lines = t.slice(3, end).split("\n");
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^(name|description):\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    let value = (m[2] ?? "").trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === "")) block.push(lines[++i]!.trim());
      value = block.filter(Boolean).join(" ");
    } else {
      value = value.replace(/^["']|["']$/g, "").trim();
    }
    out[m[1] as "name" | "description"] = value;
  }
  return out;
}

/** Throws unless `name` is a safe skill directory name. */
export function assertSkillName(name: string): void {
  if (!SKILL_NAME_RE.test(name) || name === "." || name === "..") {
    throw new Error(`invalid skill name "${name}" — use letters, digits, ".", "_" or "-" (max 64)`);
  }
}

/** A relative path that stays inside its root, "/"-separated; throws on anything else. */
function safeRelPath(p: string): string {
  const norm = normalize(p.replace(/\\/g, "/")).split(sep).join("/").replace(/\/+$/, "");
  if (!norm || isAbsolute(norm) || norm === ".." || norm.startsWith("../") || norm.split("/").some((seg) => seg === ".." || seg === "")) {
    throw new Error(`unsafe path in skill: ${p}`);
  }
  return norm;
}

/** Validate a skill's file set (SKILL.md present + frontmatter description, size caps) and return
 *  its description. */
function validateFiles(name: string, files: SkillFile[]): string {
  assertSkillName(name);
  const skillMd = files.find((f) => f.path === "SKILL.md");
  if (!skillMd) throw new Error(`skill "${name}" has no SKILL.md`);
  const fm = parseFrontmatter(skillMd.data.toString("utf8"));
  if (!fm?.description) throw new Error(`skill "${name}": SKILL.md needs frontmatter with a \`description:\` line`);
  if (files.length > MAX_SKILL_FILES) throw new Error(`skill "${name}" has too many files (${files.length} > ${MAX_SKILL_FILES})`);
  let total = 0;
  for (const f of files) {
    safeRelPath(f.path);
    if (f.data.length > MAX_FILE_BYTES) throw new Error(`skill "${name}": ${f.path} is larger than 1 MiB`);
    total += f.data.length;
  }
  if (total > MAX_SKILL_BYTES) throw new Error(`skill "${name}" is larger than 5 MiB`);
  return fm.description;
}

/** Content hash of a skill's files (order-independent). */
export function hashFiles(files: SkillFile[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(f.path).update("\0").update(String(f.mode & 0o111 ? 1 : 0)).update("\0");
    h.update(createHash("sha256").update(f.data).digest("hex")).update("\n");
  }
  return h.digest("hex").slice(0, 16);
}

/** Read every regular file under `dir` (skipping symlinks and dot-entries), relative paths. */
export function readSkillDir(dir: string): SkillFile[] {
  const out: SkillFile[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue; // .git, .DS_Store, editor droppings
      const childAbs = join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue; // never follow out of the skill dir
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) {
        if (out.length >= MAX_SKILL_FILES) throw new Error(`${dir} has more than ${MAX_SKILL_FILES} files`);
        const st = statSync(childAbs);
        if (st.size > MAX_FILE_BYTES) throw new Error(`${childRel} is larger than 1 MiB`);
        out.push({ path: childRel, data: readFileSync(childAbs), mode: st.mode & 0o111 ? 0o755 : 0o644 });
      }
    }
  };
  walk(dir, "");
  return out;
}

/** Find the skills inside an imported tree: the dir itself if it holds a SKILL.md, else each child of
 *  `<dir>`, `<dir>/skills`, `<dir>/.claude/skills` that does. Returns absolute skill dirs. */
export function discoverSkillDirs(dir: string): string[] {
  if (existsSync(join(dir, "SKILL.md"))) return [dir];
  const found: string[] = [];
  for (const parent of [dir, join(dir, "skills"), join(dir, ".claude", "skills")]) {
    if (!existsSync(parent) || !statSync(parent).isDirectory()) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const child = join(parent, entry.name);
      if (existsSync(join(child, "SKILL.md")) && !found.includes(child)) found.push(child);
    }
  }
  return found;
}

/** `owner/repo` → its GitHub https URL; anything else (https/ssh/file URLs) passes through. */
export function normalizeGitUrl(src: string): string {
  const s = src.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s.replace(/\.git$/, "")}.git`;
  return s;
}

/** True when `source` names a git repo rather than a path on this machine. */
export function isGitSource(source: string): boolean {
  const s = source.trim();
  if (isAbsolute(s) || s.startsWith("~")) return false;
  return /^(https?:|ssh:|git@|git:|file:)/.test(s) || /^[\w.-]+\/[\w.-]+$/.test(s);
}

/** Shallow-clone `url` into a temp dir; the caller must `rmSync` the returned dir. Exported for tests. */
export async function cloneShallow(url: string, ref?: string): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "anvil-skill-import-"));
  const target = join(tmp, "repo");
  const args = ["git", "clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), "--", url, target];
  const r = await gitSpawnAsync(args, tmp, CLONE_TIMEOUT_MS);
  if (r.code !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`git clone failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ")}`);
  }
  return tmp;
}

export class FleetSkillStore {
  readonly root: string;
  readonly skillsDir: string;
  private readonly indexFile: string;
  private index: Index = { role: "hub", skills: [] };

  constructor(stateDir: string) {
    this.root = join(stateDir, "fleet-skills");
    this.skillsDir = join(this.root, "skills");
    this.indexFile = join(this.root, "index.json");
    mkdirSync(this.skillsDir, { recursive: true });
    this.load();
  }

  role(): "hub" | "replica" {
    return this.index.role;
  }

  /** Every skill, by name. */
  list(): FleetSkill[] {
    return [...this.index.skills].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): FleetSkill | undefined {
    return this.index.skills.find((s) => s.name === name);
  }

  /** Whole-library hash — what a member is compared against. Covers content AND the headless flag. */
  hash(): string {
    const h = createHash("sha256");
    for (const s of this.list()) h.update(`${s.name}|${s.hash}|${s.headless ? 1 : 0}\n`);
    return h.digest("hex").slice(0, 16);
  }

  /** Names of the skills enabled for unattended (headless) runs. */
  headlessNames(): string[] {
    return this.list()
      .filter((s) => s.headless)
      .map((s) => s.name);
  }

  // ── hub-side writes ──────────────────────────────────────────────────────────

  /** Create or replace an inline skill from SKILL.md text. */
  saveInline(name: string, body: string, headless?: boolean): FleetSkill {
    this.requireHub();
    const text = body.replace(/\r\n/g, "\n");
    if (!text.trim()) throw new Error("SKILL.md is empty");
    return this.put(name, [{ path: "SKILL.md", data: Buffer.from(text.endsWith("\n") ? text : `${text}\n`, "utf8"), mode: 0o644 }], { kind: "inline" }, headless);
  }

  /** Import every skill found under `source` (a git URL or a path on this machine). Returns what landed. */
  async import(source: string, opts: { ref?: string; subdir?: string; headless?: boolean } = {}): Promise<FleetSkill[]> {
    this.requireHub();
    const src = source.trim();
    if (!src) throw new Error("source required");
    if (isGitSource(src)) {
      const url = normalizeGitUrl(src);
      const tmp = await cloneShallow(url, opts.ref?.trim() || undefined);
      try {
        const subdir = opts.subdir?.trim() ? safeRelPath(opts.subdir.trim()) : undefined;
        const base = subdir ? join(tmp, "repo", subdir) : join(tmp, "repo");
        return this.importTree(base, (dir) => {
          const rel = relative(join(tmp, "repo"), dir).split(sep).join("/");
          return { kind: "git", url, ...(opts.ref?.trim() ? { ref: opts.ref.trim() } : {}), ...(rel ? { subdir: rel } : {}) };
        }, opts.headless);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    const expanded = src.startsWith("~") ? join(process.env.HOME ?? "", src.slice(1)) : src;
    const base = resolve(opts.subdir?.trim() ? join(expanded, safeRelPath(opts.subdir.trim())) : expanded);
    if (!existsSync(base) || !statSync(base).isDirectory()) throw new Error(`no such directory on this server: ${base}`);
    return this.importTree(base, (dir) => ({ kind: "local", path: dir }), opts.headless);
  }

  /** Re-pull a git/local skill (or every one, `name` omitted) from its source. Returns the skills whose
   *  content changed. Inline skills have no source and are skipped. */
  async update(name?: string): Promise<{ changed: string[]; errors: string[] }> {
    this.requireHub();
    const targets = name ? [this.get(name)].filter((s): s is FleetSkill => !!s) : this.list();
    if (name && targets.length === 0) throw new Error(`no fleet skill named "${name}"`);
    const changed: string[] = [];
    const errors: string[] = [];
    // One clone per (url, ref) even when a repo contributed many skills.
    const clones = new Map<string, Promise<string>>();
    try {
      for (const s of targets) {
        try {
          let dir: string;
          if (s.source.kind === "git") {
            const key = `${s.source.url}#${s.source.ref ?? ""}`;
            if (!clones.has(key)) clones.set(key, cloneShallow(s.source.url, s.source.ref));
            const tmp = await clones.get(key)!;
            dir = s.source.subdir ? join(tmp, "repo", safeRelPath(s.source.subdir)) : join(tmp, "repo");
          } else if (s.source.kind === "local") {
            dir = s.source.path;
          } else continue;
          if (!existsSync(join(dir, "SKILL.md"))) throw new Error(`SKILL.md no longer exists at the source`);
          const before = s.hash;
          const after = this.put(s.name, readSkillDir(dir), s.source, s.headless);
          if (after.hash !== before) changed.push(s.name);
        } catch (e) {
          errors.push(`${s.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      for (const p of clones.values()) {
        void p.then((tmp) => rmSync(tmp, { recursive: true, force: true })).catch(() => {});
      }
    }
    return { changed, errors };
  }

  remove(name: string): void {
    this.requireHub();
    if (!this.get(name)) throw new Error(`no fleet skill named "${name}"`);
    rmSync(join(this.skillsDir, name), { recursive: true, force: true });
    this.index.skills = this.index.skills.filter((s) => s.name !== name);
    this.save();
  }

  setHeadless(name: string, headless: boolean): FleetSkill {
    this.requireHub();
    const s = this.get(name);
    if (!s) throw new Error(`no fleet skill named "${name}"`);
    s.headless = headless;
    s.updatedAt = Date.now();
    this.save();
    return s;
  }

  // ── replication ──────────────────────────────────────────────────────────────

  /** The whole library as a replica-push payload. */
  bundle(hubServerId: string): rest.skills.Bundle {
    return {
      hubServerId,
      hash: this.hash(),
      skills: this.list().map((meta) => ({
        meta,
        files: readSkillDir(join(this.skillsDir, meta.name)).map((f) => ({ path: f.path, b64: f.data.toString("base64"), ...(f.mode !== 0o644 ? { mode: f.mode } : {}) })),
      })),
    };
  }

  /** Replace this daemon's library wholesale with a hub's push and become (stay) a replica. Every skill is
   *  validated BEFORE anything is touched, and the swap is per-dir rename, so a bad push changes nothing. */
  adoptReplica(bundle: rest.skills.Bundle): void {
    const staged: { meta: FleetSkill; files: SkillFile[] }[] = [];
    const names = new Set<string>();
    for (const s of bundle.skills ?? []) {
      const files = (s.files ?? []).map((f) => ({ path: safeRelPath(f.path), data: Buffer.from(f.b64 ?? "", "base64"), mode: f.mode === 0o755 ? 0o755 : 0o644 }));
      const description = validateFiles(s.meta.name, files);
      if (names.has(s.meta.name)) throw new Error(`duplicate skill "${s.meta.name}" in push`);
      names.add(s.meta.name);
      staged.push({ meta: { ...s.meta, description, hash: hashFiles(files), files: files.length, bytes: files.reduce((n, f) => n + f.data.length, 0) }, files });
    }
    for (const { meta, files } of staged) {
      const existing = this.get(meta.name);
      if (!existing || existing.hash !== meta.hash) this.writeDir(meta.name, files);
    }
    for (const s of this.index.skills) if (!names.has(s.name)) rmSync(join(this.skillsDir, s.name), { recursive: true, force: true });
    this.index = { role: "replica", skills: staged.map((s) => s.meta) };
    this.save();
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private requireHub(): void {
    if (this.index.role === "replica") throw new Error("this server's skill library is managed by its hub — make changes there");
  }

  private importTree(base: string, sourceOf: (dir: string) => FleetSkillSource, headless?: boolean): FleetSkill[] {
    const dirs = discoverSkillDirs(base);
    if (dirs.length === 0) throw new Error("no SKILL.md found (looked at the root, */, skills/*/ and .claude/skills/*/)");
    // Validate everything first so a multi-skill import is all-or-nothing.
    const staged = dirs.map((dir) => {
      const name = basename(dir);
      const files = readSkillDir(dir);
      validateFiles(name, files);
      return { name, files, source: sourceOf(dir) };
    });
    return staged.map((s) => this.put(s.name, s.files, s.source, headless));
  }

  private put(name: string, files: SkillFile[], source: FleetSkillSource, headless?: boolean): FleetSkill {
    const description = validateFiles(name, files);
    const hash = hashFiles(files);
    const existing = this.get(name);
    if (!existing || existing.hash !== hash) this.writeDir(name, files);
    const meta: FleetSkill = {
      name,
      description,
      source,
      headless: headless ?? existing?.headless ?? true,
      hash,
      files: files.length,
      bytes: files.reduce((n, f) => n + f.data.length, 0),
      updatedAt: existing && existing.hash === hash && existing.headless === (headless ?? existing.headless) ? existing.updatedAt : Date.now(),
    };
    this.index.skills = [...this.index.skills.filter((s) => s.name !== name), meta];
    this.save();
    return meta;
  }

  /** Write a skill's files to a staging dir, then swap it into place. */
  private writeDir(name: string, files: SkillFile[]): void {
    assertSkillName(name);
    const final = join(this.skillsDir, name);
    const staging = join(this.root, `.staging-${name}-${process.pid}-${Date.now()}`);
    rmSync(staging, { recursive: true, force: true });
    for (const f of files) {
      const abs = join(staging, safeRelPath(f.path));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.data, { mode: f.mode });
    }
    const old = `${final}.old-${process.pid}-${Date.now()}`;
    if (existsSync(final) || isSymlink(final)) renameSync(final, old);
    renameSync(staging, final);
    rmSync(old, { recursive: true, force: true });
  }

  private load(): void {
    if (!existsSync(this.indexFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.indexFile, "utf8")) as Partial<Index>;
      this.index = {
        role: raw.role === "replica" ? "replica" : "hub",
        // Drop index entries whose files vanished (hand-deleted) so we never advertise a ghost skill.
        skills: (raw.skills ?? []).filter((s) => SKILL_NAME_RE.test(s.name) && existsSync(join(this.skillsDir, s.name, "SKILL.md"))),
      };
    } catch {
      this.index = { role: "hub", skills: [] }; // corrupt index — start empty rather than crash boot
    }
  }

  private save(): void {
    writeFileAtomic(this.indexFile, JSON.stringify(this.index, null, 2));
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
