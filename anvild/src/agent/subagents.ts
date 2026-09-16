import type { SubAgentState, SubAgentView } from "@protocol";

// ── Sub-agent activity tracker (§sub-agents) ───────────────────────────────────────────────────
// Correlates the SDK's sub-agent (`Task`/`Agent` tool) telemetry into a per-turn set of `SubAgentView`s.
// PURE + clock-free (no Date.now) so it is deterministic and fixture-testable offline. All SDK-shape
// knowledge stays in map.ts (`subAgentSignals`); this module only consumes the normalized signals.
//
// Keying (ID2): one launching `Task`/`Agent` tool_use == one sub-agent, keyed by that tool_use id
// (which equals the child stream's `parent_tool_use_id`). Grandchildren (a sub-agent that itself
// spawns sub-agents) roll their steps UP into the nearest depth-1 ancestor (D12/ID7) — no deeper rows.

/** A normalized sub-agent signal, produced by `subAgentSignals(m)` in map.ts (the SDK-shape seam). */
export type SubAgentSignal =
  // A `Task`/`Agent` launch. `launchedBy` is the launching message's `parent_tool_use_id`: null for a
  // main-turn launch (→ a new depth-1 row), or an ancestor id for a nested launch (→ rolled up, ID7).
  | { kind: "start"; taskId: string; launchedBy: string | null; type?: string; label?: string }
  // A sub-agent ran a (non-Task) tool. `parent` is the child message's `parent_tool_use_id`.
  | { kind: "step"; parent: string; tool?: string }
  // A sub-agent's tool produced a result (clears the "current tool").
  | { kind: "step_done"; parent: string }
  // Message-level metadata carried on sub-agent messages (subagent_type / task_description).
  | { kind: "meta"; parent: string; type?: string; label?: string }
  // A `task_progress` overlay (SDKTaskProgressMessage): richer counts/current-tool/elapsed when present.
  | { kind: "progress"; taskId: string; type?: string; label?: string; steps?: number; currentTool?: string; elapsedSeconds?: number };

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
}

export class SubAgentTracker {
  private readonly agents = new Map<string, Agent>();
  /** descendant Task id → its depth-1 ancestor id (grandchild roll-up, ID7). */
  private readonly ancestorOf = new Map<string, string>();
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
        });
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
  finish(taskId: string, isError: boolean, error?: string): SubAgentView | undefined {
    const a = this.agents.get(taskId);
    if (!a) return undefined;
    a.state = isError ? "error" : "done";
    a.currentTool = undefined;
    if (isError && error) a.error = error;
    return toView(a);
  }

  /** Mark every still-running sub-agent canceled (turn interrupted / errored). Returns true if any changed. */
  cancelRunning(): boolean {
    let changed = false;
    for (const a of this.agents.values()) {
      if (a.state === "running") {
        a.state = "canceled";
        a.currentTool = undefined;
        changed = true;
      }
    }
    return changed;
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

  /** New user turn → drop the prior turn's sub-agents (ID12). */
  reset(): void {
    this.agents.clear();
    this.ancestorOf.clear();
    this.nextOrder = 0;
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
  return v;
}
