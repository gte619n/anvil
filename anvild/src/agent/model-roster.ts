/**
 * The autonomous-dev-pipeline model roster (spec §3): exactly two decorrelated, near-peer models —
 * Claude Opus 4.8 (subscription, via the Agent SDK) and GLM 5.2 (OpenRouter's Anthropic Skin, via the
 * SAME Agent SDK). Both run through one execution path, differentiated only by their `profile` (which
 * env buildAgentEnv assembles) and their `sdkModel` id.
 *
 * This module is the single source of truth for "which model plays which role", so the spec's
 * cross-model independence rule — the reviewer of an artifact must be a DIFFERENT model than its author
 * (spec §2.2) — can be enforced and recorded structurally rather than by convention.
 */
import type { ModelProfile } from "./env";

export interface ModelSpec {
  /** Stable id used in the trace record + independence checks. */
  id: "claude" | "glm";
  /** Which env profile drives it (Anthropic subscription vs OpenRouter Anthropic Skin). */
  profile: ModelProfile;
  /** The `model` id passed to the Agent SDK (a Claude alias, or an OpenRouter slug). */
  sdkModel: string;
  /** Human label for logs + the trace record. */
  label: string;
}

/** Claude Opus 4.8 — strongest on novel from-scratch design + judgment; carries the two judgment gates. */
export const CLAUDE: ModelSpec = { id: "claude", profile: "claude", sdkModel: "opus", label: "Claude Opus 4.8" };

/** GLM 5.2 — near-peer coder, decorrelated lineage, cheap; carries cheap agentic authorship + test-gen.
 *  The exact OpenRouter slug is overridable via config so the roster can track new GLM releases. */
export const GLM: ModelSpec = { id: "glm", profile: "glm", sdkModel: "z-ai/glm-5.2", label: "GLM 5.2" };

/** Return a roster with GLM's slug overridden (e.g. from config), leaving Claude fixed. */
export function roster(glmSdkModel?: string): { claude: ModelSpec; glm: ModelSpec } {
  return {
    claude: CLAUDE,
    glm: glmSdkModel?.trim() ? { ...GLM, sdkModel: glmSdkModel.trim() } : GLM,
  };
}

/**
 * The spec's per-phase author/adversary assignment (§3.2). Authorship flips by task-type strength; the
 * adversary is always the OTHER model (independence rule). A phase with no adversary uses deterministic
 * checks instead (verification tooling) or is pure triage/release.
 */
export type PipelinePhase =
  | "intake" // P0
  | "requirements" // P1
  | "design" // P2
  | "implementation" // P3
  | "verification" // P4
  | "validation" // P5
  | "transfer"; // P6

export interface PhaseAssignment {
  author: ModelSpec["id"];
  /** The reviewing model, or null when the gate is deterministic / human / release-only. */
  adversary: ModelSpec["id"] | null;
}

/** Default assignments per spec §3.2. Escalations (e.g. GLM→Claude implementer on high risk) are applied
 *  by the orchestrator at run time, not baked here. */
export const PHASE_ASSIGNMENT: Record<PipelinePhase, PhaseAssignment> = {
  intake: { author: "glm", adversary: null }, // cheap classification, no judgment leverage
  requirements: { author: "glm", adversary: "claude" }, // judgment-stronger model AUDITS (spec §2.3)
  design: { author: "claude", adversary: "glm" }, // novel design is Claude's edge; critique is checklist-shaped
  implementation: { author: "glm", adversary: null }, // deterministic checks live in verification
  verification: { author: "glm", adversary: null }, // GLM generates adversarial TESTS, not argument
  validation: { author: "claude", adversary: null }, // blind Claude pre-check; human/proxy owns the gate
  transfer: { author: "glm", adversary: null }, // release tooling + small model
};

/** Enforce the independence rule: throw if an artifact's reviewer is the same model as its author. */
export function assertIndependent(phase: PipelinePhase, author: ModelSpec["id"], adversary: ModelSpec["id"]): void {
  if (author === adversary) {
    throw new Error(`independence violation at ${phase}: author and adversary are both "${author}" (spec §2.2 requires cross-model review)`);
  }
}
