/**
 * [B3] The Supervisor's B3 wiring, end to end with a REAL Supervisor (cad-work on) and a fake SDK
 * query (no model is called): Go creates the builder through the real `handoffCreate` — a real fresh
 * worktree, the session stamped `workUnitRole: "builder"` + `workUnitId`, the plan's approved numbers
 * applied BEFORE the first turn reaches the query — the builder gets `anvil_cad` and no browser, and the
 * turn's `result` runs the verify hook, which blocks the unit when nothing was built.
 */
import { afterEach, beforeAll, afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../../src/auth/accounts";
import { EnvironmentStore } from "../../src/env/store";
import { WorkUnitStore } from "../../src/integrations/workunit";
import { ConnectionRegistry } from "../../src/server/registry";
import { Supervisor } from "../../src/session/supervisor";
import { git } from "../helpers/cad-verify";
import { cleanupTemp, stopServices, tempRepo, until, writeRules } from "../helpers/cad-work";
import { FAKE_SOLIDCRAFT } from "../helpers/fake-solidcraft";
import { PLATE_PLAN } from "../helpers/autopilot-b3";

// A token-shaped value so the daemon is not "degraded" (it never reaches a model: the query is fake).
const savedEnv = { cli: process.env.ANVIL_SOLIDCRAFT_CLI, token: process.env.CLAUDE_CODE_OAUTH_TOKEN };
beforeAll(() => {
  process.env.ANVIL_SOLIDCRAFT_CLI = FAKE_SOLIDCRAFT;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-testtesttest-0000";
});
afterAll(() => {
  for (const [k, v] of [["ANVIL_SOLIDCRAFT_CLI", savedEnv.cli], ["CLAUDE_CODE_OAUTH_TOKEN", savedEnv.token]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const dirs: string[] = [];
const sups: Supervisor[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.shutdown?.().catch(() => undefined);
  await stopServices();
  cleanupTemp();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("[B3] wiring: Go through the Supervisor stamps the builder, applies the plan's numbers before the first turn reaches the model, and the turn's result runs the verify hook", async () => {
  const repo = tempRepo("anvil-b3-wire-");
  git(repo, "checkout", "-q", "-b", "main");
  writeRules(repo);
  writeFileSync(join(repo, "README.md"), "# b3\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "anvil-b3-wire-state-")));
  dirs.push(stateDir);
  const accounts = new AccountStore(stateDir);
  if (accounts.list().length === 0) accounts.add("test", "sk-ant-oat01-testtesttest-0000");
  const env = new EnvironmentStore(stateDir).add("proj", repo);
  const uid = new WorkUnitStore(stateDir).create({
    environmentId: env.id,
    todoistProjectId: "p",
    taskIds: [],
    title: "plate",
    plan: "Build the plate.",
    needsCad: true,
    cadExpectations: { plate: { ...PLATE_PLAN, approvedAt: "2026-11-20T00:00:00.000Z" } },
    cadExpectationsStatus: "approved",
  } as any).id;

  // The fake SDK query: records what the builder's worktree held when its FIRST user message arrived,
  // which servers it was given, then ends the turn with a `result`.
  const seen: { cwd: string; partJson?: any; servers: string[]; hasStopHook: boolean }[] = [];
  const queryFn = ((args: { prompt: AsyncIterable<any>; options: any }) => {
    const { prompt, options } = args;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const _m of prompt) {
          const pj = join(options.cwd, "cad", "plate", "part.json");
          seen.push({ cwd: options.cwd, ...(existsSync(pj) ? { partJson: JSON.parse(readFileSync(pj, "utf8")) } : {}), servers: Object.keys(options.mcpServers ?? {}), hasStopHook: !!options.hooks?.Stop?.length });
          yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 1 };
          return;
        }
      },
      interrupt: async () => {},
      setModel: async () => {},
      close: () => {},
      getContextUsage: async () => undefined,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({}),
      supportedCommands: async () => [],
    };
  }) as any;
  const sup = new Supervisor({ stateDir, accounts, envFile: join(stateDir, "env"), features: ["cad-work"], sessionQueryFn: queryFn }, new ConnectionRegistry());
  sups.push(sup);
  // The owner adopted the rules once.
  const { readRules } = await import("../../src/cadwork/rules");
  const { repoIdentity } = await import("../../src/cadwork/locks");
  const rules = readRules(repo) as any;
  const id = repoIdentity(repo);
  sup.cadwork.lockSync.approveRules({ repo: id.key, path: id.path, sha: rules.sha, text: rules.text, at: new Date().toISOString() } as any);

  const ev = await sup.startPlan(uid);
  const s = (sup as any).sessions.get(ev.sessionId);
  expect(s.data.workUnitRole).toBe("builder");
  expect(s.data.workUnitId).toBe(uid);
  await until(() => seen.length > 0, "the first turn to reach the query");
  const first = seen[0]!;
  expect(first.cwd).toBe(s.data.cwd);
  expect(first.cwd).not.toBe(repo); // a NEW worktree
  expect(first.partJson?.expectations?.lockedBy).toBe("planner"); // applied before the first turn
  expect(sup.cadwork.approvalOf(first.cwd, "plate")?.approvedBy).toBe("planner");
  expect(first.servers).toContain("anvil_cad");
  expect(first.servers).not.toContain("browser");
  expect(first.hasStopHook).toBe(true);
  // The builder's turn ended without building anything: the verify hook blocks the unit.
  const unit = () => (sup as any).autopilot.workUnits.get(uid);
  await until(() => unit().status === "blocked", "the verify hook to block the unit", 15_000);
  expect(unit().blockedReason).toContain("CAD: cad/plate");
  expect(unit().cadBlocked.reason).toContain("cad/plate");
}, 60_000);
