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

/** Max automatic lead↔member relay hops without human input — the loop guard that keeps two agents
 *  from ping-ponging forever (the reason member↔member peer messaging was cut; here it bounds the
 *  lead-as-hub two-way conversation). A human prompt to any team session resets the counter. */
export const MAX_TEAM_RELAY_HOPS = 16;
/** True once the lead↔member auto-relay has exchanged more than `cap` hops without human input. */
export function relayExhausted(hops: number, cap: number = MAX_TEAM_RELAY_HOPS): boolean {
  return hops > cap;
}
