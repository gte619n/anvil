import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeRepoTool, REPO_TOOLS } from "../../src/integrations/repo-tools";

// The repo tools are executed by the daemon on an OpenRouter model's behalf, so the safety properties
// (confined to repoRoot, read-only, error-not-throw) are load-bearing. These exercise the executor
// directly against a throwaway git repo.

let repo: string;
let outside: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "anvil-repo-"));
  outside = mkdtempSync(join(tmpdir(), "anvil-outside-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "widget.ts"), "export const answer = 42; // the ANSWER token\n");
  writeFileSync(join(repo, "README.md"), "# Demo\n");
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
  // git grep searches tracked files → init + add so the fixture is grep-able.
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  Bun.spawnSync(["git", "add", "-A"], { cwd: repo });
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("REPO_TOOLS advertises exactly the read-only trio", () => {
  expect(REPO_TOOLS.map((t) => t.function.name).sort()).toEqual(["grep", "list_dir", "read_file"]);
});

test("read_file returns file contents within the repo", async () => {
  const out = await executeRepoTool(repo, "read_file", JSON.stringify({ path: "src/widget.ts" }));
  expect(out).toContain("answer = 42");
});

test("list_dir lists entries and marks subdirectories", async () => {
  const out = await executeRepoTool(repo, "list_dir", JSON.stringify({ path: "." }));
  expect(out).toContain("src/");
  expect(out).toContain("README.md");
});

test("grep finds a tracked match with a file:line prefix", async () => {
  const out = await executeRepoTool(repo, "grep", JSON.stringify({ pattern: "ANSWER" }));
  expect(out).toContain("src/widget.ts:1");
});

test("grep on a pattern with no matches says so (not an error)", async () => {
  const out = await executeRepoTool(repo, "grep", JSON.stringify({ pattern: "zzz_no_such_token" }));
  expect(out).toBe("no matches.");
});

test("a path escaping the repo is refused, not read (relative traversal)", async () => {
  const out = await executeRepoTool(repo, "read_file", JSON.stringify({ path: "../../etc/passwd" }));
  expect(out).toMatch(/escapes the repository|not a file/);
  expect(out).not.toContain("root:");
});

test("an absolute path is refused", async () => {
  const out = await executeRepoTool(repo, "read_file", JSON.stringify({ path: join(outside, "secret.txt") }));
  expect(out).toContain("must be repo-relative");
  expect(out).not.toContain("TOP SECRET");
});

test("a symlink pointing outside the repo is refused", async () => {
  symlinkSync(join(outside, "secret.txt"), join(repo, "leak"));
  const out = await executeRepoTool(repo, "read_file", JSON.stringify({ path: "leak" }));
  expect(out).toMatch(/escapes the repository/);
  expect(out).not.toContain("TOP SECRET");
});

test("unknown tool and unparseable args return error strings, never throw", async () => {
  expect(await executeRepoTool(repo, "rm_rf", "{}")).toContain("unknown tool");
  expect(await executeRepoTool(repo, "read_file", "{not json")).toContain("could not parse");
});
