/**
 * [BE-6] captureGitDiff spawned git subprocesses and read their stdout but never awaited `exited`,
 * leaking zombie processes across the nightly autopilot fan-out. This pins the happy path (so the
 * reap can't change behaviour) and the aborted-signal path (no hang).
 */
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureGitDiff } from "../../src/pipeline/adapters";

function repoWithTwoCommits(): string {
  const dir = mkdtempSync(join(tmpdir(), "anvil-diff-"));
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir });
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "first"]);
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "second"]);
  return dir;
}

test("captureGitDiff returns the HEAD short sha and a diffstat summary", async () => {
  const dir = repoWithTwoCommits();
  const out = await captureGitDiff(dir, undefined as unknown as AbortSignal);
  expect(out).toMatch(/^[0-9a-f]{7,}/); // short sha prefix
  expect(out).toMatch(/changed|insertion/); // the diffstat summary line is appended
});

test("captureGitDiff with an already-aborted signal resolves without hanging", async () => {
  const dir = repoWithTwoCommits();
  const ac = new AbortController();
  ac.abort();
  // Must settle (not hang); output is best-effort when the spawn was killed.
  const out = await captureGitDiff(dir, ac.signal);
  expect(typeof out).toBe("string");
});
