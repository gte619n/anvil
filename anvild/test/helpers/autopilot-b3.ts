/**
 * The Phase B3 rig (autopilot CAD, agent-cad-and-browser spec §4.11, §4.14 item 41): a REAL
 * AutopilotService over a REAL CadworkService and lock store, a real git repo with an owner-adopted
 * `cad/rules.json`, and a fake `handoffCreate` that does what the Supervisor's does — a real git
 * worktree per builder, the session stamped with its role and unit, `prepare` awaited, then the
 * "first turn" (recorded: what the builder's worktree held at that moment). SolidCraft is whatever
 * `cli` names (the fake in CI, the real binary in test/real). No model is called anywhere: the
 * builder's tool calls are driven directly through the real `anvil_cad` server.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionSuggestion } from "@protocol";
import { cadTools } from "../../src/agent/cad-tools";
import type { PlanPartExpectations } from "../../src/cadwork/plan-expectations";
import { PermissionBroker, makePreToolUseHook } from "../../src/agent/permissions";
import { repoIdentity } from "../../src/cadwork/locks";
import { readRules } from "../../src/cadwork/rules";
import { EnvironmentStore } from "../../src/env/store";
import { AccountStore } from "../../src/auth/accounts";
import { IntegrationStore } from "../../src/integrations/store";
import { WorkUnitStore, type WorkUnit } from "../../src/integrations/workunit";
import { PassthroughRenderer } from "../../src/render/markdown";
import type { ConnectionRegistry } from "../../src/server/registry";
import { AutopilotService, type AutopilotDeps } from "../../src/session/autopilot-service";
import { CadworkService } from "../../src/session/cadwork-service";
import { BadCommand } from "../../src/session/errors";
import { IntegrationsFacade } from "../../src/session/integrations-facade";
import type { Session } from "../../src/session/session";
import { git } from "./cad-verify";
import { PLATE_EXPECTATIONS, PLATE_PARAMETERS, callable, plateBuild, tempDir, tempRepo, writeRules, type ToolCaller } from "./cad-work";
import { REFERENCE_PLATE } from "./fake-solidcraft";

/** The plan's approved numbers for the reference plate (L = 80, W = 50, T = 6). */
export const PLATE_PLAN: PlanPartExpectations = { process: "fdm-0.4", parameters: PLATE_PARAMETERS, expectations: PLATE_EXPECTATIONS as PlanPartExpectations["expectations"] };

export interface BuilderSession {
  session: Session;
  asked: { requestId: string; tool: string; suggestions: PermissionSuggestion[] }[];
  emitted: any[];
}

/** A session stand-in with what the permission hook and the CAD service read and write. */
function builderSession(id: string, cwd: string, data: Record<string, unknown>): BuilderSession {
  const asked: BuilderSession["asked"] = [];
  const emitted: any[] = [];
  const remembered = new Set<string>();
  const session = {
    id,
    data: { id, cwd, autonomy: "bypass", status: "idle", ...data },
    isAlwaysAllowed: (tool: string) => remembered.has(tool),
    rememberAllow: (tool: string) => void remembered.add(tool),
    requestPermission: (requestId: string, tool: string, _input: unknown, suggestions: PermissionSuggestion[]) => void asked.push({ requestId, tool, suggestions }),
    emit: (body: any) => {
      emitted.push(body);
      return body;
    },
    setStatus: (st: string) => void ((session as any).data.status = st),
  } as unknown as Session;
  return { session, asked, emitted };
}

/** What the builder's worktree held when its first turn began. */
export interface FirstTurn {
  sessionId: string;
  cwd: string;
  role?: string;
  workUnitId?: string;
  partJson?: any;
  lock?: { approvedBy: string; values?: unknown; declared?: Record<string, number> };
  design?: any;
}

export async function b3Rig(opts: { cli: string; units?: (seed: WorkUnitStore, envId: string) => void; committed?: (repo: string) => void }) {
  const repo = tempRepo("anvil-b3-");
  git(repo, "checkout", "-q", "-b", "main");
  writeRules(repo);
  writeFileSync(join(repo, "README.md"), "# b3\n");
  opts.committed?.(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const stateDir = tempDir("anvil-b3-state-");
  const sessions = new Map<string, Session>();
  const builders = new Map<string, BuilderSession>();
  const broadcasts: any[] = [];
  const cad = new CadworkService({
    enabled: true,
    getSession: (id) => sessions.get(id),
    registry: { toAll: (ev) => void broadcasts.push(ev) },
    stateDir,
    resolveCli: () => ({ path: opts.cli, source: "env" }),
  });
  // The owner adopted the repo's rules once (one tap; fleet-synced): every worktree of it sees that.
  const rules = readRules(repo);
  if (rules.kind !== "ok") throw new Error("rules.json did not parse");
  const id = repoIdentity(repo);
  cad.lockSync.approveRules({ repo: id.key, ...(id.remote ? { remote: id.remote } : {}), path: id.path, sha: rules.sha, text: rules.text, at: new Date().toISOString() } as any);

  const envStore = new EnvironmentStore(stateDir);
  const env = envStore.add("proj", repo);
  const seed = new WorkUnitStore(stateDir);
  opts.units?.(seed, env.id);
  const integrations = new IntegrationStore(stateDir);
  const events: any[] = [];
  const registry = { toAll: (ev: any) => void events.push(ev) } as unknown as ConnectionRegistry;
  const handoffs: any[] = [];
  const firstTurns: FirstTurn[] = [];
  const goals = new Map<string, string>();
  let n = 0;
  const deps: AutopilotDeps = {
    registry,
    stateDir,
    envStore,
    integrations,
    integrationsFacade: new IntegrationsFacade({ integrations, registry, selfBaseUrl: async () => undefined, cachedSelfBaseUrl: () => undefined }),
    accounts: new AccountStore(stateDir),
    renderer: new PassthroughRenderer(),
    adversarial: { models: [] },
    worktreeRoot: () => join(stateDir, "worktrees"),
    selfBaseUrl: async () => undefined,
    getSession: (sid) => sessions.get(sid),
    hasSession: (sid) => sessions.has(sid),
    require: (sid) => {
      const s = sessions.get(sid);
      if (!s) throw new BadCommand(`no such session: ${sid}`);
      return s;
    },
    budget: () => ({ available: false, warn: false }),
    // What Supervisor.handoffCreate does: a fresh worktree, the session stamped (role + unit) before
    // anything runs, `prepare` awaited (a throw removes the session), THEN the first turn.
    handoffCreate: async (a) => {
      handoffs.push(a);
      const sid = `sess_b${++n}`;
      const wt = join(stateDir, "worktrees", sid);
      mkdirSync(join(stateDir, "worktrees"), { recursive: true });
      git(repo, "worktree", "add", "-q", "-b", `b3-${n}`, wt, "HEAD");
      const b = builderSession(sid, wt, { ...(a.workUnitId ? { workUnitId: a.workUnitId } : {}), ...(a.workUnitRole ? { workUnitRole: a.workUnitRole } : {}), autonomy: a.autonomy ?? "bypass" });
      sessions.set(sid, b.session);
      builders.set(sid, b);
      if (a.prepare) {
        try {
          await a.prepare({ id: sid, cwd: wt });
        } catch (e) {
          sessions.delete(sid);
          builders.delete(sid);
          throw e;
        }
      }
      const pj = join(wt, "cad", "plate", "part.json");
      const dj = join(wt, "cad", "plate", "design.json");
      const lock = cad.approvalOf(wt, "plate");
      firstTurns.push({
        sessionId: sid,
        cwd: wt,
        role: (b.session.data as any).workUnitRole,
        workUnitId: (b.session.data as any).workUnitId,
        ...(existsSync(pj) ? { partJson: JSON.parse(readFileSync(pj, "utf8")) } : {}),
        ...(existsSync(dj) ? { design: JSON.parse(readFileSync(dj, "utf8")) } : {}),
        ...(lock ? { lock: { approvedBy: lock.approvedBy, values: lock.values, ...(lock.declared ? { declared: lock.declared } : {}) } } : {}),
      });
      return { id: sid, title: a.title, cwd: wt };
    },
    authDegraded: () => false,
    claimDegradeEpisodeAlert: () => false,
    pushSystemAlert: () => {},
    notifyAll: () => {},
    broadcastLoops: () => {},
    armGoal: (sid, condition) => void goals.set(sid, condition),
    cadwork: cad,
  };
  const svc = new AutopilotService(deps);
  // The Supervisor wires this: a builder works only on the parts its plan covers.
  cad.setBuilderScope((sid) => svc.builderParts(sid));

  /** The builder's `anvil_cad` tools, through the real server definitions. */
  const tools = (sid: string): ToolCaller => callable(cadTools(cad.toolDeps(sid, firstTurns.find((f) => f.sessionId === sid)!.cwd)) as any);
  /** Run the REAL permission hook for a builder's tool call. No answer is ever given (none is possible). */
  const gate = async (sid: string, tool: string, input: Record<string, unknown>) => {
    const b = builders.get(sid)!;
    const before = b.asked.length;
    const out = (await makePreToolUseHook(b.session, new PermissionBroker())({ tool_name: tool, tool_input: input } as any, "t", { signal: new AbortController().signal } as any)) as any;
    return { decision: out.hookSpecificOutput.permissionDecision as string, reason: String(out.hookSpecificOutput.permissionDecisionReason ?? ""), asked: b.asked.slice(before) };
  };
  /** The cards broadcast so far that nobody answered. */
  const openCards = () => {
    const done = new Set(broadcasts.filter((e) => e.type === "cad.expectations.resolved").map((e) => e.requestId));
    return broadcasts.filter((e) => e.type === "cad.expectations.request" && !done.has(e.requestId));
  };
  const unit = (uid: string): WorkUnit => (svc as any).workUnits.get(uid);
  /** The unit as its card shows it (whether or not it is on the pending grid right now). */
  const plan = (uid: string) => (svc as any).autopilotPlanInfo(unit(uid)) as import("@protocol").AutopilotPlanInfo;
  return { repo, stateDir, cad, svc, env, envStore, sessions, builders, broadcasts, events, handoffs, firstTurns, goals, tools, gate, openCards, unit, plan };
}

/** The builder's half of the reference plate when the plan already applied L, W, T: open, then model
 *  (the hole pattern as its own request). Throws on the first tool error. */
export async function builderBuildsPlate(t: ToolCaller): Promise<void> {
  const must = async (p: Promise<any>) => {
    const r = await p;
    if (r.isError) throw new Error(r.text);
    return r;
  };
  await must(t.open_part!({ part: "plate" }));
  const build = plateBuild(REFERENCE_PLATE);
  await must(t.batch!({ commands: build.slice(0, -1) }));
  await must(t.batch!({ commands: build.slice(-1) }));
}

/** A planned unit carrying the given CAD fields. */
export function cadUnit(seed: WorkUnitStore, envId: string, title: string, fields: Partial<WorkUnit>): WorkUnit {
  return seed.create({ environmentId: envId, todoistProjectId: "p1", taskIds: [], title, plan: `Build ${title}.`, ...fields } as any);
}
