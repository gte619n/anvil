import type { Model } from "@protocol";

/**
 * Map a session's `Model` to the string the Claude Agent SDK expects.
 *
 * Claude Code accepts the short aliases `opus` / `sonnet` / `haiku` directly, but Fable has no
 * alias — it must be passed by its full model id. This is the single place that translation lives,
 * used both when a session's `query()` starts and when the model is switched mid-session.
 */
const SDK_MODEL_ID: Record<Model, string> = {
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
  fable: "claude-fable-5",
};

export function sdkModelId(model: Model): string {
  return SDK_MODEL_ID[model] ?? model;
}
