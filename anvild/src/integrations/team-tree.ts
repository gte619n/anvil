import type { Session, TeamInfo, TeamMemberInfo, TeamPolicy } from "@protocol";

const DEFAULT_POLICY: TeamPolicy = { integration: "combined-pr", maxConcurrentMembers: 3 };

/** Group sessions into teams by `parentId`. A team = a lead + every session pointing at it. Pure. */
export function deriveTeams(sessions: Session[]): TeamInfo[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const membersByLead = new Map<string, Session[]>();
  for (const s of sessions) {
    if (s.parentId && byId.has(s.parentId)) {
      (membersByLead.get(s.parentId) ?? membersByLead.set(s.parentId, []).get(s.parentId)!).push(s);
    }
  }
  const teams: TeamInfo[] = [];
  for (const lead of sessions) {
    if (lead.teamRole !== "lead") continue;
    const members = membersByLead.get(lead.id) ?? [];
    teams.push({
      leadId: lead.id,
      policy: lead.team ?? DEFAULT_POLICY,
      members: members.map(toMemberInfo),
      rollup: rollup(members),
    });
  }
  return teams;
}

function toMemberInfo(s: Session): TeamMemberInfo {
  return { sessionId: s.id, task: s.memberTask, status: s.status, git: s.git };
}

function rollup(members: Session[]) {
  const r = { total: members.length, running: 0, awaiting: 0, done: 0, error: 0 };
  for (const m of members) {
    if (m.status === "thinking" || m.status === "running_tool") r.running++;
    else if (m.status === "awaiting_permission" || m.status === "awaiting_question") r.awaiting++;
    else if (m.status === "error") r.error++;
    else if (m.status === "idle" || m.status === "exited") r.done++;
  }
  return r;
}
