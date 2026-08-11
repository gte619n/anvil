/**
 * LoopService (loops-circuit spec §4) — the daemon integration for the first-class Loop entity: owns the
 * LoopStore + LoopEngine, binds the engine's injected ports to the real machinery (a fresh worktree per
 * run, a bounded Claude turn for `session-prompt` bodies, a subprocess for `skill-check` + `command`
 * checks, judgeGoal for `judge` checks, git/gh for the gate), and exposes the `loop.*` command surface.
 *
 * Deps are injected (the AutopilotService pattern) so the wiring stays testable and the Supervisor only
 * gathers the projections. The engine itself is proven deterministically by test/integration/loops-*.
 */
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { newId } from "../util/ids";
import { now } from "../util/envelope";
import { slugify } from "./slug";
import { createWorktree, removeWorktree } from "./worktree";
import { runAgentQuery } from "../agent/query";
import { judgeGoal } from "../agent/goal";
import { sdkModelId } from "../agent/models";
import { commit as gitCommit, push as gitPush, createPr as gitCreatePr } from "../git/ops";
import { LoopStore } from "../loops/store";
import { LoopEngine, type LapExecution, type LoopEngineDeps } from "../loops/engine";
import { completeLoop, chainCycleReason, chainedTargets, eventTargets } from "../loops/contract";
import { scheduledFireDue } from "../integrations/schedule";
import { BadCommand } from "./errors";
import { PROTOCOL_VERSION } from "@protocol";
import type {
  Loop,
  LoopInput,
  LoopIntakeResultEvent,
  LoopIntakeSuggestion,
  LoopRun,
  LoopsListEvent,
  LoopUpdatedEvent,
  LoopRunEvent,
  LoopRunsEvent,
  Model,
} from "@protocol";

const SESSION_INTAKE_BUDGET = 300_000;
const PIPELINE_INTAKE_BUDGET = 400_000;

/** Best-effort: the repo's configured test script (package.json "scripts.test"), for a repo-aware check. */
function readTestScript(repoRoot: string): string | undefined {
  try {
    const pkgPath = join(repoRoot, "package.json");
    if (!existsSync(pkgPath)) return undefined;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    const test = pkg.scripts?.test;
    if (!test) return undefined;
    // Prefer a runner-native invocation over "npm test" so a narrowing keyword can append cleanly.
    if (/\bbun\b/.test(test)) return "bun test";
    if (/\bvitest\b/.test(test)) return "vitest run";
    if (/\bjest\b/.test(test)) return "jest";
    return "npm test";
  } catch {
    return undefined;
  }
}
import type { EnvironmentStore } from "../env/store";
import type { ConnectionRegistry } from "../server/registry";
import type { AccountStore } from "../auth/accounts";

export interface LoopServiceDeps {
  registry: ConnectionRegistry;
  stateDir: string;
  envStore: EnvironmentStore;
  worktreeRoot: () => string;
  /** The agent env (token + provider) for judge spawns — the Supervisor's agentEnv(). */
  judgeEnv: () => Record<string, string>;
  /** Multi-account roster + the account this daemon bills to (absent ⇒ env-var path). */
  accounts?: AccountStore;
  accountId?: () => string | undefined;
  /** Push notification fan-out (at-gate / failure / success). `deepLink` is the #loops/<id> hash. */
  notify?: (title: string, body: string, tag: string, deepLink?: string) => void;
  /** Loops feed the Phase-0 projection panel too — nudge it when the entity set changes. */
  onCatalogChange?: () => void;
  /** Run the Todoist-intake autopilot (the re-homed nightly) — returns a one-line summary + draft count. */
  autopilotRun?: () => Promise<{ created: number; summary: string }>;
}

const LOOP_SCHEDULE_WINDOW_MS = 10 * 60_000; // edge-trigger window (matches the autopilot scheduler)
const TICK_MS = 60_000; // per-loop trigger tick

/** Per-run worktree bookkeeping (in-memory; durable checkpoint/resume is Phase 5). */
interface RunWorktree {
  cwd: string;
  branch: string;
  repoRoot: string;
}

export class LoopService {
  private readonly store: LoopStore;
  private readonly engine: LoopEngine;
  private readonly worktrees = new Map<string, RunWorktree>(); // runId → worktree

  constructor(private readonly deps: LoopServiceDeps) {
    mkdirSync(deps.stateDir, { recursive: true });
    this.store = new LoopStore(deps.stateDir);
    this.engine = new LoopEngine(this.engineDeps());
  }

  // ── Engine ports bound to the real machinery ──────────────────────────────────────────────────────
  private engineDeps(): LoopEngineDeps {
    return {
      store: this.store,
      now: () => new Date(now()),
      genRunId: () => newId("run"),
      runLap: (a) => this.runLap(a.loop, a.run, a.feedback, a.note),
      judge: (condition, transcript) => judgeGoal(condition, transcript, this.deps.judgeEnv()).then((v) => ({ met: v.met, ...(v.reason ? { reason: v.reason } : {}) })),
      runCommand: (command, cwd) => this.shellExit(command, cwd),
      openGateAction: (loop, run) => this.openGateAction(loop, run),
      onRun: (run) => this.broadcastRun(run),
      notify: (loop, run, kind) => this.notifyGate(loop, run, kind),
    };
  }

  /** Drive one lap of the act body in the run's worktree; return the diff + transcript + tokens. */
  private async runLap(loop: Loop, run: LoopRun, feedback?: string, note?: string): Promise<LapExecution> {
    const wt = await this.ensureWorktree(loop, run);
    if (loop.act.kind === "skill-check") {
      const r = await this.shellExit(loop.act.command, wt.cwd);
      const diffFiles = await this.diffFiles(wt.cwd);
      return { diffFiles, summary: `skill: exit ${r.exit}`, tokens: 0, transcript: r.output, cwd: wt.cwd };
    }
    if (loop.act.kind === "session-prompt") {
      const extra = [feedback ? `\n\nPrevious lap feedback: ${feedback}` : "", note ? `\n\nReviewer note: ${note}` : ""].join("");
      const prompt = `${loop.act.prompt}${extra}\n\nStay within the loop's scope. Do not edit the check's own inputs.`;
      const model = this.modelSpec(loop.act.model);
      const res = await runAgentQuery(prompt, {
        model,
        cwd: wt.cwd,
        readonly: false,
        ...(this.deps.accounts ? { accounts: this.deps.accounts } : {}),
        ...(this.deps.accountId?.() ? { accountId: this.deps.accountId()! } : {}),
      });
      const diffFiles = await this.diffFiles(wt.cwd);
      // runAgentQuery doesn't surface usage; approximate lap tokens from prompt+response length so the
      // budget guard is grounded (exactness improves when the SDK exposes usage — decision D-2xx).
      const tokens = Math.ceil((prompt.length + res.text.length) / 4);
      return { diffFiles, summary: firstLine(res.text) || "worked a lap", tokens, transcript: res.text, cwd: wt.cwd };
    }
    // autopilot / pipeline bodies are Phase 4/5.
    throw new BadCommand(`act body "${loop.act.kind}" is not runnable yet`);
  }

  private modelSpec(model?: Model): { id: "claude"; profile: "claude"; sdkModel: string; label: string } {
    return { id: "claude", profile: "claude", sdkModel: sdkModelId(model ?? "opus"), label: model ?? "opus" };
  }

  private async ensureWorktree(loop: Loop, run: LoopRun): Promise<RunWorktree> {
    const existing = this.worktrees.get(run.id);
    if (existing) return existing;
    const env = loop.environmentId ? this.deps.envStore.get(loop.environmentId) : undefined;
    if (!env) throw new BadCommand("this loop needs an environment to run a session/skill body");
    const branch = `loop/${slugify(loop.name)}-${run.id}`;
    const { cwd } = await createWorktree(env.repoRoot, env.defaultBase ?? "HEAD", branch, this.deps.worktreeRoot(), run.id);
    const wt: RunWorktree = { cwd, branch, repoRoot: env.repoRoot };
    this.worktrees.set(run.id, wt);
    return wt;
  }

  /** Files the lap touched: tracked changes vs HEAD + untracked (excludes ignored). Repo-relative. */
  private async diffFiles(cwd: string): Promise<string[]> {
    const tracked = await this.gitLines(["diff", "--name-only", "HEAD"], cwd);
    const untracked = await this.gitLines(["ls-files", "--others", "--exclude-standard"], cwd);
    return [...new Set([...tracked, ...untracked])].filter(Boolean);
  }
  private async gitLines(args: string[], cwd: string): Promise<string[]> {
    const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out.trim().split("\n").map((s) => s.trim()).filter(Boolean);
  }
  private async shellExit(command: string, cwd: string): Promise<{ exit: number; output: string }> {
    const p = Bun.spawn(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    return { exit: code, output: `${out}${err}`.trim() };
  }

  /** Ship per rung at the gate. Suggest: report only. Draft: commit+push branch. PR/Ship: +open a PR. */
  private async openGateAction(loop: Loop, run: LoopRun): Promise<{ summary: string; url?: string }> {
    const wt = this.worktrees.get(run.id);
    if (loop.rung === "suggest" || !wt) return { summary: "Report published (Suggest rung — no branch)" };
    const msg = `${loop.name} (loop ${loop.id}, run ${run.id})`;
    gitCommit(wt.cwd, msg); // no-op if nothing to commit
    if (loop.rung === "draft") {
      const p = gitPush(wt.cwd, wt.branch);
      return { summary: p.ok ? `Pushed branch ${wt.branch}` : `Push failed: ${lastLine(p.output)}` };
    }
    // pr / ship
    const push = gitPush(wt.cwd, wt.branch);
    if (!push.ok) return { summary: `Push failed: ${lastLine(push.output)}` };
    const pr = gitCreatePr(wt.cwd, loop.name, `Automated by loop ${loop.id}. Assumptions:\n${loop.assumptions.map((a) => `- ${a}`).join("\n") || "(none)"}`);
    return { summary: pr.ok ? "Opened PR" : `PR failed: ${lastLine(pr.output)}`, ...(pr.url ? { url: pr.url } : {}) };
  }

  private notifyGate(loop: Loop, run: LoopRun, kind: "gate" | "failure" | "success"): void {
    if (!this.deps.notify) return;
    const title = "Anvil loop";
    const link = `#loops/${loop.id}`; // deep link into the loop's detail (gate verbs live there)
    if (kind === "gate" && loop.notify.onGate) this.deps.notify(title, `${loop.name} is at your gate`, `loop-${loop.id}`, link);
    else if (kind === "failure" && loop.notify.onFailure) this.deps.notify(title, `${loop.name}: ${run.status} — ${run.reason ?? ""}`, `loop-${loop.id}`, link);
    else if (kind === "success" && loop.notify.onSuccess) this.deps.notify(title, `${loop.name} shipped`, `loop-${loop.id}`, link);
  }

  // ── Broadcast helpers ──────────────────────────────────────────────────────────────────────────────
  private loopsListEvent(cid?: string): LoopsListEvent {
    return { v: PROTOCOL_VERSION, type: "loops.list", ts: now(), ...(cid ? { cid } : {}), loops: this.store.list() };
  }
  private loopUpdatedEvent(loop: Loop, cid?: string): LoopUpdatedEvent {
    return { v: PROTOCOL_VERSION, type: "loop.updated", ts: now(), ...(cid ? { cid } : {}), loop };
  }
  private runEvent(run: LoopRun, cid?: string): LoopRunEvent {
    return { v: PROTOCOL_VERSION, type: "loop.run", ts: now(), ...(cid ? { cid } : {}), run };
  }
  private broadcastRun(run: LoopRun): void {
    this.deps.registry.toAll(this.runEvent(run));
    // A run reaching a terminal frees its worktree (Suggest) — keep pushed branches for Draft/PR.
    const loop = this.store.get(run.loopId);
    if (["failed", "over-budget", "no-progress", "interrupted", "shipped"].includes(run.status)) {
      const wt = this.worktrees.get(run.id);
      if (wt && (run.status !== "shipped" || loop?.rung === "suggest")) {
        try {
          removeWorktree(wt.repoRoot, wt.cwd, wt.branch);
        } catch {
          /* best-effort */
        }
        this.worktrees.delete(run.id);
      }
    }
    // Chained triggers: when a run reaches a terminal, fire loops chained onto it (spec §4.3, edge-triggered).
    if (["shipped", "failed", "over-budget", "no-progress"].includes(run.status)) this.fireChained(run);
  }

  /** Fire loops whose `chained` trigger matches this run's terminal outcome (success/failure/any). */
  private fireChained(run: LoopRun): void {
    for (const loop of chainedTargets(this.store.list(), run.loopId, run.status)) {
      if (this.engine.isActive(loop.id)) continue;
      void this.startRun(loop, { kind: "chained", source: `after ${run.loopId} (${run.status})` });
    }
  }
  private broadcastCatalog(): void {
    this.deps.registry.toAll(this.loopsListEvent());
    this.deps.onCatalogChange?.();
  }

  // ── Command surface ────────────────────────────────────────────────────────────────────────────────
  list(cid?: string): LoopsListEvent {
    return this.loopsListEvent(cid);
  }
  /** Session ids owned by a live run — fed to the projection so a real Loop's session isn't double-drawn. */
  activeRunSessionIds(): string[] {
    const out: string[] = [];
    for (const loop of this.store.list()) {
      const run = this.store.latestRun(loop.id);
      if (run && run.sessionId && ["running", "at-gate", "sent-back"].includes(run.status)) out.push(run.sessionId);
    }
    return out;
  }
  runsEvent(loopId: string, cid?: string): LoopRunsEvent {
    return { v: PROTOCOL_VERSION, type: "loop.runs", ts: now(), ...(cid ? { cid } : {}), loopId, runs: this.store.runs(loopId) };
  }

  save(input: LoopInput, cid?: string): LoopUpdatedEvent {
    const existing = input.id ? this.store.get(input.id) : undefined;
    if (input.id && !existing) throw new BadCommand(`no such loop: ${input.id}`);
    // Edit-while-armed is rejected — pause to edit (spec §7). Trigger/schedule changes are the exception.
    if (existing && existing.status === "armed") throw new BadCommand("pause this loop before editing it");
    const { loop } = completeLoop(input, { now: now(), genId: () => newId("loop"), ...(existing ? { existing } : {}) });
    // Chain cycle-check at save (spec §5): a chained loop must not reach itself through its links.
    const cycle = chainCycleReason(this.store.list(), { id: loop.id, trigger: loop.trigger });
    if (cycle) throw new BadCommand(`can't save: ${cycle}`);
    this.store.save(loop);
    this.broadcastCatalog();
    return this.loopUpdatedEvent(loop, cid);
  }
  remove(loopId: string, cid?: string): { v: number; type: "ack"; ts: string; cid?: string } {
    if (!this.store.remove(loopId)) throw new BadCommand(`no such loop: ${loopId}`);
    this.broadcastCatalog();
    return { v: PROTOCOL_VERSION, type: "ack", ts: now(), ...(cid ? { cid } : {}) };
  }
  arm(loopId: string, cid?: string): LoopUpdatedEvent {
    const loop = this.require(loopId);
    if (loop.status === "disabled") throw new BadCommand("this loop is disabled");
    loop.status = "armed";
    loop.updatedAt = now();
    this.store.save(loop);
    this.broadcastCatalog();
    return this.loopUpdatedEvent(loop, cid);
  }
  pause(loopId: string, cid?: string): LoopUpdatedEvent {
    const loop = this.require(loopId);
    loop.status = "paused";
    loop.updatedAt = now();
    this.store.save(loop);
    this.broadcastCatalog();
    return this.loopUpdatedEvent(loop, cid);
  }

  /** Start a manual run (fire-and-forget; the run streams via loop.run). Returns the initial run event. */
  run(loopId: string, cid?: string): LoopRunEvent {
    const loop = this.require(loopId);
    if (this.engine.isActive(loopId)) throw new BadCommand("a run is already live for this loop");
    void this.startRun(loop, { kind: "manual" });
    const latest = this.store.latestRun(loopId);
    return this.runEvent(latest ?? placeholderRun(loop), cid);
  }

  /** Drive a run in the background (laps + gate stream via onRun). The `autopilot` singleton delegates to
   *  the re-homed Todoist-intake run instead of the lap engine. */
  private async startRun(loop: Loop, trigger: { kind: string; source?: string }): Promise<void> {
    try {
      if (loop.act.kind === "autopilot") await this.runAutopilotLoop(loop, trigger);
      else await this.engine.run(loop, trigger);
    } catch (e) {
      console.error(`[loops] run ${loop.id} failed:`, e);
    }
  }

  /** The re-homed nightly autopilot (spec §5): one lap that runs the Todoist re-plan and reports the
   *  drafts it produced. Terminal `shipped` (the drafts land in the home's "drafts at your gate"). */
  private async runAutopilotLoop(loop: Loop, trigger: { kind: string; source?: string }): Promise<void> {
    if (this.engine.isActive(loop.id)) return;
    const nowIso = now();
    const run: LoopRun = {
      id: newId("run"),
      loopId: loop.id,
      configRevision: loop.configRevision,
      trigger: { kind: trigger.kind, ...(trigger.source ? { source: trigger.source } : {}), at: nowIso },
      status: "running",
      laps: [],
      startedAt: nowIso,
    };
    this.store.putRun(run);
    this.broadcastRun(run);
    const result = this.deps.autopilotRun ? await this.deps.autopilotRun() : { created: 0, summary: "autopilot not wired" };
    run.laps.push({ n: 1, summary: result.summary, verdicts: [{ check: "tasks triaged into drafts", v: "pass" }], at: now() });
    run.status = "shipped";
    run.reason = `${result.created} draft${result.created === 1 ? "" : "s"} created`;
    run.endedAt = now();
    this.store.putRun(run);
    this.broadcastRun(run);
  }

  // ── Trigger scheduler (per-loop tick; edge-triggered like the autopilot scheduler) ────────────────────
  private scheduleTimer?: ReturnType<typeof setInterval>;
  startScheduler(): void {
    if (this.scheduleTimer) return;
    this.ensureAutopilotLoop();
    this.scheduleTimer = setInterval(() => this.tick(), TICK_MS);
    if (typeof this.scheduleTimer.unref === "function") this.scheduleTimer.unref();
    // The first tick fires on the interval (≤TICK_MS) — no synchronous boot tick, so tests that drive
    // tick() with a fake clock aren't polluted by a real-time boot fire.
  }
  stopScheduler(): void {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.scheduleTimer = undefined;
  }
  /** One trigger tick: fire any armed schedule loop whose window is due (no catch-up, no double-fire). */
  tick(nowD: Date = new Date(now())): void {
    for (const loop of this.store.list()) {
      if (loop.status !== "armed" || loop.trigger.kind !== "schedule") continue;
      if (this.engine.isActive(loop.id)) continue;
      const sched = { enabled: true, timeOfDay: loop.trigger.timeOfDay, autoStart: false, ...(loop.trigger.days ? { days: loop.trigger.days } : {}) } as Parameters<typeof scheduledFireDue>[0];
      const lastRunAt = this.store.latestRun(loop.id)?.startedAt;
      if (scheduledFireDue(sched, nowD, LOOP_SCHEDULE_WINDOW_MS, lastRunAt)) void this.startRun(loop, { kind: "schedule" });
    }
    this.maybeDigest(nowD);
  }

  /** Daily digest (spec §4 Phase 4): once per calendar day (after 09:00 local), if any loop opted in,
   *  send one summary push — how many loops are at your gate / shipped / stopped. In-memory day marker
   *  (best-effort; resets on restart). */
  private lastDigestDay?: string;
  private maybeDigest(nowD: Date): void {
    if (nowD.getHours() < 9) return;
    const day = `${nowD.getFullYear()}-${nowD.getMonth() + 1}-${nowD.getDate()}`; // local day (matches getHours)
    if (this.lastDigestDay === day) return;
    this.lastDigestDay = day;
    if (!this.store.list().some((l) => l.notify.dailyDigest)) return;
    let atGate = 0, shipped = 0, stopped = 0;
    for (const l of this.store.list()) {
      const r = this.store.latestRun(l.id);
      if (!r) continue;
      if (r.status === "at-gate") atGate++;
      else if (r.status === "shipped") shipped++;
      else if (["failed", "over-budget", "no-progress"].includes(r.status)) stopped++;
    }
    this.deps.notify?.("Anvil loops — daily digest", `${atGate} at your gate · ${shipped} shipped · ${stopped} stopped`, "loops-digest", "#loops");
  }

  /** Route an external event to matching armed `event` loops (dedupe by key). Called from ingestTrigger. */
  private readonly eventDedupe = new Set<string>();
  private static readonly EVENT_DEDUPE_CAP = 2000; // bound the set so a long-lived daemon can't leak
  handleEvent(eventKind: string, source: string, dedupeKey?: string): void {
    for (const loop of eventTargets(this.store.list(), eventKind)) {
      if (loop.trigger.kind !== "event") continue; // narrow (eventTargets already guarantees it)
      // A per-loop dedupeKey on the trigger overrides the event's key (idempotency), spec §7.
      const key = `${loop.id}:${loop.trigger.dedupeKey ?? dedupeKey ?? source}`;
      if (this.eventDedupe.has(key)) continue;
      if (this.eventDedupe.size >= LoopService.EVENT_DEDUPE_CAP) this.eventDedupe.clear(); // simple bound (rare)
      this.eventDedupe.add(key);
      if (this.engine.isActive(loop.id)) continue;
      void this.startRun(loop, { kind: "event", source });
    }
  }

  /** Ensure the daemon-managed Todoist-intake singleton exists (the re-homed nightly autopilot). */
  private ensureAutopilotLoop(): void {
    const id = "loop_autopilot";
    if (this.store.get(id)) return;
    const nowIso = now();
    const loop: Loop = {
      id,
      name: "Todoist intake",
      status: "armed",
      trigger: { kind: "schedule", timeOfDay: "02:00" },
      act: { kind: "autopilot" },
      checks: [{ kind: "judge", condition: "every task triaged into a draft" }],
      checksMode: "all",
      rung: "suggest",
      hardStops: { maxLaps: 1, tokenBudget: PIPELINE_INTAKE_BUDGET, noProgressLaps: 1 },
      assumptions: [],
      notify: { onGate: false, onFailure: true, onSuccess: false, dailyDigest: true },
      cleanGatedLaps: 0,
      configRevision: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.store.save(loop);
  }

  /** Dry-run the first lap in a throwaway worktree (report only). Removes the worktree after — no branch/PR. */
  async dryRun(loopId: string, cid?: string): Promise<LoopRunEvent> {
    const loop = this.require(loopId);
    if (this.engine.isActive(loopId)) throw new BadCommand("a run is already live for this loop");
    const run = await this.engine.dryRun(loop);
    const wt = this.worktrees.get(run.id);
    if (wt) {
      try {
        removeWorktree(wt.repoRoot, wt.cwd, wt.branch);
      } catch {
        /* best-effort */
      }
      this.worktrees.delete(run.id);
    }
    return this.runEvent(run, cid);
  }

  /** Repo-aware intake proposal (spec §4.4): a heuristic check/scope/stops/gate + logged assumptions for
   *  an outcome. Reads the env's package.json test script so the check matches the repo. (A small-model
   *  enhancement is a follow-up — this deterministic core keeps intake CI-reproducible.) */
  intakeSuggest(prompt: string, environmentId?: string, cid?: string): LoopIntakeResultEvent {
    const p = prompt.trim();
    const isFeature = !/\b(fix|flak|bug|broke|broken|fail|regress)/i.test(p) && /\b(add|export|feature|build|create|new|implement)/i.test(p);
    // A repo-relative noun to narrow the check + scope (e.g. "upload", "reports").
    const keyword = (p.toLowerCase().match(/\b(upload|report|reports|export|auth|payment|search|api|sync|login|cache)\w*/) ?? [])[0];
    const env = environmentId ? this.deps.envStore.get(environmentId) : undefined;
    const testScript = env ? readTestScript(env.repoRoot) : undefined;
    const base = testScript ?? "bun test";
    const checkCommand = keyword ? `${base} ${keyword}` : base;
    const scopeAllow = keyword ? [`src/${keyword}/`] : [];
    const suggestion: LoopIntakeSuggestion = {
      isFeature,
      name: p.replace(/^\(from Todoist\)\s*/i, "").slice(0, 60) || "New loop",
      checkCommand,
      ...(keyword ? { checkLocks: [] } : {}),
      scopeAllow,
      maxLaps: isFeature ? 12 : 10,
      tokenBudget: isFeature ? PIPELINE_INTAKE_BUDGET : SESSION_INTAKE_BUDGET,
      rung: "pr",
      assumptions: isFeature
        ? ["Comma delimiter, UTF-8 where output format is unstated", "Streams all rows — no hard cap"]
        : ["The failure is deterministic/timing-related, not environment-specific"],
    };
    return { v: PROTOCOL_VERSION, type: "loop.intake.result", ts: now(), ...(cid ? { cid } : {}), suggestion };
  }

  async gateOpen(runId: string, cid?: string): Promise<LoopRunEvent> {
    const loopId = this.loopIdForRun(runId);
    const run = await this.engine.openGate(loopId, runId);
    return this.runEvent(run, cid);
  }
  async gateSendback(runId: string, note: string, cid?: string): Promise<LoopRunEvent> {
    if (!note?.trim()) throw new BadCommand("a sendback needs a note");
    const loopId = this.loopIdForRun(runId);
    const run = await this.engine.sendback(loopId, runId, note.trim());
    return this.runEvent(run, cid);
  }

  /** Convert an autopilot draft (work unit) into a real Loop. Idempotent per work unit. */
  convert(workUnitId: string, seed: { name: string; environmentId?: string; prompt: string }, cid?: string): LoopUpdatedEvent {
    const already = this.store.byWorkUnit(workUnitId);
    if (already) return this.loopUpdatedEvent(already, cid);
    const input: LoopInput = {
      name: seed.name,
      ...(seed.environmentId ? { environmentId: seed.environmentId } : {}),
      trigger: { kind: "manual" },
      act: { kind: "session-prompt", prompt: seed.prompt },
      checks: [],
      rung: "pr",
    };
    const { loop } = completeLoop(input, { now: now(), genId: () => newId("loop") });
    loop.workUnitId = workUnitId;
    this.store.save(loop);
    this.broadcastCatalog();
    return this.loopUpdatedEvent(loop, cid);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────────────
  private require(loopId: string): Loop {
    const loop = this.store.get(loopId);
    if (!loop) throw new BadCommand(`no such loop: ${loopId}`);
    return loop;
  }
  private loopIdForRun(runId: string): string {
    for (const loop of this.store.list()) if (this.store.runById(loop.id, runId)) return loop.id;
    throw new BadCommand(`no such run: ${runId}`);
  }
}

function placeholderRun(loop: Loop): LoopRun {
  return { id: "pending", loopId: loop.id, configRevision: loop.configRevision, trigger: { kind: "manual", at: now() }, status: "running", laps: [], startedAt: now() };
}
function firstLine(s: string): string {
  return (s.trim().split("\n")[0] ?? "").slice(0, 120);
}
function lastLine(s: string): string {
  const lines = s.trim().split("\n");
  return lines[lines.length - 1] ?? "";
}
