/**
 * LoopService (loops-circuit spec §4) — the daemon integration for the first-class Loop entity: owns the
 * LoopStore + LoopEngine, binds the engine's injected ports to the real machinery (a fresh worktree per
 * run, a bounded Claude turn for `session-prompt` bodies, a subprocess for `skill-check` + `command`
 * checks, judgeGoal for `judge` checks, git/gh for the gate), and exposes the `loop.*` command surface.
 *
 * Deps are injected (the AutopilotService pattern) so the wiring stays testable and the Supervisor only
 * gathers the projections. The engine itself is proven deterministically by test/integration/loops-*.
 */
import { mkdirSync } from "node:fs";
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
import { completeLoop } from "../loops/contract";
import { BadCommand } from "./errors";
import { PROTOCOL_VERSION } from "@protocol";
import type {
  Loop,
  LoopInput,
  LoopRun,
  LoopsListEvent,
  LoopUpdatedEvent,
  LoopRunEvent,
  LoopRunsEvent,
  Model,
} from "@protocol";
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
  /** Push notification fan-out (at-gate / failure / success). */
  notify?: (title: string, body: string, tag: string) => void;
  /** Loops feed the Phase-0 projection panel too — nudge it when the entity set changes. */
  onCatalogChange?: () => void;
}

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
    if (kind === "gate" && loop.notify.onGate) this.deps.notify(title, `${loop.name} is at your gate`, `loop-${loop.id}`);
    else if (kind === "failure" && loop.notify.onFailure) this.deps.notify(title, `${loop.name}: ${run.status} — ${run.reason ?? ""}`, `loop-${loop.id}`);
    else if (kind === "success" && loop.notify.onSuccess) this.deps.notify(title, `${loop.name} shipped`, `loop-${loop.id}`);
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
    // Drive in the background; laps + gate stream through onRun/broadcastRun.
    void this.engine.run(loop, { kind: "manual" }).catch((e) => console.error(`[loops] run ${loopId} failed:`, e));
    const latest = this.store.latestRun(loopId);
    return this.runEvent(latest ?? placeholderRun(loop), cid);
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
