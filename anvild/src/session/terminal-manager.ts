/**
 * [Phase 3 / BE-7] Per-session terminal (PTY) channel (arch §7), extracted from Supervisor.
 *
 * A persistent PTY per session via Bun's native Terminal. Scrollback is retained (capped) so a
 * reconnecting/refreshing client can replay it. The PTY spawn is injected (`SpawnTerminal`) so the
 * lifecycle is unit-testable without a real terminal; the default factory uses `Bun.Terminal`.
 */
import { BadCommand } from "./errors";

/** The bits of a Session this manager needs — narrowed for testability. */
export interface TerminalSession {
  readonly cwd: string;
  emit(body: { type: "terminal.data"; data: string; termId?: string } | { type: "terminal.exit"; code: number; termId?: string }): void;
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

const MAX_TERMINALS = 8; // per session (design 2026-08-08)
export const DEFAULT_TERM_ID = "1"; // what an absent wire termId means (pre-multi-term clients)

export class TerminalManager {
  /** sessionId → termId → live PTY record. */
  private readonly terminals = new Map<string, Map<string, { pty: TerminalPty; scrollback: Buffer }>>();
  private readonly shellTitle = (process.env.SHELL || "/bin/zsh").split("/").pop() || "shell";

  constructor(
    /** Resolve a session (throws if it doesn't exist — mirrors Supervisor.require). */
    private readonly resolve: (sessionId: string) => TerminalSession,
    /** The agent env applied to the shell (minus TERM, which the factory sets), resolved per session so
     *  a session pinned to a non-default Claude account gets its OWN token (multi-account §4.1). */
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
