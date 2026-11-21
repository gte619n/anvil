/**
 * [A1] The stdio JSON-RPC client for `solidcraft-cli mcp` (agent-cad-and-browser spec §4.2, §4.14 #1;
 * shapes from the A0 evidence). Driven against the fake server, plus a hand-made child process for
 * framing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { McpClient, McpExitError, McpRpcError, McpTimeoutError, parseToolResult, solidcraftEnv, type McpChild } from "../../src/cadwork/mcp-client";
import { cleanupTemp, recordingSpawn, tempDir } from "../helpers/cad-work";
import { FAKE_SOLIDCRAFT } from "../helpers/fake-solidcraft";

const live: McpClient[] = [];
const start = async (dir: string, extraEnv: Record<string, string> = {}, more: string[] = [], spawn = recordingSpawn()) => {
  const c = await McpClient.start({ cmd: [FAKE_SOLIDCRAFT, "mcp", "--headless", "--compact", "--allow-path", dir, "--require-allow-path", ...more], extraEnv, spawn: spawn.spawn });
  live.push(c);
  return { c, spawn };
};
afterEach(async () => {
  for (const c of live.splice(0)) c.kill();
  cleanupTemp();
});

describe("cad mcp client", () => {
  test("[A1] the handshake completes and reports the server's version", async () => {
    const { c } = await start(tempDir(), { FAKE_SC_VERSION: "0.45.0" });
    expect(c.serverInfo.name).toBe("solidcraft");
    expect(c.serverInfo.version).toBe("0.45.0");
    expect(c.alive).toBe(true);
    expect((await c.callTool("version")).json.version).toBe("0.45.0");
  });

  test("[A1] the child environment is exactly PATH, HOME, TMPDIR and SOLIDCRAFT_GPU=cpu, plus explicit extras", async () => {
    const leaky = { ...process.env, ANTHROPIC_API_KEY: "sk-secret", CLAUDE_CODE_OAUTH_TOKEN: "tok", ANVIL_FEATURES: "cad-work" };
    expect(Object.keys(solidcraftEnv(leaky)).sort()).toEqual(["HOME", "PATH", "SOLIDCRAFT_GPU", "TMPDIR"]);
    expect(solidcraftEnv(leaky).SOLIDCRAFT_GPU).toBe("cpu");
    const { spawn } = await start(tempDir(), { FAKE_SC_VERSION: "9.9.9" });
    expect(Object.keys(spawn.envs[0]!).sort()).toEqual(["FAKE_SC_VERSION", "HOME", "PATH", "SOLIDCRAFT_GPU", "TMPDIR"]);
    expect(spawn.envs[0]!.PATH).toBe(process.env.PATH!);
  });

  test("[A1] callTool keeps text parts, image parts and isError", async () => {
    const { c } = await start(tempDir());
    const okReply = await c.callTool("execute", { command: "solid.box", params: { length: 10, width: 10, height: 10 } });
    expect(okReply.isError).toBe(false);
    expect(okReply.json.created_bodies).toEqual(["Body1"]);
    expect(okReply.images).toEqual([]);

    const shot = await c.callTool("screenshot", { width: 8, height: 8 });
    expect(shot.content.map((p) => p.type)).toEqual(["image", "text"]);
    expect(shot.images).toHaveLength(1);
    expect(shot.images[0]!.mimeType).toBe("image/png");
    expect(Buffer.from(shot.images[0]!.data, "base64").subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(shot.json.width).toBe(8); // the JSON is the SECOND part here, not content[0]

    const bad = await c.callTool("execute", { command: "no.such", params: {} });
    expect(bad.isError).toBe(true);
    expect(bad.text).toBe("unknown command `no.such`");
    expect(bad.json).toBeUndefined(); // a plain message, not JSON
  });

  test("[A1] the JSON is the last text part that parses, wherever it sits", () => {
    const mismatch = parseToolResult({ isError: true, content: [{ type: "text", text: "expectation not met" }, { type: "text", text: '{"expectation":{"ok":false}}' }] });
    expect(mismatch.isError).toBe(true);
    expect(mismatch.texts).toEqual(["expectation not met", '{"expectation":{"ok":false}}']);
    expect(mismatch.json).toEqual({ expectation: { ok: false } });
    expect(parseToolResult({ content: [{ type: "text", text: "[not json" }] }).json).toBeUndefined();
    expect(parseToolResult({ content: [] })).toMatchObject({ isError: false, text: "", images: [] });
  });

  test("[A1] a JSON-RPC error is a typed McpRpcError and the process stays usable", async () => {
    const { c } = await start(tempDir());
    const err = await c.callTool("nope").catch((e) => e);
    expect(err).toBeInstanceOf(McpRpcError);
    expect((err as McpRpcError).code).toBe(-32602);
    expect((err as McpRpcError).message).toContain("unknown tool `nope`");
    const missing = await c.callTool("body_topology", {}).catch((e) => e);
    expect(missing).toBeInstanceOf(McpRpcError);
    expect((missing as McpRpcError).message).toContain("missing required argument `body`");
    expect((await c.callTool("measure", { summary: true })).json.body_count).toBe(0);
  });

  test("[A1] a request that outlives its timeout kills the process and rejects McpTimeoutError", async () => {
    const { c } = await start(tempDir(), { FAKE_SC_HANG_ON: "measure" });
    const err = await c.callTool("measure", {}, 150).catch((e) => e);
    expect(err).toBeInstanceOf(McpTimeoutError);
    expect((err as McpTimeoutError).message).toContain("did not answer `measure`");
    await c.exited;
    expect(c.alive).toBe(false);
    expect(await c.callTool("version").catch((e) => e)).toBeInstanceOf(McpExitError);
  });

  test("[A1] a crash rejects the pending call with McpExitError carrying the stderr tail", async () => {
    const { c } = await start(tempDir(), { FAKE_SC_CRASH_ON: "solid.box" });
    const err = (await c.callTool("execute", { command: "solid.box", params: { length: 1, width: 1, height: 1 } }).catch((e) => e)) as McpExitError;
    expect(err).toBeInstanceOf(McpExitError);
    expect(err.exitCode).toBe(139);
    expect(err.stderrTail).toContain("simulated crash on solid.box");
    expect(err.message).toContain("simulated crash on solid.box");
    expect(c.alive).toBe(false);
  });

  test("[A1] a process that dies before the handshake rejects with its stderr", async () => {
    const dir = tempDir();
    const err = (await start(dir, {}, ["--in", join(dir, "missing.json")]).catch((e) => e)) as McpExitError;
    expect(err).toBeInstanceOf(McpExitError);
    expect(err.exitCode).toBe(1);
    expect(err.stderrTail).toContain("No such file or directory");
    // --require-allow-path: every allowed folder missing is a start failure too.
    const gone = (await start(join(dir, "nope")).catch((e) => e)) as McpExitError;
    expect(gone).toBeInstanceOf(McpExitError);
    expect(gone.stderrTail).toContain("--allow-path");
  });

  test("[A1] close ends the process cleanly with exit code 0", async () => {
    const { c } = await start(tempDir());
    expect(await c.close()).toBe(0);
    expect(c.alive).toBe(false);
  });

  test("[A1] a reply line of 800 KB split across many chunks arrives whole (no line-length cap)", async () => {
    const big = "A".repeat(800_000);
    let push!: (s: string) => void;
    let endOut!: () => void;
    const stdout = (async function* () {
      const q: (string | null)[] = [];
      let wake: (() => void) | undefined;
      push = (s) => {
        q.push(s);
        wake?.();
      };
      endOut = () => {
        q.push(null);
        wake?.();
      };
      for (;;) {
        if (q.length === 0) await new Promise<void>((r) => (wake = r));
        const s = q.shift();
        if (s === null) return;
        if (s !== undefined) yield new TextEncoder().encode(s);
      }
    })();
    let exit!: (n: number) => void;
    const child: McpChild = {
      write: (line) => {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") push(JSON.stringify({ id: msg.id, jsonrpc: "2.0", result: { serverInfo: { name: "solidcraft", version: "x" } } }) + "\n");
        if (msg.method === "tools/call") {
          const reply = JSON.stringify({ id: msg.id, jsonrpc: "2.0", result: { content: [{ type: "image", data: big, mimeType: "image/png" }, { type: "text", text: '{"bytes":1}' }] } }) + "\n{";
          // 7 KB chunks, with the NEXT message's first byte glued to the end of this one.
          for (let i = 0; i < reply.length; i += 7001) push(reply.slice(i, i + 7001));
          push(`"id":999,"jsonrpc":"2.0","result":{}}\n`);
        }
      },
      end: () => {
        endOut();
        exit(0);
      },
      stdout,
      stderr: (async function* () {})(),
      exited: new Promise<number>((r) => (exit = r)),
      kill: () => {
        endOut();
        exit(137);
      },
    };
    const c = await McpClient.start({ cmd: ["x"], spawn: () => child });
    const r = await c.callTool("screenshot");
    expect(r.images[0]!.data.length).toBe(800_000);
    expect(r.images[0]!.data).toBe(big);
    expect(r.json).toEqual({ bytes: 1 });
    expect(await c.close()).toBe(0);
  });
});
