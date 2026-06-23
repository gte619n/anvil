/**
 * Full-daemon AskUserQuestion probe: drives the RUNNING daemon over the SAME WS protocol
 * the web client uses, so it exercises streaming-input + resume + supervisor wiring — not just
 * the SDK in isolation. Tells us whether a real session surfaces `question.request` (daemon OK,
 * bug is web-only) or silently proceeds (daemon stale / wiring broken).
 *
 *   bun run test/tools/probe-question-ws.ts [ws-url] [cwd]
 */
export {};
const url = process.argv[2] ?? "ws://localhost:7701/ws";
const cwd = process.argv[3] ?? process.cwd();
const stamp = (o: object) => JSON.stringify({ v: 1, ts: new Date().toISOString(), ...o });
const log = (t: string, o?: unknown) => console.log(`\x1b[36m[${t}]\x1b[0m`, o === undefined ? "" : JSON.stringify(o));

let sessionId = "";
let sawQuestion = false;
const ws = new WebSocket(url);

ws.onopen = () =>
  ws.send(stamp({ type: "session.create", cid: "c", source: "existing-dir", cwd, model: "sonnet", autonomy: "mostly-autonomous" }));

ws.onmessage = (ev) => {
  const m = JSON.parse(String((ev as MessageEvent).data));
  switch (m.type) {
    case "session.list":
      return;
    case "session.created":
      sessionId = m.session.id;
      log("session.created", { sessionId });
      ws.send(
        stamp({
          type: "prompt.send",
          cid: "p",
          sessionId,
          text:
            "Use the AskUserQuestion tool to ask me ONE question: what is my favorite color, " +
            "offering Red, Green, and Blue. Then tell me exactly which color I picked.",
        }),
      );
      return;
    case "status":
      log("status", m.status);
      return;
    case "question.request":
      sawQuestion = true;
      log("✓ question.request RECEIVED", { requestId: m.requestId, questions: m.questions });
      // Answer "Blue" exactly as the web card's question.respond does.
      ws.send(
        stamp({
          type: "question.respond",
          cid: "q",
          requestId: m.requestId,
          answers: [{ question: m.questions[0].question, labels: ["Blue"] }],
        }),
      );
      log("→ answered Blue");
      return;
    case "permission.request":
      log("permission.request → allow", m.tool);
      ws.send(stamp({ type: "permission.respond", cid: "pr", requestId: m.requestId, decision: "allow" }));
      return;
    case "tool.use":
      log("tool.use", m.name);
      return;
    case "tool.result":
      log("tool.result", String(m.content).slice(0, 80));
      return;
    case "assistant.message": {
      const text = m.blocks.filter((b: any) => b.kind === "markdown").map((b: any) => b.rendered.source).join("");
      if (text) log("assistant", text);
      return;
    }
    case "result":
      log("result", { stop: m.stopReason });
      console.log(
        sawQuestion
          ? "\x1b[32m✓ daemon SURFACED the question over WS — bug is NOT in the daemon\x1b[0m"
          : "\x1b[31m✗ daemon NEVER surfaced question.request — it proceeded with no answer (deployed daemon stale or wiring broken)\x1b[0m",
      );
      ws.close();
      process.exit(0);
    case "error":
      log("error", { fatal: m.fatal, message: m.message });
      return;
    default:
      log(m.type);
  }
};

setTimeout(() => {
  console.error("\x1b[31mTIMEOUT 120s\x1b[0m sawQuestion=" + sawQuestion);
  process.exit(1);
}, 120000);
