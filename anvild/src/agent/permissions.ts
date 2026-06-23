import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionDecision, PermissionSuggestion } from "@protocol";
import { newId } from "../util/ids";
import { isDangerous, isReadOnly } from "./danger-list";
import type { Session } from "../session/session";

interface ResolvedDecision {
  decision: PermissionDecision;
  updatedInput?: Record<string, unknown>;
}
interface Pending {
  resolve: (d: ResolvedDecision) => void;
  sessionId: string;
}

/**
 * Holds permission prompts blocked in the PreToolUse hook until a client answers (arch §6.6).
 * Keyed by `requestId`; resolved by `permission.respond` — possibly from another device.
 */
export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();

  request(requestId: string, sessionId: string): Promise<ResolvedDecision> {
    return new Promise((resolve) => this.pending.set(requestId, { resolve, sessionId }));
  }
  sessionFor(requestId: string): string | undefined {
    return this.pending.get(requestId)?.sessionId;
  }
  resolve(requestId: string, decision: PermissionDecision, updatedInput?: unknown): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    p.resolve({ decision, updatedInput: updatedInput as Record<string, unknown> | undefined });
    return true;
  }

  /** Resolve every prompt parked for a session (used by session.reset to unblock a wedged hook). */
  resolveSession(sessionId: string, decision: PermissionDecision): number {
    let n = 0;
    for (const [requestId, p] of this.pending) {
      if (p.sessionId === sessionId) {
        this.pending.delete(requestId);
        p.resolve({ decision });
        n++;
      }
    }
    return n;
  }
}

const SUGGESTIONS = (tool: string): PermissionSuggestion[] => [
  { decision: "allow", label: "Allow once" },
  { decision: "allow_always", label: `Always allow ${tool} this session` },
  { decision: "deny", label: "Deny" },
];

/**
 * The authoritative permission gate (arch §6.6). Registered as a `PreToolUse` hook so it
 * fires on EVERY tool — making the daemon's autonomy policy + danger list govern all tools,
 * rather than deferring to the CLI's own heuristics (which `canUseTool` alone does not).
 */
export function makePreToolUseHook(session: Session, broker: PermissionBroker): HookCallback {
  return async (input) => {
    const i = input as PreToolUseHookInput;
    const tool = i.tool_name;
    const toolInput = (i.tool_input ?? {}) as Record<string, unknown>;

    // AskUserQuestion must fall through with NO permission decision. The CLI only emits the
    // `permission_ask_user_question` dialog (which drives our onUserDialog question card) when the
    // tool's permission resolves to "ask" with no hook/rule decision: in the CLI's `ask` branch the
    // PreToolUse hooks run first and `if (hookResult) { resolve(hookResult); return }` PREEMPTS the
    // dialog. So returning *any* concrete decision here — even "allow" — suppresses the question
    // card: onUserDialog never fires, AskUserQuestion runs with empty answers, and its result
    // becomes "The user did not answer the questions." (the model then continues unanswered). Emit a
    // bare continue so the native dialog flow runs; the question card is the only UI users see.
    // (arch §6.6 — see src/agent/questions.ts)
    if (tool === "AskUserQuestion") return { continue: true };

    const out = await decide(session, broker, tool, toolInput);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: out.behavior,
        permissionDecisionReason: out.reason,
        ...(out.updatedInput ? { updatedInput: out.updatedInput } : {}),
      },
    };
  };
}

interface Decision {
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  reason?: string;
}

async function decide(
  session: Session,
  broker: PermissionBroker,
  tool: string,
  input: Record<string, unknown>,
): Promise<Decision> {
  // NOTE: AskUserQuestion is handled before this point in makePreToolUseHook — it must fall through
  // with no decision so the native question dialog (onUserDialog) fires. Do not re-add it here: a
  // decision returned from the hook preempts that dialog (arch §6.6).
  if (session.isAlwaysAllowed(tool)) {
    return { behavior: "allow", updatedInput: input, reason: "remembered allow" };
  }

  const policy = session.data.autonomy;

  // "bypass" is the daemon equivalent of `claude --dangerously-skip-permissions`: allow every
  // tool unconditionally, skipping even the danger list. Short-circuit before isDangerous() so a
  // user who opted into this mode is never parked on a prompt (arch §6.6).
  if (policy === "bypass") {
    return { behavior: "allow", updatedInput: input, reason: "bypass: permissions skipped" };
  }

  const verdict = isDangerous(tool, input, session.data.cwd);
  const mustPrompt =
    policy === "prompt-all" ||
    (policy === "allowlist" && !isReadOnly(tool)) ||
    (policy === "mostly-autonomous" && verdict.danger);

  if (!mustPrompt) {
    return { behavior: "allow", updatedInput: input, reason: "auto-allowed by autonomy policy" };
  }

  const requestId = newId("perm");
  const answer = broker.request(requestId, session.id);
  session.requestPermission(requestId, tool, input, SUGGESTIONS(tool));
  const ans = await answer;

  if (ans.decision === "deny") {
    return { behavior: "deny", reason: verdict.reason ? `denied (${verdict.reason})` : "denied by user" };
  }
  if (ans.decision === "allow_always") session.rememberAllow(tool);
  return { behavior: "allow", updatedInput: ans.updatedInput ?? input };
}
