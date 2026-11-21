/**
 * [C4] The throwaway test daemon's environment and its refusals in isolation
 * (src/browser/testdaemon.ts): the exact variable list of §4.14 item 33 / the C0 evidence, the build's
 * environment, what counts as an Anvil checkout, and the port picker.
 */
import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DAEMON_ENV_KEYS, TEST_DAEMON_TTL_MS, anvilCheckout, pickLoopbackPort, testDaemonBuildEnv, testDaemonEnv } from "../../src/browser/testdaemon";
import { fakeAnvilCheckout } from "../helpers/testdaemon";

describe("the environment", () => {
  test("[C4] the test daemon's environment is exactly the ten listed variables, with ANVIL_HOST=127.0.0.1, the state and clones folders inside the new home, and nothing else", () => {
    const env = testDaemonEnv({ bunDir: "/opt/bun/bin", home: "/tmp/anvil-testdaemon-X", port: 45678 });
    expect(env).toEqual({
      PATH: "/opt/bun/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: "/tmp/anvil-testdaemon-X/tmp",
      HOME: "/tmp/anvil-testdaemon-X",
      ANVIL_HOST: "127.0.0.1",
      ANVIL_PORT: "45678",
      ANVIL_STATE_DIR: "/tmp/anvil-testdaemon-X/state",
      ANVIL_CLONES_DIR: "/tmp/anvil-testdaemon-X/repos",
      ANVIL_WEB_DIR: "/tmp/anvil-testdaemon-X/web/dist",
      ANVIL_BASE_URL: "http://127.0.0.1:45678",
      ANVIL_LAPO_DISABLE: "1",
    });
    expect(Object.keys(env).sort()).toEqual([...TEST_DAEMON_ENV_KEYS].sort());
    expect(TEST_DAEMON_ENV_KEYS).toHaveLength(10);
    // No credential, no feature flag, no token of any kind can be in it: the key set is closed.
    for (const k of Object.keys(env)) expect(k).not.toMatch(/TOKEN|KEY|SECRET|CLAUDE|ANTHROPIC|OPENROUTER|FEATURES/);
    expect(TEST_DAEMON_TTL_MS).toBe(15 * 60_000);
  });

  test("[C4] the web build's environment is PATH, TMPDIR, HOME and ANVIL_BUILD_OUT inside the temporary home — the worktree is not the output", () => {
    expect(testDaemonBuildEnv({ bunDir: "/opt/bun/bin", home: "/tmp/h" })).toEqual({ PATH: "/opt/bun/bin:/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: "/tmp/h/tmp", HOME: "/tmp/h", ANVIL_BUILD_OUT: "/tmp/h/web" });
    // What the build writes (…/web/dist) is what the daemon is told to serve.
    expect(testDaemonEnv({ bunDir: "/b", home: "/tmp/h", port: 2000 }).ANVIL_WEB_DIR).toBe(join(testDaemonBuildEnv({ bunDir: "/b", home: "/tmp/h" }).ANVIL_BUILD_OUT!, "dist"));
  });
});

describe("which worktrees", () => {
  test("[C4] a worktree that is not an Anvil checkout (no anvild/src/main.ts) is refused with a clear message; one without node_modules is told to install first", () => {
    const empty = mkdtempSync(join(tmpdir(), "anvil-c4-empty-"));
    try {
      expect(anvilCheckout(empty)).toEqual({ error: expect.stringMatching(/only works in a checkout of Anvil itself.*no anvild\/src\/main\.ts/) });
      const wt = fakeAnvilCheckout();
      expect(anvilCheckout(wt)).toEqual({ anvild: join(wt, "anvild") });
      rmSync(join(wt, "anvild", "node_modules"), { recursive: true });
      expect(anvilCheckout(wt)).toEqual({ error: expect.stringMatching(/no node_modules.*bun install/) });
      mkdirSync(join(wt, "anvild", "node_modules"));
      rmSync(join(wt, "anvild", "web", "build.ts"));
      expect(anvilCheckout(wt)).toEqual({ error: expect.stringMatching(/only works in a checkout of Anvil/) });
      rmSync(wt, { recursive: true, force: true });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("[C4] the port picker returns a free loopback port at or above 1024", async () => {
    const ports = await Promise.all([pickLoopbackPort(), pickLoopbackPort(), pickLoopbackPort()]);
    for (const p of ports) {
      expect(Number.isInteger(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(1024);
      expect(p).toBeLessThanOrEqual(65535);
      const srv = Bun.serve({ hostname: "127.0.0.1", port: p, fetch: () => new Response("ok") }); // it is free
      srv.stop(true);
    }
  });
});
