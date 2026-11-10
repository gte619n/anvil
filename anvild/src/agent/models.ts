import type { Model, ModelTierInfo } from "@protocol";

/**
 * Map a session's `Model` to the string the Claude Agent SDK expects.
 *
 * Claude Code accepts the short aliases `opus` / `sonnet` / `haiku` directly and auto-upgrades them to
 * the current generation at run time, so those are passed through unchanged. Fable has NO such alias —
 * it must be passed by a full model id — so the static entry below is only a boot/offline fallback: the
 * live catalog (see agent/model-catalog.ts) resolves fable to the newest `claude-fable-*` release, and
 * {@link sdkModelId} prefers that so a new Fable release is actually run, not just displayed. This is the
 * single place that translation lives, used when a session's `query()` starts and on mid-session switch.
 */
const SDK_MODEL_ID: Record<Model, string> = {
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
  fable: "claude-fable-5",
};

/**
 * The `GET /v1/models` id-family each tier resolves against — the newest matching catalog entry is the
 * tier's current model. The alias tiers' prefix matches what the SDK auto-upgrades them to; fable's
 * prefix spans every `claude-fable-*` snapshot so a new minor (5 → 5.1 → 5.2) is picked up automatically
 * instead of staying pinned to the oldest id.
 */
const MODEL_FAMILY: Record<Model, string> = {
  opus: "claude-opus-",
  sonnet: "claude-sonnet-",
  haiku: "claude-haiku-",
  fable: "claude-fable-",
};

/** The catalog id-family prefix for a tier (see {@link MODEL_FAMILY}). */
export function modelFamilyPrefix(model: Model): string {
  return MODEL_FAMILY[model] ?? `claude-${model}-`;
}

/**
 * The concrete model string to RUN for a tier. Alias tiers keep their short alias so the SDK auto-
 * upgrades them; fable has no alias, so prefer the live catalog's resolved id (newest `claude-fable-*`)
 * and fall back to the static pin only while the catalog hasn't loaded yet (fresh boot / offline).
 */
export function sdkModelId(model: Model, catalog?: Partial<Record<Model, ModelTierInfo>>): string {
  if (model === "fable") return catalog?.fable?.modelId ?? SDK_MODEL_ID.fable;
  return SDK_MODEL_ID[model] ?? model;
}
