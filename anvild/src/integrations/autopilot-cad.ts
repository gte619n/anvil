/**
 * Autopilot CAD (agent-cad-and-browser spec §4.11, §4.14 item 41, Phase B3) — the pure, SDK-free
 * decisions: which units may start, what the card shows, and how a verify result is judged for a
 * builder (or the dev pipeline). The service (`session/autopilot-service.ts`) does the I/O.
 *
 * "Needs approved dimensions" is an OVERLAY, not a new `AnvilStatus`: a unit keeps its real status
 * (usually `planned`) and `cadStartRefusal` holds it, the same way `hold` and the completion overlay do.
 */
import type { AutopilotCadInfo } from "@protocol";
import { planExpectationRows, planExpectationsSha, type PlanPartExpectations } from "../cadwork/plan-expectations";
import type { PlanCadMeta } from "./plan-meta";
import type { WorkUnit } from "./workunit";

/** What startPlan / auto-start / the dev pipeline say for a unit whose CAD numbers are not approved. */
export const NEEDS_APPROVED_DIMENSIONS = "needs approved dimensions";

type CadFields = Pick<WorkUnit, "cadExpectations" | "cadExpectationsStatus" | "needsCad">;

/** The parts the plan covers (the parts a builder may work on). */
export function coveredParts(u: Pick<WorkUnit, "cadExpectations">): string[] {
  return Object.keys(u.cadExpectations ?? {}).sort();
}

/** The plan touches CAD: it carries numbers, or the planner said CAD is needed. */
export function needsCad(u: CadFields): boolean {
  return !!u.needsCad || coveredParts(u).length > 0;
}

/** Why the unit cannot start (Go, auto-start or the pipeline), or undefined when CAD is not in the way. */
export function cadStartRefusal(u: CadFields): string | undefined {
  if (!needsCad(u)) return undefined;
  if (coveredParts(u).length === 0) return `${NEEDS_APPROVED_DIMENSIONS} — the plan needs CAD but carries no valid numbers; open Plan with Claude to supply them (save_cad_expectations)`;
  if (u.cadExpectationsStatus === "approved" && coveredParts(u).every((p) => !!u.cadExpectations![p]!.approvedAt)) return undefined;
  if (u.cadExpectationsStatus === "rejected") return `${NEEDS_APPROVED_DIMENSIONS} — the proposed numbers were rejected; open Plan with Claude to supply new ones`;
  return `${NEEDS_APPROVED_DIMENSIONS} — approve the proposed CAD numbers on the plan's card first`;
}

/** Recompute the unit-level status from the per-part approvals. */
export function cadStatusOf(record: Record<string, PlanPartExpectations>): "proposed" | "approved" {
  const parts = Object.values(record);
  return parts.length > 0 && parts.every((p) => !!p.approvedAt) ? "approved" : "proposed";
}

/** The WorkUnit fields for the nightly planner's CAD metadata (item 41): numbers PROPOSED, never approved. */
export function cadFieldsFromMeta(cad: PlanCadMeta | undefined): Partial<WorkUnit> {
  if (!cad) return {};
  const parts = Object.keys(cad.expectations);
  return {
    needsCad: true,
    ...(parts.length ? { cadExpectations: cad.expectations, cadExpectationsStatus: "proposed" as const, cadExpectationsSource: "nightly" as const } : {}),
    ...(cad.note ? { cadNote: cad.note } : {}),
  };
}

/** The card's CAD section, or undefined for a unit that has nothing to do with CAD. */
export function toCadInfo(u: WorkUnit): AutopilotCadInfo | undefined {
  if (!needsCad(u) && !u.cadVerified && !u.cadBlocked) return undefined;
  const record = u.cadExpectations ?? {};
  const parts = coveredParts(u).map((part) => {
    const e = record[part]!;
    return { part, process: e.process, approved: !!e.approvedAt, rows: planExpectationRows(e) };
  });
  const status: AutopilotCadInfo["status"] = parts.length === 0 ? "missing" : (u.cadExpectationsStatus ?? "proposed");
  return {
    status,
    needsApproval: !!cadStartRefusal(u),
    ...(parts.length ? { sha: planExpectationsSha(record) } : {}),
    parts,
    ...(u.cadExpectationsSource ? { source: u.cadExpectationsSource } : {}),
    ...(u.cadExpectationsApprovedAt ? { approvedAt: u.cadExpectationsApprovedAt } : {}),
    ...(u.cadNote ? { note: u.cadNote } : {}),
    ...(u.cadVerified ? { verified: u.cadVerified } : {}),
    ...(u.cadBlocked ? { blocked: u.cadBlocked } : {}),
  };
}

/** The slice of a verify result the judge reads (structurally `cadwork/verify.ts`'s VerifyResult). */
export interface VerifyLike {
  ok: boolean;
  error?: string;
  parts: { part: string; state: string; ok: boolean; reason?: string; failing: string[]; needsAdoption?: string }[];
  selection: { changed: string[]; rulesChanged: boolean };
}

export interface CadJudgement {
  ok: boolean;
  /** One line per problem, joined: what the unit's blocked reason says. */
  reason?: string;
  /** The parts the verify looked at. */
  parts: string[];
}

/**
 * Judge a verify run for an autopilot builder (`covered` = the plan's parts) or the dev pipeline
 * (`covered` undefined: no plan coverage required, only an approved, passing design). Not OK when:
 * the run could not be carried out; `cad/rules.json` changed; a touched part is not covered by the
 * plan; a part is not `pass` (fail, gap, unverified — an adoption pending — or concept); or a part's
 * numbers were set by the agent (`agent-initial`) or are not approved at all.
 */
export function judgeCadVerify(r: VerifyLike, opts: { covered?: readonly string[]; approvalOf: (part: string) => { approvedBy: string } | undefined }): CadJudgement {
  const problems: string[] = [];
  const parts = [...new Set([...r.selection.changed, ...r.parts.map((p) => p.part)])].sort();
  if (r.error) problems.push(`the CAD check could not run: ${r.error}`);
  if (r.selection.rulesChanged) problems.push("cad/rules.json changed in this worktree; only the owner may change the manufacturing rules");
  if (opts.covered) {
    for (const p of r.selection.changed) if (!opts.covered.includes(p)) problems.push(`cad/${p} was touched but the plan has no approved dimensions for it`);
  }
  for (const v of r.parts) {
    if (v.state !== "pass") {
      const what = v.state === "gap" ? "reported a capability gap" : v.state === "unverified" && v.needsAdoption ? `is unverified (adoption pending: ${v.needsAdoption})` : `is ${v.state}`;
      const detail = v.failing.slice(0, 4).join("; ") || v.reason;
      problems.push(`cad/${v.part} ${what}${detail ? `: ${detail}` : ""}`);
      continue;
    }
    const a = opts.approvalOf(v.part);
    if (!a) problems.push(`cad/${v.part} has no approved expectations`);
    else if (a.approvedBy === "agent-initial") problems.push(`cad/${v.part}'s expected numbers were set by the agent, not approved by the owner or the plan`);
  }
  return problems.length ? { ok: false, reason: problems.join("; "), parts } : { ok: true, parts };
}
