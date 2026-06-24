#!/usr/bin/env bun
/**
 * Task-autopilot CLI.
 *
 *   bun run scripts/autopilot.ts dryrun <envNameOrId> [projectId]   # read-only: bundle + plan, print
 *   bun run scripts/autopilot.ts plan   <envNameOrId> [projectId]   # WRITES: also persists work units,
 *                                                                   #   comments the plan, tags anvil:planned
 *
 * `dryrun` touches nothing. `plan` writes to your Todoist (comments + labels) and the local work-unit
 * store. projectId defaults to the environment's linked Todoist project; pass one to test before linking.
 */
import { loadConfig } from "../src/config";
import { EnvironmentStore } from "../src/env/store";
import { IntegrationStore } from "../src/integrations/store";
import { WorkUnitStore } from "../src/integrations/workunit";
import { TodoistClient } from "../src/integrations/todoist";
import { dryRunProject, planAndTagProject } from "../src/integrations/autopilot";

const cfg = loadConfig();
const cmd = process.argv[2];
if (cmd !== "dryrun" && cmd !== "plan") {
  console.error("Usage: bun run scripts/autopilot.ts <dryrun|plan> <envNameOrId> [projectId]");
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

const client = new TodoistClient(state.accessToken);

if (cmd === "dryrun") {
  console.log(`Dry-running autopilot for "${env.name}" (${env.repoRoot})\n  project ${projectId}\n`);
  const planned = await dryRunProject(client, {
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
} else {
  console.log(`PLAN+TAG (writes to Todoist) for "${env.name}" (${env.repoRoot})\n  project ${projectId}\n`);
  const workUnits = new WorkUnitStore(cfg.stateDir);
  const { created, skipped } = await planAndTagProject(
    { client, workUnits },
    { environmentId: env.id, projectId, repoRoot: env.repoRoot, repoName: env.name, onProgress: (m) => console.log(m) },
  );
  console.log(`\n${"=".repeat(72)}\nDONE — ${created.length} work units created, ${skipped} tasks skipped (already in pipeline).`);
  for (const [i, u] of created.entries()) console.log(`  ${i + 1}. ${u.title}  [${u.taskIds.length} tasks → anvil:planned]  (${u.id})`);
}
