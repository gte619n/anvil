import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAuth } from "../../src/auth/guard";
import { AccountStore, resolveAuthStatus } from "../../src/auth/accounts";

test("ok with only the OAuth token", () => {
  expect(checkAuth({ CLAUDE_CODE_OAUTH_TOKEN: "tok" }).subscriptionAuthOk).toBe(true);
});

test("fails when ANTHROPIC_API_KEY is also set (would meter billing)", () => {
  const s = checkAuth({ CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "sk-…" });
  expect(s.subscriptionAuthOk).toBe(false);
  expect(s.reason).toContain("ANTHROPIC_API_KEY");
});

test("fails when ANTHROPIC_AUTH_TOKEN is set (outranks OAuth)", () => {
  const s = checkAuth({ CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_AUTH_TOKEN: "x" });
  expect(s.subscriptionAuthOk).toBe(false);
});

test("fails when the OAuth token is absent", () => {
  expect(checkAuth({}).subscriptionAuthOk).toBe(false);
});

test("treats a whitespace-only token as unset", () => {
  expect(checkAuth({ CLAUDE_CODE_OAUTH_TOKEN: "   " }).subscriptionAuthOk).toBe(false);
});

test("health reports authed when the roster has an account but the env line was lost", () => {
  const store = new AccountStore(mkdtempSync(join(tmpdir(), "anvil-guard-")));
  store.add("work", "sk-ant-oat01-workworkwork-1111");
  const status = resolveAuthStatus({ env: {}, accounts: store });
  expect(status.subscriptionAuthOk).toBe(true);
  expect(status.fatal).toBe(false);
});

test("a metered key is still fatal regardless of the roster", () => {
  const store = new AccountStore(mkdtempSync(join(tmpdir(), "anvil-guard-")));
  store.add("work", "sk-ant-oat01-workworkwork-1111");
  const status = resolveAuthStatus({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-x" }, accounts: store });
  expect(status.fatal).toBe(true);
});

test("an empty roster and no env token is still non-fatal (degraded boot, HJ §4.1)", () => {
  const store = new AccountStore(mkdtempSync(join(tmpdir(), "anvil-guard-")));
  const status = resolveAuthStatus({ env: {}, accounts: store });
  expect(status.subscriptionAuthOk).toBe(false);
  expect(status.fatal).toBe(false);
});
