/**
 * A minimal MCP client over a child process's stdio (newline-delimited JSON-RPC), for the real-tool
 * browser suite. After the C0 spike's probe client. Test fixture, not product code.
 */
export interface McpToolReply {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

export class McpStdioClient {
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  stderr = "";
  private constructor(readonly proc: ReturnType<typeof Bun.spawn>) {}

  /** Spawn `command args…` and complete the MCP handshake. */
  static async start(command: string, args: string[], opts: { cwd: string; env?: Record<string, string | undefined> }): Promise<McpStdioClient> {
    const proc = Bun.spawn([command, ...args], { cwd: opts.cwd, env: opts.env ?? process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const c = new McpStdioClient(proc);
    void c.pump();
    void (async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) c.stderr += dec.decode(chunk, { stream: true });
    })();
    await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "anvil-real-suite", version: "0" } }, 120_000);
    c.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    return c;
  }

  private write(o: unknown): void {
    const stdin = this.proc.stdin as { write: (s: string) => void; flush?: () => void };
    stdin.write(`${JSON.stringify(o)}\n`);
    stdin.flush?.();
  }

  private async pump(): Promise<void> {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id !== undefined && m.method) {
          this.write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "client: unsupported" } }); // a request FROM the server
          continue;
        }
        const p = this.pending.get(m.id);
        if (!p) continue;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error)));
        else p.resolve(m.result);
      }
    }
    for (const p of this.pending.values()) p.reject(new Error(`the server exited. stderr: ${this.stderr.slice(-800)}`));
    this.pending.clear();
  }

  request(method: string, params: unknown = {}, timeoutMs = 90_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no reply to ${method} within ${timeoutMs} ms. stderr: ${this.stderr.slice(-800)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Call one tool; returns the raw reply and its text. */
  async tool(name: string, args: Record<string, unknown> = {}): Promise<{ reply: McpToolReply; text: string }> {
    const reply = (await this.request("tools/call", { name, arguments: args })) as McpToolReply;
    return { reply, text: (reply.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n") };
  }

  /** End stdin (the server closes its browser — about 10 s for Chrome), then make sure the process is gone. */
  async close(): Promise<void> {
    try {
      (this.proc.stdin as { end: () => void }).end();
    } catch {
      /* already closed */
    }
    const exited = await Promise.race([this.proc.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 40_000))]);
    if (!exited) this.proc.kill("SIGKILL");
    await this.proc.exited;
  }
}
