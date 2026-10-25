// Sub-agent row merge rules (§sub-agents) — DOM-free so they're unit-tested (test/web/subagentView.test.ts).
// A row is fed from three sources (launch tool_use, the live `subagent.activity` snapshot, and the durable
// settle — the Task `tool.result.subagent` or, for a BACKGROUND agent, `subagent.settled`). Whatever the
// arrival order, a settled row never regresses to running, and the background flag is sticky.
import type { SubAgentState, SubAgentView } from "../../protocol";

export const isSettled = (s: SubAgentState | string | undefined): boolean => s === "done" || s === "error" || s === "canceled";

export function mergeView(prev: SubAgentView | undefined, inc: SubAgentView): SubAgentView {
  if (!prev) return { ...inc };
  const settled = isSettled(prev.state);
  const state = settled && inc.state === "running" ? prev.state : inc.state;
  const out: SubAgentView = {
    id: inc.id,
    label: inc.label || prev.label,
    type: inc.type ?? prev.type,
    // never regress a settled row back to "running" (a late live heartbeat must not un-finish it)
    state,
    steps: Math.max(prev.steps ?? 0, inc.steps ?? 0),
    currentTool: state === "running" ? (inc.currentTool ?? prev.currentTool) : undefined,
    elapsedSeconds: inc.elapsedSeconds ?? prev.elapsedSeconds,
    error: inc.error ?? prev.error,
  };
  if (inc.background || prev.background) out.background = true;
  return out;
}

/** The activity block's title: live → "Working"; ended but a background sub-agent is still running →
 *  "Background agents running" (the turn is over, the work isn't); otherwise "Worked". */
export function activityTitle(live: boolean, rowStates: Iterable<string | undefined>): string {
  if (live) return "Working";
  for (const s of rowStates) if (s === "running") return "Background agents running";
  return "Worked";
}
