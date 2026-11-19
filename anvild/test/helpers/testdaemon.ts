/**
 * Fixtures for the throwaway test daemon's tests (Phase C4): a fake runner that records exactly what
 * would have been built and started and stands a small loopback HTTP server in for the daemon, a raw
 * HTTP-proxy client, a captured timer, and a folder shaped like an Anvil checkout. Nothing here builds
 * a bundle or starts a daemon.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestDaemonProcess, TestDaemonRunner, TestDaemonSeams, TestDaemonSpawnOptions } from "../../src/browser/testdaemon";

export const FAKE_BUN = "/opt/anvil-test/bun/bin/bun";

export interface FakeStart {
  command: string;
  args: string[];
  opts: TestDaemonSpawnOptions;
  proc: TestDaemonProcess & { killed: boolean };
  /** Requests the stand-in daemon received. */
  requests: string[];
}

export interface FakeRunner extends TestDaemonRunner {
  builds: { command: string; args: string[]; opts: TestDaemonSpawnOptions & { timeoutMs: number } }[];
  starts: FakeStart[];
  /** What the next build answers (default ok). */
  buildResult: { ok: boolean; output: string };
  /** false: the "daemon" never listens (so /api/health never answers). */
  listen: boolean;
  /** true: the "daemon" exits at once. */
  exitAtOnce: boolean;
  /** Resolve to let a held build finish (set `holdBuild` first). */
  holdBuild?: Promise<void>;
}

/**
 * A runner that starts nothing. `spawn` serves `/api/health` and a page on 127.0.0.1:<ANVIL_PORT> from
 * inside the test process — the stand-in for the daemon — until its group is "killed".
 */
export function fakeRunner(): FakeRunner {
  const r: FakeRunner = {
    builds: [],
    starts: [],
    buildResult: { ok: true, output: "" },
    listen: true,
    exitAtOnce: false,
    async build(command, args, opts) {
      r.builds.push({ command, args, opts });
      if (r.holdBuild) await r.holdBuild;
      return r.buildResult;
    },
    spawn(command, args, opts) {
      const requests: string[] = [];
      const port = Number(opts.env.ANVIL_PORT);
      const srv = r.listen
        ? Bun.serve({
            hostname: "127.0.0.1",
            port,
            fetch(req) {
              const u = new URL(req.url);
              requests.push(u.pathname);
              if (u.pathname === "/api/health") return Response.json({ ok: true, subscriptionAuthOk: false });
              return new Response("<!doctype html><title>Anvil (test daemon)</title><body>hello from the stand-in</body>", { headers: { "content-type": "text/html" } });
            },
          })
        : undefined;
      let done!: () => void;
      const exited = new Promise<void>((res) => (done = res));
      const proc: FakeStart["proc"] = {
        pid: 0, // never a real pid: nothing may ever signal it
        killed: false,
        killGroup() {
          if (proc.killed) return;
          proc.killed = true;
          srv?.stop(true);
          done();
        },
        exited,
        stderrTail: () => "fake stderr tail",
      };
      if (r.exitAtOnce) {
        srv?.stop(true);
        done();
      }
      r.starts.push({ command, args, opts, proc, requests });
      return proc;
    },
  };
  return r;
}

export interface CapturedTimers {
  timers: { fn: () => void; ms: number; cleared: boolean }[];
  setTimer: TestDaemonSeams["setTimer"];
  clearTimer: TestDaemonSeams["clearTimer"];
  /** Run every timer that has not been cleared, as if its time had passed. */
  fire(): number;
}
export function capturedTimers(): CapturedTimers {
  const c: CapturedTimers = {
    timers: [],
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      c.timers.push(t);
      return t;
    },
    clearTimer: (h) => void ((h as { cleared: boolean }).cleared = true),
    fire() {
      const due = c.timers.filter((t) => !t.cleared);
      for (const t of due) {
        t.cleared = true;
        t.fn();
      }
      return due.length;
    },
  };
  return c;
}

/** The seams a functional test passes as `browser.testDaemon`. */
export function fakeTestDaemonSeams(runner: FakeRunner, timers: CapturedTimers): Partial<TestDaemonSeams> {
  return { runner, bunPath: () => FAKE_BUN, setTimer: timers.setTimer, clearTimer: timers.clearTimer, startTimeoutMs: 3000 };
}

/** A new folder shaped like an Anvil checkout (`anvild/src/main.ts`, `anvild/web/build.ts`, `node_modules`). */
export function fakeAnvilCheckout(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "anvil-c4-wt-")));
  for (const d of ["anvild/src", "anvild/web", "anvild/node_modules"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "anvild", "src", "main.ts"), "// stand-in\n");
  writeFileSync(join(dir, "anvild", "web", "build.ts"), "// stand-in\n");
  return dir;
}

/** One plain-HTTP request through an HTTP proxy on loopback: the status and the body. */
export function proxyGet(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const sock = connect({ host: "127.0.0.1", port: proxyPort });
    let buf = "";
    sock.setTimeout(10_000, () => sock.destroy(new Error("proxy request timed out")));
    sock.on("error", fail);
    sock.on("data", (b) => void (buf += b.toString()));
    sock.on("close", () => {
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buf)?.[1] ?? 0);
      done({ status, body: buf.slice(buf.indexOf("\r\n\r\n") + 4) });
    });
    sock.on("connect", () => sock.write(`GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\nConnection: close\r\n\r\n`));
  });
}
