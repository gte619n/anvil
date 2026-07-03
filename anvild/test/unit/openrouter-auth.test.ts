import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPENROUTER_KEY,
  clearOpenRouterKey,
  loadPersistedOpenRouterKey,
  openRouterAuthStatus,
  setOpenRouterKey,
} from "../../src/auth/openrouter";
import { setClaudeToken } from "../../src/auth/store";

// These poke process.env[OPENROUTER_KEY] via the store; restore after each so they don't leak the
// daemon's real key state into sibling tests.
const ORIGINAL = process.env[OPENROUTER_KEY];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[OPENROUTER_KEY];
  else process.env[OPENROUTER_KEY] = ORIGINAL;
});

function tmpEnvFile(): string {
  return join(mkdtempSync(join(tmpdir(), "anvil-or-")), "env");
}

test("set persists to the env file (0600) and applies live; status reflects it", () => {
  const file = tmpEnvFile();
  try {
    const status = setOpenRouterKey("sk-or-v1-abcdef0123456789", file);
    expect(status.connected).toBe(true);
    expect(status.persisted).toBe(true);
    expect(status.masked).toContain("…"); // masked, never the full secret
    expect(status.masked).not.toContain("0123456789");
    // live in this process
    expect(process.env[OPENROUTER_KEY]).toBe("sk-or-v1-abcdef0123456789");
    // durable + private on disk
    expect(readFileSync(file, "utf8")).toContain(`${OPENROUTER_KEY}=sk-or-v1-abcdef0123456789`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(file, { force: true });
  }
});

test("a metered-looking key is NOT rejected — OpenRouter is a different provider than Claude", () => {
  const file = tmpEnvFile();
  try {
    // The §3 guard rejects sk-ant-api… for Claude; OpenRouter has no such restriction.
    expect(() => setOpenRouterKey("sk-or-v1-whatever", file)).not.toThrow();
    expect(() => setOpenRouterKey("", file)).toThrow(); // but an empty key is still rejected
  } finally {
    rmSync(file, { force: true });
  }
});

test("clear removes the key from the process and the env file", () => {
  const file = tmpEnvFile();
  try {
    setOpenRouterKey("sk-or-v1-abcdef0123456789", file);
    const status = clearOpenRouterKey(file);
    expect(status.connected).toBe(false);
    expect(status.persisted).toBe(false);
    expect(process.env[OPENROUTER_KEY]).toBeUndefined();
    expect(readFileSync(file, "utf8")).not.toContain(OPENROUTER_KEY);
  } finally {
    rmSync(file, { force: true });
  }
});

test("loadPersisted hydrates process.env from the file only when unset", () => {
  const file = tmpEnvFile();
  try {
    setOpenRouterKey("sk-or-persisted", file);
    delete process.env[OPENROUTER_KEY]; // simulate a fresh process that didn't source the env file
    loadPersistedOpenRouterKey(file);
    expect(process.env[OPENROUTER_KEY]).toBe("sk-or-persisted");
    // a value already in the environment wins (not clobbered by the file)
    process.env[OPENROUTER_KEY] = "sk-or-live";
    loadPersistedOpenRouterKey(file);
    expect(process.env[OPENROUTER_KEY]).toBe("sk-or-live");
  } finally {
    rmSync(file, { force: true });
  }
});

test("the Claude token and OpenRouter key coexist in one env file; clearing one keeps the other", () => {
  const file = tmpEnvFile();
  const claudeOriginal = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    setClaudeToken("sk-ant-oat01-abc", file);
    setOpenRouterKey("sk-or-v1-xyz", file);
    let contents = readFileSync(file, "utf8");
    expect(contents).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc");
    expect(contents).toContain(`${OPENROUTER_KEY}=sk-or-v1-xyz`);

    clearOpenRouterKey(file);
    contents = readFileSync(file, "utf8");
    expect(contents).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc"); // Claude untouched
    expect(contents).not.toContain(OPENROUTER_KEY);
  } finally {
    rmSync(file, { force: true });
    if (claudeOriginal === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = claudeOriginal;
  }
});

test("status on a missing file reports not-connected without throwing", () => {
  const file = join(tmpdir(), "anvil-or-nope", "env");
  expect(existsSync(file)).toBe(false);
  delete process.env[OPENROUTER_KEY];
  const status = openRouterAuthStatus(process.env, file);
  expect(status).toEqual({ provider: "openrouter", connected: false, persisted: false });
});
