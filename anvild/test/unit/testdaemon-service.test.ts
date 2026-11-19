/**
 * [C4] The test-daemon launcher in isolation (src/browser/testdaemon.ts) with a fake runner, fake
 * proxy calls and a captured timer: the order of its steps, one per session, every way it ends, and
 * that a failure leaves nothing behind.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { TEST_DAEMON_ENV_KEYS, TEST_DAEMON_HOME_PREFIX, TEST_DAEMON_LEDGER, TEST_DAEMON_TTL_MS, TestDaemonService, testDaemonEnv, type TestDaemonPorts } from "../../src/browser/testdaemon";
import { FAKE_BUN, capturedTimers, fakeAnvilCheckout, fakeRunner, type CapturedTimers, type FakeRunner } from "../helpers/testdaemon";

let stateDir: string;
let worktree: string;
let runner: FakeRunner;
let timers: CapturedTimers;
let log: string[];
let ports: TestDaemonPorts & { running: boolean; refuse?: string; allow: boolean };
let stopped: [string, string, string][];
let notices: string[];
let svc: TestDaemonService;
const homes: string[] = [];

const session = (id = "s1", cwd = worktree) => ({ id, data: { cwd } });
const make = (over: Partial<ConstructorParameters<typeof TestDaemonService>[0]> = {}): TestDaemonService =>
  new TestDaemonService({
    stateDir,
    ports,
    runner,
    bunPath: () => FAKE_BUN,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    startTimeoutMs: 2000,
    onStopped: (id, origin, reason) => void stopped.push([id, origin, reason]),
    notice: (id, md) => void notices.push(`${id}: ${md}`),
    ...over,
  });

beforeEach(() => {
  stateDir = realpathSync(mkdtempSync(join(tmpdir(), "anvil-c4-state-")));
  worktree = fakeAnvilCheckout();
  runner = fakeRunner();
  timers = capturedTimers();
  log = [];
  stopped = [];
  notices = [];
  ports = {
    running: true,
    allow: true,
    proxyRunning: () => ports.running,
    registerTestDaemon: (id, port) => (log.push(`register ${id} ${port}`), ports.refuse ? { ok: false, reason: ports.refuse } : { ok: true }),
    allowLoopbackPort: (id, port) => (log.push(`allow ${id} ${port}`), ports.allow),
    revokeLoopbackPort: (id, port) => void log.push(`revoke ${id} ${port}`),
  };
  svc = make();
});

afterEach(() => {
  svc.stopAll();
  for (const s of runner.starts) {
    s.proc.killGroup();
    homes.push(s.opts.env.HOME!);
  }
  for (const b of runner.builds) homes.push(b.opts.env.HOME!);
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
});

describe("starting", () => {
  test("[C4] start builds the worktree's bundle into the new home, then starts `bun run src/main.ts` from the worktree's anvild with exactly the listed environment, waits for /api/health, and only then registers and opens the port — register before allow", async () => {
    const out = await svc.start(session());
    if ("error" in out) throw new Error(out.error);
    expect(out.existing).toBe(false);

    // The build: the worktree's own script, output inside the temporary home.
    expect(runner.builds).toHaveLength(1);
    const b = runner.builds[0]!;
    const home = b.opts.env.HOME!;
    expect([b.command, b.args, b.opts.cwd]).toEqual([FAKE_BUN, ["run", "web/build.ts"], join(worktree, "anvild")]);
    expect(b.opts.env).toEqual({ PATH: `${dirname(FAKE_BUN)}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: join(home, "tmp"), HOME: home, ANVIL_BUILD_OUT: join(home, "web") });

    // The daemon: the complete environment is the list, nothing of this process's own.
    expect(runner.starts).toHaveLength(1);
    const s = runner.starts[0]!;
    const port = Number(s.opts.env.ANVIL_PORT);
    expect([s.command, s.args, s.opts.cwd]).toEqual([FAKE_BUN, ["run", "src/main.ts"], join(worktree, "anvild")]);
    expect(s.opts.env).toEqual(testDaemonEnv({ bunDir: dirname(FAKE_BUN), home, port }));
    expect(Object.keys(s.opts.env).sort()).toEqual([...TEST_DAEMON_ENV_KEYS].sort());
    expect(s.opts.env.ANVIL_HOST).toBe("127.0.0.1");
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(out.url).toBe(`http://127.0.0.1:${port}`);
    expect(svc.origin("s1")).toBe(out.url);

    // HOME is a new temporary folder made for this start.
    expect(basename(home).startsWith(TEST_DAEMON_HOME_PREFIX)).toBe(true);
    expect(dirname(home)).toBe(realpathSync(tmpdir()));
    expect(existsSync(home)).toBe(true);
    expect(home).not.toBe(process.env.HOME);

    // Health was asked before the port was opened, and register came before allow.
    expect(s.requests).toContain("/api/health");
    expect(log).toEqual([`register s1 ${port}`, `allow s1 ${port}`]);
    // The 15-minute timer is armed.
    expect(timers.timers.map((t) => [t.ms, t.cleared])).toEqual([[TEST_DAEMON_TTL_MS, false]]);
  });

  test("[C4] one test daemon per session: a second call returns the existing one, concurrent calls share one start, and another session gets its own on another port", async () => {
    const [a, b] = await Promise.all([svc.start(session()), svc.start(session())]);
    expect(a).toEqual(b);
    expect(runner.starts).toHaveLength(1);
    const again = await svc.start(session());
    expect(again).toEqual({ url: (a as { url: string }).url, existing: true });
    expect(runner.builds).toHaveLength(1);
    expect(runner.starts).toHaveLength(1);

    const other = await svc.start(session("s2"));
    expect(runner.starts).toHaveLength(2);
    expect((other as { url: string }).url).not.toBe((a as { url: string }).url);
    expect(runner.starts[1]!.opts.env.HOME).not.toBe(runner.starts[0]!.opts.env.HOME);
    expect(svc.count()).toBe(2);
  });

  test("[C4] refused before anything is built: a worktree that is not Anvil, and a session whose browser proxy is not running", async () => {
    const notAnvil = mkdtempSync(join(tmpdir(), "anvil-c4-other-"));
    try {
      expect(await svc.start(session("s1", notAnvil))).toEqual({ error: expect.stringMatching(/only works in a checkout of Anvil itself/) });
      ports.running = false;
      expect(await svc.start(session())).toEqual({ error: expect.stringMatching(/agent browser is not running for this session/) });
      expect(runner.builds).toEqual([]);
      expect(runner.starts).toEqual([]);
      expect(log).toEqual([]);
      expect(svc.count()).toBe(0);
    } finally {
      rmSync(notAnvil, { recursive: true, force: true });
    }
  });
});

describe("a start that fails leaves nothing behind", () => {
  const leftovers = (): string[] => [...runner.builds.map((b) => b.opts.env.HOME!), ...runner.starts.map((s) => s.opts.env.HOME!)].filter((h) => existsSync(h));

  test("[C4] a failed build starts no daemon, registers no port and deletes the temporary home; the error carries the build's output", async () => {
    runner.buildResult = { ok: false, output: "error: Could not resolve ./missing" };
    const out = await svc.start(session());
    expect(out).toEqual({ error: expect.stringMatching(/did not build[\s\S]*Could not resolve \.\/missing/) });
    expect(runner.starts).toEqual([]);
    expect(log).toEqual([]);
    expect(leftovers()).toEqual([]);
    expect(svc.count()).toBe(0);
    expect(timers.timers).toEqual([]);
  });

  test("[C4] a port that cannot be registered (this daemon's own, another session's) is never started on", async () => {
    ports.refuse = "that is this daemon's own port";
    const out = await svc.start(session());
    expect(out).toEqual({ error: expect.stringMatching(/port could not be used \(that is this daemon's own port\)/) });
    expect(runner.starts).toEqual([]);
    expect(log.filter((l) => l.startsWith("allow"))).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  test("[C4] a daemon that exits while starting, or never answers /api/health, is killed, its port revoked without ever being opened, and its home deleted", async () => {
    runner.exitAtOnce = true;
    const died = await svc.start(session());
    expect(died).toEqual({ error: expect.stringMatching(/exited while starting[\s\S]*fake stderr tail/) });
    runner.exitAtOnce = false;
    runner.listen = false;
    svc = make({ startTimeoutMs: 400, healthy: async () => false, sleep: async () => new Promise((r) => setTimeout(r, 20)) });
    const silent = await svc.start(session("s2"));
    expect(silent).toEqual({ error: expect.stringMatching(/did not answer \/api\/health/) });
    expect(runner.starts).toHaveLength(2);
    expect(runner.starts.every((s) => s.proc.killed)).toBe(true);
    expect(log.filter((l) => l.startsWith("allow"))).toEqual([]);
    expect(log.filter((l) => l.startsWith("revoke")).length).toBe(2);
    expect(leftovers()).toEqual([]);
    expect(svc.count()).toBe(0);
  });

  test("[C4] a daemon whose port cannot be opened in the session's proxy is killed and deleted, and the call fails", async () => {
    ports.allow = false;
    const out = await svc.start(session());
    expect(out).toEqual({ error: expect.stringMatching(/could not be opened in this session's browser proxy/) });
    expect(runner.starts[0]!.proc.killed).toBe(true);
    expect(leftovers()).toEqual([]);
    expect(svc.origin("s1")).toBeUndefined();
  });

  test("[C4] a stop that arrives while the bundle is still building cancels the start: no daemon is started and the home is deleted", async () => {
    let release!: () => void;
    runner.holdBuild = new Promise<void>((r) => (release = r));
    const pending = svc.start(session());
    await new Promise((r) => setTimeout(r, 10));
    expect(svc.stop("s1", "the turn ended")).toBe(true);
    release();
    expect(await pending).toEqual({ error: expect.stringMatching(/stopped while it was starting/) });
    expect(runner.starts).toEqual([]);
    expect(leftovers()).toEqual([]);
    expect(stopped).toEqual([]); // it never became a page origin
  });
});

describe("ending", () => {
  test("[C4] stop revokes the port, kills the process group and deletes the temporary home at once, clears the timer, and reports the origin that is gone; a second stop is a no-op", async () => {
    const out = (await svc.start(session())) as { url: string };
    const s = runner.starts[0]!;
    const home = s.opts.env.HOME!;
    const port = Number(s.opts.env.ANVIL_PORT);
    writeFileSync(join(home, "state.json"), "{}");
    log.length = 0;

    expect(svc.stop("s1", "the turn ended")).toBe(true);
    expect(log).toEqual([`revoke s1 ${port}`]);
    expect(s.proc.killed).toBe(true);
    expect(existsSync(home)).toBe(false);
    expect(timers.timers[0]!.cleared).toBe(true);
    expect(svc.origin("s1")).toBeUndefined();
    expect(stopped).toEqual([["s1", out.url, "the turn ended"]]);
    expect(svc.stop("s1", "again")).toBe(false);
    // The next start is a new daemon in a new home.
    const next = (await svc.start(session())) as { url: string; existing: boolean };
    expect(next.existing).toBe(false);
    expect(runner.starts[1]!.opts.env.HOME).not.toBe(home);
  });

  test("[C4] the 15-minute timer stops the daemon by itself and says so in the session; stopping first disarms it", async () => {
    await svc.start(session());
    const s = runner.starts[0]!;
    expect(timers.timers[0]!.ms).toBe(15 * 60_000);
    expect(timers.fire()).toBe(1); // 15 minutes pass
    expect(s.proc.killed).toBe(true);
    expect(existsSync(s.opts.env.HOME!)).toBe(false);
    expect(svc.count()).toBe(0);
    expect(stopped.map((x) => x[2])).toEqual(["its 15 minutes are up"]);
    expect(notices).toEqual([expect.stringMatching(/^s1: .*test daemon was stopped: its 15 minutes are up/)]);

    await svc.start(session("s2"));
    svc.stop("s2", "stop_test_daemon was called");
    expect(timers.fire()).toBe(0); // nothing left to fire
    expect(notices).toHaveLength(1);
  });

  test("[C4] stopAll (daemon shutdown) ends every session's test daemon; a daemon that exits by itself is cleaned up the same way", async () => {
    await svc.start(session("s1"));
    await svc.start(session("s2"));
    await svc.start(session("s3"));
    runner.starts[2]!.proc.killGroup(); // s3's daemon dies on its own
    await new Promise((r) => setTimeout(r, 5));
    expect(svc.origin("s3")).toBeUndefined();
    expect(existsSync(runner.starts[2]!.opts.env.HOME!)).toBe(false);
    expect(stopped.map((x) => [x[0], x[2]])).toEqual([["s3", "it exited"]]);

    svc.stopAll();
    expect(runner.starts.every((s) => s.proc.killed)).toBe(true);
    expect(runner.starts.filter((s) => existsSync(s.opts.env.HOME!))).toEqual([]);
    expect(svc.count()).toBe(0);
    expect(log.filter((l) => l.startsWith("revoke")).length).toBe(3);
  });
});

describe("the crash ledger", () => {
  test("[C4] a started daemon with a real pid is listed in <stateDir>/testdaemons.json and removed from it when stopped", async () => {
    const pid = 99_999_999; // not a pid any process can have
    const real = fakeRunner();
    const spawn = real.spawn.bind(real);
    real.spawn = (c, a, o) => Object.assign(spawn(c, a, o), { pid });
    svc = make({ runner: real });
    await svc.start(session());
    const home = real.starts[0]!.opts.env.HOME!;
    expect(JSON.parse(readFileSync(join(stateDir, TEST_DAEMON_LEDGER), "utf8"))).toEqual([{ pid, home }]);
    svc.stop("s1", "done");
    expect(existsSync(join(stateDir, TEST_DAEMON_LEDGER))).toBe(false);
    homes.push(home);
  });

  test("[C4] reapOrphans deletes a home a crashed run left behind, asks what the pid is before signalling it, and ignores rows that do not name a folder this code made", () => {
    const orphan = realpathSync(mkdtempSync(join(tmpdir(), TEST_DAEMON_HOME_PREFIX)));
    writeFileSync(join(orphan, ".anvil-test-daemon"), "");
    mkdirSync(join(orphan, "state"));
    const notOurs = realpathSync(mkdtempSync(join(tmpdir(), "anvil-c4-precious-")));
    const unmarked = realpathSync(mkdtempSync(join(tmpdir(), TEST_DAEMON_HOME_PREFIX))); // right name, no marker
    writeFileSync(join(stateDir, TEST_DAEMON_LEDGER), JSON.stringify([{ pid: 99_999_999, home: orphan }, { pid: 99_999_998, home: notOurs }, { pid: 99_999_997, home: unmarked }, { pid: 1, home: orphan }, "junk", { home: 3 }]));
    const asked: number[] = [];
    try {
      expect(svc.reapOrphans((pid) => (asked.push(pid), "some unrelated program"))).toBe(1); // never "src/main.ts" → nothing is signalled
      expect(asked).toEqual([99_999_999]);
      expect(existsSync(orphan)).toBe(false);
      expect(existsSync(notOurs)).toBe(true);
      expect(existsSync(unmarked)).toBe(true);
      expect(existsSync(join(stateDir, TEST_DAEMON_LEDGER))).toBe(false);
      expect(svc.reapOrphans()).toBe(0); // no ledger, nothing to do
      expect(readdirSync(stateDir)).toEqual([]);
    } finally {
      for (const d of [orphan, notOurs, unmarked]) rmSync(d, { recursive: true, force: true });
    }
  });
});
