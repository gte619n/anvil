#!/usr/bin/env bun
/**
 * Task-autopilot CLI — dry-run the nightly BUNDLE + PLAN against a real project. Writes nothing
 * (no Todoist labels/comments, no sessions, no git): it pulls tasks, groups them into units of
 * work, and plans each by reading the repo read-only, then prints the result.
 *
 *   bun run scripts/autopilot.ts dryrun <envNameOrId> [projectId]
 *
 * projectId defaults to the environment's linked Todoist project (set in the web UI). Pass one
 * explicitly to test before linking.
 */
import { loadConfig } from "../src/config";
import { EnvironmentStore } from "../src/env/store";
import { IntegrationStore } from "../src/integrations/store";
import { TodoistClient } from "../src/integrations/todoist";
import { dryRunProject } from "../src/integrations/autopilot";

const cfg = loadConfig();
const cmd = process.argv[2];
if (cmd !== "dryrun") {
  console.error("Usage: bun run scripts/autopilot.ts dryrun <envNameOrId> [projectId]");
  process.exit(1);
}

const envStore = new EnvironmentStore(cfg.stateDir);
const integrations = new IntegrationStore(cfg.stateDir);

const envRef = process.argv[3];
if (!envRef) {
  console.error("Provide an environment name or id.");
  process.exit(1);
}
const env =
  envStore.list().find((e) => e.id === envRef) ??
  envStore.list().find((e) => e.name.toLowerCase() === envRef.toLowerCase());
if (!env) {
  console.error(`No such environment: ${envRef}. Known: ${envStore.list().map((e) => e.name).join(", ")}`);
  process.exit(1);
}

const projectId = process.argv[4] ?? env.todoistProjectId;
if (!projectId) {
  console.error(`Environment "${env.name}" has no linked Todoist project. Link it in the web UI or pass a projectId.`);
  process.exit(1);
}

const state = integrations.todoist();
if (!state?.accessToken) {
  console.error("Todoist is not connected. Run: bun run scripts/todoist.ts set");
  process.exit(1);
}

console.log(`Dry-running autopilot for "${env.name}" (${env.repoRoot})\n  project ${projectId}\n`);
const planned = await dryRunProject(new TodoistClient(state.accessToken), {
  projectId,
  repoRoot: env.repoRoot,
  repoName: env.name,
  onProgress: (m) => console.log(m),
});

console.log(`\n${"=".repeat(72)}\nPROPOSED UNITS OF WORK (${planned.length})\n${"=".repeat(72)}`);
for (const [i, u] of planned.entries()) {
  console.log(`\n### ${i + 1}. ${u.title}`);
  console.log(`Rationale: ${u.rationale}`);
  console.log(`Tasks:`);
  for (const t of u.tasks) console.log(`  • ${t.content}`);
  console.log(`\n--- Plan ---\n${u.plan}\n`);
}
