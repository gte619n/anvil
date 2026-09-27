import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoOp } from "../../src/fleet/repo-access";

// The read-only repo ops behind the fleet concierge (anvil-fleet-concierge): what a member serves
// the hub via /api/fleet/repo, and what the concierge's repo_* tools run for local environments.
// The security property under test: NOTHING outside the environment's repoRoot is reachable — not
// via `..`, not via an absolute path, and not via an in-tree symlink pointing out of the tree.

let root: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "anvil-repoaccess-"));
  outside = mkdtempSync(join(tmpdir(), "anvil-repoaccess-outside-"));
  writeFileSync(join(root, "a.txt"), "hello needle\nworld\n");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "b.txt"), "needle in sub\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
  writeFileSync(join(root, "big.txt"), "x".repeat(300 * 1024));
  writeFileSync(join(outside, "secret.txt"), "top secret\n");
  symlinkSync(outside, join(root, "link")); // in-tree symlink escaping the root
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("list: returns entries with kinds; no path = repo root", async () => {
  const r = await repoOp(root, { op: "list" });
  expect(r.ok).toBe(true);
  const byName = new Map(r.entries!.map((e) => [e.name, e]));
  expect(byName.get("a.txt")?.kind).toBe("file");
  expect(byName.get("a.txt")?.size).toBeGreaterThan(0);
  expect(byName.get("sub")?.kind).toBe("dir");
  expect(byName.get("link")?.kind).toBe("symlink");
});

test("read: returns file text", async () => {
  const r = await repoOp(root, { op: "read", path: "sub/b.txt" });
  expect(r.ok).toBe(true);
  expect(r.text).toBe("needle in sub\n");
});

test("read: caps oversized files and flags truncation", async () => {
  const r = await repoOp(root, { op: "read", path: "big.txt" });
  expect(r.ok).toBe(true);
  expect(r.truncated).toBe(true);
  expect(r.text!.length).toBe(256 * 1024);
});

test("read: refuses binary files", async () => {
  const r = await repoOp(root, { op: "read", path: "bin.dat" });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("binary");
});

test("read: missing file reports, never throws", async () => {
  const r = await repoOp(root, { op: "read", path: "nope.txt" });
  expect(r.ok).toBe(false);
});

test("escape: `..` walks, absolute paths, and out-of-tree symlinks are all refused", async () => {
  for (const path of ["../", "../../etc/hosts", "/etc/hosts", "sub/../../x", "link/secret.txt", "link"]) {
    for (const op of ["list", "read"] as const) {
      const r = await repoOp(root, { op, path });
      expect(r.ok).toBe(false);
    }
  }
  // And none of them leaked the outside file's content anywhere.
  const viaLink = await repoOp(root, { op: "read", path: "link/secret.txt" });
  expect(JSON.stringify(viaLink)).not.toContain("top secret");
});

test("grep: finds matches with file:line prefixes (non-repo → system-grep fallback)", async () => {
  const r = await repoOp(root, { op: "grep", pattern: "needle" });
  expect(r.ok).toBe(true);
  expect(r.matches!.some((l) => l.includes("a.txt:1:") && l.includes("hello needle"))).toBe(true);
  expect(r.matches!.some((l) => l.includes("b.txt:1:"))).toBe(true);
});

test("grep: scopes to a subtree and reports clean no-match", async () => {
  const scoped = await repoOp(root, { op: "grep", pattern: "needle", path: "sub" });
  expect(scoped.ok).toBe(true);
  expect(scoped.matches!.length).toBe(1);
  const none = await repoOp(root, { op: "grep", pattern: "zebra-unicorn-9000" });
  expect(none.ok).toBe(true);
  expect(none.matches).toEqual([]);
});

test("grep: requires a pattern; escape paths refused", async () => {
  expect((await repoOp(root, { op: "grep" })).ok).toBe(false);
  expect((await repoOp(root, { op: "grep", pattern: "x", path: "../" })).ok).toBe(false);
});

test("a vanished repoRoot reports instead of throwing", async () => {
  const r = await repoOp(join(root, "not-there"), { op: "list" });
  expect(r.ok).toBe(false);
});
