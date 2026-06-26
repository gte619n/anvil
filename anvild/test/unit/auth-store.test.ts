import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_TOKEN_KEY,
  claudeAuthStatus,
  clearClaudeToken,
  loadPersistedClaudeToken,
  looksLikeMeteredKey,
  setClaudeToken,
} from "../../src/auth/store";

// These tests poke process.env[CLAUDE_TOKEN_KEY] via the store; restore it after each so they don't
// leak the daemon's real token state into sibling tests.
const ORIGINAL = process.env[CLAUDE_TOKEN_KEY];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[CLAUDE_TOKEN_KEY];
  else process.env[CLAUDE_TOKEN_KEY] = ORIGINAL;
});

function tmpEnvFile(): string {
  return join(mkdtempSync(join(tmpdir(), "anvil-auth-")), "env");
}

test("rejects a metered API key (the §3 invariant the OAuth token protects)", () => {
  expect(looksLikeMeteredKey("sk-ant-api03-abc")).toBe(true);
  expect(looksLikeMeteredKey("sk-ant-oat01-abc")).toBe(false);
  const file = tmpEnvFile();
  try {
    expect(() => setClaudeToken("sk-ant-api03-leak", file)).toThrow();
    expect(existsSync(file)).toBe(false); // nothing was persisted
  } finally {
    rmSync(file, { force: true });
  }
});

test("set persists to the env file (0600) and applies live; status reflects it", () => {
  const file = tmpEnvFile();
  try {
    const status = setClaudeToken("sk-ant-oat01-secrettoken-1234", file);
    expect(status.connected).toBe(true);
    expect(status.persisted).toBe(true);
    expect(status.masked).toContain("…"); // masked, never the raw secret
    expect(status.masked).not.toContain("secrettoken");
    expect(process.env[CLAUDE_TOKEN_KEY]).toBe("sk-ant-oat01-secrettoken-1234"); // live for the next run
    const contents = readFileSync(file, "utf8");
    expect(contents).toContain(`${CLAUDE_TOKEN_KEY}=sk-ant-oat01-secrettoken-1234`);
  } finally {
    rmSync(file, { force: true });
  }
});

test("set preserves other env lines and replaces the token line (no duplicates)", () => {
  const file = tmpEnvFile();
  try {
    writeFileSync(file, `ANVIL_PORT=7701\n${CLAUDE_TOKEN_KEY}=old\nANVIL_HOST=127.0.0.1\n`);
    setClaudeToken("sk-ant-oat01-new", file);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toContain("ANVIL_PORT=7701");
    expect(lines).toContain("ANVIL_HOST=127.0.0.1");
    expect(lines.filter((l) => l.startsWith(`${CLAUDE_TOKEN_KEY}=`))).toEqual([`${CLAUDE_TOKEN_KEY}=sk-ant-oat01-new`]);
  } finally {
    rmSync(file, { force: true });
  }
});

test("clear removes the token from the process and the env file", () => {
  const file = tmpEnvFile();
  try {
    writeFileSync(file, `KEEP=1\n${CLAUDE_TOKEN_KEY}=tok\n`);
    process.env[CLAUDE_TOKEN_KEY] = "tok";
    const status = clearClaudeToken(file);
    expect(status.connected).toBe(false);
    expect(process.env[CLAUDE_TOKEN_KEY]).toBeUndefined();
    const contents = readFileSync(file, "utf8");
    expect(contents).toContain("KEEP=1");
    expect(contents).not.toContain(CLAUDE_TOKEN_KEY);
  } finally {
    rmSync(file, { force: true });
  }
});

test("loadPersistedClaudeToken fills the env only when unset, and never loads a metered key", () => {
  const file = tmpEnvFile();
  try {
    writeFileSync(file, `${CLAUDE_TOKEN_KEY}="sk-ant-oat01-fromfile"\n`);
    delete process.env[CLAUDE_TOKEN_KEY];
    loadPersistedClaudeToken(file);
    expect(process.env[CLAUDE_TOKEN_KEY]).toBe("sk-ant-oat01-fromfile"); // quotes stripped

    process.env[CLAUDE_TOKEN_KEY] = "already-set";
    loadPersistedClaudeToken(file);
    expect(process.env[CLAUDE_TOKEN_KEY]).toBe("already-set"); // doesn't override a present token

    // A metered key in the file is ignored (defense in depth for §3).
    writeFileSync(file, `${CLAUDE_TOKEN_KEY}=sk-ant-api03-leak\n`);
    delete process.env[CLAUDE_TOKEN_KEY];
    loadPersistedClaudeToken(file);
    expect(process.env[CLAUDE_TOKEN_KEY]).toBeUndefined();
  } finally {
    rmSync(file, { force: true });
  }
});

test("status is disconnected when no token is present", () => {
  delete process.env[CLAUDE_TOKEN_KEY];
  const status = claudeAuthStatus({});
  expect(status.connected).toBe(false);
  expect(status.masked).toBeUndefined();
});
