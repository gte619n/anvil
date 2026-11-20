/**
 * The throwaway test daemon (agent-cad-and-browser §4.12 "Throwaway test daemon", §4.14 item 33,
 * Phase C4): a session working on Anvil itself can start a second, credential-less copy of the daemon
 * from its own worktree and look at it in the agent browser.
 *
 * What is started, and how:
 *   1. the worktree's web bundle is built with `ANVIL_BUILD_OUT=<temp home>/web`, so the worktree is
 *      not written;
 *   2. `bun run src/main.ts` is started from the worktree's `anvild/` with EXACTLY the environment in
 *      `testDaemonEnv` — nothing inherited, so no token, no `~/.config/anvil/env`, no push keys — on
 *      `127.0.0.1` and a random port, with a new temporary `HOME` that holds its state;
 *   3. once `/api/health` answers, the port is registered for the session and opened in THAT session's
 *      proxy only (`registerTestDaemon` then `allowLoopbackPort`).
 *
 * One per session. It is killed (its whole process group) and its temporary home deleted when the
 * session's turn ends, when the session is reset or deleted, when this daemon stops, and by a
 * 15-minute timer; the proxy exemption is revoked — open connections dropped — at the same moment.
 *
 * A daemon that dies without stopping (a crash) cannot run any of that, so every started test daemon
 * is also written to `<stateDir>/testdaemons.json` with what identifies its process — its start time
 * (`ps -o lstart=`), its exact command line and its environment's `HOME` (the temp home) — and the next
 * start reaps what is listed there. A pid is signalled only when all three still match (C4 review,
 * item 6): a pid the system has since given to another program is left alone and its row dropped.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export const TEST_DAEMON_TTL_MS = 15 * 60_000;
export const TEST_DAEMON_HOME_PREFIX = "anvil-testdaemon-";
export const TEST_DAEMON_LEDGER = "testdaemons.json";
const HOME_MARKER = ".anvil-test-daemon";
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** The names of every variable the test daemon is started with. Nothing else is passed. */
export const TEST_DAEMON_ENV_KEYS = ["PATH", "TMPDIR", "HOME", "ANVIL_HOST", "ANVIL_PORT", "ANVIL_STATE_DIR", "ANVIL_CLONES_DIR", "ANVIL_WEB_DIR", "ANVIL_BASE_URL", "ANVIL_LAPO_DISABLE"] as const;

/** The complete environment of the test daemon (the C0 evidence's list, §4.14 item 33). */
export function testDaemonEnv(input: { bunDir: string; home: string; port: number }): Record<string, string> {
  return {
    PATH: `${input.bunDir}:${SYSTEM_PATH}`,
    TMPDIR: join(input.home, "tmp"),
    HOME: input.home,
    ANVIL_HOST: "127.0.0.1", // the default would bind the tailnet address
    ANVIL_PORT: String(input.port),
    ANVIL_STATE_DIR: join(input.home, "state"),
    ANVIL_CLONES_DIR: join(input.home, "repos"),
    ANVIL_WEB_DIR: join(input.home, "web", "dist"),
    ANVIL_BASE_URL: `http://127.0.0.1:${input.port}`, // without it the daemon shells out to `tailscale`
    ANVIL_LAPO_DISABLE: "1",
  };
}

/** The complete environment of the web-bundle build that precedes it. */
export function testDaemonBuildEnv(input: { bunDir: string; home: string }): Record<string, string> {
  return { PATH: `${input.bunDir}:${SYSTEM_PATH}`, TMPDIR: join(input.home, "tmp"), HOME: input.home, ANVIL_BUILD_OUT: join(input.home, "web") };
}

/** Where the worktree's daemon lives, or why this worktree is not an Anvil checkout. */
export function anvilCheckout(worktree: string): { anvild: string } | { error: string } {
  const anvild = join(worktree, "anvild");
  if (!existsSync(join(anvild, "src", "main.ts")) || !existsSync(join(anvild, "web", "build.ts"))) {
    return { error: "start_test_daemon only works in a checkout of Anvil itself (this session's worktree has no anvild/src/main.ts)" };
  }
  if (!existsSync(join(anvild, "node_modules"))) return { error: "this worktree's anvild/ has no node_modules; run `bun install --frozen-lockfile` in anvild/ first, then call start_test_daemon again" };
  return { anvild };
}

// ── Starting processes (the seam the functional tests replace) ───────────────────────────────────

export interface TestDaemonProcess {
  pid: number;
  /** SIGKILL the process and everything in its group. Never throws. */
  killGroup(): void;
  /** Settles when the process has exited. */
  exited: Promise<void>;
  /** The last lines it wrote to stderr (for a start that failed). */
  stderrTail(): string;
}

export interface TestDaemonSpawnOptions {
  cwd: string;
  /** The COMPLETE environment: nothing of the daemon's own is added. */
  env: Record<string, string>;
}

export interface TestDaemonRunner {
  /** Run the web build to completion. */
  build(command: string, args: string[], opts: TestDaemonSpawnOptions & { timeoutMs: number }): Promise<{ ok: boolean; output: string }>;
  /** Start the daemon in its own process group. */
  spawn(command: string, args: string[], opts: TestDaemonSpawnOptions): TestDaemonProcess;
}

function killGroupOf(pid: number | undefined): void {
  if (!pid) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

const tail = (text: string, max = 1200): string => (text.length > max ? `…${text.slice(-max)}` : text).trim();

export const defaultTestDaemonRunner: TestDaemonRunner = {
  build(command, args, opts) {
    return new Promise((done) => {
      let out = "";
      // `env` is the whole environment (node replaces, never merges, when `env` is given).
      const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        out += "\n(the build took too long and was stopped)";
        killGroupOf(child.pid);
      }, opts.timeoutMs);
      const add = (b: Buffer): void => void (out = (out + b.toString()).slice(-8000));
      child.stdout?.on("data", add);
      child.stderr?.on("data", add);
      child.once("error", (e) => {
        clearTimeout(timer);
        done({ ok: false, output: e.message });
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        done({ ok: code === 0, output: tail(out) });
      });
    });
  },
  spawn(command, args, opts) {
    let err = "";
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (b: Buffer) => void (err = (err + b.toString()).slice(-8000)));
    const exited = new Promise<void>((done) => {
      child.once("exit", () => done());
      child.once("error", (e) => {
        err += `\n${e.message}`;
        done();
      });
    });
    child.unref(); // never keeps this daemon alive; `killGroup` is how it ends
    let killed = false;
    return {
      pid: child.pid ?? 0,
      killGroup: () => {
        if (killed) return; // once: a pid is not signalled again after it may have been reused
        killed = true;
        killGroupOf(child.pid);
      },
      exited,
      stderrTail: () => tail(err),
    };
  },
};

/** A free loopback port (≥ 1024: the kernel's ephemeral range). */
export function pickLoopbackPort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr !== "string" ? addr.port : 0;
      srv.close(() => (port >= 1024 ? done(port) : fail(new Error("no free loopback port"))));
    });
  });
}

async function defaultHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500), redirect: "error" });
    if (!res.ok) return false;
    return ((await res.json()) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

// ── The service ─────────────────────────────────────────────────────────────────────────────────

/** The three proxy calls the launcher makes (the browser service's own). */
export interface TestDaemonPorts {
  proxyRunning(sessionId: string): boolean;
  registerTestDaemon(sessionId: string, port: number): { ok: true } | { ok: false; reason: string };
  allowLoopbackPort(sessionId: string, port: number): boolean;
  revokeLoopbackPort(sessionId: string, port?: number): void;
}

/** What identifies a running process across a restart of this daemon (pids are reused). */
export interface ProcessIdentity {
  /** `ps -o lstart=`: when it started, to the second. */
  started: string;
  /** `ps -o command=`: its exact command line. */
  command: string;
  /** Its environment's HOME (`ps eww`), when it could be read. */
  home?: string;
}

export interface TestDaemonSeams {
  runner: TestDaemonRunner;
  /** What `ps` says about a live pid, or undefined when it is not running (default: `ps`). */
  identify: (pid: number) => ProcessIdentity | undefined;
  /** Absolute path of `bun` (default: the binary this daemon runs under). */
  bunPath: () => string;
  /** Create the new temporary home and return its real path. */
  makeHome: () => string;
  pickPort: () => Promise<number>;
  /** One probe of `<url>/api/health`. */
  healthy: (url: string) => Promise<boolean>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  sleep: (ms: number) => Promise<void>;
  ttlMs: number;
  buildTimeoutMs: number;
  startTimeoutMs: number;
}

export interface TestDaemonServiceDeps extends Partial<TestDaemonSeams> {
  stateDir: string;
  ports: TestDaemonPorts;
  /** Called after a test daemon is gone, with its origin (the gate leaves a page that was on it). */
  onStopped?: (sessionId: string, origin: string, reason: string) => void;
  notice?: (sessionId: string, markdown: string) => void;
}

interface Running {
  home: string;
  /** The process as `ps` saw it right after it started (for the crash ledger). */
  identity?: ProcessIdentity;
  port: number;
  url: string;
  proc?: TestDaemonProcess;
  timer?: unknown;
  /** Set when a stop arrived while the start was still in flight. */
  cancelled?: string;
  ready: boolean;
}

export type TestDaemonStart = { url: string; existing: boolean } | { error: string };

function defaultMakeHome(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), TEST_DAEMON_HOME_PREFIX)));
}

export class TestDaemonService {
  private readonly bySession = new Map<string, Running>();
  private readonly starting = new Map<string, Promise<TestDaemonStart>>();
  private readonly seams: TestDaemonSeams;

  constructor(private readonly deps: TestDaemonServiceDeps) {
    this.seams = {
      runner: deps.runner ?? defaultTestDaemonRunner,
      identify: deps.identify ?? psIdentity,
      bunPath: deps.bunPath ?? (() => process.execPath),
      makeHome: deps.makeHome ?? defaultMakeHome,
      pickPort: deps.pickPort ?? pickLoopbackPort,
      healthy: deps.healthy ?? defaultHealthy,
      setTimer: deps.setTimer ?? ((fn, ms) => {
        const t = setTimeout(fn, ms);
        (t as { unref?: () => void }).unref?.();
        return t;
      }),
      clearTimer: deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      ttlMs: deps.ttlMs ?? TEST_DAEMON_TTL_MS,
      buildTimeoutMs: deps.buildTimeoutMs ?? 180_000,
      startTimeoutMs: deps.startTimeoutMs ?? 45_000,
    };
  }

  /** `http://127.0.0.1:<port>` of the session's RUNNING test daemon — its origin, exactly. */
  origin(sessionId: string): string | undefined {
    const r = this.bySession.get(sessionId);
    return r?.ready ? r.url : undefined;
  }

  port(sessionId: string): number | undefined {
    const r = this.bySession.get(sessionId);
    return r?.ready ? r.port : undefined;
  }

  count(): number {
    return this.bySession.size;
  }

  /**
   * Start the session's test daemon, or return the one it already has. Never throws: a refusal or a
   * failure is `{ error }`, and nothing is left running or on disk after one.
   */
  start(session: { id: string; data: { cwd: string } }): Promise<TestDaemonStart> {
    const existing = this.bySession.get(session.id);
    if (existing?.ready) return Promise.resolve({ url: existing.url, existing: true });
    const inFlight = this.starting.get(session.id);
    if (inFlight) return inFlight;
    const run = this.launch(session.id, session.data.cwd)
      .catch((e): TestDaemonStart => {
        this.discard(session.id);
        return { error: `the test daemon could not be started: ${e instanceof Error ? e.message : String(e)}` };
      })
      .finally(() => this.starting.delete(session.id));
    this.starting.set(session.id, run);
    return run;
  }

  private async launch(sessionId: string, worktree: string): Promise<TestDaemonStart> {
    const checkout = anvilCheckout(worktree);
    if ("error" in checkout) return checkout;
    if (!this.deps.ports.proxyRunning(sessionId)) return { error: "the agent browser is not running for this session (its network block has no listener), so a test daemon would be unreachable; switch the Browser on in the Tools menu first" };

    const bun = this.seams.bunPath();
    const bunDir = dirname(bun);
    const home = this.seams.makeHome();
    const rec: Running = { home, port: 0, url: "", ready: false };
    this.bySession.set(sessionId, rec);
    const fail = (error: string): TestDaemonStart => {
      this.discard(sessionId);
      return { error };
    };
    const gone = (): string | undefined => (this.bySession.get(sessionId) === rec ? rec.cancelled : "it was stopped");

    mkdirSync(join(home, "tmp"), { recursive: true });
    writeFileSync(join(home, HOME_MARKER), "");
    const build = await this.seams.runner.build(bun, ["run", "web/build.ts"], { cwd: checkout.anvild, env: testDaemonBuildEnv({ bunDir, home }), timeoutMs: this.seams.buildTimeoutMs });
    if (gone()) return fail(`the test daemon was stopped while it was starting (${gone()})`);
    if (!build.ok) return fail(`the web bundle of this worktree did not build, so no test daemon was started:\n${build.output}`);

    rec.port = await this.seams.pickPort();
    rec.url = `http://127.0.0.1:${rec.port}`;
    if (gone()) return fail(`the test daemon was stopped while it was starting (${gone()})`);
    // Reserve the port for this session BEFORE anything listens on it: a port that cannot be
    // registered (this daemon's own, another session's) is never started on.
    const reg = this.deps.ports.registerTestDaemon(sessionId, rec.port);
    if (!reg.ok) return fail(`the test daemon's port could not be used (${reg.reason})`);

    rec.proc = this.seams.runner.spawn(bun, ["run", "src/main.ts"], { cwd: checkout.anvild, env: testDaemonEnv({ bunDir, home, port: rec.port }) });
    if (rec.proc.pid > 1) rec.identity = this.seams.identify(rec.proc.pid);
    this.writeLedger();
    let exited = false;
    void rec.proc.exited.then(() => {
      exited = true;
      // It died by itself after it was ready: clean up as if it had been stopped.
      if (rec.ready && this.bySession.get(sessionId) === rec) this.stop(sessionId, "it exited");
    });

    const deadline = Date.now() + this.seams.startTimeoutMs;
    let healthy = false;
    while (!healthy && !exited && !gone() && Date.now() < deadline) {
      healthy = await this.seams.healthy(rec.url);
      if (!healthy) await this.seams.sleep(150);
    }
    if (gone()) return fail(`the test daemon was stopped while it was starting (${gone()})`);
    if (exited) return fail(`the test daemon exited while starting:\n${rec.proc.stderrTail()}`);
    if (!healthy) return fail(`the test daemon did not answer /api/health within ${Math.round(this.seams.startTimeoutMs / 1000)} s:\n${rec.proc.stderrTail()}`);

    if (!this.deps.ports.allowLoopbackPort(sessionId, rec.port)) return fail("the test daemon started, but its port could not be opened in this session's browser proxy (the browser is not running for this session)");
    rec.ready = true;
    rec.timer = this.seams.setTimer(() => {
      if (this.bySession.get(sessionId) !== rec) return;
      this.stop(sessionId, "its 15 minutes are up");
      this.deps.notice?.(sessionId, "🧪 _The test daemon was stopped: its 15 minutes are up._");
    }, this.seams.ttlMs);
    return { url: rec.url, existing: false };
  }

  /** Remove a record that never became ready (or failed): kill, revoke, delete. */
  private discard(sessionId: string): void {
    const rec = this.bySession.get(sessionId);
    if (!rec) return;
    this.bySession.delete(sessionId);
    this.destroy(sessionId, rec);
  }

  private destroy(sessionId: string, rec: Running): void {
    if (rec.timer !== undefined) this.seams.clearTimer(rec.timer);
    if (rec.port) this.deps.ports.revokeLoopbackPort(sessionId, rec.port); // open tunnels are destroyed
    rec.proc?.killGroup();
    const remove = (): void => {
      try {
        rmSync(rec.home, { recursive: true, force: true });
      } catch {
        /* tried */
      }
    };
    remove();
    // The process may have been mid-write when it was killed: once it is really gone, once more.
    void rec.proc?.exited.then(remove);
    this.writeLedger();
  }

  /**
   * Stop the session's test daemon now: revoke the proxy exemption, kill the process group, delete
   * the temporary home. Synchronous up to the kill signal and the delete. Returns whether there was one.
   */
  stop(sessionId: string, reason: string): boolean {
    const rec = this.bySession.get(sessionId);
    if (!rec) return false;
    rec.cancelled = reason; // a start still in flight sees this after its current step and gives up
    this.bySession.delete(sessionId);
    this.destroy(sessionId, rec);
    if (!rec.ready) return true;
    try {
      this.deps.onStopped?.(sessionId, rec.url, reason);
    } catch (e) {
      console.error(`[testdaemon] onStopped failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return true;
  }

  /** This daemon is shutting down: every test daemon goes. */
  stopAll(reason = "the daemon is shutting down"): void {
    for (const id of [...this.bySession.keys()]) this.stop(id, reason);
  }

  /** Resolves when every process this service killed has exited (tests, shutdown). */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.starting.values()]);
  }

  // ── the crash ledger ────────────────────────────────────────────────────────────────────────

  private ledgerPath(): string {
    return join(this.deps.stateDir, TEST_DAEMON_LEDGER);
  }

  private writeLedger(): void {
    const rows = [...this.bySession.values()].filter((r) => r.proc?.pid).map((r) => ({ pid: r.proc!.pid, home: r.home, ...(r.identity ? { started: r.identity.started, command: r.identity.command } : {}) }));
    try {
      if (rows.length) writeFileSync(this.ledgerPath(), `${JSON.stringify(rows)}\n`, { mode: 0o600 });
      else rmSync(this.ledgerPath(), { force: true });
    } catch {
      /* the ledger is best effort */
    }
  }

  /**
   * Kill and delete the test daemons a previous run of THIS daemon left behind (it crashed before it
   * could stop them). A row is believed only as far as: the home is a folder this code created (its
   * name and its marker file). Its pid is signalled only when the process running under it now is the
   * one that was started — the same start time, the same command line, and HOME the row's temp home;
   * otherwise (the pid is gone or was reused) only the row and the home go.
   */
  reapOrphans(identify: (pid: number) => ProcessIdentity | undefined = this.seams.identify): number {
    let rows: { pid?: unknown; home?: unknown; started?: unknown; command?: unknown }[];
    try {
      rows = JSON.parse(readFileSync(this.ledgerPath(), "utf8"));
      if (!Array.isArray(rows)) rows = [];
    } catch {
      return 0;
    }
    let reaped = 0;
    for (const row of rows) {
      if (typeof row?.home !== "string" || typeof row.pid !== "number" || !Number.isInteger(row.pid) || row.pid < 2) continue;
      if (!basename(row.home).startsWith(TEST_DAEMON_HOME_PREFIX) || !existsSync(join(row.home, HOME_MARKER))) continue;
      if (typeof row.started === "string" && row.started && typeof row.command === "string" && row.command) {
        const now = identify(row.pid);
        if (now && now.started === row.started && now.command === row.command && now.home === row.home) killGroupOf(row.pid);
      }
      try {
        rmSync(row.home, { recursive: true, force: true });
        reaped++;
      } catch {
        /* tried */
      }
    }
    try {
      rmSync(this.ledgerPath(), { force: true });
    } catch {
      /* tried */
    }
    return reaped;
  }
}

const psOut = (args: string[]): string => {
  try {
    const r = Bun.spawnSync(["/bin/ps", ...args], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  } catch {
    return "";
  }
};

/** What `ps` says about `pid`: start time, command line, and the HOME in its environment. */
export function psIdentity(pid: number): ProcessIdentity | undefined {
  if (!Number.isInteger(pid) || pid < 2) return undefined;
  const started = psOut(["-o", "lstart=", "-p", String(pid)]);
  const command = psOut(["-o", "command=", "-p", String(pid)]);
  if (!started || !command) return undefined;
  // `ps eww` appends the environment to the command line (own-user processes only).
  const withEnv = psOut(["eww", "-o", "command=", "-p", String(pid)]);
  const home = withEnv.startsWith(command) ? / HOME=(\S+)/.exec(withEnv.slice(command.length))?.[1] : undefined;
  return { started, command, ...(home ? { home } : {}) };
}
