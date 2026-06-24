import type { AutopilotEffort, AutopilotSize } from "@protocol";

/**
 * Pure (SDK-free) helpers for the planner's metadata block. Kept out of `autopilot.ts` — which
 * imports the agent SDK at module load — so the parsing logic can be unit-tested without the SDK
 * self-extracting and racing bun's resolver (see memory: anvil-sdk-test-extraction-flake).
 */

const VALID_SIZES: ReadonlySet<AutopilotSize> = new Set<AutopilotSize>(["xs", "s", "m", "l", "xl"]);

/** Instruction appended to a planning prompt so the model ends with a parseable metadata block. */
export const PLAN_META_INSTRUCTION = `After the plan, on its own line, append a fenced \`\`\`json metadata block with a one or two sentence "summary" of the work, a "size" of exactly one of xs|s|m|l|xl, and "filesTouched" (your best integer guess at the number of files the change touches). Example:
\`\`\`json
{"summary": "Add a retry wrapper around the upload client and surface failures in the UI.", "size": "m", "filesTouched": 6}
\`\`\``;

/**
 * Pull the planner's trailing ```json metadata block ({summary,size,filesTouched}) out of a plan,
 * returning the cleaned markdown (block stripped) and the parsed metadata. Tolerant of a missing or
 * malformed block — the plan text is always returned, just without effort/summary in that case.
 */
export function extractPlanMeta(plan: string): { plan: string; summary?: string; effort?: AutopilotEffort } {
  const m = plan.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```\s*$/);
  if (!m) return { plan: plan.trim() };
  try {
    const raw = JSON.parse(m[1]!) as { summary?: unknown; size?: unknown; filesTouched?: unknown };
    const summary = typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : undefined;
    const size = typeof raw.size === "string" && VALID_SIZES.has(raw.size as AutopilotSize) ? (raw.size as AutopilotSize) : undefined;
    const filesTouched =
      typeof raw.filesTouched === "number" && Number.isFinite(raw.filesTouched) ? Math.max(0, Math.round(raw.filesTouched)) : undefined;
    const effort = size ? { size, ...(filesTouched != null ? { filesTouched } : {}) } : undefined;
    return { plan: plan.slice(0, m.index).trim(), summary, effort };
  } catch {
    return { plan: plan.trim() }; // unparseable block — leave the plan untouched
  }
}
