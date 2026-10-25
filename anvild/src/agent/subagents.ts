import type { SubAgentState, SubAgentView } from "@protocol";

// ── Sub-agent activity tracker (§sub-agents) ───────────────────────────────────────────────────
// Correlates the SDK's sub-agent (`Task`/`Agent` tool) telemetry into a per-turn set of `SubAgentView`s.
// PURE + clock-free (no Date.now) so it is deterministic and fixture-testable offline. All SDK-shape
// knowledge stays in map.ts (`subAgentSignals`); this module only consumes the normalized signals.
//
// Keying (ID2): one launching `Task`/`Agent` tool_use == one sub-agent, keyed by that tool_use id
// (which equals the child stream's `parent_tool_use_id`). Grandchildren (a sub-agent that itself
// spawns sub-agents) roll their steps UP into the nearest depth-1 ancestor (D12/ID7) — no deeper rows.
//
// Background sub-agents (`run_in_background`, or backgrounded mid-run): the launching tool.result is an
// instant "launched" ack, so `finish()` must NOT settle them — they stay running (flagged `background`)
// until the CLI's `task_notification` reports how they ended. Those settlements are queued for
// `drainSettled()` so the session can persist them (`subagent.settled`), and a new user turn keeps
// still-running background agents instead of forgetting them (their notification may come turns later).

/** A normalized sub-agent signal, produced by `subAgentSignals(m)` in map.ts (the SDK-shape seam). */
export type SubAgentSignal =
  // A `Task`/`Agent` launch. `launchedBy` is the launching message's `parent_tool_use_id`: null for a
  // main-turn launch (→ a new depth-1 row), or an ancestor id for a nested launch (→ rolled up, ID7).
  | { kind: "start"; taskId: string; launchedBy: string | null; type?: string; label?: string; background?: boolean }
  // A sub-agent ran a (non-Task) tool. `parent` is the child message's `parent_tool_use_id`.
  | { kind: "step"; parent: string; tool?: string }
  // A sub-agent's tool produced a result (clears the "current tool").
  | { kind: "step_done"; parent: string }
  // Message-level metadata carried on sub-agent messages (subagent_type / task_description).
  | { kind: "meta"; parent: string; type?: string; label?: string }
  // A `task_progress` overlay (SDKTaskProgressMessage): richer counts/current-tool/elapsed when present.
  | { kind: "progress"; taskId: string; type?: string; label?: string; steps?: number; currentTool?: string; elapsedSeconds?: number }
  // `task_started`: binds the CLI's own task id to the launching tool_use id (later task_updated frames
  // carry only the task id).
  | { kind: "task"; taskId: string; sdkTaskId: string }
  // `task_updated` with `is_backgrounded: true` — a foreground agent was pushed to the background.
  | { kind: "backgrounded"; taskId?: string; sdkTaskId?: string }
  // `task_notification` (or a terminal `task_updated`): the agent ended. The authoritative settle for a
  // background agent; harmless for a foreground one (its tool.result settles it the same way).
  | { kind: "settle"; taskId?: string; sdkTaskId?: string; status: "completed" | "failed" | "stopped"; error?: string };

interface Agent {
  id: string;
  order: number; // insertion order → stable "#n" fallback labels + stable UI ordering
  label?: string;
  type?: string;
  state: SubAgentState;
  steps: number;
  currentTool?: string;
  elapsedSeconds?: number;
  error?: string;
  background?: boolean;
}

const SETTLED_STATE = { completed: "done", failed: "error", stopped: "canceled" } as const;

export class SubAgentTracker {
  private readonly agents = new Map<string, Agent>();
  /** descendant Task id → its depth-1 ancestor id (grandchild roll-up, ID7). */
  private readonly ancestorOf = new Map<string, string>();
  /** The CLI's task id → launching tool_use id (from `task_started`). */
  private readonly bySdkTask = new Map<string, string>();
  /** Background agents settled since the last `drainSettled()` — the session persists these. */
  private settledQueue: Agent[] = [];
  private nextOrder = 0;

  /** Apply one signal. Returns true iff it caused a STRUCTURAL change worth broadcasting (ID11) —
   *  an elapsed-only refresh returns false so a `task_progress` heartbeat can't flood the socket. */
  apply(sig: SubAgentSignal): boolean {
    switch (sig.kind) {
      case "start": {
        if (sig.launchedBy != null) {
          // A nested launch: don't create a row — register it under its depth-1 ancestor and count it
          // as one step on that ancestor (its own inner steps then roll up via resolve()).
          const root = this.resolve(sig.launchedBy);
          if (!root) return false;
          this.ancestorOf.set(sig.taskId, root);
          const a = this.agents.get(root)!;
          a.steps += 1;
          return true;
        }
        // A main-turn launch: a new depth-1 sub-agent row (idempotent on the same id).
        if (this.agents.has(sig.taskId)) {
          const a = this.agents.get(sig.taskId)!;
          return this.mergeMeta(a, sig.type, sig.label);
        }
        this.agents.set(sig.taskId, {
          id: sig.taskId,
          order: this.nextOrder++,
          label: sig.label,
          type: sig.type,
          state: "running",
          steps: 0,
          ...(sig.background ? { background: true } : {}),
        });
        return true;
      }
      case "task": {
        this.bySdkTask.set(sig.sdkTaskId, sig.taskId);
        return false;
      }
      case "backgrounded": {
        const a = this.byEither(sig.taskId, sig.sdkTaskId);
        if (!a || a.background || a.state !== "running") return false;
        a.background = true;
        return true;
      }
      case "settle": {
        const a = this.byEither(sig.taskId, sig.sdkTaskId);
        if (!a || a.state !== "running") return false; // unknown, or already settled (idempotent)
        this.settle(a, SETTLED_STATE[sig.status], sig.status === "failed" ? sig.error : undefined);
        return true;
      }
      case "step": {
        const a = this.rootAgent(sig.parent);
        if (!a) return false;
        a.steps += 1;
        if (sig.tool) a.currentTool = sig.tool;
        return true;
      }
      case "step_done": {
        const a = this.rootAgent(sig.parent);
        if (!a || a.currentTool === undefined) return false;
        a.currentTool = undefined;
        return true;
      }
      case "meta": {
        const a = this.rootAgent(sig.parent);
        if (!a) return false;
        return this.mergeMeta(a, sig.type, sig.label);
      }
      case "progress": {
        const a = this.rootAgent(sig.taskId);
        if (!a) return false;
        let changed = this.mergeMeta(a, sig.type, sig.label);
        if (typeof sig.steps === "number" && sig.steps > a.steps) {
          a.steps = sig.steps;
          changed = true;
        }
        if (sig.currentTool && sig.currentTool !== a.currentTool) {
          a.currentTool = sig.currentTool;
          changed = true;
        }
        // elapsed is a non-structural refresh (ID11): update the value but never trigger a broadcast on it alone.
        if (typeof sig.elapsedSeconds === "number") a.elapsedSeconds = sig.elapsedSeconds;
        return changed;
      }
    }
  }

  /** Settle a sub-agent as done/error (its launching Task tool.result arrived). Returns the settled
   *  view for the DURABLE tool.result.subagent field (D10/ID6), or undefined if `taskId` isn't tracked. */
  /** `launchedAsync`: the tool.result is the CLI's "launched in the background" ack, not the agent's end —
   *  flag it background and leave it running; its `task_notification` settles it later. */
  finish(taskId: string, isError: boolean, error?: string, launchedAsync = false): SubAgentView | undefined {
    const a = this.agents.get(taskId);
    if (!a) return undefined;
    if (launchedAsync && !isError) {
      a.background = true;
      return toView(a); // still running (or already settled, if the notification somehow won the race)
    }
    if (a.state === "running") {
      a.state = isError ? "error" : "done";
      a.currentTool = undefined;
      if (isError && error) a.error = error;
    }
    return toView(a);
  }

  /** Mark every still-running sub-agent canceled (the query died). Background ones are queued for
   *  persistence like any other background settlement. Returns true if any changed. */
  cancelRunning(): boolean {
    let changed = false;
    for (const a of this.agents.values()) {
      if (a.state === "running") {
        this.settle(a, "canceled");
        changed = true;
      }
    }
    return changed;
  }

  /** Background agents settled since the last call (each returned once), as wire views. */
  drainSettled(): SubAgentView[] {
    const out = this.settledQueue.map(toView);
    this.settledQueue = [];
    return out;
  }

  /** Whether any background sub-agent is still running (the turn ended but work continues). */
  hasRunningBackground(): boolean {
    for (const a of this.agents.values()) if (a.background && a.state === "running") return true;
    return false;
  }

  /** The current set, in launch order. */
  snapshot(): SubAgentView[] {
    return [...this.agents.values()].sort((x, y) => x.order - y.order).map(toView);
  }

  hasAny(): boolean {
    return this.agents.size > 0;
  }

  hasRunning(): boolean {
    for (const a of this.agents.values()) if (a.state === "running") return true;
    return false;
  }

  /** Whether `taskId` is a tracked depth-1 sub-agent (used by the driver to decide tool.result enrichment). */
  isTracked(taskId: string): boolean {
    return this.agents.has(taskId);
  }

  /** New user turn → drop the prior turn's sub-agents (ID12) — except background agents still running,
   *  whose settlement (and its persisted record) would otherwise be lost. */
  reset(): void {
    const keep = [...this.agents.values()].filter((a) => a.background && a.state === "running");
    const keepIds = new Set(keep.map((a) => a.id));
    this.agents.clear();
    for (const a of keep) this.agents.set(a.id, a);
    for (const [child, root] of this.ancestorOf) if (!keepIds.has(root)) this.ancestorOf.delete(child);
    for (const [sdk, id] of this.bySdkTask) if (!keepIds.has(id)) this.bySdkTask.delete(sdk);
    this.nextOrder = keep.length ? Math.max(...keep.map((a) => a.order)) + 1 : 0;
  }

  private settle(a: Agent, state: Exclude<SubAgentState, "running">, error?: string): void {
    a.state = state;
    a.currentTool = undefined;
    if (state === "error" && error) a.error = error;
    if (a.background) this.settledQueue.push(a);
  }

  private byEither(taskId?: string, sdkTaskId?: string): Agent | undefined {
    const id = taskId ?? (sdkTaskId ? this.bySdkTask.get(sdkTaskId) : undefined);
    return id ? this.agents.get(id) : undefined;
  }

  /** Resolve an id to its depth-1 root id (following the grandchild chain), or undefined if unknown. */
  private resolve(id: string): string | undefined {
    let cur: string | undefined = id;
    const seen = new Set<string>();
    while (cur && !this.agents.has(cur)) {
      if (seen.has(cur)) return undefined; // defensive: cycle guard
      seen.add(cur);
      cur = this.ancestorOf.get(cur);
    }
    return cur && this.agents.has(cur) ? cur : undefined;
  }

  private rootAgent(id: string): Agent | undefined {
    const root = this.resolve(id);
    return root ? this.agents.get(root) : undefined;
  }

  private mergeMeta(a: Agent, type?: string, label?: string): boolean {
    let changed = false;
    if (type && type !== a.type) {
      a.type = type;
      changed = true;
    }
    if (label && label !== a.label) {
      a.label = label;
      changed = true;
    }
    return changed;
  }
}

/** Snapshot an internal agent to the wire view, deriving the display label with fallbacks (D6/ID3). */
function toView(a: Agent): SubAgentView {
  const label = a.label ?? (a.type ? `${a.type} #${a.order + 1}` : `Sub-agent #${a.order + 1}`);
  const v: SubAgentView = { id: a.id, label, state: a.state, steps: a.steps };
  if (a.type) v.type = a.type;
  if (a.currentTool) v.currentTool = a.currentTool;
  if (typeof a.elapsedSeconds === "number") v.elapsedSeconds = a.elapsedSeconds;
  if (a.error) v.error = a.error;
  if (a.background) v.background = true;
  return v;
}
