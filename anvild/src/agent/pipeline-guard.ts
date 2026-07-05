import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { isDangerous } from "./danger-list";

/**
 * [SEC-H4] The autonomy backstop for the UNATTENDED dev pipeline (agent/query.ts).
 *
 * Interactive sessions run every tool through the PreToolUse danger list and can PARK a risky
 * op on a permission prompt (permissions.ts). The pipeline has no human in the loop and drives a
 * third-party model (GLM) with Write/Edit/Bash enabled, so there is nobody to ask: the only safe
 * default is to DENY anything the danger list flags and allow the rest. This mirrors the interactive
 * gate's danger check but collapses "park + prompt" to a hard deny, keeping the pipeline from taking
 * a destructive or credential-touching action nobody approved.
 *
 * `cwd` is the run's worktree; passed through so writes escaping it are treated as dangerous.
 */
export interface GuardVerdict {
  behavior: "allow" | "deny";
  reason: string;
}

export function pipelineGuardVerdict(
  tool: string,
  input: Record<string, unknown>,
  cwd?: string,
): GuardVerdict {
  const verdict = isDangerous(tool, input, cwd);
  if (verdict.danger) {
    return { behavior: "deny", reason: verdict.reason ?? "flagged by danger list" };
  }
  return { behavior: "allow", reason: "non-dangerous (pipeline auto-allow)" };
}

/** PreToolUse hook that hard-denies dangerous tools in an unattended pipeline run. */
export function makePipelineGuardHook(cwd?: string): HookCallback {
  return async (input) => {
    const i = input as PreToolUseHookInput;
    const tool = i.tool_name;
    const toolInput = (i.tool_input ?? {}) as Record<string, unknown>;

    // AskUserQuestion has no answer path in an unattended run; let it fall through so the SDK's
    // default handling applies rather than a fabricated decision (mirrors the interactive gate).
    if (tool === "AskUserQuestion") return { continue: true };

    const { behavior, reason } = pipelineGuardVerdict(tool, toolInput, cwd);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: behavior,
        permissionDecisionReason:
          behavior === "deny" ? `pipeline denied — ${reason}` : reason,
      },
    };
  };
}
