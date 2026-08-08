/**
 * [Phase 3 / BE-7] Per-session terminal (PTY) channel (arch §7), extracted from Supervisor.
 *
 * A persistent PTY per session via Bun's native Terminal. Scrollback is retained (capped) so a
 * reconnecting/refreshing client can replay it. The PTY spawn is injected (`SpawnTerminal`) so the
 * lifecycle is unit-testable without a real terminal; the default factory uses `Bun.Terminal`.
 */

/** The bits of a Session this manager needs — narrowed for testability. */
export interface TerminalSession {
  readonly cwd: string;
  emit(body: { type: "terminal.data"; data: string } | { type: "terminal.exit"; code: number }): void;
}

export interface TerminalPty {
  resize(cols: number, rows: number): void;
  write(data: Buffer): void;
  close(): void;
}
export interface TerminalHandle {
  pty: TerminalPty;
  proc: { exited: Promise<number | null> };
}
export type SpawnTerminal = (opts: {
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  onData: (bytes: Uint8Array) => void;
}) => TerminalHandle;

const SCROLLBACK_CAP = 262_144; // 256KB retained per session

/** Wrap the shell so it starts as a session leader with the PTY slave as its controlling TTY.
 *  Bun.spawn({terminal}) attaches the PTY as stdio only — without a ctty the line discipline has
 *  no foreground process group, so ^C's SIGINT is delivered to nobody ("bash: no job control in
 *  this shell"; zsh degrades silently). Verified live on both fleet hosts (design 2026-08-08). */
export function cttyArgv(platform: string, shell: string): string[] {
  if (platform === "linux") return ["setsid", "--ctty", "--wait", shell];
  if (platform === "darwin") return ["script", "-q", "/dev/null", shell];
  return [shell];
}

/** The real PTY factory: Bun.Terminal + a shell spawned onto it. */
const defaultSpawnTerminal: SpawnTerminal = ({ cols, rows, cwd, env, onData }) => {
  const BunAny = Bun as unknown as {
    Terminal: new (o: { cols: number; rows: number; data: (t: unknown, b: Uint8Array) => void }) => TerminalPty;
    spawn: (cmd: string[], o: { terminal: TerminalPty; cwd: string; env: Record<string, string> }) => { exited: Promise<number | null> };
  };
  const term = new BunAny.Terminal({ cols, rows, data: (_t, bytes) => onData(bytes) });
  const shell = process.env.SHELL || "/bin/zsh";
  let proc: { exited: Promise<number | null> };
  try {
    proc = BunAny.spawn(cttyArgv(process.platform, shell), { terminal: term, cwd, env });
  } catch {
    // setsid/script binary missing — degrade to the ctty-less spawn (terminal works, no job control)
    proc = BunAny.spawn([shell], { terminal: term, cwd, env });
  }
  return { pty: term, proc };
};

export class TerminalManager {
  private readonly terminals = new Map<string, { pty: TerminalPty; scrollback: Buffer }>();

  constructor(
    /** Resolve a session (throws if it doesn't exist — mirrors Supervisor.require). */
    private readonly resolve: (sessionId: string) => TerminalSession,
    /** The agent env applied to the shell (minus TERM, which the factory sets), resolved per session so
     *  a session pinned to a non-default Claude account gets its OWN token (multi-account §4.1). */
    private readonly agentEnv: (sessionId: string) => Record<string, string>,
    private readonly spawn: SpawnTerminal = defaultSpawnTerminal,
  ) {}

  has(sessionId: string): boolean {
    return this.terminals.has(sessionId);
  }

  open(sessionId: string, cols: number, rows: number): void {
    const s = this.resolve(sessionId);
    const existing = this.terminals.get(sessionId);
    if (existing) {
      if (existing.scrollback.length) s.emit({ type: "terminal.data", data: existing.scrollback.toString("base64") });
      try {
        existing.pty.resize(cols, rows);
      } catch {
        /* pty gone */
      }
      return;
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
        s.emit({ type: "terminal.data", data: buf.toString("base64") });
      },
    });
    rec.pty = handle.pty;
    this.terminals.set(sessionId, rec);
    handle.proc.exited.then((code) => {
      s.emit({ type: "terminal.exit", code: code ?? 0 });
      this.terminals.delete(sessionId);
    });
  }

  input(sessionId: string, dataBase64: string): void {
    try {
      this.terminals.get(sessionId)?.pty.write(Buffer.from(dataBase64, "base64"));
    } catch {
      /* no pty */
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    try {
      this.terminals.get(sessionId)?.pty.resize(cols, rows);
    } catch {
      /* no pty */
    }
  }

  kill(sessionId: string): void {
    const t = this.terminals.get(sessionId);
    if (t) {
      try {
        t.pty.close();
      } catch {
        /* already closed */
      }
      this.terminals.delete(sessionId);
    }
  }

  /** Reap every terminal (shutdown). */
  killAll(): void {
    for (const id of [...this.terminals.keys()]) this.kill(id);
  }
}
