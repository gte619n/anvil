/**
 * A stdio JSON-RPC client for `solidcraft-cli mcp` (agent-cad-and-browser spec §4.2, §4.14 #1; shapes
 * from the A0 spike evidence). One message per line each way; a reply line can be ~720 KB (a
 * screenshot), so nothing here caps line length.
 *
 * The three error channels of the real server map to:
 *   1. a tool/command failure   → a resolved `McpToolResult` with `isError: true` (text is NOT JSON);
 *   2. a bad tool name or args  → a rejected `McpRpcError` (JSON-RPC `error`, e.g. -32602);
 *   3. the process going away   → a rejected `McpExitError` carrying the stderr tail;
 * plus a per-request timeout    → the process is killed and the call rejects `McpTimeoutError`.
 *
 * The child's environment is EXACTLY `PATH`, `HOME`, `TMPDIR` and `SOLIDCRAFT_GPU=cpu` (no daemon
 * secrets), plus whatever a test passes explicitly as `extraEnv` (the fake server's FAKE_SC_* hooks).
 */

export interface McpChild {
  write(line: string): void;
  end(): void;
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
  pid?: number;
}

/** Starts the child process. Injectable so the manager's tests can count and inspect every spawn. */
export type McpSpawn = (cmd: string[], env: Record<string, string>) => McpChild;

export const defaultMcpSpawn: McpSpawn = (cmd, env) => {
  const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
  return {
    write: (line) => {
      proc.stdin.write(line);
      proc.stdin.flush();
    },
    end: () => {
      try {
        proc.stdin.end();
      } catch {
        /* already closed */
      }
    },
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    kill: () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    },
    pid: proc.pid,
  };
};

/** Timers the client (and the manager) use; injectable so idle and cap tests need no real waiting. */
export interface CadClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const realClock: CadClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** The child environment: nothing of the daemon's leaks into SolidCraft. */
export function solidcraftEnv(base: Record<string, string | undefined> = process.env, extraEnv: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: base.PATH ?? "/usr/bin:/bin",
    HOME: base.HOME ?? "/",
    TMPDIR: base.TMPDIR ?? "/tmp",
    SOLIDCRAFT_GPU: "cpu",
    ...extraEnv,
  };
}

export type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | { type: string; [k: string]: unknown };

export interface McpToolResult {
  /** The tool answered with `isError` (a user-facing failure; the design may or may not have changed). */
  isError: boolean;
  /** Every content part, in order, as sent. */
  content: McpContent[];
  /** The text parts, in order. */
  texts: string[];
  /** The text parts joined by a newline. */
  text: string;
  /** The LAST text part that parses as a JSON object or array. Never assume it is `content[0]`:
   *  an `expect` mismatch is a message part then a JSON part; a screenshot is an image then JSON. */
  json?: any;
  /** The image parts (screenshot, compare_picture). */
  images: { data: string; mimeType: string }[];
}

/** A JSON-RPC `error` reply: a bad tool name, bad tool arguments, unknown method. */
export class McpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "McpRpcError";
  }
}

/** The process ended (crash, kill, or never started) with requests outstanding or before use. */
export class McpExitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = "McpExitError";
  }
}

/** A request outlived its timeout; the process has been killed. */
export class McpTimeoutError extends Error {
  constructor(
    message: string,
    readonly timeoutMs: number,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = "McpTimeoutError";
  }
}

export function parseToolResult(result: any): McpToolResult {
  const content: McpContent[] = Array.isArray(result?.content) ? result.content : [];
  const texts = content.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof (c as any).text === "string").map((c) => c.text);
  let json: unknown;
  for (const t of texts) {
    const s = t.trimStart();
    if (!s.startsWith("{") && !s.startsWith("[")) continue;
    try {
      json = JSON.parse(t);
    } catch {
      /* a plain message that happens to start with a bracket */
    }
  }
  const images = content
    .filter((c): c is { type: "image"; data: string; mimeType: string } => c.type === "image" && typeof (c as any).data === "string")
    .map((c) => ({ data: c.data, mimeType: c.mimeType || "image/png" }));
  return { isError: result?.isError === true, content, texts, text: texts.join("\n"), ...(json !== undefined ? { json } : {}), images };
}

export interface McpStartOptions {
  /** The full command line, e.g. [cli, "mcp", "--headless", …]. */
  cmd: string[];
  /** FAKE_SC_* hooks for the fake server. Never set in production. */
  extraEnv?: Record<string, string>;
  /** Base for PATH/HOME/TMPDIR (default: the daemon's environment). */
  baseEnv?: Record<string, string | undefined>;
  spawn?: McpSpawn;
  clock?: CadClock;
  /** How long `initialize` may take (default 30 s). */
  initTimeoutMs?: number;
  /** Bytes of stderr kept for error messages (default 4096). */
  stderrTailBytes?: number;
}

const STDERR_TAIL = 4096;

export class McpClient {
  private readonly waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer?: unknown }>();
  private nextId = 0;
  private err = "";
  private ended = false;
  private exitCode: number | null = null;
  /** Set when WE killed it (timeout / close), so the exit is reported as such. */
  private killedBecause: string | undefined;
  /** The `initialize` reply's `serverInfo` ({name, title, version}). */
  serverInfo: { name?: string; title?: string; version?: string } = {};
  readonly exited: Promise<number>;

  private constructor(
    private readonly child: McpChild,
    private readonly clock: CadClock,
    private readonly tailBytes: number,
    readonly cmd: readonly string[],
  ) {
    void (async () => {
      const dec = new TextDecoder();
      try {
        for await (const chunk of child.stderr) {
          this.err += dec.decode(chunk, { stream: true });
          if (this.err.length > this.tailBytes * 2) this.err = this.err.slice(-this.tailBytes);
        }
      } catch {
        /* stream torn down with the process */
      }
    })();
    const drained = (async () => {
      const dec = new TextDecoder();
      // Parts of the current line. Joined only when the newline arrives, so a 720 KB reply that
      // comes in many chunks is not re-copied per chunk, and there is no length cap anywhere.
      let parts: string[] = [];
      try {
        for await (const chunk of child.stdout) {
          let text = dec.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = text.indexOf("\n")) >= 0) {
            parts.push(text.slice(0, nl));
            const line = parts.join("");
            parts = [];
            text = text.slice(nl + 1);
            this.onLine(line);
          }
          if (text) parts.push(text);
        }
      } catch {
        /* stream torn down with the process */
      }
    })();
    this.exited = (async () => {
      const code = await child.exited.catch(() => -1);
      await drained; // replies already in the pipe are delivered before the outstanding calls fail
      this.exitCode = code;
      this.ended = true;
      // Give stderr a beat to flush so the tail in the error is complete.
      await new Promise((r) => setTimeout(r, 5));
      for (const [id, w] of this.waiting) {
        this.waiting.delete(id);
        if (w.timer !== undefined) this.clock.clearTimeout(w.timer);
        w.reject(this.exitError());
      }
      return code;
    })();
  }

  /** Spawn the server and complete the MCP handshake. Rejects `McpExitError` (with the stderr tail)
   *  when the process dies first — e.g. `--in` on a script it cannot replay exits 1. */
  static async start(opts: McpStartOptions): Promise<McpClient> {
    const clock = opts.clock ?? realClock;
    const env = solidcraftEnv(opts.baseEnv, opts.extraEnv);
    let child: McpChild;
    try {
      child = (opts.spawn ?? defaultMcpSpawn)(opts.cmd, env);
    } catch (e) {
      throw new McpExitError(`could not start SolidCraft (${opts.cmd[0]}): ${e instanceof Error ? e.message : String(e)}`, null, "");
    }
    const client = new McpClient(child, clock, opts.stderrTailBytes ?? STDERR_TAIL, opts.cmd);
    try {
      const init = await client.request(
        "initialize",
        { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "anvild", version: "1" } },
        opts.initTimeoutMs ?? 30_000,
      );
      client.serverInfo = init?.serverInfo ?? {};
      client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    } catch (e) {
      client.kill();
      throw e;
    }
    return client;
  }

  get alive(): boolean {
    return !this.ended;
  }
  get pid(): number | undefined {
    return this.child.pid;
  }
  /** The last few KB the process wrote to stderr. */
  stderrTail(): string {
    return this.err.slice(-this.tailBytes).trim();
  }

  private exitError(): McpExitError {
    const tail = this.stderrTail();
    const why = this.killedBecause ?? `SolidCraft exited${this.exitCode === null ? "" : ` (code ${this.exitCode})`}`;
    return new McpExitError(tail ? `${why}: ${tail}` : why, this.exitCode, tail);
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not a JSON-RPC line (the server writes none, but never let noise kill the reader)
    }
    if (msg?.id === undefined || msg.id === null) return; // a notification, or a parse-error reply to nobody
    const w = this.waiting.get(msg.id);
    if (!w) return;
    this.waiting.delete(msg.id);
    if (w.timer !== undefined) this.clock.clearTimeout(w.timer);
    if (msg.error) w.reject(new McpRpcError(Number(msg.error.code ?? 0), String(msg.error.message ?? "JSON-RPC error")));
    else w.resolve(msg.result);
  }

  private send(msg: unknown): void {
    this.child.write(JSON.stringify(msg) + "\n");
  }

  /** One JSON-RPC request. A timeout KILLS the process: its reply stream can no longer be trusted. */
  request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (this.ended) return Promise.reject(this.exitError());
    const id = ++this.nextId;
    return new Promise<any>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? this.clock.setTimeout(() => {
              if (!this.waiting.delete(id)) return;
              const what = method === "tools/call" ? `\`${(params as any)?.name}\`` : method;
              this.killedBecause = `SolidCraft did not answer ${what} within ${Math.round(timeoutMs / 1000)} s and was stopped`;
              const tail = this.stderrTail();
              this.kill();
              reject(new McpTimeoutError(tail ? `${this.killedBecause}: ${tail}` : this.killedBecause, timeoutMs, tail));
            }, timeoutMs)
          : undefined;
      this.waiting.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
      } catch (e) {
        // A write to a pipe whose reader has gone: the exit handler will reject this call with the
        // stderr tail. Only reject here if the process somehow has not been seen to end.
        if (this.ended && this.waiting.delete(id)) {
          if (timer !== undefined) this.clock.clearTimeout(timer);
          reject(this.exitError());
        }
        void e;
      }
    });
  }

  /** `tools/call`. Resolves for both success and `isError`; rejects for the other error channels. */
  async callTool(name: string, args: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<McpToolResult> {
    return parseToolResult(await this.request("tools/call", { name, arguments: args }, timeoutMs));
  }

  /** Stop now. Outstanding calls reject with `McpExitError`. */
  kill(): void {
    this.killedBecause ??= "SolidCraft was stopped";
    this.child.kill();
  }

  /** Clean stop: close stdin (the server exits 0 on EOF), then kill if it lingers past `graceMs`. */
  async close(graceMs = 2000): Promise<number> {
    if (this.ended) return this.exited;
    this.killedBecause ??= "SolidCraft was stopped";
    this.child.end();
    let t: ReturnType<typeof setTimeout> | undefined;
    const lingering = new Promise<"linger">((r) => {
      t = setTimeout(() => r("linger"), graceMs);
    });
    const first = await Promise.race([this.exited, lingering]);
    if (t) clearTimeout(t);
    if (first === "linger") this.child.kill();
    return this.exited;
  }
}
