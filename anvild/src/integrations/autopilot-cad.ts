/**
 * Autopilot CAD (agent-cad-and-browser spec §4.11, §4.14 item 41, Phase B3) — the pure, SDK-free
 * decisions: which units may start, what the card shows, and how a verify result is judged for a
 * builder (or the dev pipeline). The service (`session/autopilot-service.ts`) does the I/O.
 *
 * "Needs approved dimensions" is an OVERLAY, not a new `AnvilStatus`: a unit keeps its real status
 * (usually `planned`) and `cadStartRefusal` holds it, the same way `hold` and the completion overlay do.
 */
import type { AutopilotCadInfo } from "@protocol";
import { createHash } from "node:crypto";
import { approvedFingerprint, planExpectationRows, planExpectationsSha, replaceNote, replacesApproval, sameAsApproved, type ApprovedNumbers, type PlanPartExpectations } from "../cadwork/plan-expectations";
import type { PlanCadMeta } from "./plan-meta";
import type { WorkUnit } from "./workunit";

/** What startPlan / auto-start / the dev pipeline say for a unit whose CAD numbers are not approved. */
export const NEEDS_APPROVED_DIMENSIONS = "needs approved dimensions";
/** Why the dev pipeline and "Link to session" refuse a CAD unit (decision 182): only Go builds CAD. */
export const CAD_BUILDS_WITH_GO = "CAD units build with Go (the pipeline cannot model)";

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

/** The WorkUnit fields for the nightly planner's CAD metadata (item 41): numbers PROPOSED, never approved.
 *  With `processes` (the repo's cad/rules.json ids; `null` when it has none), a part whose process is not
 *  there is dropped with a note, like a malformed one — the unit still needs CAD. */
export function cadFieldsFromMeta(cad: PlanCadMeta | undefined, processes?: readonly string[] | null): Partial<WorkUnit> {
  if (!cad) return {};
  const expectations: Record<string, PlanPartExpectations> = {};
  const dropped: string[] = [];
  for (const [part, e] of Object.entries(cad.expectations)) {
    const why = processProblem(e.process, processes);
    if (why) dropped.push(`cad/${part}: ${why}`);
    else expectations[part] = e;
  }
  const parts = Object.keys(expectations);
  const note = [cad.note, dropped.length ? `Ignored: ${dropped.join("; ")}` : undefined].filter(Boolean).join(" ");
  return {
    needsCad: true,
    ...(parts.length ? { cadExpectations: expectations, cadExpectationsStatus: "proposed" as const, cadExpectationsSource: "nightly" as const } : {}),
    ...(note ? { cadNote: note } : {}),
  };
}

/** What the card needs to know about the repo besides the unit (decision 183): the CURRENT approval of
 *  each part (the repo-wide lock entry), the processes `cad/rules.json` defines, and the default branch's
 *  name. Absent: drawn from the unit alone (no "old" side, no process check). */
export interface CadCardContext {
  approved: (part: string) => ApprovedNumbers | undefined;
  /** The process ids in the repo's `cad/rules.json`; `null` when it is missing or unreadable. */
  processes: readonly string[] | null;
  defaultBranch: string;
}

/** Why a part's process cannot be used, or undefined. */
export function processProblem(process: string, processes: readonly string[] | null | undefined): string | undefined {
  if (processes === undefined) return undefined;
  if (processes === null) return `process ${process} cannot be checked: the repo has no readable cad/rules.json`;
  return processes.includes(process) ? undefined : `process ${process} is not in the repo's cad/rules.json (it has: ${processes.join(", ") || "none"})`;
}

/**
 * The identity of exactly what a unit's card shows: the plan's numbers and, per part, the approval its
 * "old" side was drawn from. With no approval on record for any part it is `planExpectationsSha`.
 */
export function cadCardSha(record: Record<string, PlanPartExpectations> | undefined, ctx?: Pick<CadCardContext, "approved">): string {
  const plan = planExpectationsSha(record);
  const prints = Object.keys(record ?? {})
    .sort()
    .map((p) => [p, approvedFingerprint(ctx?.approved(p))] as const);
  if (prints.every(([, f]) => f === null)) return plan;
  return createHash("sha256").update(JSON.stringify([plan, prints])).digest("hex");
}

/**
 * Decision 183 (b): a part whose approved numbers were changed by someone AFTER this plan's numbers for
 * it were approved — a start would silently overwrite that newer approval. Undefined when none.
 */
export function approvalChangedRefusal(u: Pick<WorkUnit, "cadExpectations">, approved: (part: string) => ApprovedNumbers | undefined): string | undefined {
  for (const p of coveredParts(u)) {
    const e = u.cadExpectations![p]!;
    const a = approved(p);
    if (!a || !e.approvedAt || sameAsApproved(e, a)) continue;
    if (Date.parse(a.at) > Date.parse(e.approvedAt)) return `the approved numbers for cad/${p} changed after this plan was approved; re-approve the plan`;
  }
  return undefined;
}

/** The card's CAD section, or undefined for a unit that has nothing to do with CAD. */
export function toCadInfo(u: WorkUnit, ctx?: CadCardContext): AutopilotCadInfo | undefined {
  if (!needsCad(u) && !u.cadVerified && !u.cadBlocked) return undefined;
  const record = u.cadExpectations ?? {};
  const parts = coveredParts(u).map((part) => {
    const e = record[part]!;
    const approved = ctx?.approved(part);
    const invalid = processProblem(e.process, ctx?.processes);
    return {
      part,
      process: e.process,
      approved: !!e.approvedAt,
      rows: planExpectationRows(e, approved),
      ...(ctx && replacesApproval(e, approved) && approved ? { note: replaceNote(part, ctx.defaultBranch) } : {}),
      ...(invalid ? { invalid } : {}),
    };
  });
  const status: AutopilotCadInfo["status"] = parts.length === 0 ? "missing" : (u.cadExpectationsStatus ?? "proposed");
  const reapprove = ctx ? approvalChangedRefusal(u, ctx.approved) : undefined;
  return {
    status,
    needsApproval: !!cadStartRefusal(u) || !!reapprove || parts.some((p) => !!p.invalid),
    ...(parts.length ? { sha: cadCardSha(record, ctx) } : {}),
    parts,
    ...(reapprove ? { reapprove } : {}),
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
 * the run could not be carried out; a changed path under cad/ is not a valid part's file nor
 * cad/rules.json (`unexpected`); `cad/rules.json` changed; a touched part is not covered by the
 * plan; a part is not `pass` (fail, gap, unverified — an adoption pending — or concept); or a part's
 * numbers were set by the agent (`agent-initial`) or are not approved at all.
 */
export function judgeCadVerify(
  r: VerifyLike,
  opts: { covered?: readonly string[]; approvalOf: (part: string) => { approvedBy: string } | undefined; unexpected?: readonly string[] },
): CadJudgement {
  const problems: string[] = [];
  const parts = [...new Set([...r.selection.changed, ...r.parts.map((p) => p.part)])].sort();
  if (r.error) problems.push(`the CAD check could not run: ${r.error}`);
  // Changed paths under cad/ outside every valid part folder (and not cad/rules.json): never shipped unseen.
  for (const p of opts.unexpected ?? []) problems.push(`unexpected path ${p}`);
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
