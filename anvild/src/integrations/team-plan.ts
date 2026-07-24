import type { TeamPlan, TeamPlanMember } from "@protocol";

/** Extract the lead's fenced ```json team-plan block; returns null if absent/unparseable. */
export function parseTeamPlan(text: string, leadId: string): { plan: TeamPlan; prose: string } | null {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]!.trim()) as Partial<TeamPlan>;
    if (!Array.isArray(raw.members) || raw.members.length === 0) return null;
    const plan: TeamPlan = {
      leadId,
      members: raw.members.map((x) => ({
        title: String(x.title ?? "member"),
        task: String(x.task ?? ""),
        source: x.source === "existing-dir" ? "existing-dir" : "fresh-worktree",
        dependsOn: Array.isArray(x.dependsOn) ? x.dependsOn.map(String) : undefined,
      })),
      integration: raw.integration === "pr-per-member" ? "pr-per-member" : "combined-pr",
    };
    return { plan, prose: text.replace(m[0], "").trim() };
  } catch {
    return null;
  }
}

/** Topologically order members by `dependsOn` (title = node id). Stable; cycles fall back to input order. */
export function integrationOrder(members: TeamPlanMember[]): TeamPlanMember[] {
  const byTitle = new Map(members.map((m) => [m.title, m]));
  const seen = new Set<string>(), out: TeamPlanMember[] = [];
  const visit = (m: TeamPlanMember, stack: Set<string>) => {
    if (seen.has(m.title) || stack.has(m.title)) return;
    stack.add(m.title);
    for (const d of m.dependsOn ?? []) { const dep = byTitle.get(d); if (dep) visit(dep, stack); }
    stack.delete(m.title); seen.add(m.title); out.push(m);
  };
  for (const m of members) visit(m, new Set());
  return out;
}
