#!/usr/bin/env bun
/**
 * Todoist integration CLI — manage the daemon's Todoist connection and inspect structure.
 *
 *   bun run scripts/todoist.ts set [<token>]   # store token (or read $TODOIST_TOKEN / stdin), then verify
 *   bun run scripts/todoist.ts verify          # validate the stored token
 *   bun run scripts/todoist.ts dump            # print projects / sections / labels / task counts
 *   bun run scripts/todoist.ts disconnect      # remove the stored token
 *
 * Token resolution for `set`: argv → $TODOIST_TOKEN → stdin. Prefer env/stdin so the token
 * never lands in shell history.
 */
import { loadConfig } from "../src/config";
import { IntegrationStore } from "../src/integrations/store";
import { TodoistClient } from "../src/integrations/todoist";

const cfg = loadConfig();
const store = new IntegrationStore(cfg.stateDir);
const cmd = process.argv[2] ?? "verify";

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of Bun.stdin.stream()) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function clientOrExit(): Promise<TodoistClient> {
  const state = store.todoist();
  if (!state?.accessToken) {
    console.error("Not connected. Run: bun run scripts/todoist.ts set");
    process.exit(1);
  }
  return new TodoistClient(state.accessToken);
}

async function dump(client: TodoistClient): Promise<void> {
  const [projects, labels] = await Promise.all([client.projects(), client.labels()]);
  const [sections, tasks] = await Promise.all([client.sections(), client.tasks()]);

  const byProject = new Map<string, number>();
  for (const t of tasks) byProject.set(t.project_id, (byProject.get(t.project_id) ?? 0) + 1);
  const secByProject = new Map<string, number>();
  for (const s of sections) secByProject.set(s.project_id, (secByProject.get(s.project_id) ?? 0) + 1);

  console.log(`\nProjects (${projects.length}):`);
  for (const p of projects) {
    const tags = [
      p.is_inbox_project ? "inbox" : "",
      p.is_favorite ? "★" : "",
      p.parent_id ? "sub" : "",
    ].filter(Boolean).join(" ");
    console.log(
      `  ${p.name}${tags ? ` [${tags}]` : ""} — ${byProject.get(p.id) ?? 0} tasks, ` +
        `${secByProject.get(p.id) ?? 0} sections  (id ${p.id})`,
    );
  }
  console.log(`\nLabels (${labels.length}): ${labels.map((l) => l.name).join(", ") || "(none)"}`);
  console.log(`\nTotals: ${tasks.length} active tasks, ${sections.length} sections.`);
}

switch (cmd) {
  case "set": {
    const token = (process.argv[3] ?? process.env.TODOIST_TOKEN ?? (await readStdin())).trim();
    if (!token) {
      console.error("No token provided (argv / $TODOIST_TOKEN / stdin all empty).");
      process.exit(1);
    }
    const user = await new TodoistClient(token).whoami();
    store.setTodoistToken(token, user.email ?? user.full_name);
    console.log(`Connected as ${user.full_name ?? "?"} <${user.email ?? "?"}>. Token stored.`);
    await dump(new TodoistClient(token));
    break;
  }
  case "verify": {
    const client = await clientOrExit();
    const user = await client.whoami();
    console.log(`Token OK — ${user.full_name ?? "?"} <${user.email ?? "?"}>`);
    break;
  }
  case "dump": {
    await dump(await clientOrExit());
    break;
  }
  case "disconnect": {
    store.disconnectTodoist();
    console.log("Disconnected; token removed.");
    break;
  }
  default:
    console.error(`Unknown command: ${cmd}. Use set | verify | dump | disconnect.`);
    process.exit(1);
}
