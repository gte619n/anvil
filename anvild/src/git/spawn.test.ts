import { describe, expect, it } from "bun:test";
import { GIT_ENV, gitSpawn, NET_TIMEOUT_MS } from "./spawn";

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
