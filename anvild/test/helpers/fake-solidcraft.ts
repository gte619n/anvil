/**
 * Test client for test/fixtures/fake-solidcraft.ts (and, with `cli`, the real `solidcraft-cli`): spawns
 * the stdio MCP server and speaks JSON-RPC 2.0 to it, one message per line. Shared by every suite
 * that needs a SolidCraft process without the daemon's own manager in the way.
 */
import { join } from "node:path";

export const FAKE_SOLIDCRAFT = join(import.meta.dir, "..", "fixtures", "fake-solidcraft.ts");

export interface ToolReply {
  /** True when the tool answered with `isError` (a user-facing failure, not a protocol error). */
  isError: boolean;
  /** The concatenated text blocks. */
  text: string;
  /** `text` parsed as JSON, when it is JSON. */
  json: any;
  /** Every content block as sent (text and image). */
  content: any[];
}

export interface FakeSolidcraft {
  /** Send a request and wait for its reply (the raw JSON-RPC response). */
  rpc(method: string, params?: unknown): Promise<any>;
  /** `tools/call`. Rejects on a JSON-RPC error; an `isError` result resolves with `isError: true`. */
  call(name: string, args?: Record<string, unknown>): Promise<ToolReply>;
  /** Resolves with the exit code once the process ends. */
  exited: Promise<number>;
  /** Everything the process wrote to stderr so far. */
  stderr(): string;
  /** Close stdin and wait for the process to end. */
  close(): Promise<number>;
}

export interface StartOptions {
  /** Folders the server may read and write (`--allow-path`). */
  allow?: string[];
  /** Extra environment — the FAKE_SC_* hooks. */
  env?: Record<string, string>;
  /** A design or script to open at startup (`--in`). */
  inFile?: string;
  /** Run this binary instead of the fake (the real CLI, in test/real). */
  cli?: string[];
  /** Skip the initialize handshake (to test it by hand). */
  noHandshake?: boolean;
}

export async function startFake(opts: StartOptions = {}): Promise<FakeSolidcraft> {
  const cmd = [
    ...(opts.cli ?? ["bun", FAKE_SOLIDCRAFT]),
    "mcp",
    "--headless",
    "--compact",
    ...(opts.allow ?? []).flatMap((d) => ["--allow-path", d]),
    ...(opts.inFile ? ["--in", opts.inFile] : []),
  ];
  const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...opts.env } });
  let err = "";
  void (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stderr) err += dec.decode(chunk, { stream: true });
  })();

  const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let ended = false;
  void (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const w = waiting.get(msg.id);
        if (w) {
          waiting.delete(msg.id);
          w.resolve(msg);
        }
      }
    }
    ended = true;
    const code = await proc.exited;
    for (const w of waiting.values()) w.reject(new Error(`solidcraft exited (code ${code}) before replying`));
    waiting.clear();
  })();

  let nextId = 0;
  const write = (msg: unknown) => {
    proc.stdin.write(JSON.stringify(msg) + "\n");
    proc.stdin.flush();
  };
  const rpc = (method: string, params?: unknown): Promise<any> => {
    if (ended) return Promise.reject(new Error("solidcraft has exited"));
    const id = ++nextId;
    const p = new Promise<any>((resolve, reject) => waiting.set(id, { resolve, reject }));
    write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    return p;
  };
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolReply> => {
    const r = await rpc("tools/call", { name, arguments: args });
    if (r.error) throw new Error(`${name}: JSON-RPC error ${r.error.code}: ${r.error.message}`);
    const content: any[] = r.result.content ?? [];
    const text = content.filter((c) => c.type === "text").map((c) => c.text).join("");
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: r.result.isError === true, text, json, content };
  };

  if (!opts.noHandshake) {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "anvil-test", version: "0" } });
    write({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
  return {
    rpc,
    call,
    exited: proc.exited,
    stderr: () => err,
    close: async () => {
      try {
        proc.stdin.end();
      } catch {
        /* already closed (the process crashed) */
      }
      return proc.exited;
    },
  };
}

/** The 16-command reference plate from SolidCraft's modeling skill: 23335.2 mm³, 22 faces; 35335.2 mm³ at L = 120. */
export const REFERENCE_PLATE: { command: string; params: Record<string, unknown> }[] = [
  { command: "parameters.add", params: { name: "L", expression: "80 mm" } },
  { command: "parameters.add", params: { name: "W", expression: "50 mm" } },
  { command: "parameters.add", params: { name: "T", expression: "6 mm" } },
  { command: "parameters.add", params: { name: "inset", expression: "8 mm" } },
  { command: "sketch.create", params: { plane: "XY", name: "PlateSketch" } },
  {
    command: "sketch.draw.dimensioned",
    params: { command: "sketch.rectangle.center", params: { center: [0, 0], corner: [40, 25] }, dimensions: { width: "L", height: "W" } },
  },
  { command: "sketch.finish", params: {} },
  { command: "solid.extrude", params: { distance: "T", name: "Plate" } },
  { command: "solid.fillet", params: { edges: [[40, 25, 3], [-40, 25, 3], [40, -25, 3], [-40, -25, 3]], radius: 5, name: "Corners" } },
  { command: "sketch.create", params: { plane: "XY", name: "HolePts", offset: "T" } },
  { command: "sketch.point", params: { point: [32, 17] } },
  { command: "sketch.dimension", params: { entities: ["origin", "p1"], type: "horizontal", value: "L/2 - inset" } },
  { command: "sketch.dimension", params: { entities: ["origin", "p1"], type: "vertical", value: "W/2 - inset" } },
  { command: "sketch.finish", params: {} },
  { command: "solid.hole", params: { sketch: "HolePts", diameter: 3.4, type: "counterbore", cb_diameter: 6.5, cb_depth: 3.3, name: "Hole" } },
  {
    command: "solid.pattern.rectangular",
    params: { features: ["Hole"], dir1: [-1, 0, 0], count1: 2, spacing1: "L - 2*inset", dir2: [0, -1, 0], count2: 2, spacing2: "W - 2*inset", name: "Holes" },
  },
];
