import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../../src/auth/accounts";
import { seedFromEnv } from "../../src/auth/account-mirror";
import { CLAUDE_TOKEN_KEY } from "../../src/auth/store";

const ORIGINAL = process.env[CLAUDE_TOKEN_KEY];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[CLAUDE_TOKEN_KEY];
  else process.env[CLAUDE_TOKEN_KEY] = ORIGINAL;
});

const dir = (): string => mkdtempSync(join(tmpdir(), "anvil-seed-"));

test("seeds an existing env token as the 'default' account", () => {
  const s = new AccountStore(dir());
  expect(seedFromEnv(s, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-existingtoken-1111" })).toBe(true);
  expect(s.list()).toHaveLength(1);
  expect(s.list()[0]!.label).toBe("default");
  expect(s.token(undefined)).toBe("sk-ant-oat01-existingtoken-1111");
});

test("is idempotent — a populated roster is never re-seeded", () => {
  const d = dir();
  const s1 = new AccountStore(d);
  seedFromEnv(s1, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-existingtoken-1111" });
  const s2 = new AccountStore(d);
  expect(seedFromEnv(s2, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-differentone-2222" })).toBe(false);
  expect(s2.list()).toHaveLength(1);
  expect(s2.token(undefined)).toBe("sk-ant-oat01-existingtoken-1111");
});

test("no env token → nothing seeded, no throw (a fresh headless box)", () => {
  const s = new AccountStore(dir());
  expect(seedFromEnv(s, {})).toBe(false);
  expect(s.list()).toEqual([]);
});

test("never seeds a metered key", () => {
  const s = new AccountStore(dir());
  expect(seedFromEnv(s, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-api03-leak" })).toBe(false);
  expect(s.list()).toEqual([]);
});

test("never seeds into a replica", () => {
  const s = new AccountStore(dir());
  s.adoptReplica({ rev: 3, defaultId: "acct_x", entries: [{ id: "acct_x", label: "work", token: "sk-ant-oat01-pushed-9999", createdAt: 1 }] });
  expect(seedFromEnv(s, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-local-1111" })).toBe(false);
  expect(s.list()).toHaveLength(1);
});
