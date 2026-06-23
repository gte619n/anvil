/**
 * Throwaway trigger for the phase-2B build pipeline on the LIVE daemon. Sends `todoist.build`; the
 * daemon builds the planned work unit(s) (build → validate → PR → tag) in the background, logging
 * progress to its own stdout (`[autopilot] …`). Watch the daemon log for results.
 *
 *   bun run test/tools/trigger-autopilot-build.ts list                      # list planned units + ids
 *   bun run test/tools/trigger-autopilot-build.ts <environmentId> <workUnitId>   # build ONE unit (recommended first)
 *   bun run test/tools/trigger-autopilot-build.ts <environmentId>           # build ALL planned units (heavy!)
 *
 * Spawns REAL worktree sessions and may open REAL PRs — only run it when you mean to. Start with a
 * single small unit (`list` to find ids, then pass one).
 */
export {};
import { existsSync, readFileSync } from "node:fs";

const a = process.argv[2];

if (!a || a === "list") {
  const f = `${process.env.HOME}/.anvil/integrations/workunits.json`;
  if (!existsSync(f)) {
    console.error("No work units yet — run `scripts/autopilot.ts plan <env>` first.");
    process.exit(1);
  }
  const wus = (JSON.parse(readFileSync(f, "utf8")).workunits ?? []) as Array<{ id: string; status: string; title: string; environmentId: string; taskIds: string[] }>;
  const planned = wus.filter((u) => u.status === "planned");
  console.log(`Planned units (${planned.length}):`);
  for (const u of planned) console.log(`  ${u.id}  env=${u.environmentId}  (${u.taskIds.length} task) — ${u.title}`);
  console.log(`\nBuild one:  bun run test/tools/trigger-autopilot-build.ts <env_id> <work_unit_id>`);
  process.exit(0);
}

const environmentId = a;
const workUnitId = process.argv[3] && !process.argv[3].startsWith("ws") ? process.argv[3] : undefined;
const url = process.argv.find((x) => x.startsWith("ws://")) ?? "ws://localhost:7701/ws";

const ws = new WebSocket(url);
const stamp = (o: object) => JSON.stringify({ v: 1, ts: new Date().toISOString(), ...o });
ws.onopen = () => ws.send(stamp({ type: "todoist.build", cid: "b", environmentId, ...(workUnitId ? { workUnitId } : {}) }));
ws.onmessage = (ev) => {
  const m = JSON.parse(String((ev as MessageEvent).data));
  if (m.type === "session.list" || m.type === "budget" || m.type === "environments" || m.type === "todoist.status") return;
  if (m.cid === "b" && m.type === "ack") {
    console.log(`✓ build accepted (${workUnitId ? `unit ${workUnitId}` : "ALL planned units"}) — watch the daemon log for \`[autopilot] …\`.`);
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
