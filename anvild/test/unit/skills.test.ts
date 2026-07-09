import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommandInfo, skillPlugins } from "../../src/agent/skills";

/** Lay down a `<root>/.claude/skills/<name>/SKILL.md` with the given frontmatter description. */
function writeSkill(root: string, name: string, description: string): void {
  const dir = join(root, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`);
}

test("buildCommandInfo tags built-ins and enriches project skills with descriptions", () => {
  const repo = mkdtempSync(join(tmpdir(), "anvil-skills-"));
  mkdirSync(join(repo, ".git")); // mark the repo root so project discovery stops here
  writeSkill(repo, "deploy-thing", "Deploys the thing to prod");

  const cmds = buildCommandInfo(["compact", "context", "project:deploy-thing"], repo);

  expect(cmds).toContainEqual({ name: "compact", source: "builtin" });
  expect(cmds).toContainEqual({
    name: "project:deploy-thing",
    source: "project",
    description: "Deploys the thing to prod",
  });
});

test("buildCommandInfo keeps a namespaced skill even when its SKILL.md is missing (no description)", () => {
  const repo = mkdtempSync(join(tmpdir(), "anvil-skills-"));
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, ".claude", "skills"), { recursive: true }); // dir exists, skill does not

  const cmds = buildCommandInfo(["project:ghost"], repo);
  expect(cmds).toEqual([{ name: "project:ghost", source: "project" }]);
});

test("skillPlugins synthesizes a skills-only plugin dir pointing at the project skills", () => {
  const repo = mkdtempSync(join(tmpdir(), "anvil-skills-"));
  const state = mkdtempSync(join(tmpdir(), "anvil-state-"));
  mkdirSync(join(repo, ".git"));
  writeSkill(repo, "foo", "does foo");

  const plugins = skillPlugins({ cwd: repo, sessionId: "sess_1", stateDir: state });
  const project = plugins.find((p) => p.path.endsWith(join("sess_1", "project")));
  expect(project).toBeDefined();

  // Manifest names the plugin "project" (→ skills namespace as `project:foo`).
  const manifest = JSON.parse(readFileSync(join(project!.path, ".claude-plugin", "plugin.json"), "utf8"));
  expect(manifest.name).toBe("project");

  // `skills` is a symlink to the real project skills dir — skills only, nothing else auto-discovered.
  const link = join(project!.path, "skills");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(realpathSync(link)).toBe(realpathSync(join(repo, ".claude", "skills")));
});

test("skillPlugins returns nothing when there are no skill dirs", () => {
  const repo = mkdtempSync(join(tmpdir(), "anvil-skills-"));
  const state = mkdtempSync(join(tmpdir(), "anvil-state-"));
  mkdirSync(join(repo, ".git")); // repo root, but no .claude/skills
  // Only the (possibly-present) user ~/.claude/skills could contribute; the project side is empty.
  const plugins = skillPlugins({ cwd: repo, sessionId: "sess_2", stateDir: state });
  expect(plugins.every((p) => !p.path.endsWith(join("sess_2", "project")))).toBe(true);
});
