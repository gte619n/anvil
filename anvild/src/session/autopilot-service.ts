/**
 * Autopilot domain, extracted from Supervisor (P7 slice 6) — the largest slice. Owns the work-unit
 * plan lifecycle (plan cards, Go/link/dismiss/resolve, "Plan with Claude" planning sessions + their
 * MCP tools), the autopilot run (runAutopilot with its watchdog/abort/run-log), the autonomous dev
 * pipeline (runDevPipeline + §6.3 adversary metrics), the in-daemon 5-min scheduler, the inbound
 * Todoist completion sync, the anvil:* label maintenance, and the lapo run report.
 *
 * Behaviour-preserving: moved verbatim from Supervisor with its deps injected. The WorkUnitStore and
 * AutopilotScheduleStore are owned here (constructed over stateDir) — the Supervisor no longer touches
 * them. The Supervisor delegates the wire/dispatch entry points and calls startScheduler() at boot and
 * buildPlanningServer() from ensureDriver.
 */
import {
  PROTOCOL_VERSION,
  type AutonomyPolicy,
  type AutopilotMaintenanceResultEvent,
  type AutopilotPipelineMetricsEvent,
  type AutopilotPlanInfo,
  type AutopilotPlanResultEvent,
  type AutopilotPlansEvent,
  type AutopilotRunSnapshotEvent,
  type AutopilotSchedule,
  type AutopilotScheduleEvent,
  type AutopilotStartedEvent,
  type Budget,
  type Environment,
  type Model,
} from "@protocol";
import { now } from "../util/envelope";
import { newId } from "../util/ids";
import type { ConnectionRegistry } from "../server/registry";
import type { EnvironmentStore } from "../env/store";
import type { IntegrationStore } from "../integrations/store";
import type { IntegrationsFacade } from "./integrations-facade";
import type { AccountStore } from "../auth/accounts";
import type { MarkdownRenderer } from "../render/markdown";
import { WorkUnitStore, type WorkUnit } from "../integrations/workunit";
import { AutopilotScheduleStore, scheduledFireDue, nextScheduledFire, runWithinBudget } from "../integrations/schedule";
import { selectPendingPlans, selectCompletedUnits, RECONCILABLE_STATUSES, toPlanInfo, buildAutopilotBrief, buildAutopilotGoal, buildPlanningBrief } from "../integrations/autopilot-plans";
import { normalizeTrigger, type TriggerEvent } from "../integrations/event-trigger";
import type { LoopsInput } from "../integrations/loops";
import { TodoistClient, type TodoistTask } from "../integrations/todoist";
import { LapoClient, type LapoEntryEndpoint } from "../integrations/lapo";
import { buildAutopilotReport, renderJournalOutline, extractOpenQuestions, type ReportUnit } from "../integrations/lapo-report";
import { readStatus, withStatus, type AnvilStatus } from "../integrations/status";
import { planAndTagProject, planAndTagTasks, planUnit, buildTodoistPrompt } from "../integrations/autopilot";
import { autoStartDecision } from "../integrations/autostart-gate";
import { OpenRouterClient } from "../integrations/openrouter";
import { OPENROUTER_KEY } from "../auth/openrouter";
import { runDevPipeline as executeDevPipeline } from "../pipeline/run";
import { defaultAgent, captureGitDiff } from "../pipeline/adapters";
import { envChecks, gitPrOpener, workUnitTaskText, pipelineStatusToUnit, adversaryStats } from "../pipeline/daemon-adapters";
import { loadMetrics, saveMetrics } from "../pipeline/metrics-store";
import type { AdversaryMetrics } from "../pipeline/metrics";
import type { PhaseDeps } from "../pipeline/phases";
import type { PipelineOutcome } from "../pipeline/orchestrator";
import { buildPlanningToolsServer } from "../agent/planning-tools";
import type { PushPayload } from "../push/webpush";
import { createWorktree, removeWorktree } from "./worktree";
import { slugify } from "./slug";
import { BadCommand } from "./errors";
import type { Session } from "./session";

/** Hard ceiling on a single autopilot run, and the budget the DERIVED `running` state uses: a run older
 *  than this reports `running: false` to every client no matter what, so a hung run (an await that never
 *  settles, a skipped finally) can't latch the live spinner. A full multi-env run plans several units
 *  with Opus, so keep it generous enough to never cut off legitimate work. */
const AUTOPILOT_RUN_TIMEOUT_MS = 30 * 60_000;
/** Per-unit budget for a background dev-pipeline run auto-started by the scheduler. Generous: a full
 *  7-gate run with both live models + real checks + loop-backs can legitimately take a while. */
const PIPELINE_RUN_BUDGET_MS = 45 * 60_000;

/** How often the scheduler checks whether the scheduled time has arrived. */
const SCHEDULE_TICK_MS = 5 * 60_000;
/** A scheduled run fires only if the daemon notices within this window of the scheduled time. Must be
 *  > SCHEDULE_TICK_MS so a tick always lands inside it; small enough that a restart well away from the
 *  scheduled time never trips it (see scheduledFireDue — restarts must not launch a run). */
const SCHEDULE_RUN_WINDOW_MS = 10 * 60_000;
/** How far back the inbound completion sync looks for tasks checked off in Todoist. Todoist caps the
 *  completion query at ~3 months; 60 days stays well under that while covering any realistic stretch of
 *  daemon downtime between the completion and the next reconcile tick. */
const RECONCILE_WINDOW_DAYS = 60;

export interface AutopilotDeps {
  registry: ConnectionRegistry;
  stateDir: string;
  envStore: EnvironmentStore;
  integrations: IntegrationStore;
  integrationsFacade: IntegrationsFacade;
  accounts: AccountStore;
  renderer: MarkdownRenderer;
  /** Static adversarial-panel config (models + preferred provider); the KEY is resolved live. */
  adversarial: { models: string[]; provider?: string | undefined };
  /** Where pipeline worktrees are created (SessionStore.worktreeRoot). */
  worktreeRoot: () => string;
  selfBaseUrl: () => Promise<string | undefined>;
  getSession: (id: string) => Session | undefined;
  hasSession: (id: string) => boolean;
  /** Resolve a session or throw BadCommand (mirrors Supervisor.require). */
  require: (id: string) => Session;
  budget: () => Budget;
  /** Create-and-brief a new session (Supervisor.handoffCreate) — Go build + planning sessions.
   *  [BE2-2] May resolve asynchronously (fresh-worktree creation runs async git); callers await
   *  either shape, so synchronous test fakes keep working. */
  handoffCreate: (a: {
    environmentId?: string | undefined;
    source: "fresh-worktree";
    title: string;
    model?: Model | undefined;
    autonomy?: AutonomyPolicy | undefined;
    brief: string;
    workUnitId?: string | undefined;
    workUnitRole?: "planner" | undefined;
  }) => { id: string; title: string; cwd: string } | Promise<{ id: string; title: string; cwd: string }>;
  /** Degraded-machine read model (§4.6) — suppresses the scheduled run with one alert per episode. */
  authDegraded: () => boolean;
  claimDegradeEpisodeAlert: () => boolean;
  pushSystemAlert: (title: string, body: string, tag: string) => void;
  /** Fan a push out to every registry (webpush + FCM + APNs). */
  notifyAll: (payload: PushPayload) => void;
  /** Rebroadcast the Loops panel snapshot (Supervisor composes it — goal rows live on sessions). */
  broadcastLoops: () => void;
  /** Arm a run-until-done `/goal` on a freshly-created build session (Supervisor owns goal state). */
  armGoal: (sessionId: string, condition: string) => void;
}

export class AutopilotService {
  /** Work-unit + schedule stores — owned by this domain, constructed over stateDir. */
  private readonly workUnits: WorkUnitStore;
  private readonly autopilotSchedule: AutopilotScheduleStore;
  // The live run is tracked by a START TIMESTAMP, not a boolean — `running` is DERIVED from it (below),
  // so it physically cannot latch: once a run outlives AUTOPILOT_RUN_TIMEOUT_MS, every reader (schedule
  // event, connect handshake, the re-run guard) sees `running: false` automatically, even if the run's
  // cleanup never fires (a hung await, a skipped finally). A monotonically-increasing token disambiguates
  // overlapping runs so a slow run's late cleanup can't clear a newer run's state. undefined = idle.
  private autopilotRunStartedAt: number | undefined;
  private autopilotRunToken = 0;
  /** Derived live-run state: a run is "running" only while its start is within the time budget. This is
   *  the single source of truth broadcast to clients; being time-bounded is what makes the spinner
   *  un-latchable. */
  private get autopilotRunning(): boolean {
    return runWithinBudget(this.autopilotRunStartedAt, Date.now(), AUTOPILOT_RUN_TIMEOUT_MS);
  }
  private autopilotRunLog: string[] = []; // the live run's progress lines, retained so a connecting/refreshed client can replay them
  /** Work units whose autonomous dev pipeline is running right now (id → title). Feeds the Loops panel's
   *  live pipeline rows; populated at runDevPipeline start, cleared in its finally. */
  private readonly runningPipelines = new Map<string, string>();
  /** Statuses a triggered unit is considered "live" in for dedupe (a terminal one may re-propose). */
  private static readonly TRIGGER_LIVE = new Set<AnvilStatus>(["proposed", "planned", "needs-clarification", "planning", "building", "review", "blocked"]);
  private scheduleTimer?: ReturnType<typeof setInterval>;
  /** Persisted first-pass rejection-rate metric for the dev pipeline's adversaries (§6.3). */
  private readonly devPipelineMetrics: AdversaryMetrics;

  constructor(private readonly deps: AutopilotDeps) {
    this.workUnits = new WorkUnitStore(deps.stateDir);
    this.autopilotSchedule = new AutopilotScheduleStore(deps.stateDir);
    this.devPipelineMetrics = loadMetrics(deps.stateDir);
  }

  /** In-daemon autopilot timer (anvil-autopilot-ui.md → Scheduling): every 5 min check whether the
   *  scheduled time has just arrived and fire it then. `unref` so it never holds the process (or a
   *  test) open. NO startup tick on purpose — a (re)start must not kick off a run (that fired a fresh
   *  run + spinner on every restart); the run happens only when the clock crosses the scheduled time
   *  while the daemon is already running. SCHEDULE_TICK_MS must stay < SCHEDULE_RUN_WINDOW_MS so a tick
   *  always lands inside the window. */
  startScheduler(): void {
    this.scheduleTimer = setInterval(() => {
      void this.maybeRunScheduled();
      // Todoist has no webhooks, so completion is polled: on every tick, drop any pending plan whose
      // source task the user has since checked off in Todoist. Independent of whether a scheduled run
      // is due, so a card clears within a tick of the task being completed even with autopilot idle.
      void this.reconcileCompletedUnits();
    }, SCHEDULE_TICK_MS);
    this.scheduleTimer.unref?.();
  }
  private async maybeRunScheduled(): Promise<void> {
    const sched = this.autopilotSchedule.get();
    if (this.autopilotRunning || !scheduledFireDue(sched, new Date(), SCHEDULE_RUN_WINDOW_MS, sched.lastRunAt)) return;
    // Degraded machine: every unit this run planned would fail at spawn. Suppress the run rather than
    // manufacturing a nightly wall of auth errors — but say so ONCE per degraded episode, so it's not a
    // silent stop either (HJ-12/HJ-29). Stamp the window as run so the 5-min ticks don't re-alert.
    if (this.deps.authDegraded()) {
      this.autopilotSchedule.markRun(now());
      this.broadcastSchedule();
      if (this.deps.claimDegradeEpisodeAlert()) {
        console.warn("[anvild] autopilot: scheduled run suppressed — this machine has no usable Claude token.");
        this.deps.pushSystemAlert("Autopilot paused", "This machine has no Claude login, so the scheduled run was skipped. Pair it with your fleet to resume.", "auth-degraded");
      }
      return;
    }
    // Stamp the run NOW so a slow run isn't re-triggered on the next 5-min tick, and so a hard error
    // (Todoist down, no linked envs) doesn't hammer — it waits for the next scheduled window.
    this.autopilotSchedule.markRun(now());
    this.broadcastSchedule();
    try {
      await this.runAutopilot({ notify: true, autoStart: sched.autoStart, usePipeline: sched.usePipeline, maxAutoStart: sched.maxAutoStart });
    } catch {
      /* swallowed: re-tries at the next due window */
    }
  }

  /**
   * Post an autopilot run report to lapo as a markdown information entry (what was done, what's held
   * for clarification, what was skipped). Best-effort and fully defensive: a lapo hiccup must never
   * fail — or surface into — the autopilot run, so it's fire-and-forget and swallows every error. On a
   * 401 it refreshes once and retries. No-op when lapo isn't configured/connected.
   */
  async postAutopilotReport(input: {
    units: WorkUnit[];
    skipped: number;
    started: number;
    startedIds: Set<string>;
    trigger: "scheduled" | "manual";
  }): Promise<void> {
    const cfg = this.deps.integrationsFacade.effectiveLapoConfig();
    if (!cfg || !this.deps.integrations.isLapoConnected()) return;
    const client = new LapoClient(cfg);
    const appBaseUrl = await this.deps.selfBaseUrl(); // deep-link target back into this daemon's Autopilot view
    const environments = [...new Set(input.units.map((u) => this.deps.envStore.get(u.environmentId)?.name ?? u.environmentId))];
    const units: ReportUnit[] = input.units.map((u) => ({
      id: u.id,
      title: u.title,
      status: u.status,
      ...(u.summary ? { summary: u.summary } : {}),
      ...(u.effort ? { effort: u.effort } : {}),
      taskCount: u.taskIds.length,
      ...(u.source ? { source: u.source } : {}),
      started: input.startedIds.has(u.id),
      ...(u.prUrl ? { prUrl: u.prUrl } : {}),
      ...(u.status === "needs-clarification" ? { questions: extractOpenQuestions(u.plan) } : {}),
    }));
    const reportInput = {
      runAt: new Date().toISOString(),
      trigger: input.trigger,
      environments,
      units,
      skipped: input.skipped,
      started: input.started,
      ...(appBaseUrl ? { appBaseUrl } : {}), // deep link into the Autopilot view (undefined → no link)
    };
    try {
      // Prefer the entry endpoint discovered at connect; if it wasn't captured (older connection),
      // discover it now. Undefined → createEntry falls back to the configured entryPath + fields.
      let entry: LapoEntryEndpoint | undefined = this.deps.integrations.lapo()?.entry;
      if (!entry) {
        entry = await client.discoverResource();
        if (entry) this.deps.integrations.patchLapoEntry(entry);
      }
      const token = await this.deps.integrationsFacade.lapoAccessToken(client);
      // A journal endpoint (no title field) renders as a Logseq outline folded under one collapsed
      // node — so a run adds a single tidy bullet to the day's journal. A document endpoint gets the
      // titled markdown report instead.
      const doc = entry && entry.titleField
        ? buildAutopilotReport(reportInput)
        : { title: "", markdown: renderJournalOutline(reportInput) };
      try {
        const res = await client.createEntry(token, doc, entry);
        console.log(`[lapo] posted autopilot report${res.url ? ` → ${res.url}` : ""}`);
      } catch (e) {
        // Token may have lapsed between the refresh check and the write — refresh once and retry.
        const stored = this.deps.integrations.lapo();
        if (e instanceof Error && /→ 401\b/.test(e.message) && stored?.refreshToken) {
          const next = await client.refresh(stored.refreshToken, { tokenEndpoint: stored.tokenEndpoint });
          this.deps.integrations.patchLapoTokens(next);
          const res = await client.createEntry(next.accessToken, doc, entry);
          console.log(`[lapo] posted autopilot report (after refresh)${res.url ? ` → ${res.url}` : ""}`);
        } else throw e;
      }
    } catch (e) {
      console.warn(`[lapo] couldn't post the autopilot report: ${e instanceof Error ? e.message : String(e)}`);
    }
  }


  // ── Autopilot plan review (anvil-autopilot-ui.md) ─────────────────────────────────
  // Selection + presentation logic lives in integrations/autopilot-plans.ts (pure + unit-tested);
  // these methods just supply the Supervisor's stores/renderer.
  /** Pending plans = planned work units not yet started; what the Autopilot card grid shows. */
  private pendingPlans(): WorkUnit[] {
    return selectPendingPlans(this.workUnits.list());
  }

  /** Shape a WorkUnit for the card grid + reader (env name + the rendered plan markdown). */
  private autopilotPlanInfo(u: WorkUnit): AutopilotPlanInfo {
    return toPlanInfo(u, this.deps.envStore.get(u.environmentId)?.name, this.deps.renderer);
  }

  /** The §6.3 adversary calibration metrics for the Models settings card. */
  devPipelineMetricsEvent(cid?: string): AutopilotPipelineMetricsEvent {
    return { v: PROTOCOL_VERSION, type: "autopilot.pipeline.metrics", ts: now(), ...(cid ? { cid } : {}), adversaries: adversaryStats(this.devPipelineMetrics) };
  }
  autopilotPlansEvent(cid?: string): AutopilotPlansEvent {
    return {
      v: PROTOCOL_VERSION,
      type: "autopilot.plans",
      ts: now(),
      ...(cid ? { cid } : {}),
      plans: this.pendingPlans().map((u) => this.autopilotPlanInfo(u)),
    };
  }
  private broadcastAutopilotPlans(): void {
    this.deps.registry.toAll(this.autopilotPlansEvent());
    this.deps.broadcastLoops(); // proposals/pipelines feed the Loops panel — keep it in lockstep with the grid
  }

  /** Seed a loop.convert with a draft work unit's request (name / env / prompt), or undefined if gone. */
  workUnitSeed(id: string): { name: string; environmentId?: string; prompt: string } | undefined {
    const u = this.workUnits.get(id);
    if (!u) return undefined;
    return { name: u.title, ...(u.environmentId ? { environmentId: u.environmentId } : {}), prompt: workUnitTaskText(u) };
  }

  /** The autopilot-owned slice of the Loops panel snapshot (the Supervisor adds the goal rows). */
  loopsInputs(): Omit<LoopsInput, "goals"> {
    const schedule = this.autopilotSchedule.get();
    const next = nextScheduledFire(schedule, new Date());
    const envName = (id?: string): { environmentId?: string; environmentName?: string } => {
      if (!id) return {};
      const name = this.deps.envStore.get(id)?.name;
      return { environmentId: id, ...(name ? { environmentName: name } : {}) };
    };
    const pipelines = [...this.runningPipelines].map(([id, title]) => {
      const u = this.workUnits.get(id);
      const phaseReached = u?.devPipeline?.phaseReached;
      return { id, title, ...(phaseReached ? { phaseReached } : {}), ...envName(u?.environmentId) };
    });
    const proposals = this.workUnits
      .list()
      .filter((u) => u.status === "proposed")
      .map((u) => ({ id: u.id, title: u.title, source: u.trigger?.source ?? "event", ...envName(u.environmentId) }));
    // Drafts a human owns next: planned/needs-clarification units not yet building (Loops home's
    // "drafts at your gate" section). Excludes proposed (its own row above), building, and terminal states.
    const drafts = this.workUnits
      .list()
      .filter((u) => u.status === "planned" || u.status === "needs-clarification")
      .map((u) => ({ id: u.id, title: u.title, status: u.status, source: u.trigger?.source ?? "Todoist", ...envName(u.environmentId) }));
    return {
      schedule: { enabled: schedule.enabled, timeOfDay: schedule.timeOfDay, running: this.autopilotRunning, autoStart: schedule.autoStart, ...(next ? { nextRunAt: next.toISOString() } : {}) },
      pipelines,
      proposals,
      drafts,
    };
  }


  /**
   * Open an interactive "Plan with Claude" session on a work unit (replaces the old refine chat).
   * Unlike Go (`startPlan`, which seeds the plan and builds autonomously), this hands the session the
   * FULL context — the live Todoist prompt, the design so far, and any open questions — and lets the
   * user and Claude settle the plan together before building. It's a continuous session: once the plan
   * is agreed it can implement here, or call `run_pipeline` to hand off to the autonomous loop. Works on
   * held (needs-clarification) units too — this is how their open questions get answered.
   */
  async startPlanningSession(workUnitId: string, model?: Model, autonomy?: AutonomyPolicy, cid?: string): Promise<AutopilotStartedEvent> {
    const u = this.workUnits.get(workUnitId);
    if (!u) throw new BadCommand(`no such work unit: ${workUnitId}`);
    if (u.sessionId && this.deps.hasSession(u.sessionId)) throw new BadCommand("this plan already has a live session");
    const env = this.deps.envStore.get(u.environmentId);
    if (!env) throw new BadCommand("the plan's environment no longer exists");
    // Best-effort: re-fetch the live Todoist prompt (task text + comments) so the session sees exactly
    // what the user asked for, not just the planner's derived plan. Todoist offline → empty, plan carries on.
    let todoistPrompt = "";
    const state = this.deps.integrations.todoist();
    if (state?.accessToken) {
      try {
        todoistPrompt = await buildTodoistPrompt(new TodoistClient(state.accessToken), u.taskIds, AbortSignal.timeout(30_000));
      } catch {
        /* Todoist unreachable — plan on the derived plan alone */
      }
    }
    const { id } = await this.deps.handoffCreate({
      environmentId: env.id,
      source: "fresh-worktree",
      title: u.title,
      model: model ?? "opus",
      // Interactive by default: it should ask the open questions and confirm the design, not blast ahead.
      autonomy: autonomy ?? "mostly-autonomous",
      brief: buildPlanningBrief(u, todoistPrompt),
      workUnitId: u.id,
      workUnitRole: "planner",
    });
    this.workUnits.update(u.id, { sessionId: id, status: "planning" });
    void this.tagTasks(u, "planning");
    this.broadcastAutopilotPlans();
    return { v: PROTOCOL_VERSION, type: "autopilot.started", ts: now(), ...(cid ? { cid } : {}), workUnitId: u.id, sessionId: id };
  }

  /** Build the planning-session MCP server (save_plan / run_pipeline), closed over its session id. */
  buildPlanningServer(sessionId: string) {
    return buildPlanningToolsServer({
      sessionId,
      savePlan: (plan, ready) => this.plannerSavePlan(sessionId, plan, ready),
      runPipeline: () => this.plannerRunPipeline(sessionId),
    });
  }

  /** `save_plan` tool: a planning session writes its settled plan back onto its work unit and posts it
   *  to Todoist. Scoped to the session's own unit. `ready` is advisory (the unit stays owned by the live
   *  session); it just marks the plan settled in the Todoist note. */
  private plannerSavePlan(sessionId: string, plan: string, ready: boolean): string {
    const u = this.plannerUnit(sessionId);
    this.workUnits.update(u.id, { plan });
    void this.postPlanComment(
      u,
      ready
        ? `🤖 **anvil** settled the plan for “${u.title}” in a planning session.`
        : `🤖 **anvil** checkpointed a work-in-progress plan for “${u.title}”.`,
    );
    this.broadcastAutopilotPlans();
    return `Saved the plan to “${u.title}”${ready ? " and marked it settled" : " as a checkpoint"}. Posted it to Todoist.`;
  }

  /** `run_pipeline` tool: a planning session hands its settled unit to the autonomous dev pipeline (§4).
   *  Fire-and-forget — progress streams to the Autopilot screen; returns once the run is launched. */
  private plannerRunPipeline(sessionId: string): string {
    const u = this.plannerUnit(sessionId);
    void this.runDevPipeline(u.id, { signal: AbortSignal.timeout(PIPELINE_RUN_BUDGET_MS) }).catch((e) => {
      this.broadcastRunProgress(`⚠ Pipeline “${u.title}” failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    return `Started the review→development→testing pipeline for “${u.title}”. It builds in a fresh worktree and opens a PR; watch the Autopilot screen for progress.`;
  }

  /** Resolve + validate a planning session's work unit (guards the save_plan/run_pipeline tools). */
  private plannerUnit(sessionId: string): WorkUnit {
    const s = this.deps.require(sessionId);
    if (s.data.workUnitRole !== "planner" || !s.data.workUnitId) throw new BadCommand("not a planning session");
    const u = this.workUnits.get(s.data.workUnitId);
    if (!u) throw new BadCommand(`no such work unit: ${s.data.workUnitId}`);
    return u;
  }

  /** Reassign a plan to a different environment (repo) and re-evaluate it there: re-plan the unit's
   *  existing tasks against the new repo, persist the fresh plan/summary/effort, note it on Todoist,
   *  broadcast, and return the updated plan. Used to correct a mis-routed (e.g. label-sourced) plan. */
  async reassignPlan(workUnitId: string, environmentId: string, cid?: string): Promise<AutopilotPlanResultEvent> {
    const u = this.workUnits.get(workUnitId);
    if (!u) throw new BadCommand(`no such work unit: ${workUnitId}`);
    if (u.sessionId && this.deps.hasSession(u.sessionId)) throw new BadCommand("this plan already has a running session; can't reassign it");
    const env = this.deps.envStore.get(environmentId);
    if (!env) throw new BadCommand("no such environment");
    if (env.id === u.environmentId) throw new BadCommand("the plan is already in that environment");
    const state = this.deps.integrations.todoist();
    if (!state?.accessToken) throw new BadCommand("Todoist is not connected");
    const client = new TodoistClient(state.accessToken);
    const tasks: TodoistTask[] = [];
    for (const id of u.taskIds) {
      try {
        tasks.push(await client.getTask(id));
      } catch {
        /* skip a deleted/closed task */
      }
    }
    if (tasks.length === 0) throw new BadCommand("this plan has no live tasks to re-evaluate");
    const planned = await planUnit(
      { title: u.title, rationale: u.rationale ?? "", taskIds: tasks.map((t) => t.id) },
      tasks,
      { repoRoot: env.repoRoot, accounts: this.deps.accounts, ...(env.accountId ? { accountId: env.accountId } : {}) },
    );
    const updated = this.workUnits.update(u.id, {
      environmentId: env.id,
      plan: planned.plan,
      ...(planned.summary ? { summary: planned.summary } : {}),
      ...(planned.effort ? { effort: planned.effort } : {}),
    });
    void this.postPlanComment(
      u,
      `🤖 **anvil** re-evaluated “${u.title}” against **${env.name}**.\n\n${planned.summary?.trim() || "Plan updated."}`,
    );
    this.broadcastAutopilotPlans();
    return { v: PROTOCOL_VERSION, type: "autopilot.plan", ts: now(), ...(cid ? { cid } : {}), plan: this.autopilotPlanInfo(updated ?? u) };
  }

  /** Reject a plan: label its member tasks `anvil:dismissed` (so the nightly run skips them) and
   *  drop the card. Best-effort on the Todoist side — the local status change is authoritative. */
  async dismissPlan(workUnitId: string): Promise<void> {
    const u = this.workUnits.get(workUnitId);
    if (!u) throw new BadCommand(`no such work unit: ${workUnitId}`);
    const state = this.deps.integrations.todoist();
    if (state?.accessToken) {
      const client = new TodoistClient(state.accessToken);
      for (const taskId of u.taskIds) {
        try {
          const t = await client.getTask(taskId);
          await client.setTaskLabels(taskId, withStatus(t.labels, "dismissed"));
        } catch {
          /* a deleted/closed task — skip it, the local status still drops the card */
        }
      }
    }
    this.workUnits.update(u.id, { status: "dismissed" });
    this.broadcastAutopilotPlans();
  }

  /** Mark a plan completed or expired: relabel its member tasks (anvil:completed / anvil:expired) and,
   *  when `closeTodoist`, close them in Todoist too. Drops the card (status is no longer "planned").
   *  Best-effort on the Todoist side — the local status change is authoritative. */
  async resolvePlan(workUnitId: string, status: "completed" | "expired", closeTodoist: boolean): Promise<void> {
    const u = this.workUnits.get(workUnitId);
    if (!u) throw new BadCommand(`no such work unit: ${workUnitId}`);
    const state = this.deps.integrations.todoist();
    if (state?.accessToken) {
      const client = new TodoistClient(state.accessToken);
      for (const taskId of u.taskIds) {
        try {
          const t = await client.getTask(taskId);
          await client.setTaskLabels(taskId, withStatus(t.labels, status));
          if (closeTodoist) await client.closeTask(taskId);
        } catch {
          /* a deleted/closed task — skip it, the local status still drops the card */
        }
      }
    }
    this.workUnits.update(u.id, { status });
    this.broadcastAutopilotPlans();
  }

  /** Inbound completion sync (Todoist → anvil): when the human checks off a plan's source task(s) in
   *  Todoist, mark that work unit `completed` here too, so the card leaves the grid on its own. Todoist
   *  has no webhooks, so this polls the completion-date endpoint — driven by the schedule tick and the
   *  top of every autopilot run. Best-effort: a Todoist hiccup just means we retry next tick; a unit with
   *  a live build session is left alone (its session, not the checkbox, owns its lifecycle). Returns the
   *  number of units completed. */
  async reconcileCompletedUnits(): Promise<number> {
    if (this.autopilotRunning) return 0; // don't race a run that's mutating the same store
    const state = this.deps.integrations.todoist();
    if (!state?.accessToken) return 0;
    const isLive = (u: WorkUnit): boolean => !!u.sessionId && this.deps.hasSession(u.sessionId);
    const pending = this.workUnits
      .list()
      .filter((u) => RECONCILABLE_STATUSES.has(u.status) && !isLive(u) && u.taskIds.length > 0);
    if (pending.length === 0) return 0;
    // One completion query per distinct project the pending units draw from — this is exactly the set of
    // boards we care about, whether project- or label-sourced (each unit stores the project its tasks live in).
    const projectIds = new Set(pending.map((u) => u.todoistProjectId).filter((id): id is string => !!id));
    const client = new TodoistClient(state.accessToken);
    const completed = new Set<string>();
    try {
      for (const projectId of projectIds) {
        for (const t of await client.completedTasks({ projectId, windowDays: RECONCILE_WINDOW_DAYS })) completed.add(t.id);
      }
    } catch {
      return 0; // Todoist unreachable/rate-limited — leave the cards as-is and retry next tick
    }
    const done = selectCompletedUnits(pending, completed, isLive);
    for (const u of done) this.workUnits.update(u.id, { status: "completed" });
    if (done.length > 0) this.broadcastAutopilotPlans();
    return done.length;
  }

  // ── Autopilot maintenance (Todoist-settings buttons) ──────────────────────────────
  /** Remove the anvil:* status label from each given task (best-effort), keeping the user's own labels —
   *  including the "Autopilot" sourcing label — intact. Returns how many tasks actually had one removed. */
  private async stripAnvilLabels(taskIds: Iterable<string>): Promise<number> {
    const state = this.deps.integrations.todoist();
    if (!state?.accessToken) return 0;
    const client = new TodoistClient(state.accessToken);
    let cleared = 0;
    for (const taskId of new Set(taskIds)) {
      try {
        const t = await client.getTask(taskId);
        if (!readStatus(t.labels)) continue; // no anvil:* label → nothing to strip
        await client.setTaskLabels(taskId, withStatus(t.labels, undefined));
        cleared++;
      } catch {
        /* a deleted/closed task — skip it */
      }
    }
    return cleared;
  }

  /** Every Todoist task currently carrying an anvil:* status label, swept straight from Todoist across
   *  all linked project boards and the Autopilot sourcing label. This sees labels orphaned from a work
   *  unit that no longer exists (e.g. a wiped/lost store) — which the known-units list cannot — so Reset
   *  can clear them and let the task be re-planned. Best-effort: returns whatever it managed to gather. */
  private async taggedTaskIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    const state = this.deps.integrations.todoist();
    if (!state?.accessToken) return ids;
    const client = new TodoistClient(state.accessToken);
    const label = this.autopilotSchedule.get().label;
    try {
      const swept: TodoistTask[] = [];
      for (const env of this.deps.envStore.list()) {
        if (env.todoistProjectId) swept.push(...(await client.tasks(env.todoistProjectId)));
      }
      if (label) swept.push(...(await client.tasksByLabel(label)));
      for (const t of swept) if (readStatus(t.labels)) ids.add(t.id);
    } catch {
      /* best-effort sweep — fall back to whatever was gathered */
    }
    return ids;
  }

  /** Reset the pipeline so tasks can be re-planned: strip anvil:* labels and drop the work units that
   *  aren't tied to a live session (in-progress builds are left alone). The "Autopilot" sourcing label
   *  is preserved, so the next run picks the tasks straight back up. Sweeps Todoist directly for tagged
   *  tasks too, so labels orphaned by a lost work unit don't block a re-plan forever. */
  async resetAnvilTags(cid?: string): Promise<AutopilotMaintenanceResultEvent> {
    const all = this.workUnits.list();
    const isLive = (u: WorkUnit) => !!u.sessionId && this.deps.hasSession(u.sessionId);
    const resettable = all.filter((u) => !isLive(u));
    // Tasks owned by a live build session keep their labels — the running session depends on them.
    const protectedIds = new Set<string>();
    for (const u of all) if (isLive(u)) for (const id of u.taskIds) protectedIds.add(id);
    // Clear every anvil-tagged task: the resettable units' members PLUS any orphaned by a lost unit
    // (swept straight from Todoist), minus the protected live-session ones.
    const toClear = await this.taggedTaskIds();
    for (const u of resettable) for (const id of u.taskIds) toClear.add(id);
    for (const id of protectedIds) toClear.delete(id);
    const tasksCleared = await this.stripAnvilLabels(toClear);
    for (const u of resettable) this.workUnits.remove(u.id);
    this.broadcastAutopilotPlans();
    return { v: PROTOCOL_VERSION, type: "autopilot.maintenance.result", ts: now(), ...(cid ? { cid } : {}), op: "reset", tasksCleared, unitsRemoved: resettable.length };
  }

  /** Clear the autopilot entirely: strip anvil:* labels from every unit's tasks and remove ALL work
   *  units (the pending grid empties). Running sessions are not killed, but their unit is forgotten. */
  async clearAutopilot(cid?: string): Promise<AutopilotMaintenanceResultEvent> {
    const units = this.workUnits.list();
    const taskIds = new Set<string>();
    for (const u of units) for (const id of u.taskIds) taskIds.add(id);
    const tasksCleared = await this.stripAnvilLabels(taskIds);
    for (const u of units) this.workUnits.remove(u.id);
    this.broadcastAutopilotPlans();
    return { v: PROTOCOL_VERSION, type: "autopilot.maintenance.result", ts: now(), ...(cid ? { cid } : {}), op: "clear", tasksCleared, unitsRemoved: units.length };
  }

  /** Go: create a fresh-worktree session seeded with the plan and start it. Autonomy defaults to
   *  `bypass` so the work runs without stalling on a permission prompt. The card then leaves the
   *  pending grid (sessionId set + status building). */
  // [BE2-2] Async: Go spawns a fresh-worktree session whose creation runs async git (base-sync fetch).
  async startPlan(workUnitId: string, model?: Model, autonomy?: AutonomyPolicy, cid?: string): Promise<AutopilotStartedEvent> {
    const u = this.workUnits.get(workUnitId);
    if (!u) throw new BadCommand(`no such work unit: ${workUnitId}`);
    if (u.sessionId && this.deps.hasSession(u.sessionId)) throw new BadCommand("this plan already has a running session");
    // A held unit's "plan" is just its open questions — building it would implement nothing useful. Force
    // the reviewer to answer them first, in a "Plan with Claude" session, before it can start.
    if (u.status === "needs-clarification") throw new BadCommand("this plan needs clarification — open a planning session (Plan with Claude) to answer its open questions before starting");
    // Server-side propose-don't-run: the web hides Start for proposals, but the gate must hold for ANY
    // client — an unapproved event-triggered unit never builds without an explicit approve.
    if (u.status === "proposed") throw new BadCommand("this plan is a proposal awaiting approval — approve it first (autopilot.approve)");
    const env = this.deps.envStore.get(u.environmentId);
    if (!env) throw new BadCommand("the plan's environment no longer exists");
    const brief = this.autopilotBrief(u);
    // Seed the build session with a `/goal` derived from the plan so it self-verifies to completion — the
    // Stop hook keeps it going until a judge agrees the plan is actually built + the checks pass, rather
    // than stopping the instant the model claims it's done (loop-engineering: run-until-done).
    const goalCondition = buildAutopilotGoal(u);
    const { id } = await this.deps.handoffCreate({
      environmentId: env.id,
      source: "fresh-worktree",
      title: u.title,
      model: model ?? "opus",
      autonomy: autonomy ?? "bypass",
      brief,
    });
    // Clear any auto-start hold — a human is deliberately starting it now — and record the seeded goal.
    this.workUnits.update(u.id, { sessionId: id, status: "building", hold: undefined, ...(goalCondition ? { goalCondition } : {}) });
    if (goalCondition) this.deps.armGoal(id, goalCondition);
    void this.tagTasks(u, "building");
    this.broadcastAutopilotPlans();
    return { v: PROTOCOL_VERSION, type: "autopilot.started", ts: now(), ...(cid ? { cid } : {}), workUnitId: u.id, sessionId: id };
  }

  /** Link a plan to an existing session that's already doing the work, instead of spawning a new one
   *  via Go. Sets the unit's sessionId + status building and tags its tasks — the card then leaves the
   *  pending grid, exactly like startPlan. The session must belong to the plan's environment. */
  linkPlan(workUnitId: string, sessionId: string, cid?: string): AutopilotStartedEvent {
    const u = this.workUnits.get(workUnitId);
    if (!u) throw new BadCommand(`no such work unit: ${workUnitId}`);
    if (u.sessionId && this.deps.hasSession(u.sessionId)) throw new BadCommand("this plan already has a running session");
    if (u.status === "proposed") throw new BadCommand("this plan is a proposal awaiting approval — approve it first (autopilot.approve)");
    const session = this.deps.getSession(sessionId);
    if (!session) throw new BadCommand("no such session");
    if (session.data.environmentId !== u.environmentId) throw new BadCommand("that session belongs to a different environment");
    // A human deliberately linking the plan to live work clears any auto-start hold (mirrors startPlan).
    this.workUnits.update(u.id, { sessionId, status: "building", hold: undefined });
    void this.tagTasks(u, "building");
    this.broadcastAutopilotPlans();
    return { v: PROTOCOL_VERSION, type: "autopilot.started", ts: now(), ...(cid ? { cid } : {}), workUnitId: u.id, sessionId };
  }

  /** The opening brief handed to a plan's build session (see integrations/autopilot-plans.ts). */
  private autopilotBrief(u: WorkUnit): string {
    return buildAutopilotBrief(u);
  }

  // ── Event-driven intake (loop-engineering: Channels) ──────────────────────────────────
  /**
   * Ingest an external event as a PROPOSED work unit (a CI failure, a labelled task, a webhook). Defaults
   * to needing a human approve — nothing runs unattended off an event unless a trusted source opts in via
   * `autoApprove`. Dedupes on the trigger key so a re-delivered event collapses onto the existing card.
   */
  async ingestTrigger(input: TriggerEvent): Promise<AutopilotPlanInfo> {
    const intent = normalizeTrigger(input, new Date().toISOString());
    const envId =
      intent.environmentId ??
      this.autopilotSchedule.get().defaultEnvironmentId ??
      this.deps.envStore.list().find((e) => e.todoistProjectId)?.id ??
      this.deps.envStore.list()[0]?.id;
    if (!envId) throw new BadCommand("no environment is configured to route the trigger to");
    const env = this.deps.envStore.get(envId);
    if (!env) throw new BadCommand("the target environment no longer exists");
    // Dedupe: a live unit with the same trigger key already covers this event — return it, don't clone.
    const dup = this.workUnits
      .list()
      .find((u) => u.trigger?.dedupeKey === intent.trigger.dedupeKey && AutopilotService.TRIGGER_LIVE.has(u.status));
    if (dup) return this.autopilotPlanInfo(dup);
    const unit = this.workUnits.create({
      environmentId: env.id,
      todoistProjectId: env.todoistProjectId ?? "",
      taskIds: [],
      title: intent.title,
      summary: intent.summary,
      ...(input.body ? { rationale: input.body } : {}),
      trigger: intent.trigger,
      status: intent.autoApprove ? "planned" : "proposed",
    });
    this.broadcastAutopilotPlans();
    // A trusted source may auto-run: it's already `planned`, so start a build if the budget is healthy.
    if (intent.autoApprove && !this.deps.budget().warn) {
      try {
        await this.startPlan(unit.id);
      } catch (e) {
        console.error(`[autopilot] auto-approved trigger “${unit.title}” could not start: ${e instanceof Error ? e.message : e}`);
      }
    }
    return this.autopilotPlanInfo(this.workUnits.get(unit.id) ?? unit);
  }

  /**
   * Approve a proposed (event-triggered) unit: promote it to `planned` and, when `start`, launch the build
   * immediately. Rejecting a proposal reuses the existing `autopilot.dismiss` path. Returns the started
   * event (when `start`) or the promoted plan.
   */
  async approveProposed(workUnitId: string, start: boolean, cid?: string): Promise<AutopilotStartedEvent | AutopilotPlanResultEvent> {
    const u = this.workUnits.get(workUnitId);
    if (!u) throw new BadCommand(`no such work unit: ${workUnitId}`);
    if (u.status !== "proposed") throw new BadCommand(`only a proposed plan can be approved (this one is ${u.status})`);
    this.workUnits.update(u.id, { status: "planned" });
    this.broadcastAutopilotPlans();
    if (start) return this.startPlan(u.id, undefined, undefined, cid);
    return { v: PROTOCOL_VERSION, type: "autopilot.plan", ts: now(), ...(cid ? { cid } : {}), plan: this.autopilotPlanInfo(this.workUnits.get(u.id)!) };
  }

  /** Clear the display-only goalCondition mirror when a session's goal resolves (called by Supervisor). */
  clearGoalCondition(sessionId: string): void {
    const unit = this.workUnits.list().find((u) => u.sessionId === sessionId && u.goalCondition);
    if (unit) this.workUnits.update(unit.id, { goalCondition: undefined });
  }

  /** Re-plan linked Todoist projects on this server (the Autopilot "Run autopilot" button + the
   *  scheduled run). Broadcasts refreshed plans; when `autoStart`, launches up to `maxAutoStart` of
   *  the new units (skipped while the budget is warning); pushes a summary when `notify`. */
  async runAutopilot(opts: {
    environmentId?: string;
    notify?: boolean;
    autoStart?: boolean;
    usePipeline?: boolean; // auto-start units through the autonomous dev pipeline (§4) instead of a plain build session
    maxAutoStart?: number;
  }): Promise<{ created: number; skipped: number; started: number; output: string }> {
    if (this.autopilotRunning) throw new BadCommand("an autopilot run is already in progress");
    const state = this.deps.integrations.todoist();
    if (!state?.accessToken) throw new BadCommand("Todoist is not connected");
    // Clear any plan whose source task was checked off since the last tick before we plan afresh, so a
    // manual "Run autopilot" reflects completions immediately. Runs before the run marks itself active.
    await this.reconcileCompletedUnits().catch(() => 0);
    // Run-level abort: the watchdog (below) fires it on timeout so every in-flight Todoist/SDK call
    // unwinds instead of hanging the run open. Threaded into the client and the planning calls.
    const ac = new AbortController();
    const client = new TodoistClient(state.accessToken, ac.signal);
    // Build the adversarial panel once for this run — a plain OpenRouter client (its own provider/key,
    // outside the §3 subscription-auth guard). The key is read LIVE from the environment so a key set via
    // Settings → Models applies to this run without a restart. Threaded into planning with the same
    // run-level signal so a timed-out/cancelled run tears down the OpenRouter calls too. Undefined → skipped.
    const openRouterKey = (process.env[OPENROUTER_KEY] ?? "").trim();
    const adversarial =
      openRouterKey && process.env.ANVIL_ADVERSARIAL !== "0" // key present + not killed via ANVIL_ADVERSARIAL=0
        ? {
            enabled: true,
            client: new OpenRouterClient(openRouterKey, ac.signal, this.deps.adversarial.provider),
            models: this.deps.adversarial.models,
          }
        : undefined;
    const envs = this.deps.envStore
      .list()
      .filter((e) => e.todoistProjectId && (!opts.environmentId || e.id === opts.environmentId));
    const schedule = this.autopilotSchedule.get();
    const defaultEnv = schedule.defaultEnvironmentId ? this.deps.envStore.get(schedule.defaultEnvironmentId) : undefined;
    // The account-wide Autopilot-label pass runs only on a full run (no single-env scope) and needs both a
    // label and a resolvable catch-all environment configured.
    const labelPass = !opts.environmentId && !!schedule.label && !!defaultEnv;
    if (envs.length === 0 && !labelPass) throw new BadCommand("no environments are linked to a Todoist project");
    const deps = { client, workUnits: this.workUnits };
    this.autopilotRunLog = [];
    const emit = (line: string): void => {
      this.autopilotRunLog.push(line);
      this.broadcastRunProgress(line); // every client, live — not just the one that triggered the run
    };
    // Each unit broadcasts the refreshed plan list the moment it's persisted, so every client's grid
    // climbs in real time (12 → 13 → …) instead of only filling in when the whole run finishes.
    const onUnitCreated = (): void => this.broadcastAutopilotPlans();
    const token = ++this.autopilotRunToken;
    this.autopilotRunStartedAt = Date.now();
    this.broadcastSchedule(); // tell every client a run just started (running: true)
    // Watchdog: clients only re-render `running` when they RECEIVE a schedule event, so once the derived
    // state flips to false (run outlived its budget) we proactively abort the hung work and broadcast it,
    // rather than waiting for the next connect. The derived getter already guarantees correctness; this
    // just makes the spinner clear promptly and frees the in-flight subprocess/socket.
    const watchdog = setTimeout(() => {
      if (this.autopilotRunToken !== token) return; // a newer run already owns the state
      emit("⚠ Autopilot run exceeded its time budget — ending it. Check the daemon log if this recurs.");
      ac.abort();
      this.autopilotRunStartedAt = undefined;
      this.broadcastSchedule();
    }, AUTOPILOT_RUN_TIMEOUT_MS);
    watchdog.unref?.(); // a pending watchdog must never keep the daemon alive on its own
    const createdUnits: WorkUnit[] = [];
    const startedUnitIds = new Set<string>(); // units this run auto-started — feeds the lapo report
    let skipped = 0;
    let started = 0;
    try {
      for (const env of envs) {
        // Name the Claude account the run bills to, so the report/log says whose subscription paid
        // for an unattended run rather than leaving it to be inferred (§6).
        const envAcct = this.deps.accounts.labelOf(env.accountId ?? this.deps.accounts.defaultId());
        emit(`▸ ${env.name}${envAcct ? ` · account: ${envAcct}` : ""}`);
        const res = await this.runEnvPlan(emit, env.name, () =>
          planAndTagProject(deps, {
          environmentId: env.id,
          projectId: env.todoistProjectId!,
          repoRoot: env.repoRoot,
          repoName: env.name,
          adversarial,
          signal: ac.signal,
          onProgress: emit,
          onUnitCreated,
          // Unattended runs bill to the environment's chosen account, else the roster default (§6).
            accounts: this.deps.accounts,
            ...(env.accountId ? { accountId: env.accountId } : {}),
          }),
        );
        if (!res) continue; // this environment failed; the others still run
        createdUnits.push(...res.created);
        skipped += res.skipped;
      }
      // Account-wide label pass: pull every @<label> task, drop those a linked project already covers
      // (coexist + dedup), and plan the rest against the catch-all env. These are review-only (below).
      if (labelPass && defaultEnv && schedule.label) {
        const labelAcct = this.deps.accounts.labelOf(defaultEnv.accountId ?? this.deps.accounts.defaultId());
        emit(`▸ @${schedule.label} → ${defaultEnv.name}${labelAcct ? ` · account: ${labelAcct}` : ""}`);
        const linkedProjectIds = new Set(
          this.deps.envStore.list().map((e) => e.todoistProjectId).filter((id): id is string => !!id),
        );
        const labelled = await client.tasksByLabel(schedule.label);
        const external = labelled.filter((t) => !linkedProjectIds.has(t.project_id));
        emit(`  ${labelled.length} @${schedule.label} task(s) · ${external.length} outside linked projects.`);
        const res = await planAndTagTasks(deps, {
          environmentId: defaultEnv.id,
          repoRoot: defaultEnv.repoRoot,
          repoName: defaultEnv.name,
          tasks: external,
          adversarial,
          signal: ac.signal,
          onProgress: emit,
          onUnitCreated,
          accounts: this.deps.accounts,
          ...(defaultEnv.accountId ? { accountId: defaultEnv.accountId } : {}),
        });
        createdUnits.push(...res.created);
        skipped += res.skipped;
      }
      // Auto-start the new units, capped, and only when the subscription budget is healthy — an
      // unattended run must never spawn a swarm of sessions or exhaust the weekly window. Each unit must
      // also clear the auto-start gate: label-sourced units are review-only, units held `needs-clarification`
      // by intake are never built, and a plan the adversarial panel scored below the confidence bar is left
      // `planned` for a human. (The intake/clarification holds were already logged during planning; only
      // surface the adversarial-quality holds here so the run log explains a plan that DID get planned but
      // won't build.)
      const autoStartable: WorkUnit[] = [];
      for (const u of createdUnits) {
        const decision = autoStartDecision(u);
        if (decision.start) autoStartable.push(u);
        else if (u.source !== "label" && u.status === "planned" && decision.reason) {
          // Persist the hold on the unit so the stop-reason is durable on the card (not just this run's
          // log): the panel can show "Held: adversarial 4/10" until a human starts or dismisses it.
          this.workUnits.update(u.id, { hold: { reason: decision.reason, at: new Date().toISOString() } });
          emit(`⏸ Holding “${u.title}” — ${decision.reason}.`);
        }
      }
      // Pipeline auto-start needs an OpenRouter key (GLM authors several gates); fall back to a plain build
      // session if the operator asked for the pipeline but no key is set, rather than failing every unit.
      const pipeline = opts.usePipeline && !!openRouterKey;
      if (opts.usePipeline && !openRouterKey) emit("⚠ Pipeline requested but no OpenRouter key is set — falling back to build sessions. Set one in Settings → Models.");
      if (opts.autoStart && autoStartable.length) {
        if (this.deps.budget().warn) {
          emit("⏸ Auto-start skipped — subscription budget is in its warn zone; plans left for review.");
        } else {
          const cap = opts.maxAutoStart ?? 3;
          for (const u of autoStartable.slice(0, cap)) {
            try {
              if (pipeline) {
                // Long-running (all 7 gates, both models, opens a PR). Fire in the background with its own
                // budget so one slow unit can't pin the scheduled run open; progress + status update live.
                emit(`🔬 Pipeline “${u.title}”…`);
                void this.runDevPipeline(u.id, { signal: AbortSignal.timeout(PIPELINE_RUN_BUDGET_MS) })
                  .then((o) => emit(`  “${u.title}” → ${o.status} (reached ${o.phaseReached}).`))
                  .catch((e) => emit(`⚠ Pipeline “${u.title}” failed: ${e instanceof Error ? e.message : String(e)}`));
              } else {
                await this.startPlan(u.id);
                emit(`🚀 Started “${u.title}”.`);
              }
              started++;
              startedUnitIds.add(u.id);
            } catch (e) {
              emit(`⚠ Couldn't start “${u.title}”: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          if (autoStartable.length > cap) emit(`${autoStartable.length - cap} more plan(s) left for manual review (cap ${cap}).`);
        }
      }
    } finally {
      clearTimeout(watchdog);
      // Only clear if THIS run still owns the state — a watchdog-timed-out run that's been superseded by
      // a newer run must not wipe the newer run's start timestamp when its own late cleanup finally runs.
      if (this.autopilotRunToken === token) this.autopilotRunStartedAt = undefined;
      this.broadcastSchedule(); // run finished (or errored) — tell every client (running: false)
    }
    const created = createdUnits.length;
    this.broadcastAutopilotPlans();
    // Post a run report to lapo (best-effort, fire-and-forget) — what was done, what's held for
    // clarification, and what was skipped. Only when something actually happened this run (empty runs
    // are skipped by the operator's choice). `notify` is true only for the scheduled run, so it also
    // distinguishes the nightly run from a manual "Run autopilot" in the report header.
    if (created > 0 || started > 0) {
      void this.postAutopilotReport({
        units: createdUnits,
        skipped,
        started,
        startedIds: startedUnitIds,
        trigger: opts.notify ? "scheduled" : "manual",
      });
    }
    if (opts.notify && created > 0) {
      const body = started
        ? `${created} new plan${created === 1 ? "" : "s"} · ${started} started`
        : `${created} new plan${created === 1 ? "" : "s"} ready to review`;
      const payload: PushPayload = { title: "Anvil autopilot", body, tag: "autopilot", kind: "result" };
      this.deps.notifyAll(payload);
    }
    return { created, skipped, started, output: this.autopilotRunLog.join("\n") };
  }

  /**
   * Run the autonomous dev pipeline (§4) for a planned work unit: intake → the tier-selected gauntlet,
   * in a fresh worktree, with the environment's validation commands as the P4 gate and the existing
   * git/gh ops opening the PR at P6. Both models run through the Agent SDK (GLM via OpenRouter's
   * Anthropic Skin). Persists the trace record on the unit + the §6.3 metrics on completion. Opt-in
   * (manual trigger) — it does not replace the existing startPlan build flow.
   */
  async runDevPipeline(workUnitId: string, opts: { signal?: AbortSignal; onProgress?: (m: string) => void } = {}): Promise<PipelineOutcome> {
    const u = this.workUnits.get(workUnitId);
    if (!u) throw new BadCommand(`no such work unit: ${workUnitId}`);
    if (u.status === "needs-clarification") throw new BadCommand("this plan needs clarification — open a planning session (Plan with Claude) to answer its open questions before running the pipeline");
    if (u.status === "proposed") throw new BadCommand("this plan is a proposal awaiting approval — approve it first (autopilot.approve)");
    const env = this.deps.envStore.get(u.environmentId);
    if (!env) throw new BadCommand("the work unit's environment no longer exists");
    if (!(process.env[OPENROUTER_KEY] ?? "").trim()) throw new BadCommand("the dev pipeline needs an OpenRouter key — set one in Settings → Models");
    // Default to broadcasting progress to every client (so the live view updates like an autopilot run).
    const log = opts.onProgress ?? ((m: string) => this.broadcastRunProgress(m));
    const runId = newId("pipe");
    const branch = `${slugify(u.title)}-pipeline`;
    // One worktree for the whole run: read-only phases inspect it, P3/P4 write, P6 opens the PR from it.
    const { cwd } = await createWorktree(env.repoRoot, env.defaultBase ?? "HEAD", branch, this.deps.worktreeRoot(), runId);
    this.runningPipelines.set(u.id, u.title); // surface it as a live loop in the Loops panel
    this.deps.broadcastLoops();
    try {
      const glmSlug = this.deps.adversarial.models.find((m) => /glm/i.test(m));
      const deps: PhaseDeps = {
        task: { id: u.id, text: workUnitTaskText(u) },
        repoRoot: cwd,
        ...(glmSlug ? { glmSlug } : {}),
        agent: defaultAgent,
        ...(env.validation?.commands?.length ? { checks: envChecks(env.validation.commands) } : {}),
        openPr: gitPrOpener(branch),
        captureDiff: captureGitDiff,
      };
      const outcome = await executeDevPipeline(deps, { metrics: this.devPipelineMetrics, log, signal: opts.signal });
      const mapped = pipelineStatusToUnit(outcome);
      this.workUnits.update(u.id, {
        devPipeline: { status: outcome.status, phaseReached: outcome.phaseReached, ...(outcome.reason ? { reason: outcome.reason } : {}), trace: outcome.trace },
        status: mapped.status,
        // The pipeline was deliberately run on this unit — drop any pre-run auto-start hold so the
        // review/blocked card shows the pipeline verdict, not a stale "Held — adversarial…" banner.
        hold: undefined,
        ...(mapped.prUrl ? { prUrl: mapped.prUrl } : {}),
        ...(mapped.blockedReason ? { blockedReason: mapped.blockedReason } : {}),
      });
      this.broadcastAutopilotPlans();
      log(`Pipeline ${outcome.status} at ${outcome.phaseReached}${outcome.reason ? ` — ${outcome.reason}` : ""}.`);
      return outcome;
    } finally {
      this.runningPipelines.delete(workUnitId); // pipeline loop ended (shipped/blocked/threw)
      this.deps.broadcastLoops();
      // [BE-13] Persist metrics on EVERY exit, not just success. `executeDevPipeline` mutates the
      // in-memory tallies (recordFirstPass) as it runs; a run that throws is exactly one where the
      // adversary fired hardest, so saving only on success biased the §6.3 collusion metric toward
      // clean runs. saveMetrics is atomic (tmp+rename), so a partial write can't corrupt the file.
      saveMetrics(this.deps.stateDir, this.devPipelineMetrics);
      // The branch (when shipped) is on origin via P6's push; the local worktree is disposable either way.
      try {
        removeWorktree(env.repoRoot, cwd, branch);
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  // ── Autopilot schedule (in-daemon timer) ──────────────────────────────────────────
  autopilotScheduleEvent(cid?: string): AutopilotScheduleEvent {
    const schedule = this.autopilotSchedule.get();
    const next = nextScheduledFire(schedule, new Date());
    return {
      v: PROTOCOL_VERSION,
      type: "autopilot.schedule",
      ts: now(),
      ...(cid ? { cid } : {}),
      schedule,
      ...(next ? { nextRunAt: next.toISOString() } : {}),
      running: this.autopilotRunning,
    };
  }
  private broadcastSchedule(): void {
    this.deps.registry.toAll(this.autopilotScheduleEvent());
    this.deps.broadcastLoops(); // the schedule heartbeat + its running state are loop rows
  }
  /** Stream one run-progress line to every connected client (live, regardless of who started the run —
   *  or whether it was the scheduler). Centralized here so manual and scheduled runs behave the same. */
  private broadcastRunProgress(line: string): void {
    this.deps.registry.toAll({ v: PROTOCOL_VERSION, type: "autopilot.run.progress", ts: now(), line });
  }
  /** The live run's accumulated progress, for replay to a client that connects/refreshes mid-run so it
   *  restores the running view instead of blanking. `log` is empty when no run is in flight. */
  autopilotRunSnapshotEvent(cid?: string): AutopilotRunSnapshotEvent {
    return {
      v: PROTOCOL_VERSION,
      type: "autopilot.run.snapshot",
      ts: now(),
      ...(cid ? { cid } : {}),
      running: this.autopilotRunning,
      log: this.autopilotRunning ? [...this.autopilotRunLog] : [],
    };
  }
  setAutopilotSchedule(patch: Partial<Omit<AutopilotSchedule, "lastRunAt">>, cid?: string): AutopilotScheduleEvent {
    this.autopilotSchedule.set(patch);
    this.broadcastSchedule(); // every device (no cid)
    return this.autopilotScheduleEvent(cid); // the requester (cid)
  }

  /** Best-effort: set every member task's anvil status label (used on dismiss/build/promotion transitions). */
  private async tagTasks(u: WorkUnit, status: AnvilStatus): Promise<void> {
    const state = this.deps.integrations.todoist();
    if (!state?.accessToken) return;
    const client = new TodoistClient(state.accessToken);
    for (const taskId of u.taskIds) {
      try {
        const t = await client.getTask(taskId);
        await client.setTaskLabels(taskId, withStatus(t.labels, status));
      } catch {
        /* skip a missing task */
      }
    }
  }
  /** Best-effort: post a comment on the unit's first task (the plan-carrying one). */
  private async postPlanComment(u: WorkUnit, content: string): Promise<void> {
    const state = this.deps.integrations.todoist();
    const taskId = u.taskIds[0];
    if (!state?.accessToken || !taskId) return;
    try {
      await new TodoistClient(state.accessToken).addComment(taskId, content);
    } catch {
      /* comment is an audit nicety — never fail the plan save over it */
    }
  }


  /**
   * Run ONE environment's planning pass, isolated. The scheduled run used to have a `finally` but no
   * `catch`, so a single failing environment — most easily one left pointing at a removed Claude
   * account — aborted the whole nightly run, silently taking every environment after it with no
   * report. An unattended run must degrade per-environment, not all-or-nothing.
   */
  private async runEnvPlan<T>(emit: (line: string) => void, envName: string, run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit(`  ⚠ ${envName} failed: ${msg} — continuing with the remaining environments.`);
      console.warn(`[autopilot] environment ${envName} failed: ${msg}`);
      return undefined;
    }
  }
}
