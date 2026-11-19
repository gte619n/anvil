/**
 * Fleet skill library (docs/plans/2026-11-19-fleet-skills.md): the store (inline/local/git import,
 * update, validation), replication (bundle → adoptReplica), and how the library reaches agents
 * (the `fleet` session plugin, the headless plugin for unattended runs, `/` menu descriptions).
 */
import { test, expect, afterEach } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetSkillStore, isGitSource, normalizeGitUrl, parseFrontmatter } from "../../src/skills/fleet-store";
import { buildCommandInfo, headlessSkillOptions, refreshHeadlessSkills, skillPlugins } from "../../src/agent/skills";
import { runAgentQuery } from "../../src/agent/query";
import { CLAUDE } from "../../src/agent/model-roster";
import { gitSpawn } from "../../src/git/spawn";

const dirs: string[] = [];
function tmp(prefix = "anvil-fleet-skills-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  refreshHeadlessSkills({ stateDir: "/nonexistent", fleetSkillsDir: "/nonexistent", names: [] });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const md = (name: string, description: string, body = "Do the thing.") => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

function writeSkillDir(root: string, name: string, description: string, extra: Record<string, string> = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), md(name, description));
  for (const [p, c] of Object.entries(extra)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

// ── store ────────────────────────────────────────────────────────────────────

test("saveInline stores a skill, reports it, and changes the library hash", () => {
  const store = new FleetSkillStore(tmp());
  const h0 = store.hash();
  const s = store.saveInline("release-notes", md("release-notes", "Write release notes from git log"));
  expect(s).toMatchObject({ name: "release-notes", description: "Write release notes from git log", source: { kind: "inline" }, headless: true, files: 1 });
  expect(readFileSync(join(store.skillsDir, "release-notes", "SKILL.md"), "utf8")).toContain("Do the thing.");
  expect(store.hash()).not.toBe(h0);
  // Flipping the headless flag alone is a library change members must receive.
  const h1 = store.hash();
  store.setHeadless("release-notes", false);
  expect(store.hash()).not.toBe(h1);
  expect(store.headlessNames()).toEqual([]);
});

test("saveInline rejects bad names and a SKILL.md without a description", () => {
  const store = new FleetSkillStore(tmp());
  expect(() => store.saveInline("../evil", md("x", "y"))).toThrow(/invalid skill name/);
  expect(() => store.saveInline("ok", "no frontmatter here")).toThrow(/description/);
  expect(store.list()).toEqual([]);
});

test("import from a local dir picks up every skill, with supporting files, skipping dotfiles + symlinks", async () => {
  const src = tmp("anvil-skill-src-");
  writeSkillDir(join(src, "skills"), "alpha", "Alpha skill", { "scripts/run.sh": "echo hi\n", "reference/notes.md": "notes" });
  writeSkillDir(join(src, "skills"), "beta", "Beta skill");
  writeFileSync(join(src, "skills", "alpha", ".DS_Store"), "junk");
  symlinkSync("/etc/hosts", join(src, "skills", "alpha", "leak"));

  const store = new FleetSkillStore(tmp());
  const got = await store.import(src);
  expect(got.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
  const alpha = join(store.skillsDir, "alpha");
  expect(readFileSync(join(alpha, "scripts", "run.sh"), "utf8")).toBe("echo hi\n");
  expect(existsSync(join(alpha, "reference", "notes.md"))).toBe(true);
  expect(existsSync(join(alpha, ".DS_Store"))).toBe(false);
  expect(existsSync(join(alpha, "leak"))).toBe(false);
  expect(store.get("alpha")?.source).toEqual({ kind: "local", path: join(src, "skills", "alpha") });
});

test("a multi-skill import is all-or-nothing when one skill is invalid", async () => {
  const src = tmp("anvil-skill-src-");
  writeSkillDir(src, "good", "Fine");
  mkdirSync(join(src, "bad"));
  writeFileSync(join(src, "bad", "SKILL.md"), "no frontmatter");
  const store = new FleetSkillStore(tmp());
  await expect(store.import(src)).rejects.toThrow(/description/);
  expect(store.list()).toEqual([]);
});

test("import from git clones the repo, and update re-pulls changed content", async () => {
  const repo = tmp("anvil-skill-repo-");
  const git = (...args: string[]) => {
    const r = gitSpawn(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], repo);
    if (r.code !== 0) throw new Error(r.stderr);
  };
  git("init", "-q", "-b", "main");
  writeSkillDir(join(repo, "skills"), "deploy", "Deploy v1");
  git("add", "-A");
  git("commit", "-qm", "v1");

  const store = new FleetSkillStore(tmp());
  const [s] = await store.import(`file://${repo}`);
  expect(s).toMatchObject({ name: "deploy", description: "Deploy v1", source: { kind: "git", url: `file://${repo}`, subdir: "skills/deploy" } });

  writeFileSync(join(repo, "skills", "deploy", "SKILL.md"), md("deploy", "Deploy v2"));
  git("commit", "-qam", "v2");
  const r = await store.update();
  expect(r).toEqual({ changed: ["deploy"], errors: [] });
  expect(store.get("deploy")?.description).toBe("Deploy v2");
  expect(await store.update("deploy")).toEqual({ changed: [], errors: [] }); // nothing new
});

test("git source detection + GitHub shorthand", () => {
  expect(isGitSource("vercel-labs/agent-skills")).toBe(true);
  expect(isGitSource("https://github.com/a/b.git")).toBe(true);
  expect(isGitSource("git@github.com:a/b.git")).toBe(true);
  expect(isGitSource("/Users/me/.claude/skills/foo")).toBe(false);
  expect(isGitSource("~/.claude/skills")).toBe(false);
  expect(normalizeGitUrl("vercel-labs/agent-skills")).toBe("https://github.com/vercel-labs/agent-skills.git");
});

// ── replication ──────────────────────────────────────────────────────────────

test("a replica adopts the hub's bundle exactly, becomes read-only, and survives a restart", () => {
  const hub = new FleetSkillStore(tmp());
  hub.saveInline("one", md("one", "First"));
  hub.saveInline("two", md("two", "Second"), false);

  const memberDir = tmp();
  const member = new FleetSkillStore(memberDir);
  member.saveInline("local-only", md("local-only", "Will be replaced"));
  member.adoptReplica(hub.bundle("srv_hub"));

  expect(member.role()).toBe("replica");
  expect(member.hash()).toBe(hub.hash());
  expect(member.list().map((s) => s.name)).toEqual(["one", "two"]);
  expect(member.headlessNames()).toEqual(["one"]);
  expect(existsSync(join(member.skillsDir, "local-only"))).toBe(false);
  expect(() => member.saveInline("x", md("x", "y"))).toThrow(/hub/);

  const reloaded = new FleetSkillStore(memberDir);
  expect(reloaded.role()).toBe("replica");
  expect(reloaded.hash()).toBe(hub.hash());

  // A later push that drops a skill removes it on the member.
  hub.remove("two");
  reloaded.adoptReplica(hub.bundle("srv_hub"));
  expect(reloaded.list().map((s) => s.name)).toEqual(["one"]);
  expect(existsSync(join(reloaded.skillsDir, "two"))).toBe(false);
});

test("a malicious bundle (path traversal) is rejected and changes nothing", () => {
  const hub = new FleetSkillStore(tmp());
  hub.saveInline("one", md("one", "First"));
  const member = new FleetSkillStore(tmp());
  member.adoptReplica(hub.bundle("srv_hub"));
  const before = member.hash();

  const evil = hub.bundle("srv_hub");
  evil.skills[0]!.files.push({ path: "../../escape.txt", b64: Buffer.from("x").toString("base64") });
  expect(() => member.adoptReplica(evil)).toThrow(/unsafe path/);
  expect(member.hash()).toBe(before);
  expect(existsSync(join(member.root, "..", "escape.txt"))).toBe(false);
});

// ── reaching agents ──────────────────────────────────────────────────────────

test("sessions get a `fleet` plugin over the library", () => {
  const state = tmp();
  const store = new FleetSkillStore(state);
  store.saveInline("lint-fix", md("lint-fix", "Fix lint"));
  const repo = tmp();
  mkdirSync(join(repo, ".git"));

  const plugins = skillPlugins({ cwd: repo, sessionId: "sess_1", stateDir: state, fleetSkillsDir: store.skillsDir });
  const fleet = plugins.find((p) => p.path.endsWith(join("sess_1", "fleet")));
  expect(fleet).toBeDefined();
  expect(JSON.parse(readFileSync(join(fleet!.path, ".claude-plugin", "plugin.json"), "utf8")).name).toBe("fleet");
  expect(realpathSync(join(fleet!.path, "skills"))).toBe(realpathSync(store.skillsDir));
});

test("an empty library adds no fleet plugin", () => {
  const state = tmp();
  const store = new FleetSkillStore(state);
  const repo = tmp();
  mkdirSync(join(repo, ".git"));
  const plugins = skillPlugins({ cwd: repo, sessionId: "s", stateDir: state, fleetSkillsDir: store.skillsDir });
  expect(plugins.some((p) => p.path.endsWith("fleet"))).toBe(false);
});

test("the headless plugin exposes only headless-flagged skills, and reaches runAgentQuery", async () => {
  const state = tmp();
  const store = new FleetSkillStore(state);
  store.saveInline("on", md("on", "Headless on"));
  store.saveInline("off", md("off", "Headless off"), false);

  expect(headlessSkillOptions()).toEqual({});
  refreshHeadlessSkills({ stateDir: state, fleetSkillsDir: store.skillsDir, names: store.headlessNames() });
  const opts = headlessSkillOptions();
  expect(opts.skills).toBe("all");
  const skillsDir = join(opts.plugins![0]!.path, "skills");
  expect(readdirSync(skillsDir)).toEqual(["on"]);
  expect(lstatSync(join(skillsDir, "on")).isSymbolicLink()).toBe(true);

  const prevTok = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
  let seen: Record<string, unknown> = {};
  try {
    await runAgentQuery("hi", {
      model: CLAUDE,
      queryFn: ({ options }) => {
        seen = options;
        return (async function* () {
          yield { type: "result", result: "ok" };
        })();
      },
    });
  } finally {
    if (prevTok === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevTok;
  }
  expect(seen.plugins).toEqual(opts.plugins);
  expect(seen.skills).toBe("all");
  expect(seen.settingSources).toEqual([]); // still no ambient settings / permission rules
});

test("buildCommandInfo tags fleet skills and reads their description", () => {
  const store = new FleetSkillStore(tmp());
  store.saveInline("triage", md("triage", "Triage a bug report"));
  const cmds = buildCommandInfo(["fleet:triage"], "/tmp", store.skillsDir);
  expect(cmds).toContainEqual({ name: "fleet:triage", source: "fleet", description: "Triage a bug report" });
});

test("frontmatter descriptions written as YAML block scalars are folded to one line", () => {
  expect(parseFrontmatter("---\nname: ponytail\ndescription: >\n  Lazy senior dev mode:\n  the smallest change.\nlicense: MIT\n---\nbody")).toEqual({
    name: "ponytail",
    description: "Lazy senior dev mode: the smallest change.",
  });
  expect(parseFrontmatter('---\ndescription: |-\n  one\n  two\n---\n')?.description).toBe("one two");
  expect(parseFrontmatter('---\ndescription: "quoted: value"\n---\n')?.description).toBe("quoted: value");
});
