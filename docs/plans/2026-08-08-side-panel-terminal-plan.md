# Side Panel Pin + Terminal Overhaul — Implementation Plan

**Goal:** Fix terminal job control (^C), selection visibility, copy/paste; add multi-terminal with kill/respawn; add desktop-only panel pinning as a split view — one PR, phone layout untouched.
**Architecture:** Daemon fix in `TerminalManager` (PTY gets a controlling TTY via a ctty wrapper; terminals keyed by `(sessionId, termId)` with a roster on `Session`); additive protocol fields only; web changes confined to `panel.ts`/`main.ts`/`app.css`/`index.html` with all pin/split CSS behind the 700px desktop breakpoint.
**Tech Stack:** Bun/TypeScript daemon, xterm.js 6 web client, bun:test.
**Design:** `docs/plans/2026-08-08-side-panel-terminal-design.md` (approved 2026-08-08).

Worktree note: run all daemon commands from `anvild/`. CI gates: `bun run typecheck`, `bun run typecheck:web`, `bun run build:web`, `bun test` — all four must stay green.

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | Branch + Bun job-control spike | pending | no | no |
| 2 | ctty wrapper (`cttyArgv`) — TDD | pending | no | no |
| 3 | Protocol: additive `termId` + `Session.terminals` + contract test | pending | no | no |
| 4 | TerminalManager multi-terminal — TDD | pending | no | no |
| 5 | Supervisor + dispatch wiring, restore() roster clear | pending | no | no |
| 6 | Web: selection theme + copy-on-select + right-click paste | pending | no | no |
| 7 | Web: terminal chip strip + termId routing | pending | no | no |
| 8 | Web: pin + split view (desktop-gated) | pending | no | no |
| 9 | Full gates + live daemon acceptance + phone-layout proof | pending | no | no |
| 10 | Push branch, open upstream PR | pending | no | no |

---

### Task 1: Branch + Bun job-control spike

**Files:** none committed (spike runs from the scratchpad).

**Step 1: Create the feature branch, restore main**

The design-doc commit (`1807f18`) currently sits on local `main`, unpushed. Move it onto the feature branch and put `main` back on `origin/main`:

```sh
cd /home/stonelyd/anvil
git checkout -b feat/side-panel-terminal
git branch -f main origin/main
git log --oneline -1   # expect: 1807f18 docs: design for side-panel pin + terminal overhaul
```

**Step 2: Spike — does Bun 1.3.14 give the shell a controlling TTY?**

Write `/tmp/spike-pty.ts` (anywhere outside the repo):

```ts
// Does a shell under Bun.Terminal get job control? (design 2026-08-08, phase 1 spike)
const out: Buffer[] = [];
const BunAny = Bun as any;
const term = new BunAny.Terminal({ cols: 80, rows: 24, data: (_t: unknown, b: Uint8Array) => out.push(Buffer.from(b)) });
const proc = BunAny.spawn(["/bin/bash"], { terminal: term, env: { ...process.env, TERM: "xterm-256color" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await sleep(600);
term.write(Buffer.from("sleep 30\n"));
await sleep(600);
term.write(Buffer.from("\x03")); // ^C
await sleep(800);
term.write(Buffer.from("echo BACK:$?\n"));
await sleep(600);
const text = Buffer.concat(out).toString();
console.log(text);
console.log(text.includes("BACK:130") ? "JOB CONTROL OK" : "NO JOB CONTROL");
proc.kill?.();
process.exit(0);
```

Run: `bun /tmp/spike-pty.ts`

Expected (based on the live repro on both fleet hosts): output contains `bash: no job control in this shell` and final line `NO JOB CONTROL` → proceed with Task 2 as written.

Contingency: if it prints `JOB CONTROL OK`, the fleet daemons are on an older Bun than local — still implement Task 2 (the wrapper is harmless when job control already works: it only wraps when the binary exists), but note the finding in the PR body.

---

### Task 2: ctty wrapper — TDD

**Files:**
- Modify: `anvild/src/session/terminal-manager.ts` (the `defaultSpawnTerminal` block, lines ~34-44)
- Test: `anvild/test/unit/terminal-manager.test.ts` (append)

**Step 1: Write failing test** — append to `terminal-manager.test.ts`:

```ts
import { cttyArgv } from "../../src/session/terminal-manager";

test("cttyArgv wraps the shell so it acquires a controlling TTY (job control)", () => {
  expect(cttyArgv("linux", "/bin/bash")).toEqual(["setsid", "--ctty", "--wait", "/bin/bash"]);
  expect(cttyArgv("darwin", "/bin/zsh")).toEqual(["script", "-q", "/dev/null", "/bin/zsh"]);
  expect(cttyArgv("win32", "/bin/sh")).toEqual(["/bin/sh"]); // unknown platform → unwrapped
});
```

**Step 2: Run, verify failure**

Run: `cd anvild && bun test test/unit/terminal-manager.test.ts`
Expected: FAIL — `cttyArgv` is not exported.

**Step 3: Implement** — in `terminal-manager.ts`, above `defaultSpawnTerminal`, add:

```ts
/** Wrap the shell so it starts as a session leader with the PTY slave as its controlling TTY.
 *  Bun.spawn({terminal}) attaches the PTY as stdio only — without a ctty the line discipline has
 *  no foreground process group, so ^C's SIGINT is delivered to nobody ("bash: no job control in
 *  this shell"; zsh degrades silently). Verified live on both fleet hosts (design 2026-08-08). */
export function cttyArgv(platform: string, shell: string): string[] {
  if (platform === "linux") return ["setsid", "--ctty", "--wait", shell];
  if (platform === "darwin") return ["script", "-q", "/dev/null", shell];
  return [shell];
}
```

and change the spawn line inside `defaultSpawnTerminal` from

```ts
  const proc = BunAny.spawn([shell], { terminal: term, cwd, env });
```

to

```ts
  let proc: { exited: Promise<number | null> };
  try {
    proc = BunAny.spawn(cttyArgv(process.platform, shell), { terminal: term, cwd, env });
  } catch {
    // setsid/script binary missing — degrade to the ctty-less spawn (terminal works, no job control)
    proc = BunAny.spawn([shell], { terminal: term, cwd, env });
  }
```

**Step 4: Run, verify pass**

Run: `bun test test/unit/terminal-manager.test.ts` → PASS. Also `bun run typecheck` → clean.

**Step 5: Commit**

`git add -A && git commit -m "fix(terminal): give the PTY shell a controlling TTY so ^C delivers SIGINT"`

---

### Task 3: Protocol — additive `termId` + `Session.terminals`

**Files:**
- Modify: `docs/plans/anvil-protocol.ts` (edits land in `anvild/protocol.ts` via the symlink)
- Create: `anvild/test/contract/terminal-additive.test.ts`

**Step 1: Protocol edits.** In §4d (`TerminalDataEvent`/`TerminalExitEvent`, near line 990) add to **both** interfaces:

```ts
  termId?: string; // multi-terminal (design 2026-08-08); absent = "1", the pre-multi-term default
```

In §5d (near line 1441) add the same `termId?: string;` line to `TerminalOpenCmd`, `TerminalInputCmd`, `TerminalResizeCmd`, and `TerminalCloseCmd`. On `TerminalCloseCmd`, also update its comment: closing now **kills** that PTY (kill/respawn escape hatch) — safe because no released client ever sent `terminal.close`.

In `Session` (near line 250), after `accountMissing?`, add:

```ts
  /** Live terminal roster for this session's chip strip (multi-terminal, design 2026-08-08).
   *  Runtime-only — cleared on daemon restart (the PTYs die with the process). Additive. */
  terminals?: TerminalInfo[];
```

and next to `Session` declare:

```ts
/** One live PTY of a session (multi-terminal). */
export interface TerminalInfo {
  id: string; // client-chosen, numeric-string ("1", "2", …); "1" is the default terminal
  title: string; // shell basename, e.g. "zsh"
}
```

**Step 2: Contract test** — create `anvild/test/contract/terminal-additive.test.ts`:

```ts
/** Design 2026-08-08: multi-terminal protocol fields are ADDITIVE (no version bump). A v4 client
 *  that omits `termId` must still satisfy the types, and `Session.terminals` must stay optional —
 *  this test failing to COMPILE is the guard. */
import { test, expect } from "bun:test";
import { PROTOCOL_VERSION } from "../../protocol";
import type { TerminalOpenCmd, TerminalInputCmd, TerminalResizeCmd, TerminalCloseCmd, TerminalDataEvent, TerminalExitEvent } from "../../protocol";

test("terminal.* messages compile without termId; version stays 4", () => {
  const open: TerminalOpenCmd = { v: PROTOCOL_VERSION, type: "terminal.open", ts: "t", sessionId: "s", cols: 80, rows: 24 };
  const input: TerminalInputCmd = { v: PROTOCOL_VERSION, type: "terminal.input", ts: "t", sessionId: "s", data: "" };
  const resize: TerminalResizeCmd = { v: PROTOCOL_VERSION, type: "terminal.resize", ts: "t", sessionId: "s", cols: 80, rows: 24 };
  const close: TerminalCloseCmd = { v: PROTOCOL_VERSION, type: "terminal.close", ts: "t", sessionId: "s" };
  const data: TerminalDataEvent = { v: PROTOCOL_VERSION, type: "terminal.data", ts: "t", sessionId: "s", seq: 1, data: "" };
  const exit: TerminalExitEvent = { v: PROTOCOL_VERSION, type: "terminal.exit", ts: "t", sessionId: "s", seq: 2, code: 0 };
  for (const m of [open, input, resize, close, data, exit]) expect(m.termId).toBeUndefined();
  expect(PROTOCOL_VERSION).toBe(4);
});
```

Note: if `TerminalDataEvent`'s envelope fields differ (check `SessionScoped`/`Envelope` in the protocol file — `seq` may be optional), adjust the literals to the **minimum required** fields; the point is compiling without `termId`.

**Step 3: Verify**

Run: `bun test test/contract/` → all pass (including the existing surface/wire-shape pins). `bun run typecheck` → clean.

**Step 4: Commit**

`git commit -am "feat(protocol): additive termId + Session.terminals roster for multi-terminal"`

---

### Task 4: TerminalManager multi-terminal — TDD

**Files:**
- Modify: `anvild/src/session/terminal-manager.ts` (class rewrite; keep `SpawnTerminal`/`TerminalPty`/`TerminalHandle`/`cttyArgv` as-is)
- Modify: `anvild/test/unit/terminal-manager.test.ts`

**Step 1: Update the test file.** The constructor gains an `onRoster` callback as the 3rd arg (spawn moves to 4th); `TerminalSession.emit` bodies gain `termId`. Update the helpers and add multi-term tests:

- Change `fakeSession` events type to `Array<{ type: string; data?: string; code?: number; termId?: string }>`.
- Change `mgrWith` to `new TerminalManager((_id) => session, () => ({ FOO: "bar" }), undefined, spawn)` (and the inline `new TerminalManager` in the kill test likewise).
- Existing tests keep passing untouched otherwise (no `termId` argument = default `"1"`).

Append:

```ts
function mgrWithRoster(session: TerminalSession, spawn: SpawnTerminal) {
  const rosters: Array<{ sessionId: string; terminals: { id: string; title: string }[] }> = [];
  const mgr = new TerminalManager((_id) => session, () => ({}), (sessionId, terminals) => rosters.push({ sessionId, terminals }), spawn);
  return { mgr, rosters };
}

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
```

**Step 2: Run, verify failure**

Run: `bun test test/unit/terminal-manager.test.ts`
Expected: FAIL — constructor arity, `closeOne`/`has(termId)` missing, no `termId` on events.

**Step 3: Implement.** Rewrite the class in `terminal-manager.ts` (keep header comment, interfaces, `SCROLLBACK_CAP`, `cttyArgv`, `defaultSpawnTerminal`; widen `TerminalSession.emit` bodies with `termId?: string`; add `import { BadCommand } from "./errors";`):

```ts
const MAX_TERMINALS = 8; // per session (design 2026-08-08)
export const DEFAULT_TERM_ID = "1"; // what an absent wire termId means (pre-multi-term clients)

export class TerminalManager {
  /** sessionId → termId → live PTY record. */
  private readonly terminals = new Map<string, Map<string, { pty: TerminalPty; scrollback: Buffer }>>();
  private readonly shellTitle = (process.env.SHELL || "/bin/zsh").split("/").pop() || "shell";

  constructor(
    private readonly resolve: (sessionId: string) => TerminalSession,
    private readonly agentEnv: (sessionId: string) => Record<string, string>,
    /** Roster fan-out — fires after every open/exit/close so the Session's chip strip stays live. */
    private readonly onRoster: (sessionId: string, terminals: { id: string; title: string }[]) => void = () => {},
    private readonly spawn: SpawnTerminal = defaultSpawnTerminal,
  ) {}

  roster(sessionId: string): { id: string; title: string }[] {
    const terms = this.terminals.get(sessionId);
    if (!terms) return [];
    return [...terms.keys()].sort((a, b) => Number(a) - Number(b)).map((id) => ({ id, title: this.shellTitle }));
  }

  has(sessionId: string, termId: string = DEFAULT_TERM_ID): boolean {
    return this.terminals.get(sessionId)?.has(termId) ?? false;
  }

  open(sessionId: string, cols: number, rows: number, termId: string = DEFAULT_TERM_ID): void {
    const s = this.resolve(sessionId);
    let terms = this.terminals.get(sessionId);
    const existing = terms?.get(termId);
    if (existing) {
      if (existing.scrollback.length) s.emit({ type: "terminal.data", data: existing.scrollback.toString("base64"), termId });
      try {
        existing.pty.resize(cols, rows);
      } catch {
        /* pty gone */
      }
      return;
    }
    if ((terms?.size ?? 0) >= MAX_TERMINALS) throw new BadCommand(`this session already has ${MAX_TERMINALS} terminals — close one first`);
    if (!terms) {
      terms = new Map();
      this.terminals.set(sessionId, terms);
    }
    const rec: { pty: TerminalPty; scrollback: Buffer } = { pty: null as unknown as TerminalPty, scrollback: Buffer.alloc(0) };
    const handle = this.spawn({
      cols,
      rows,
      cwd: s.cwd,
      env: { ...this.agentEnv(sessionId), TERM: "xterm-256color" }, // TERM is a terminal concern, set here
      onData: (bytes) => {
        const buf = Buffer.from(bytes);
        rec.scrollback = Buffer.concat([rec.scrollback, buf]);
        if (rec.scrollback.length > SCROLLBACK_CAP) rec.scrollback = rec.scrollback.subarray(rec.scrollback.length - SCROLLBACK_CAP);
        s.emit({ type: "terminal.data", data: buf.toString("base64"), termId });
      },
    });
    rec.pty = handle.pty;
    terms.set(termId, rec);
    handle.proc.exited.then((code) => {
      s.emit({ type: "terminal.exit", code: code ?? 0, termId });
      this.drop(sessionId, termId);
      this.onRoster(sessionId, this.roster(sessionId));
    });
    this.onRoster(sessionId, this.roster(sessionId));
  }

  input(sessionId: string, dataBase64: string, termId: string = DEFAULT_TERM_ID): void {
    try {
      this.terminals.get(sessionId)?.get(termId)?.pty.write(Buffer.from(dataBase64, "base64"));
    } catch {
      /* no pty */
    }
  }

  resize(sessionId: string, cols: number, rows: number, termId: string = DEFAULT_TERM_ID): void {
    try {
      this.terminals.get(sessionId)?.get(termId)?.pty.resize(cols, rows);
    } catch {
      /* no pty */
    }
  }

  /** Kill ONE terminal (the chip-strip ×): the client's kill/respawn escape hatch for wedged shells. */
  closeOne(sessionId: string, termId: string = DEFAULT_TERM_ID): void {
    const t = this.terminals.get(sessionId)?.get(termId);
    if (!t) return;
    try {
      t.pty.close();
    } catch {
      /* already closed */
    }
    this.drop(sessionId, termId);
    this.onRoster(sessionId, this.roster(sessionId));
  }

  /** Reap every terminal of one session (session kill/archive/reset). */
  kill(sessionId: string): void {
    const terms = this.terminals.get(sessionId);
    if (!terms) return;
    for (const t of terms.values()) {
      try {
        t.pty.close();
      } catch {
        /* already closed */
      }
    }
    this.terminals.delete(sessionId);
    this.onRoster(sessionId, []);
  }

  /** Reap every terminal (shutdown). */
  killAll(): void {
    for (const id of [...this.terminals.keys()]) this.kill(id);
  }

  private drop(sessionId: string, termId: string): void {
    const terms = this.terminals.get(sessionId);
    terms?.delete(termId);
    if (terms && terms.size === 0) this.terminals.delete(sessionId);
  }
}
```

**Step 4: Run, verify pass**

Run: `bun test test/unit/terminal-manager.test.ts` → PASS (old + new). `bun run typecheck` → clean (supervisor still compiles: its 2-arg construction gets the default `onRoster`; `emit` bodies now allow `termId`).

**Step 5: Commit**

`git commit -am "feat(terminal): multi-terminal TerminalManager — per-termId PTYs, roster callback, closeOne, cap 8"`

---

### Task 5: Supervisor + dispatch wiring

**Files:**
- Modify: `anvild/src/session/supervisor.ts:1160-1178` (terminalMgr construction + delegates), `:1877-1890` (restore)
- Modify: `anvild/src/server/dispatch.ts:467-480`

**Step 1: Supervisor.** Replace the terminalMgr construction + delegates (lines ~1162-1178) with:

```ts
  private readonly terminalMgr = new TerminalManager(
    (sessionId) => {
      const s = this.require(sessionId);
      return { cwd: s.data.cwd, emit: (body) => s.emit(body) };
    },
    (sessionId) => this.shellEnv(this.sessions.get(sessionId)),
    (sessionId, terminals) => {
      // The roster rides the Session (additive `terminals`, design 2026-08-08) so every device's
      // chip strip stays live. Runtime-only: restore() clears it — PTYs die with the process.
      const s = this.sessions.get(sessionId);
      if (!s) return; // roster change raced a session kill
      s.data.terminals = terminals.length ? terminals : undefined;
      this.broadcastUpdated(s.data);
    },
  );

  terminalOpen(sessionId: string, cols: number, rows: number, termId?: string): void {
    this.terminalMgr.open(sessionId, cols, rows, termId);
  }
  terminalInput(sessionId: string, dataBase64: string, termId?: string): void {
    this.terminalMgr.input(sessionId, dataBase64, termId);
  }
  terminalResize(sessionId: string, cols: number, rows: number, termId?: string): void {
    this.terminalMgr.resize(sessionId, cols, rows, termId);
  }
  /** Kill one PTY (chip ×) — the client's respawn escape hatch for a wedged shell. */
  terminalClose(sessionId: string, termId?: string): void {
    this.terminalMgr.closeOne(sessionId, termId);
  }
```

Note: `open(id, c, r, undefined)` hits the manager's `= DEFAULT_TERM_ID` default — no branching needed.

In `restore()` (line ~1887), directly after `if (interrupted) p.data.status = "idle";` add:

```ts
        p.data.terminals = undefined; // terminal roster is runtime state — the PTYs died with the old process
```

**Step 2: Dispatch.** In `dispatch.ts` update the four cases (lines ~467-480):

```ts
      case "terminal.open":
        deps.supervisor.terminalOpen(cmd.sessionId, cmd.cols, cmd.rows, cmd.termId);
        if (cid) send(ack(cid));
        return;
      case "terminal.input":
        deps.supervisor.terminalInput(cmd.sessionId, cmd.data, cmd.termId);
        return;
      case "terminal.resize":
        deps.supervisor.terminalResize(cmd.sessionId, cmd.cols, cmd.rows, cmd.termId);
        return;
      case "terminal.close":
        // Kills the PTY (kill/respawn escape hatch, design 2026-08-08). Previously a documented
        // no-op that no released client ever sent, so repurposing it is not a breaking change.
        deps.supervisor.terminalClose(cmd.sessionId, cmd.termId);
        if (cid) send(ack(cid));
        return;
```

BadCommand from the cap propagates through dispatch's outer catch → `command.error` → the web client's `error` toast; no extra handling needed.

**Step 3: Verify**

Run: `bun run typecheck && bun test`
Expected: clean + full suite green (supervisor guard tests + terminal tests included).

**Step 4: Commit**

`git commit -am "feat(daemon): wire termId through supervisor/dispatch; terminal.close now kills the PTY"`

---

### Task 6: Web — selection theme + copy/paste

**Files:**
- Modify: `anvild/web/src/panel.ts` (inside `mountTerminal`'s async block, lines ~176-213)

**Step 1: Theme.** Replace the `new Terminal({...})` theme lines with:

```ts
    xterm = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      // selectionBackground is REQUIRED: without it xterm resolves selection to white-on-white and
      // the DOM renderer paints selected glyph cells invisibly (live debug, design 2026-08-08).
      theme: dark
        ? { background: "#1a1b1e", foreground: "#e6e7e9", selectionBackground: "rgba(107,155,255,0.35)", selectionInactiveBackground: "rgba(107,155,255,0.18)" }
        : { background: "#ffffff", foreground: "#1c2024", selectionBackground: "rgba(59,110,245,0.30)", selectionInactiveBackground: "rgba(59,110,245,0.15)" },
    });
```

**Step 2: Copy + paste wiring.** After the `xterm.onData(...)` block, add:

```ts
    // Copy-on-select (design 2026-08-08): a settled selection lands in the clipboard, iTerm-style.
    let selTimer = 0;
    xterm.onSelectionChange(() => {
      if (selTimer) clearTimeout(selTimer);
      selTimer = window.setTimeout(() => {
        const sel = xterm?.getSelection();
        if (sel) void navigator.clipboard.writeText(sel).catch(() => {}); // keys still work if blocked
      }, 150);
    });
    // ⌘C / Ctrl+Shift+C copy; Ctrl+C WITH a selection copies, without one it stays SIGINT.
    xterm.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const wantsCopy =
        (ev.metaKey && !ev.ctrlKey && ev.key === "c") ||
        (ev.ctrlKey && ev.shiftKey && (ev.key === "C" || ev.key === "c")) ||
        (ev.ctrlKey && !ev.shiftKey && !ev.metaKey && ev.key === "c" && !!xterm?.hasSelection());
      if (wantsCopy && xterm?.hasSelection()) {
        void navigator.clipboard.writeText(xterm.getSelection()).catch(() => toast("Copy failed — clipboard blocked"));
        xterm.clearSelection();
        return false; // consumed: don't also send \x03 to the shell
      }
      return true;
    });
    // PuTTY-style right-click paste (Shift+right-click keeps the browser's own menu).
    $("#term-host").addEventListener("contextmenu", (e) => {
      if (e.shiftKey) return;
      e.preventDefault();
      navigator.clipboard
        .readText()
        .then((t) => {
          if (t && activeId()) sendTo(activeId()!, { type: "terminal.input", sessionId: activeId()!, data: strToB64(t) });
        })
        .catch(() => toast("Allow clipboard access to paste"));
    });
```

(`toast` is already imported in panel.ts. The `terminal.input` send gains `termId` in Task 7.)

**Step 3: Verify**

Run: `bun run typecheck:web && bun run build:web`
Expected: both clean.

**Step 4: Commit**

`git commit -am "fix(web): visible terminal selection + copy-on-select, copy keys, right-click paste"`

---

### Task 7: Web — terminal chip strip + termId routing

**Files:**
- Modify: `anvild/web/src/panel.ts` (terminal section)
- Modify: `anvild/web/src/main.ts:1390-1395` (router), `:1123` area (session.updated)
- Modify: `anvild/web/styles/app.css` (strip styles)

**Step 1: panel.ts.** Add `TerminalInfo` to the protocol type import (line ~38). Add state + strip renderer near the other terminal state (line ~123):

```ts
export let activeTermId = "1"; // which of the session's terminals the mounted xterm shows (panel.ts sole writer)

/** The chips to draw: the session's live roster, always including the tab we're on (a just-created
 *  terminal isn't in the roster until the daemon's session.updated lands). */
function termRoster(): TerminalInfo[] {
  const roster: TerminalInfo[] = (activeId() ? sessions.get(activeId()!)?.terminals : undefined) ?? [];
  const merged = roster.some((t) => t.id === activeTermId) ? [...roster] : [...roster, { id: activeTermId, title: "shell" }];
  return merged.sort((a, b) => Number(a.id) - Number(b.id));
}

/** Redraw the chip strip (no-op unless the Terminal tab is mounted). main.ts calls this on
 *  session.updated for the active session so roster changes from any device land live. */
export function renderTermStrip(): void {
  const strip = document.getElementById("term-strip");
  if (!strip || panelView !== "terminal") return;
  const chips = termRoster()
    .map(
      (t) =>
        `<span class="term-chip${t.id === activeTermId ? " active" : ""}" data-tid="${esc(t.id)}">` +
        `<button type="button" class="term-sel">${esc(t.id)}: ${esc(t.title)}</button>` +
        `<button type="button" class="term-kill" title="Kill this terminal">${icon("close")}</button></span>`,
    )
    .join("");
  strip.innerHTML = chips + `<button type="button" id="term-new" class="term-chip term-new" title="New terminal">${icon("add")}</button>`;
  strip.querySelectorAll<HTMLElement>(".term-sel").forEach((b) =>
    b.addEventListener("click", () => {
      const tid = (b.parentElement as HTMLElement).dataset.tid!;
      // Same chip → remount (respawns if the shell exited); other chip → switch to it.
      if (tid !== activeTermId) activeTermId = tid;
      mountTerminal();
    }),
  );
  strip.querySelectorAll<HTMLElement>(".term-kill").forEach((b) =>
    b.addEventListener("click", () => {
      const tid = (b.parentElement as HTMLElement).dataset.tid!;
      if (activeId()) sendTo(activeId()!, { type: "terminal.close", sessionId: activeId()!, termId: tid });
    }),
  );
  const add = document.getElementById("term-new");
  if (add)
    add.onclick = () => {
      activeTermId = String(Math.max(0, ...termRoster().map((t) => Number(t.id) || 0)) + 1);
      mountTerminal(); // daemon caps at 8 → command.error toast
    };
}
```

In `resetPanelForSession()` add `activeTermId = "1";`.

In `mountTerminal()`:
- Replace the `panelContent.innerHTML` line with:

```ts
  panelContent.innerHTML = '<div class="term-wrap"><div id="term-strip" class="term-strip"></div><div id="term-host"></div></div>';
  renderTermStrip();
```

- Add `termId: activeTermId` to the three sends (`terminal.input` in `onData`, the Task 6 paste send, `terminal.open`, and `terminal.resize` in the ResizeObserver).

**Step 2: main.ts.**
- Add `activeTermId, renderTermStrip,` to the panel.ts import block (line ~143).
- Router (line ~1390):

```ts
    case "terminal.data":
      if ((e.termId ?? "1") === activeTermId) xterm?.write(b64ToBytes(e.data));
      return;
    case "terminal.exit":
      if ((e.termId ?? "1") === activeTermId) xterm?.write(`\r\n\x1b[90m[process exited: ${e.code}] — click the terminal's chip to restart\x1b[0m\r\n`);
      return;
```

- In the `case "session.updated"` active-session block (next to `updateGitPanelMeta();`, line ~1123) add:

```ts
        renderTermStrip(); // roster changes (open/exit/kill on any device) refresh the chip strip
```

**Step 3: CSS** — append to `app.css` (main section, NOT inside a media query):

```css
/* Terminal chip strip (multi-terminal, design 2026-08-08) */
.term-wrap { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.term-strip { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--border); }
.term-chip { display: inline-flex; align-items: center; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--panel); }
.term-chip.active { border-color: var(--accent); }
.term-chip button { background: none; border: none; color: var(--text); cursor: pointer; font: inherit; font-size: 12px; padding: 3px 8px; }
.term-chip .term-kill { padding: 3px 5px; color: var(--muted); }
.term-chip .term-kill .msym { font-size: 14px; }
.term-chip.term-new { padding: 3px 6px; color: var(--muted); }
#term-host { flex: 1; min-height: 0; }
```

**Step 4: Verify**

Run: `bun run typecheck:web && bun run build:web && bun run typecheck && bun test`
Expected: all clean/green.

**Step 5: Commit**

`git commit -am "feat(web): multi-terminal chip strip with kill/respawn + termId event routing"`

---

### Task 8: Web — pin + split view (desktop-gated)

**Files:**
- Modify: `anvild/web/index.html:97-98` (pin button)
- Modify: `anvild/web/src/panel.ts` (pin state + open/close/dismiss changes)
- Modify: `anvild/web/src/main.ts:1880-1881` (selectSession)
- Modify: `anvild/web/styles/app.css` (split CSS + phone gating)

**Step 1: index.html.** Between `<span class="ptab-spacer"></span>` and the close button insert:

```html
              <button id="panel-pin" title="Pin — keep the panel open beside the conversation"><span class="msym">keep</span></button>
```

**Step 2: panel.ts.**
- Import `isNarrow` from `./layout` (layout.ts imports only dom/overlays/state — no cycle).
- Add near `panelView` (line ~119):

```ts
// ── Pin (desktop-only, design 2026-08-08) ────────────────────────────────────────
// Pinned = the panel is a split column: no overlay/back-stack entry, no outside-click dismiss,
// survives session switches, persisted across reloads. panel.ts is the sole writer.
export let panelPinned = false;
const PIN_KEY = "anvil.panelPin"; // value = the pinned view; presence = pinned
const VIEWS = ["files", "reader", "git", "terminal", "links"] as const;
type View = (typeof VIEWS)[number];
function pinnedStoredView(): View {
  const v = localStorage.getItem(PIN_KEY);
  return (VIEWS as readonly string[]).includes(v ?? "") ? (v as View) : "terminal";
}
/** body.panel-pinned drives the split CSS — only while the panel is actually open. */
function syncPinnedLayout(): void {
  document.body.classList.toggle("panel-pinned", panelPinned && panel.classList.contains("open"));
  document.getElementById("panel-pin")?.classList.toggle("active", panelPinned);
}
```

- In `initPanel(deps)`, after the existing button wiring, add:

```ts
  document.getElementById("panel-pin")?.addEventListener("click", () => {
    if (isNarrow()) return; // pin is desktop-only
    if (!panelPinned) {
      panelPinned = true;
      localStorage.setItem(PIN_KEY, panelView ?? "terminal");
    } else {
      panelPinned = false;
      localStorage.removeItem(PIN_KEY);
      if (panelView) openOverlay("panel", closePanelDom); // back to overlay semantics: Back closes it again
    }
    syncPinnedLayout();
  });
  panelPinned = !isNarrow() && localStorage.getItem(PIN_KEY) !== null; // restore across reloads
```

- `openPanel(...)` — replace the `openOverlay` line:

```ts
  if (panelPinned) localStorage.setItem(PIN_KEY, view); // remember the pinned tab
  else openOverlay("panel", closePanelDom); // Back closes the panel (no-op if it's already a layer)
```

  and add `syncPinnedLayout();` right after `setPanelTabs();`.
- `openFile(...)` — same replacement for its `openOverlay` line (reader is a pinnable view too).
- `closePanelDom()` — first line: `if (panelPinned) return; // a stale Back entry must not close a pinned panel` and last line add `syncPinnedLayout();` (after `setPanelTabs()`).
- `closePanel` — replace with:

```ts
/** ✕ / programmatic close. A pinned panel unpins first (✕ means "put it away"). */
export const closePanel = (): void => {
  if (panelPinned) {
    panelPinned = false;
    localStorage.removeItem(PIN_KEY);
    panel.classList.remove("open");
    panelView = null;
    disposeTerminal();
    setPanelTabs();
    syncPinnedLayout();
    return;
  }
  dismissOverlay("panel"); // programmatic close → unwind the back-stack
};
```

- `wirePanelOutsideDismiss()` — add as the handler's first line: `if (panelPinned) return; // pinned panels don't dismiss`.
- Add the session-switch/boot reopen helper:

```ts
/** Called by selectSession after resetPanelForSession: a pinned panel stays open and re-targets
 *  the new session (its own terminal/worktree); an unpinned open panel falls back to Files
 *  (historical behavior). Also restores a pinned panel on the boot-time first selection. */
export function reopenPanelForSession(): void {
  if (panelPinned) {
    openPanel(panelView ?? pinnedStoredView());
    return;
  }
  if (panelView) openPanel("files");
}
```

**Step 3: main.ts.** In `selectSession` (line ~1880) replace

```ts
  resetPanelForSession();
  if (panelView) openPanel("files");
```

with

```ts
  resetPanelForSession();
  reopenPanelForSession(); // pinned → same tab, new session; unpinned open panel → files (as before)
```

Add `reopenPanelForSession` to the panel.ts import; `openPanel`/`panelView` stay imported (other call sites use them).

**Step 4: CSS.** Append to `app.css`:

```css
/* Pinned side panel (desktop-only split, design 2026-08-08): the conversation column reflows
   beside the open panel instead of being covered. Width tracks the existing --panel-w resizer. */
@media (min-width: 701px) {
  body.panel-pinned #convo-col { margin-right: var(--panel-w, 460px); }
  body.panel-pinned #side-panel { box-shadow: none; }
}
```

And inside the existing `@media (max-width: 700px)` block (the one hiding `.resizer`, line ~1018):

```css
  #panel-pin { display: none; } /* pin is desktop-only — phone keeps overlay + dismiss untouched */
```

**Step 5: Verify**

Run: `bun run typecheck:web && bun run build:web`
Expected: clean.

**Step 6: Commit**

`git commit -am "feat(web): pin the side panel into a desktop split view, persisted across sessions/reloads"`

---

### Task 9: Full gates + live acceptance + phone-layout proof

**Step 1: All four CI gates**

```sh
cd anvild && bun run typecheck && bun run typecheck:web && bun run build:web && bun test
```

Expected: all green.

**Step 2: Live daemon.** Start locally (degraded boot without a token is fine — terminals don't need the agent):

```sh
cd anvild && bun run start   # serves http://localhost:7701 (run in background)
```

**Step 3: agent-browser acceptance** (headed optional). Against `http://localhost:7701`:

1. Open a session → Terminal. Expect NO `cannot set terminal process group` warning.
2. `sleep 100` + Ctrl+C → prompt returns immediately (^C echoes AND kills). **[fix 1]**
3. Drag-select text → visible accent highlight over glyphs; paste elsewhere shows it copied. **[fix 2]**
4. Right-click in the terminal → clipboard content pastes at the prompt. **[fix 3]**
5. `[+]` chip → terminal 2 with its own shell; run `top` in 2, switch to 1 and back — 2 replays. **[multi-term]**
6. `[×]` on a chip → roster shrinks; re-click the chip → fresh shell (respawn). **[kill/unstick]**
7. Pin → conversation reflows (no overlay shadow); click in the conversation → panel stays; switch session → panel stays on Terminal for the new session; reload → still pinned. Unpin/✕ → overlay behavior back. **[pin]**
8. Phone proof: set viewport 390×844 → pin button absent, panel opens as full-bleed overlay, outside tap dismisses, chips still usable. Screenshot for the PR.

**Step 4: Update tracking tables** — set Status/Tested in this plan's table and the design doc's phase table; commit:

`git commit -am "docs: mark side-panel/terminal plan phases verified"`

---

### Task 10: Push + upstream PR

Governance (memory): upstream `gte619n/anvil` is OSS; Evan approves/merges — **stop after opening the PR**.

```sh
git push -u origin feat/side-panel-terminal
gh pr create --title "Side panel: pin + terminal overhaul (^C job control, selection/copy/paste, multi-terminal)" --body "$(cat <<'EOF'
## Summary
- **^C now works**: the PTY shell is spawned as a session leader with a controlling TTY (setsid/script wrapper); SIGINT reaches the foreground process on both Linux and macOS daemons
- **Selection is visible + copy/paste work**: xterm selection theme colors, copy-on-select, ⌘C / Ctrl+Shift+C, PuTTY-style right-click paste
- **Multi-terminal**: additive `termId` protocol fields + `Session.terminals` roster (no version bump), chip strip UI with kill/respawn escape hatch, 8-per-session cap
- **Pin (desktop only)**: the side panel pins into a real split view, survives session switches and reloads; phone layout untouched (pin hidden + all split CSS behind the desktop breakpoint)

Design: `docs/plans/2026-08-08-side-panel-terminal-design.md` · Plan: `docs/plans/2026-08-08-side-panel-terminal-plan.md`

## Test plan
- [ ] `bun test` (new TerminalManager multi-term + cttyArgv + protocol-additive contract tests)
- [ ] typecheck + typecheck:web + build:web
- [ ] Live: ^C kills `sleep 100`; select/copy/paste; two terminals; kill/respawn; pin split + persistence
- [ ] Phone viewport: no pin button, overlay + dismiss unchanged

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed. Stop here — Evan reviews/merges.
