/**
 * [Phase 3 / BE-7] TerminalManager is extracted from supervisor.ts, where the PTY channel was inline
 * (real Bun.Terminal + spawn) and therefore untestable. With an injected spawn factory the full
 * lifecycle is now unit-testable: open/reopen, scrollback accumulation + cap, data/exit emission,
 * input/resize/kill, and shutdown. These tests pin the behavior the extraction must preserve.
 */
import { test, expect } from "bun:test";
import { TerminalManager, cttyArgv, type SpawnTerminal, type TerminalSession } from "../../src/session/terminal-manager";

test("cttyArgv wraps the shell so it acquires a controlling TTY (job control)", () => {
  expect(cttyArgv("linux", "/bin/bash")).toEqual(["setsid", "--ctty", "--wait", "/bin/bash"]);
  expect(cttyArgv("darwin", "/bin/zsh")).toEqual(["script", "-q", "/dev/null", "/bin/zsh"]);
  expect(cttyArgv("win32", "/bin/sh")).toEqual(["/bin/sh"]); // unknown platform → unwrapped
});

function fakeSession(cwd = "/tmp/wt") {
  const events: Array<{ type: string; data?: string; code?: number; termId?: string }> = [];
  const session: TerminalSession = { cwd, emit: (e) => events.push(e) };
  return { session, events };
}

function fakeSpawn() {
  const created: Array<{
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
    onData: (b: Uint8Array) => void;
    pty: { resized: Array<[number, number]>; writes: Buffer[]; closed: boolean };
    exit: (code: number | null) => void;
  }> = [];
  const spawn: SpawnTerminal = ({ cols, rows, cwd, env, onData }) => {
    let resolveExit!: (c: number | null) => void;
    const proc = { exited: new Promise<number | null>((r) => (resolveExit = r)) };
    const pty = {
      resized: [] as Array<[number, number]>,
      writes: [] as Buffer[],
      closed: false,
      resize(c: number, r: number) {
        this.resized.push([c, r]);
      },
      write(b: Buffer) {
        this.writes.push(b);
      },
      close() {
        this.closed = true;
      },
    };
    created.push({ cols, rows, cwd, env, onData, pty, exit: resolveExit });
    return { pty, proc };
  };
  return { spawn, created };
}

const mgrWith = (session: TerminalSession, spawn: SpawnTerminal) =>
  new TerminalManager((_id) => session, () => ({ FOO: "bar" }), undefined, spawn);

function mgrWithRoster(session: TerminalSession, spawn: SpawnTerminal) {
  const rosters: Array<{ sessionId: string; terminals: { id: string; title: string }[] }> = [];
  const mgr = new TerminalManager((_id) => session, () => ({}), (sessionId, terminals) => rosters.push({ sessionId, terminals }), spawn);
  return { mgr, rosters };
}

test("open spawns a PTY with the session cwd + agent env (plus TERM) and tracks it", () => {
  const { session } = fakeSession("/repo/wt");
  const { spawn, created } = fakeSpawn();
  const mgr = mgrWith(session, spawn);

  mgr.open("s1", 80, 24);
  expect(created.length).toBe(1);
  expect(created[0]!.cwd).toBe("/repo/wt");
  expect(created[0]!.cols).toBe(80);
  expect(created[0]!.env.FOO).toBe("bar");
  expect(created[0]!.env.TERM).toBe("xterm-256color");
  expect(mgr.has("s1")).toBe(true);
});

test("re-opening an existing terminal resizes and replays scrollback without spawning again", () => {
  const { session, events } = fakeSession();
  const { spawn, created } = fakeSpawn();
  const mgr = mgrWith(session, spawn);

  mgr.open("s1", 80, 24);
  created[0]!.onData(new TextEncoder().encode("hello")); // produce some scrollback
  events.length = 0;

  mgr.open("s1", 100, 30);
  expect(created.length).toBe(1); // no second spawn
  expect(created[0]!.pty.resized.at(-1)).toEqual([100, 30]);
  const replay = events.find((e) => e.type === "terminal.data");
  expect(Buffer.from(replay!.data!, "base64").toString()).toBe("hello");
});

test("PTY data is emitted base64 and scrollback is capped at 256KB", () => {
  const { session, events } = fakeSession();
  const { spawn, created } = fakeSpawn();
  const mgr = mgrWith(session, spawn);
  mgr.open("s1", 80, 24);

  created[0]!.onData(new TextEncoder().encode("abc"));
  const emitted = events.find((e) => e.type === "terminal.data");
  expect(Buffer.from(emitted!.data!, "base64").toString()).toBe("abc");

  created[0]!.onData(new Uint8Array(300_000)); // exceed the 256KB cap
  events.length = 0;
  mgr.open("s1", 80, 24); // reopen → replays scrollback
  const replay = events.find((e) => e.type === "terminal.data");
  expect(Buffer.from(replay!.data!, "base64").length).toBeLessThanOrEqual(262_144);
});

test("PTY exit emits terminal.exit and drops the session", async () => {
  const { session, events } = fakeSession();
  const { spawn, created } = fakeSpawn();
  const mgr = mgrWith(session, spawn);
  mgr.open("s1", 80, 24);

  created[0]!.exit(137);
  await Promise.resolve(); // let the exited.then fire
  await Promise.resolve();
  expect(events.some((e) => e.type === "terminal.exit" && e.code === 137)).toBe(true);
  expect(mgr.has("s1")).toBe(false);
});

test("input writes base64-decoded bytes; resize resizes; both no-op on an unknown session", () => {
  const { session } = fakeSession();
  const { spawn, created } = fakeSpawn();
  const mgr = mgrWith(session, spawn);
  mgr.open("s1", 80, 24);

  mgr.input("s1", Buffer.from("xy").toString("base64"));
  expect(created[0]!.pty.writes.at(-1)!.toString()).toBe("xy");
  mgr.resize("s1", 120, 40);
  expect(created[0]!.pty.resized.at(-1)).toEqual([120, 40]);

  expect(() => mgr.input("nope", "AA==")).not.toThrow();
  expect(() => mgr.resize("nope", 1, 1)).not.toThrow();
});

test("kill closes the PTY and removes it; killAll clears everything", () => {
  const { session } = fakeSession();
  const { spawn, created } = fakeSpawn();
  const mgr = new TerminalManager((_id) => session, () => ({}), undefined, spawn);

  mgr.open("s1", 80, 24);
  mgr.open("s2", 80, 24);
  mgr.kill("s1");
  expect(created[0]!.pty.closed).toBe(true);
  expect(mgr.has("s1")).toBe(false);
  expect(mgr.has("s2")).toBe(true);

  mgr.killAll();
  expect(created[1]!.pty.closed).toBe(true);
  expect(mgr.has("s2")).toBe(false);
});

test("two terminals on one session: independent PTYs, scrollback, and routed input", () => {
  const { session, events } = fakeSession();
  const { spawn, created } = fakeSpawn();
  const mgr = mgrWith(session, spawn);
  mgr.open("s1", 80, 24);           // default "1"
  mgr.open("s1", 80, 24, "2");
  expect(created.length).toBe(2);
  mgr.input("s1", Buffer.from("a").toString("base64"), "2");
  expect(created[1]!.pty.writes.length).toBe(1);
  expect(created[0]!.pty.writes.length).toBe(0);
  created[1]!.onData(new TextEncoder().encode("two"));
  const ev = events.findLast((e) => e.type === "terminal.data");
  expect(ev!.termId).toBe("2");
  events.length = 0;
  mgr.open("s1", 80, 24, "2");      // reopen replays only term 2's scrollback
  const replay = events.find((e) => e.type === "terminal.data");
  expect(Buffer.from(replay!.data!, "base64").toString()).toBe("two");
});

test("closeOne kills a single terminal and fires the roster; kill(session) reaps all", () => {
  const { session } = fakeSession();
  const { spawn, created } = fakeSpawn();
  const { mgr, rosters } = mgrWithRoster(session, spawn);
  mgr.open("s1", 80, 24);
  mgr.open("s1", 80, 24, "2");
  expect(rosters.at(-1)!.terminals.map((t) => t.id)).toEqual(["1", "2"]);
  mgr.closeOne("s1", "1");
  expect(created[0]!.pty.closed).toBe(true);
  expect(mgr.has("s1", "1")).toBe(false);
  expect(mgr.has("s1", "2")).toBe(true);
  expect(rosters.at(-1)!.terminals.map((t) => t.id)).toEqual(["2"]);
  mgr.kill("s1");
  expect(created[1]!.pty.closed).toBe(true);
  expect(rosters.at(-1)!.terminals).toEqual([]);
});

test("PTY exit updates the roster and carries its termId", async () => {
  const { session, events } = fakeSession();
  const { spawn, created } = fakeSpawn();
  const { mgr, rosters } = mgrWithRoster(session, spawn);
  mgr.open("s1", 80, 24, "3");
  created[0]!.exit(0);
  await Promise.resolve();
  await Promise.resolve();
  expect(events.some((e) => e.type === "terminal.exit" && e.termId === "3")).toBe(true);
  expect(rosters.at(-1)!.terminals).toEqual([]);
  expect(mgr.has("s1", "3")).toBe(false);
});

test("terminal cap: the 9th open throws BadCommand", () => {
  const { session } = fakeSession();
  const { spawn } = fakeSpawn();
  const mgr = mgrWith(session, spawn);
  for (let i = 1; i <= 8; i++) mgr.open("s1", 80, 24, String(i));
  expect(() => mgr.open("s1", 80, 24, "9")).toThrow(/8 terminals/);
});
