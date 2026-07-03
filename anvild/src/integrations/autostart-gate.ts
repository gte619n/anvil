import type { AnvilStatus } from "./status";

/**
 * Pure (SDK-free) gates that stand between a freshly-planned work unit and an unattended, bypass-permission
 * build session. Kept out of `autopilot.ts` — which imports the agent SDK at module load — so the decision
 * logic can be unit-tested without the SDK self-extracting and racing bun's resolver (same reason
 * `plan-meta.ts` is split out; see memory: anvil-sdk-test-extraction-flake).
 *
 * Two independent things can hold a unit back:
 *  - INTAKE (`parseIntakeVerdict`): before planning, an independent classifier judges whether the request is
 *    even specified well enough to build without inventing material product decisions. Not well-formed → the
 *    unit is parked `needs-clarification` with its open questions instead of being planned + built.
 *  - PLAN QUALITY (`autoStartDecision`): at auto-start time, a unit whose adversarial panel scored the plan
 *    below the confidence bar is left `planned` for a human to review rather than shipped on autopilot.
 */

/** Minimum adversarial consensus (0–10) a plan needs before the nightly run will auto-start it. Plans the
 *  panel scored below this are left `planned` for manual review — the panel already flags them as weak, so
 *  building them unattended is exactly the failure we're guarding against. Units with no panel (no
 *  OpenRouter key → `consensusScore` undefined) are not held on this axis; the intake gate still applies. */
export const AUTOSTART_MIN_CONSENSUS = 6;

/** The classifier's verdict on whether a task is specified well enough to build unattended. */
export interface IntakeVerdict {
  classification: "well-formed" | "needs-clarification" | "out-of-scope";
  wellFormed: boolean; // convenience: classification === "well-formed"
  reason: string; // one-sentence justification
  questions: string[]; // what a human needs to answer (empty when well-formed)
}

/**
 * Normalize a classifier's raw JSON into a strict verdict. Defensive by design: anything that isn't an
 * explicit, recognized "not well-formed" answer is treated as well-formed, so a garbled/parse-failed intake
 * response can never wedge every unit into needs-clarification (the gate should catch the vague, not become
 * a new way for the run to stall). `parsed` is the already-JSON-extracted object (or null on parse failure).
 */
export function parseIntakeVerdict(parsed: unknown): IntakeVerdict {
  const raw = (parsed ?? {}) as { classification?: unknown; reason?: unknown; questions?: unknown };
  const classification =
    raw.classification === "needs-clarification" || raw.classification === "out-of-scope"
      ? raw.classification
      : "well-formed";
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  const questions = Array.isArray(raw.questions)
    ? raw.questions.filter((q): q is string => typeof q === "string" && q.trim().length > 0).map((q) => q.trim())
    : [];
  return { classification, wellFormed: classification === "well-formed", reason, questions };
}

/** The minimal WorkUnit shape the auto-start gate reads (keeps this module free of the full type + its SDK-y
 *  transitive imports). */
export interface AutoStartCandidate {
  status: AnvilStatus;
  source?: "project" | "label";
  adversarial?: { consensusScore?: number };
}

/** Decide whether the nightly run may auto-start a unit. `hold` units stay on the grid for a human; `reason`
 *  is a one-line, user-facing explanation for the run log. Encodes every guard except the intake gate, which
 *  runs earlier (its held units never reach `planned` in the first place). */
export function autoStartDecision(u: AutoStartCandidate): { start: boolean; reason?: string } {
  // Label-sourced units may be mis-routed to the catch-all env → always review first (pre-existing rule).
  if (u.source === "label") return { start: false, reason: "label-sourced — review-only" };
  // Only a clean `planned` unit is a build candidate. Anything parked (needs-clarification) or already moving
  // (building/review/…) is not auto-started.
  if (u.status !== "planned") return { start: false, reason: `status is ${u.status}` };
  // Plan-quality gate: a panel that scored the plan below the bar is a strong signal not to ship it blind.
  const score = u.adversarial?.consensusScore;
  if (typeof score === "number" && score < AUTOSTART_MIN_CONSENSUS) {
    return { start: false, reason: `adversarial consensus ${score}/10 < ${AUTOSTART_MIN_CONSENSUS} — held for review` };
  }
  return { start: true };
}
