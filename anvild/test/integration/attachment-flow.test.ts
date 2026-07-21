import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";

// Capture every streaming-input SDKUserMessage the agent driver pushes to the SDK. The icon
// picker also calls query() but with a *string* prompt (not an AsyncIterable) — skip those.
const captured: any[] = [];
// mock.module replaces the SDK module GLOBALLY for the rest of the run — it is not scoped to this
// file and is not undone when it finishes. So the replacement must carry every export the rest of the
// codebase pulls from the SDK, not just the one being faked: `default-tools.ts` (the concierge's
// in-process MCP server, constructed by every Supervisor) imports `createSdkMcpServer` and `tool`.
// A query-only stub link-errors any file that loads the supervisor AFTER this one —
// "Export named 'createSdkMcpServer' not found" — which reads like a flaky SDK extraction but is
// really just this mock. Same fix, same reason, as test/unit/autopilot-adversarial.test.ts.
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: () => ({ type: "sdk", name: "mock", instance: {} }),
  tool: (name: string, _desc: unknown, _schema: unknown, handler: unknown) => ({ name, handler }),
  query: (opts: any) => {
    if (opts.prompt && typeof opts.prompt !== "string" && typeof opts.prompt[Symbol.asyncIterator] === "function") {
      void (async () => {
        for await (const m of opts.prompt) captured.push(m);
      })();
    }
    // Minimal Query: emit one result so the turn completes, then end.
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "result", subtype: "success", total_cost_usd: 0 } as any;
      },
      interrupt: async () => {},
      setModel: async () => {},
    };
  },
}));

// These tests drive a real prompt through the supervisor, and a degraded machine (no Claude login)
// now refuses one with the §4.3 pair-this-machine error instead of spawning — see
// anvil-headless-join.md. Give the daemon a placeholder credential so the attachment path under test
// is reachable. (The SDK itself is mocked above, so the value is never used for anything.)
process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "sk-ant-oat-test-placeholder";

const { createServer } = await import("../../src/server/http");

// 1×1 red PNG.
const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const stamp = (o: object): string => JSON.stringify({ v: PROTOCOL_VERSION, ts: "t", ...o });

test("an uploaded image survives the wire: shows in message.user AND reaches Claude", async () => {
  captured.length = 0;
  const dir = mkdtempSync(join(tmpdir(), "anvil-att-"));
  const srv = createServer({ host: "127.0.0.1", port: 0, stateDir: dir });
  const base = `http://127.0.0.1:${srv.port}`;

  try {
    // 1) open the control WS and create a session (exactly what the web client does).
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    const events: any[] = [];
    const waitFor = (type: string, timeoutMs = 4000): Promise<any> =>
      new Promise((resolve, reject) => {
        const hit = events.find((e) => e.type === type);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
        ws.addEventListener("message", (ev) => {
          const m = JSON.parse(String((ev as MessageEvent).data));
          if (m.type === type) {
            clearTimeout(t);
            resolve(m);
          }
        });
      });
    ws.addEventListener("message", (ev) => events.push(JSON.parse(String((ev as MessageEvent).data))));
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    ws.send(stamp({ type: "session.create", cid: "c", source: "existing-dir", cwd: dir, model: "sonnet", autonomy: "mostly-autonomous" }));
    const created = await waitFor("session.created");
    const sessionId = created.session.id as string;

    // 2) upload the image over REST (the web client's uploadAttachment()).
    const upRes = await fetch(`${base}/api/sessions/${sessionId}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "red.png", mediaType: "image/png", dataBase64: RED_PNG_B64 }),
    });
    expect(upRes.ok).toBe(true);
    const { attachment } = (await upRes.json()) as { attachment: { id: string } };
    expect(attachment.id).toBeTruthy();

    // 3) send a prompt referencing the attachment (the web client's composer submit).
    ws.send(stamp({ type: "prompt.send", cid: "p", sessionId, text: "what color is this?", attachmentIds: [attachment.id] }));

    // 3a) the broadcast user message must carry the attachment so every device renders it.
    const userEvt = await waitFor("message.user");
    expect(userEvt.attachments).toHaveLength(1);
    expect(userEvt.attachments[0].id).toBe(attachment.id);
    expect(userEvt.attachments[0].kind).toBe("image");

    // 3b) the GET endpoint serves the bytes back (what the <img> src loads).
    const getRes = await fetch(`${base}/api/sessions/${sessionId}/attachments/${attachment.id}`);
    expect(getRes.ok).toBe(true);
    expect(getRes.headers.get("Content-Type")).toBe("image/png");

    // 3c) and Claude actually receives the image as an inline content block.
    await waitFor("result");
    const userMsg = captured.find((m) => Array.isArray(m.message?.content) && m.message.content.some((b: any) => b.type === "image"));
    expect(userMsg).toBeDefined();
    const img = userMsg.message.content.find((b: any) => b.type === "image");
    expect(img.source.media_type).toBe("image/png");
    expect(img.source.data).toBe(RED_PNG_B64);

    ws.close();
  } finally {
    srv.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-image file attachment lands in the chat AND its contents reach Claude as text", async () => {
  captured.length = 0;
  const dir = mkdtempSync(join(tmpdir(), "anvil-att-"));
  const srv = createServer({ host: "127.0.0.1", port: 0, stateDir: dir });
  const base = `http://127.0.0.1:${srv.port}`;

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    const events: any[] = [];
    const waitFor = (type: string, timeoutMs = 4000): Promise<any> =>
      new Promise((resolve, reject) => {
        const hit = events.find((e) => e.type === type);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
        ws.addEventListener("message", (ev) => {
          const m = JSON.parse(String((ev as MessageEvent).data));
          if (m.type === type) {
            clearTimeout(t);
            resolve(m);
          }
        });
      });
    ws.addEventListener("message", (ev) => events.push(JSON.parse(String((ev as MessageEvent).data))));
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    ws.send(stamp({ type: "session.create", cid: "c", source: "existing-dir", cwd: dir, model: "sonnet", autonomy: "mostly-autonomous" }));
    const created = await waitFor("session.created");
    const sessionId = created.session.id as string;

    // Upload a text file WITH AN EMPTY mediaType — exactly what Android's content picker sends.
    // The daemon must infer "text/*" from the ".log" extension (otherwise it's dropped).
    const fileText = "ERROR boot failed at line 42\nstacktrace: ...";
    const upRes = await fetch(`${base}/api/sessions/${sessionId}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "crash.log", mediaType: "", dataBase64: Buffer.from(fileText).toString("base64") }),
    });
    expect(upRes.ok).toBe(true);
    const { attachment } = (await upRes.json()) as { attachment: { id: string; kind: string } };
    expect(attachment.kind).toBe("file");

    ws.send(stamp({ type: "prompt.send", cid: "p", sessionId, text: "what's in this log?", attachmentIds: [attachment.id] }));

    // the broadcast user message carries it as a "file" attachment so every device renders a chip
    const userEvt = await waitFor("message.user");
    expect(userEvt.attachments).toHaveLength(1);
    expect(userEvt.attachments[0].kind).toBe("file");

    // and Claude receives the file's TEXT inline (not a broken image block)
    await waitFor("result");
    const userMsg = captured.find(
      (m) => Array.isArray(m.message?.content) && m.message.content.some((b: any) => b.type === "text" && b.text.includes("crash.log")),
    );
    expect(userMsg).toBeDefined();
    const block = userMsg.message.content.find((b: any) => b.type === "text" && b.text.includes("crash.log"));
    expect(block.text).toContain("ERROR boot failed at line 42");
    // no bogus image block was produced for a text file
    expect(userMsg.message.content.some((b: any) => b.type === "image")).toBe(false);

    ws.close();
  } finally {
    srv.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
