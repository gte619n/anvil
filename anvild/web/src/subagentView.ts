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
  if (inc.kind ?? prev.kind) out.kind = inc.kind ?? prev.kind;
  return out;
}

/** The activity block's count: "· 2 sub-agents · 1 background task", else "· N steps", else "". */
export function activityCountText(rows: Iterable<{ kind?: string }>, steps: number): string {
  let agents = 0;
  let shells = 0;
  for (const r of rows) r.kind === "shell" ? shells++ : agents++;
  const parts: string[] = [];
  if (agents) parts.push(`${agents} sub-agent${agents === 1 ? "" : "s"}`);
  if (shells) parts.push(`${shells} background task${shells === 1 ? "" : "s"}`);
  if (parts.length) return `· ${parts.join(" · ")}`;
  return steps ? `· ${steps} step${steps === 1 ? "" : "s"}` : "";
}

/** The activity block's title: live → "Working"; ended but a background sub-agent or shell task is still
 *  running → "Background tasks running" (the turn is over, the work isn't); otherwise "Worked". */
export function activityTitle(live: boolean, rowStates: Iterable<string | undefined>): string {
  if (live) return "Working";
  for (const s of rowStates) if (s === "running") return "Background tasks running";
  return "Worked";
}
