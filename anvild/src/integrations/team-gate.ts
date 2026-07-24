import type { AutonomyPolicy } from "@protocol";
/** The team-plan gate rides the session's autonomy dial: only `bypass` auto-approves. */
export function shouldAutoApprove(autonomy: AutonomyPolicy): boolean {
  return autonomy === "bypass";
}

/** Pause NEW member spawns while the subscription budget is in its warn zone (running members finish),
 *  mirroring autopilot's auto-start skip under budget pressure (see anvil-team-support.md §7). */
export function spawnPaused(budget: { warn?: boolean }): boolean {
  return budget.warn === true;
}
