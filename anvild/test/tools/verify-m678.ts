/**
 * Throwaway live check for M6 (resume), M7 (authoritative permission hook), M8 (budget).
 *   bun run test/tools/verify-m678.ts <ws-url> <cwd>
 */
export {};
const url = process.argv[2] ?? "ws://localhost:7701/ws";
const cwd = process.argv[3] ?? process.cwd();
const stamp = (o: object) => JSON.stringify({ v: 1, ts: new Date().toISOString(), ...o });

let sessionId = "";
let sawPermission = false;
let lastBudget: any = null;

const ws = new WebSocket(url);
ws.onopen = () =>
  ws.send(stamp({ type: "session.create", cid: "c", source: "existing-dir", cwd, model: "sonnet", autonomy: "prompt-all" }));
ws.onmessage = (ev) => {
  const m = JSON.parse(String((ev as MessageEvent).data));
  switch (m.type) {
    case "session.created":
      sessionId = m.session.id;
      console.log(`created ${sessionId}`);
      ws.send(stamp({ type: "prompt.send", cid: "p", sessionId, text: "Use the Bash tool to run exactly: echo anvil-works — then say done." }));
      return;
    case "permission.request":
      sawPermission = true;
      console.log(`  M7  permission.request(${m.tool}) → responding allow`);
      ws.send(stamp({ type: "permission.respond", cid: "pr", requestId: m.requestId, decision: "allow" }));
      return;
    case "tool.use":
      console.log(`  tool.use ${m.name}`);
      return;
    case "tool.result":
      console.log(`  tool.result ${String(m.content).slice(0, 40)}`);
      return;
    case "budget":
      lastBudget = m.budget;
      return;
    case "result":
      console.log(`M7  permission hook fired for a benign tool under prompt-all: ${sawPermission}`);
      console.log(`M8  rate limits after turn: week=${lastBudget?.week?.utilization}% session=${lastBudget?.session?.utilization}% warn=${lastBudget?.warn}`);
      ws.close();
      void resume();
      return;
  }
};

async function resume(): Promise<void> {
  // M6a: cold attach (no lastSeq) → conversation.snapshot
  const snap = await attachAndWait({ type: "session.attach", cid: "a", sessionId }, "conversation.snapshot");
  console.log(`M6  cold attach → snapshot: ${snap.events.length} folded events, lastSeq=${snap.lastSeq}`);
  // M6b: partial attach (lastSeq=1) → raw replay of seq > 1
  const replayed = await attachAndWait({ type: "session.attach", cid: "a2", sessionId, lastSeq: 1 }, null);
  console.log(`M6  partial attach(lastSeq=1) → replayed seq ${replayed.seq} (${replayed.type})`);
  process.exit(0);
}

function attachAndWait(cmd: object, waitType: string | null): Promise<any> {
  return new Promise((resolve, reject) => {
    const w = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("resume timeout")), 8000);
    w.onopen = () => w.send(stamp(cmd));
    w.onmessage = (ev) => {
      const m = JSON.parse(String((ev as MessageEvent).data));
      if (m.type === "session.list" || m.type === "budget" || m.type === "ack") return;
      if (waitType ? m.type === waitType : typeof m.seq === "number" && m.sessionId === sessionId) {
        clearTimeout(timer);
        resolve(m);
        w.close();
      }
    };
  });
}

setTimeout(() => {
  console.error("overall timeout");
  process.exit(1);
}, 120000);
