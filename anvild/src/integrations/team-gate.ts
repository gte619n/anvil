import type { AutonomyPolicy } from "@protocol";
/** The team-plan gate rides the session's autonomy dial: only `bypass` auto-approves. */
export function shouldAutoApprove(autonomy: AutonomyPolicy): boolean {
  return autonomy === "bypass";
}
