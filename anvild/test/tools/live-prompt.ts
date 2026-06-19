/**
 * Throwaway end-to-end check: create a session over WS, send one prompt, print the
 * streamed events until `result`.
 *   bun run test/tools/live-prompt.ts [ws-url] [cwd] [model] [prompt]
 */
const url = process.argv[2] ?? "ws://localhost:7701/ws";
const cwd = process.argv[3] ?? process.cwd();
const model = process.argv[4] ?? "sonnet";
const promptText = process.argv[5] ?? "Reply with exactly the word PONG and nothing else.";

const ws = new WebSocket(url);
const stamp = (o: object) => JSON.stringify({ v: 1, ts: new Date().toISOString(), ...o });
let sessionId = "";
let deltas = 0;

const autonomy = process.env.ANVIL_AUTONOMY ?? "mostly-autonomous";
ws.onopen = () => ws.send(stamp({ type: "session.create", cid: "c", source: "existing-dir", cwd, model, autonomy }));
ws.onmessage = (ev) => {
  const m = JSON.parse(String((ev as MessageEvent).data));
  switch (m.type) {
    case "session.list":
      return;
    case "session.created":
      sessionId = m.session.id;
      console.log(`created ${sessionId} (model=${m.session.model})`);
      ws.send(stamp({ type: "prompt.send", cid: "p", sessionId, text: promptText }));
      return;
    case "status":
      console.log(`  status → ${m.status}`);
      return;
    case "assistant.delta":
      deltas++;
      return;
    case "permission.request":
      console.log(`  permission.request ${m.tool} ${JSON.stringify(m.input).slice(0, 50)} → responding allow`);
      ws.send(stamp({ type: "permission.respond", cid: "perm", requestId: m.requestId, decision: "allow" }));
      return;
    case "tool.use":
      console.log(`  tool.use ${m.name} ${JSON.stringify(m.input).slice(0, 60)}`);
      return;
    case "tool.result":
      console.log(`  tool.result(${m.isError ? "error" : "ok"}) ${String(m.content).slice(0, 50)}`);
      return;
    case "assistant.message": {
      const text = m.blocks.filter((b: any) => b.kind === "markdown").map((b: any) => b.rendered.source).join("");
      if (text) console.log(`assistant: ${JSON.stringify(text)}`);
      return;
    }
    case "result":
      console.log(`result: stop=${m.stopReason} deltas=${deltas} usage=${JSON.stringify(m.usage)}`);
      ws.close();
      process.exit(0);
    case "error":
      console.log(`error(fatal=${m.fatal}): ${m.message}`);
      return;
    default:
      console.log(m.type);
  }
};
setTimeout(() => {
  console.error("timeout");
  process.exit(1);
}, 120000);
