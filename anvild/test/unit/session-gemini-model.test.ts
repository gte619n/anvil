import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { Supervisor, BadCommand } from "../../src/session/supervisor";
import { ConnectionRegistry } from "../../src/server/registry";
import { AccountStore } from "../../src/auth/accounts";
import { OPENROUTER_ANTHROPIC_BASE_URL } from "../../src/agent/env";

// Gemini sessions run through the same Agent SDK via OpenRouter. A Claude ↔ Gemini switch changes the
// provider + credential a running query() holds for life, so the driver must be dropped (the next turn
// respawns + resumes); a same-provider switch stays a live setModel on the existing driver.

interface FakeDriver { stopped: boolean; models: string[]; stop: () => Promise<void>; setModel: (m: string) => Promise<void> }
function fakeDriver(): FakeDriver {
  const d: FakeDriver = { stopped: false, models: [], stop: async () => {}, setModel: async () => {} };
  d.stop = async () => { d.stopped = true; };
  d.setModel = async (m) => { d.models.push(m); };
  return d;
}
const driversOf = (sup: Supervisor) => (sup as unknown as { drivers: Map<string, FakeDriver> }).drivers;
const createCmd = (cwd: string) => ({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd }) as const;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "anvil-gemini-"));
  const accounts = new AccountStore(dir);
  accounts.add("work", "sk-ant-oat01-workworkwork-1111");
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  return { dir, sup, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("Claude → Gemini on an idle session drops the driver instead of a live setModel", async () => {
  const { dir, sup, cleanup } = setup();
  const s = await sup.create(createCmd(dir));
  const d = fakeDriver();
  driversOf(sup).set(s.data.id, d);
  await sup.setModel(s.data.id, "gemini");
  expect(s.data.model).toBe("gemini");
  expect(d.stopped).toBe(true);
  expect(d.models).toEqual([]);
  expect(driversOf(sup).has(s.data.id)).toBe(false);
  cleanup();
});

test("a same-provider switch stays live on the existing driver", async () => {
  const { dir, sup, cleanup } = setup();
  const s = await sup.create(createCmd(dir));
  const d = fakeDriver();
  driversOf(sup).set(s.data.id, d);
  await sup.setModel(s.data.id, "sonnet");
  expect(d.stopped).toBe(false);
  expect(d.models).toEqual(["sonnet"]);
  cleanup();
});

test("a cross-provider switch is refused mid-turn and leaves the model unchanged", async () => {
  const { dir, sup, cleanup } = setup();
  const s = await sup.create(createCmd(dir));
  driversOf(sup).set(s.data.id, fakeDriver());
  s.setStatus("thinking");
  await expect(sup.setModel(s.data.id, "gemini")).rejects.toThrow(BadCommand);
  expect(s.data.model).toBe("opus");
  cleanup();
});

test("a Gemini session's agent env goes to OpenRouter with no Claude token; its terminal keeps the Claude env", async () => {
  const { dir, sup, cleanup } = setup();
  const prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "sk-or-x";
  try {
    const s = await sup.create(createCmd(dir));
    await sup.setModel(s.data.id, "gemini");
    const priv = sup as unknown as { agentEnv: (s: unknown) => Record<string, string>; shellEnv: (s: unknown) => Record<string, string> };
    const env = priv.agentEnv(s);
    expect(env.ANTHROPIC_BASE_URL).toBe(OPENROUTER_ANTHROPIC_BASE_URL);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-x");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("google/gemini-4-neon");
    expect(priv.shellEnv(s).ANTHROPIC_BASE_URL).toBeUndefined();
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prev;
    cleanup();
  }
});
