/**
 * [F0] Feature flags (agent-cad-and-browser spec §4.8). `ANVIL_FEATURES` switches on the opt-in
 * capability-gated features; everything is off by default, unknown names are ignored with a warning
 * (never a startup failure), and `/api/health` + `server.hello` advertise exactly the enabled ones.
 */
import { test, expect } from "bun:test";
import { join } from "node:path";
import { FEATURE_CAPABILITIES, featureEnabled, loadConfig, parseFeatures } from "../../src/config";
import { SERVER_CAPABILITIES } from "../../src/server/identity";
import { tmpDir } from "../helpers";

const base = { HOME: "/home/t", ANVIL_HOST: "127.0.0.1" } as Record<string, string | undefined>;

test("[F0] features default to none", () => {
  expect(loadConfig({ ...base }).features).toEqual([]);
  expect(loadConfig({ ...base, ANVIL_FEATURES: "" }).features).toEqual([]);
  expect(loadConfig({ ...base, ANVIL_FEATURES: " , ," }).features).toEqual([]);
});

test("[F0] ANVIL_FEATURES is comma-separated, trimmed, de-duplicated and canonically ordered", () => {
  const c = loadConfig({ ...base, ANVIL_FEATURES: " browser , cad-work,browser,solidcraft-pin" });
  expect(c.features).toEqual(["cad-work", "solidcraft-pin", "browser"]);
  expect(loadConfig({ ...base, ANVIL_FEATURES: FEATURE_CAPABILITIES.join(",") }).features).toEqual([...FEATURE_CAPABILITIES]);
});

test("[F0] an unknown feature is ignored with a warning, not a startup error", () => {
  const warnings: string[] = [];
  expect(parseFeatures("cad-work,teleport", (m) => warnings.push(m))).toEqual(["cad-work"]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("[anvild] ANVIL_FEATURES");
  expect(warnings[0]).toContain('"teleport"');
  // A known list produces no warning at all.
  const quiet: string[] = [];
  parseFeatures("cad-work, browser", (m) => quiet.push(m));
  expect(quiet).toEqual([]);
});

test("[F0] featureEnabled reads the flag off a config-like object", () => {
  const c = loadConfig({ ...base, ANVIL_FEATURES: "cad-work" });
  expect(featureEnabled(c, "cad-work")).toBe(true);
  expect(featureEnabled(c, "browser")).toBe(false);
  expect(featureEnabled({}, "cad-work")).toBe(false);
});

test("[F0] /api/health and server.hello advertise the base list plus the enabled features", async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "sk-ant-oat-test-placeholder";
  const { createServer } = await import("../../src/server/http");
  const boot = (features?: string[]) => {
    const { dir, cleanup } = tmpDir("anvil-feat-");
    const srv = createServer({ host: "127.0.0.1", port: 0, stateDir: dir, envFile: join(dir, "env"), ...(features ? { features } : {}) });
    return { srv, cleanup };
  };
  const hello = (port: number) =>
    new Promise<{ capabilities: string[] }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.onmessage = (m) => {
        const ev = JSON.parse(String(m.data));
        if (ev.type === "server.hello") {
          ws.close();
          resolve(ev);
        }
      };
      ws.onerror = () => reject(new Error("ws error"));
    });

  const off = boot();
  const on = boot(["cad-work", "browser"]);
  try {
    const hOff = (await (await fetch(`http://127.0.0.1:${off.srv.port}/api/health`)).json()) as { capabilities: string[] };
    expect(hOff.capabilities).toEqual([...SERVER_CAPABILITIES]);
    expect((await hello(off.srv.port)).capabilities).toEqual([...SERVER_CAPABILITIES]);

    const hOn = (await (await fetch(`http://127.0.0.1:${on.srv.port}/api/health`)).json()) as { capabilities: string[] };
    expect(hOn.capabilities).toEqual([...SERVER_CAPABILITIES, "cad-work", "browser"]);
    expect((await hello(on.srv.port)).capabilities).toEqual([...SERVER_CAPABILITIES, "cad-work", "browser"]);
  } finally {
    off.srv.stop();
    off.cleanup();
    on.srv.stop();
    on.cleanup();
  }
});
