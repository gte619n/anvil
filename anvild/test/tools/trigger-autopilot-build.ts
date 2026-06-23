/**
 * Throwaway trigger for the phase-2B build pipeline on the LIVE daemon. Sends `todoist.build` for
 * an environment; the daemon builds every `planned` work unit (build → validate → PR → tag) in the
 * background, logging progress to its own stdout (`[autopilot] …`). Watch the daemon log for results.
 *
 *   bun run test/tools/trigger-autopilot-build.ts <environmentId> [ws-url]
 *
 * Get the environmentId from ~/.anvil/environments.json. This spawns REAL worktree sessions and may
 * open REAL PRs — only run it when you mean to.
 */
export {};
const environmentId = process.argv[2];
const url = process.argv[3] ?? "ws://localhost:7701/ws";
if (!environmentId) {
  console.error("Usage: bun run test/tools/trigger-autopilot-build.ts <environmentId> [ws-url]");
  process.exit(1);
}

const ws = new WebSocket(url);
const stamp = (o: object) => JSON.stringify({ v: 1, ts: new Date().toISOString(), ...o });
ws.onopen = () => ws.send(stamp({ type: "todoist.build", cid: "b", environmentId }));
ws.onmessage = (ev) => {
  const m = JSON.parse(String((ev as MessageEvent).data));
  if (m.type === "session.list" || m.type === "budget" || m.type === "environments" || m.type === "todoist.status") return;
  if (m.cid === "b" && m.type === "ack") {
    console.log("✓ build phase accepted — watch the daemon log for `[autopilot] …` progress.");
    ws.close();
    process.exit(0);
  }
  if (m.type === "command.error") {
    console.error(`✗ ${m.message}`);
    ws.close();
    process.exit(1);
  }
};
ws.onerror = (e) => {
  console.error(`ws error: ${String((e as ErrorEvent).message ?? e)}`);
  process.exit(1);
};
