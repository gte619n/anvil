import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../../src/auth/accounts";

function tmpStore(): AccountStore {
  return new AccountStore(mkdtempSync(join(tmpdir(), "anvil-accounts-")));
}

test("starts empty at rev 0", () => {
  const s = tmpStore();
  expect(s.list()).toEqual([]);
  expect(s.snapshot().rev).toBe(0);
  expect(s.defaultId()).toBeUndefined();
});

test("add returns a stable acct_ id, marks the first account default, bumps rev", () => {
  const s = tmpStore();
  const a = s.add("work", "sk-ant-oat01-workworkwork-1111");
  expect(a.id).toMatch(/^acct_/);
  expect(a.label).toBe("work");
  expect(s.defaultId()).toBe(a.id);
  expect(s.snapshot().rev).toBe(1);

  const b = s.add("personal", "sk-ant-oat01-personalpers-2222");
  expect(s.defaultId()).toBe(a.id); // the second account does NOT steal default
  expect(s.snapshot().rev).toBe(2);
  expect(s.list().map((x) => x.label)).toEqual(["work", "personal"]);
});

test("token() resolves by id and falls back to the default", () => {
  const s = tmpStore();
  const a = s.add("work", "sk-ant-oat01-workworkwork-1111");
  const b = s.add("personal", "sk-ant-oat01-personalpers-2222");
  expect(s.token(b.id)).toBe("sk-ant-oat01-personalpers-2222");
  expect(s.token(undefined)).toBe("sk-ant-oat01-workworkwork-1111");
  expect(s.token("acct_nope")).toBeUndefined(); // absent is NOT a silent fallback — caller decides
  expect(s.has(a.id)).toBe(true);
  expect(s.has("acct_nope")).toBe(false);
});

test("rename and replace keep the id and bump rev", () => {
  const s = tmpStore();
  const a = s.add("work", "sk-ant-oat01-workworkwork-1111");
  s.rename(a.id, "day job");
  expect(s.list()[0]!.label).toBe("day job");
  expect(s.list()[0]!.id).toBe(a.id);
  s.replace(a.id, "sk-ant-oat01-rotatedtoken-3333");
  expect(s.token(a.id)).toBe("sk-ant-oat01-rotatedtoken-3333");
  expect(s.snapshot().rev).toBe(3);
});

test("setDefault moves the marker; remove drops the entry", () => {
  const s = tmpStore();
  const a = s.add("work", "sk-ant-oat01-workworkwork-1111");
  const b = s.add("personal", "sk-ant-oat01-personalpers-2222");
  s.setDefault(b.id);
  expect(s.defaultId()).toBe(b.id);
  s.remove(a.id);
  expect(s.list().map((x) => x.id)).toEqual([b.id]);
});

test("masked() never leaks the raw token", () => {
  const s = tmpStore();
  const a = s.add("work", "sk-ant-oat01-supersecretvalue-1111");
  const pub = s.publicList();
  expect(pub[0]!.masked).toContain("…");
  expect(JSON.stringify(pub)).not.toContain("supersecretvalue");
  expect(pub[0]).not.toHaveProperty("token");
  expect(pub[0]!.id).toBe(a.id);
});

test("persists to <stateDir>/accounts.json at 0600 and reloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-accounts-"));
  const s1 = new AccountStore(dir);
  const a = s1.add("work", "sk-ant-oat01-workworkwork-1111");
  const file = join(dir, "accounts.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, "utf8")).accounts[0].label).toBe("work");

  const s2 = new AccountStore(dir);
  expect(s2.defaultId()).toBe(a.id);
  expect(s2.token(a.id)).toBe("sk-ant-oat01-workworkwork-1111");
  expect(s2.snapshot().rev).toBe(1);
});

test("a corrupt file behaves as empty rather than throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-accounts-"));
  Bun.write(join(dir, "accounts.json"), "{ not json");
  const s = new AccountStore(dir);
  expect(s.list()).toEqual([]);
});

test("replicas refuse local mutation", () => {
  const s = tmpStore();
  s.adoptReplica({ rev: 7, defaultId: "acct_x", entries: [{ id: "acct_x", label: "work", token: "sk-ant-oat01-pushedtoken-9999", createdAt: 1 }] });
  expect(s.snapshot().role).toBe("replica");
  expect(s.snapshot().rev).toBe(7);
  expect(s.token("acct_x")).toBe("sk-ant-oat01-pushedtoken-9999");
  expect(() => s.add("local", "sk-ant-oat01-nope-0000")).toThrow(/replica/i);
});

test("rejects a metered API key on add and on replace (§3)", () => {
  const s = tmpStore();
  expect(() => s.add("bad", "sk-ant-api03-leak")).toThrow(/metered/i);
  const a = s.add("work", "sk-ant-oat01-workworkwork-1111");
  expect(() => s.replace(a.id, "sk-ant-api03-leak")).toThrow(/metered/i);
  expect(s.token(a.id)).toBe("sk-ant-oat01-workworkwork-1111"); // unchanged
});

test("rejects empty and duplicate labels, case-insensitively", () => {
  const s = tmpStore();
  s.add("work", "sk-ant-oat01-workworkwork-1111");
  expect(() => s.add("  ", "sk-ant-oat01-aaaa-1111")).toThrow(/label/i);
  expect(() => s.add("WORK", "sk-ant-oat01-bbbb-2222")).toThrow(/already/i);
  const b = s.add("personal", "sk-ant-oat01-cccc-3333");
  expect(() => s.rename(b.id, "Work")).toThrow(/already/i);
  s.rename(b.id, "personal"); // renaming to its own label is a no-op, not a conflict
});

test("rejects a label over 32 chars and an empty token", () => {
  const s = tmpStore();
  expect(() => s.add("x".repeat(33), "sk-ant-oat01-dddd-4444")).toThrow(/32/);
  expect(() => s.add("ok", "   ")).toThrow(/token/i);
});

test("refuses to remove the last account", () => {
  const s = tmpStore();
  const a = s.add("work", "sk-ant-oat01-workworkwork-1111");
  expect(() => s.remove(a.id)).toThrow(/last account/i);
});

test("labels and tokens are trimmed", () => {
  const s = tmpStore();
  const a = s.add("  work  ", "  sk-ant-oat01-workworkwork-1111  ");
  expect(a.label).toBe("work");
  expect(s.token(a.id)).toBe("sk-ant-oat01-workworkwork-1111");
});

// ── Hardening from the independent E2E pass (2026-07-27) ────────────────────────────────────

test("F3: validation is no longer negative-only — junk is refused, not persisted", () => {
  const s = tmpStore();
  expect(() => s.add("junk", "not-a-real-token")).toThrow(/sk-ant-/);
  expect(() => s.add("junk", "hunter2")).toThrow(/sk-ant-/);
  expect(s.list()).toEqual([]); // nothing persisted, so nothing gets replicated to members either
  s.add("ok", "sk-ant-oat01-realish-1111"); // a plausible token still sails through
  expect(s.list()).toHaveLength(1);
});

test("F6: the same token cannot be added twice under two labels", () => {
  const s = tmpStore();
  s.add("work", "sk-ant-oat01-sametoken-1111");
  expect(() => s.add("work-again", "sk-ant-oat01-sametoken-1111")).toThrow(/already on the roster as "work"/);
  // ...nor smuggled in by rotating a second account onto the first's token.
  const b = s.add("personal", "sk-ant-oat01-different-2222");
  expect(() => s.replace(b.id, "sk-ant-oat01-sametoken-1111")).toThrow(/already on the roster/);
  // Replacing an account with its OWN token is a no-op, not a self-collision.
  expect(() => s.replace(b.id, "sk-ant-oat01-different-2222")).not.toThrow();
});

test("adoptReplica ignores a STALE push rather than moving the member backwards", () => {
  const s = tmpStore();
  s.adoptReplica({ rev: 5, defaultId: "a", entries: [{ id: "a", label: "work", token: "sk-ant-oat01-new-5555", createdAt: 1 }] });
  // A retry of an older rotation lands late — it must not resurrect the old roster.
  expect(s.adoptReplica({ rev: 3, defaultId: "a", entries: [{ id: "a", label: "old", token: "sk-ant-oat01-old-3333", createdAt: 1 }] })).toBe(false);
  expect(s.snapshot().rev).toBe(5);
  expect(s.token("a")).toBe("sk-ant-oat01-new-5555");
  // A newer push still applies.
  expect(s.adoptReplica({ rev: 6, defaultId: "a", entries: [{ id: "a", label: "newer", token: "sk-ant-oat01-newer-6666", createdAt: 1 }] })).toBe(true);
  expect(s.snapshot().rev).toBe(6);
});

test("a dangling defaultId doesn't strand every spawn with 'no token'", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-accounts-"));
  writeFileSync(
    join(dir, "accounts.json"),
    JSON.stringify({ rev: 4, defaultId: "acct_ghost", role: "hub", accounts: [{ id: "acct_real", label: "work", token: "sk-ant-oat01-real-1111", createdAt: 1 }] }),
  );
  const s = new AccountStore(dir);
  expect(s.defaultId()).toBe("acct_real");          // repointed, not left dangling
  expect(s.token(undefined)).toBe("sk-ant-oat01-real-1111");
});

test("a corrupt roster is preserved for recovery, not silently discarded", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-accounts-"));
  writeFileSync(join(dir, "accounts.json"), "{ truncated mid-writ");
  const s = new AccountStore(dir);
  expect(s.list()).toEqual([]);
  expect(readdirSync(dir).some((f) => f.startsWith("accounts.json.corrupt-"))).toBe(true);
});

test("saves are atomic — no .tmp is left behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-accounts-"));
  const s = new AccountStore(dir);
  s.add("work", "sk-ant-oat01-workworkwork-1111");
  expect(existsSync(join(dir, "accounts.json"))).toBe(true);
  expect(existsSync(join(dir, "accounts.json.tmp"))).toBe(false);
});

test("C3: removing the DEFAULT is refused — you must choose a new one first (design §10)", () => {
  const s = tmpStore();
  const work = s.add("work", "sk-ant-oat01-workworkwork-1111"); // first add becomes the default
  const personal = s.add("personal", "sk-ant-oat01-personalpers-2222");
  expect(s.defaultId()).toBe(work.id);

  // Silently repointing the default at accounts[0] would move every default-following session onto
  // a different subscription with no prompt and no badge.
  expect(() => s.remove(work.id)).toThrow(/is the default account/);
  expect(s.list()).toHaveLength(2); // nothing removed
  expect(s.defaultId()).toBe(work.id);

  // Choose first, then it's allowed — and the default is exactly what the user picked.
  s.setDefault(personal.id);
  s.remove(work.id);
  expect(s.list().map((a) => a.label)).toEqual(["personal"]);
  expect(s.defaultId()).toBe(personal.id);
});
