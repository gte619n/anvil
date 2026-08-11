import { describe, expect, it } from "bun:test";
import { GIT_ENV, gitSpawn, gitSpawnAsync, NET_TIMEOUT_MS } from "./spawn";

describe("gitSpawn", () => {
  it("returns a command's output with code 0 on success", () => {
    const r = gitSpawn(["echo", "hello"], process.cwd());
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
  });

  it("kills a process that exceeds the timeout and reports it as a non-zero failure", () => {
    // The daemon-freeze bug: a hung network git op blocks the single-threaded event loop forever.
    // A short-timeout `sleep` stands in for that hang; the hard timeout must reap it.
    const start = performance.now();
    const r = gitSpawn(["sleep", "10"], process.cwd(), 300);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(3000); // killed promptly, not after the full 10s
    expect(r.code).not.toBe(0); // callers' `code !== 0` fallback path runs
    expect(r.stderr).toContain("exceeded 300ms");
  });

  it("carries an SSH keepalive + connect timeout so a dead connection can't hang forever", () => {
    // These are what prevents the original incident: a `git fetch` → ssh over a dead TCP connection.
    expect(GIT_ENV.GIT_SSH_COMMAND).toContain("ServerAliveInterval");
    expect(GIT_ENV.GIT_SSH_COMMAND).toContain("ConnectTimeout");
    expect(GIT_ENV.GIT_SSH_COMMAND).toContain("BatchMode=yes");
    expect(GIT_ENV.GIT_TERMINAL_PROMPT).toBe("0"); // never block on an interactive credential prompt
  });

  it("inherits the host environment (so git/gh keep PATH, ssh agent, gh token)", () => {
    expect(GIT_ENV.PATH).toBe(process.env.PATH ?? "");
    expect(NET_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

// [BE2-2/3/5] The async twin must honour the exact same result contract as gitSpawn — every caller
// branches on `code !== 0`, so the timeout (124) and missing-binary (127) surfaces must match. The
// end-to-end "slow git doesn't freeze the daemon" property lives in
// test/integration/slow-git-responsiveness.test.ts (child process with a pre-doctored PATH).
describe("gitSpawnAsync", () => {
  it("returns a command's output with code 0 on success", async () => {
    const r = await gitSpawnAsync(["echo", "hello"], process.cwd());
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
  });

  it("kills a process that exceeds the timeout — without blocking the event loop while it waits", async () => {
    // The freeze regression guard in miniature: while the doomed `sleep` runs, a concurrent timer
    // must still fire (a sync spawn would hold the loop for the full 10s / until the kill).
    let tickedDuring = false;
    const tick = setTimeout(() => {
      tickedDuring = true;
    }, 100);
    const start = performance.now();
    const r = await gitSpawnAsync(["sleep", "10"], process.cwd(), 300);
    const elapsed = performance.now() - start;
    clearTimeout(tick);
    expect(elapsed).toBeLessThan(3000); // killed promptly, not after the full 10s
    expect(tickedDuring).toBe(true); // the event loop kept running while the child slept
    expect(r.code).not.toBe(0); // callers' `code !== 0` fallback path runs
    expect(r.stderr).toContain("exceeded 300ms");
  });

  it("reports a missing binary as code 127 instead of throwing", async () => {
    const r = await gitSpawnAsync(["definitely-not-a-real-binary-anvil"], process.cwd());
    expect(r.code).toBe(127);
    expect(r.stderr).toContain("couldn't run");
  });
});
