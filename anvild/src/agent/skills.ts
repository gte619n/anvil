/**
 * Skill discovery for interactive sessions (§skills).
 *
 * Two jobs, both deliberately narrow so the daemon stays the permission authority (arch §6.6):
 *
 *  1. `skillPlugins()` — makes the user's own `~/.claude/skills` and the project's `.claude/skills`
 *     available to a session WITHOUT enabling `settingSources`. We hand the SDK the `plugins` option
 *     pointing at *synthesized, skills-only* plugin dirs (a `.claude-plugin/plugin.json` + a `skills`
 *     symlink). Pointing a plugin straight at `~/.claude` would also auto-discover `agents/`, `hooks/`,
 *     and `.mcp.json`; the synthesized wrapper exposes skills and nothing else. Crucially, the `plugins`
 *     option does NOT load `settings.json` permission allow-rules, so `settingSources: []` stays intact.
 *
 *  2. `buildCommandInfo()` — turns the SDK `init` message's `slash_commands` into the `CommandInfo[]`
 *     the composer's `/` autocomplete renders, enriching each with its SKILL.md one-line description.
 *
 * Everything here is best-effort: any filesystem hiccup degrades to "no custom skills"/"no description"
 * rather than throwing into a session start.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandInfo } from "@protocol";

/** A local plugin dir handed to the SDK's `plugins` option. Structurally matches `SdkPluginConfig`. */
export interface LocalPlugin {
  type: "local";
  path: string;
}

type SkillSourceName = "user" | "project";
interface SkillSource {
  name: SkillSourceName;
  skillsDir: string;
}

/** `~/.claude/skills` — the user's personal skills. */
function userSkillsDir(): string {
  return join(homedir(), ".claude", "skills");
}

/** The nearest `.claude/skills` at or above `cwd`, not climbing past a repo boundary (`.git`). Mirrors
 *  how Claude Code discovers project skills up to the repo root. Undefined when there are none. */
function projectSkillsDir(cwd: string): string | undefined {
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, ".claude", "skills");
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, ".git"))) return undefined; // reached the repo root, no project skills
    const parent = dirname(dir);
    if (parent === dir) return undefined; // filesystem root
    dir = parent;
  }
}

/** The ambient skill sources for a session, de-duplicated (a home-dir cwd can alias user↔project). */
function skillSources(cwd: string): SkillSource[] {
  const sources: SkillSource[] = [];
  const user = userSkillsDir();
  if (existsSync(user)) sources.push({ name: "user", skillsDir: user });
  const project = projectSkillsDir(cwd);
  if (project && project !== user) sources.push({ name: "project", skillsDir: project });
  return sources;
}

/** Build (or refresh) a skills-only plugin wrapper under the daemon state dir. Returns its path, or
 *  undefined if the wrapper couldn't be created (skills are best-effort — never fail a session start). */
function synthPluginDir(stateDir: string, sessionId: string, src: SkillSource): string | undefined {
  try {
    const root = join(stateDir, "skill-plugins", sessionId, src.name);
    const manifestDir = join(root, ".claude-plugin");
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, "plugin.json"), JSON.stringify({ name: src.name, version: "0.0.0" }));
    const link = join(root, "skills");
    rmSync(link, { force: true }); // re-point on every start so it can't go stale
    symlinkSync(src.skillsDir, link, "dir");
    return root;
  } catch {
    return undefined;
  }
}

/**
 * The `plugins` list for a session's SDK query — skills-only wrappers around the user + project skill
 * dirs. Empty when neither exists. Keep `settingSources: []` alongside this: skills load, on-disk
 * permission rules do not.
 */
export function skillPlugins(opts: { cwd: string; sessionId: string; stateDir: string }): LocalPlugin[] {
  const plugins: LocalPlugin[] = [];
  for (const src of skillSources(opts.cwd)) {
    const root = synthPluginDir(opts.stateDir, opts.sessionId, src);
    if (root) plugins.push({ type: "local", path: root });
  }
  return plugins;
}

/** Minimal SKILL.md frontmatter reader (no YAML dep): pulls single-line `name:`/`description:`. */
function frontmatter(file: string): { name?: string; description?: string } | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  if (!text.startsWith("---")) return undefined;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return undefined;
  const out: { name?: string; description?: string } = {};
  for (const raw of text.slice(3, end).split("\n")) {
    const m = /^(name|description):\s*(.*)$/.exec(raw.trim());
    if (m) out[m[1] as "name" | "description"] = (m[2] ?? "").replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

/** The one-line description for a skill in `skillsDir`, matched by directory name first, then by the
 *  `name:` frontmatter field (the namespaced command can use either). Undefined if not found. */
function skillDescription(skillsDir: string, skill: string): string | undefined {
  const direct = frontmatter(join(skillsDir, skill, "SKILL.md"));
  if (direct?.description) return direct.description;
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fm = frontmatter(join(skillsDir, entry.name, "SKILL.md"));
      if (fm?.name === skill && fm.description) return fm.description;
    }
  } catch {
    /* dir vanished — fall through to no description */
  }
  return undefined;
}

/**
 * Blurbs for the built-in commands anvil cares to explain in the `/` menu. The two context controls are
 * daemon-handled (§context): `/clear` routes to a fresh topic; `/compact` is forwarded to the SDK to
 * summarize the window. We inject them if the SDK didn't already list them, so the menu always offers
 * them. Other built-ins stay description-less (the SDK doesn't hand us blurbs for them).
 */
const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  clear: "Start a fresh topic — Claude forgets the conversation above; your visible history stays",
  compact: "Summarize the conversation so far to free up the context window, then continue",
};

/**
 * Map the SDK `init` message's `slash_commands` to the composer's `CommandInfo[]`. Plugin skills come
 * namespaced (`user:foo` / `project:bar`) — we split the namespace to tag the source and look up the
 * SKILL.md description; everything else (built-in commands + skills) is reported bare as "builtin",
 * enriched with a blurb when we have one. The context controls are guaranteed present (§context).
 */
export function buildCommandInfo(slashCommands: readonly string[], cwd: string): CommandInfo[] {
  const dirs: Record<SkillSourceName, string | undefined> = {
    user: existsSync(userSkillsDir()) ? userSkillsDir() : undefined,
    project: projectSkillsDir(cwd),
  };
  const out: CommandInfo[] = slashCommands.map((name) => {
    const colon = name.indexOf(":");
    const ns = colon > 0 ? name.slice(0, colon) : "";
    if ((ns === "user" || ns === "project") && dirs[ns]) {
      const description = skillDescription(dirs[ns]!, name.slice(colon + 1));
      return description ? { name, description, source: ns } : { name, source: ns };
    }
    const description = BUILTIN_DESCRIPTIONS[name];
    return description ? { name, description, source: "builtin" as const } : { name, source: "builtin" as const };
  });
  const have = new Set(out.map((c) => c.name));
  for (const name of ["clear", "compact"]) {
    if (!have.has(name)) out.unshift({ name, description: BUILTIN_DESCRIPTIONS[name], source: "builtin" });
  }
  return out;
}
