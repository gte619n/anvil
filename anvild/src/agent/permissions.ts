import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionDecision, PermissionSuggestion } from "@protocol";
import { newId } from "../util/ids";
import { isDangerous, isReadOnly } from "./danger-list";
import { isUnattended, protectedVerdict } from "./protected";
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

/** The card for a protected always-prompt action (spec §4.4): Allow once / Deny ONLY — never an
 *  "always allow", because the whole point is that it is asked every single time. */
const PROTECTED_SUGGESTIONS = (label?: string): PermissionSuggestion[] => [
  { decision: "allow", label: label ?? "Allow once" },
  { decision: "deny", label: "Deny" },
];

/**
 * Called when the model asks to leave plan mode (ExitPlanMode) with its finished plan. Lets the
 * daemon run the adversarial panel over the plan before it's approved (advisory only — see the
 * supervisor's planReviewer). Awaited so the critique lands before execution; must never throw.
 */
export type PlanProposedHook = (plan: string) => Promise<void>;

/**
 * The authoritative permission gate (arch §6.6). Registered as a `PreToolUse` hook so it
 * fires on EVERY tool — making the daemon's autonomy policy + danger list govern all tools,
 * rather than deferring to the CLI's own heuristics (which `canUseTool` alone does not).
 *
 * `onPlanProposed`, when set, runs the adversarial plan review the moment the model calls
 * ExitPlanMode and BEFORE the normal permission decision, so the panel's verdict is surfaced
 * alongside the plan. It's advisory: it never changes the permission outcome.
 */
export function makePreToolUseHook(
  session: Session,
  broker: PermissionBroker,
  onPlanProposed?: PlanProposedHook,
): HookCallback {
  return async (input) => {
    const i = input as PreToolUseHookInput;
    const tool = i.tool_name;
    const toolInput = (i.tool_input ?? {}) as Record<string, unknown>;

    // The model is committing to a plan and asking to leave plan mode: run the adversarial panel
    // over it first (advisory). Awaited so the critique is emitted before ExitPlanMode proceeds;
    // the hook itself is defensive, but never let a review failure block the tool. (adversarial panel)
    if (tool === "ExitPlanMode" && onPlanProposed) {
      try {
        await onPlanProposed(typeof toolInput.plan === "string" ? toolInput.plan : "");
      } catch {
        /* advisory only — a panel failure must never block the plan */
      }
    }

    // AskUserQuestion must fall through with NO permission decision. Its checkPermissions resolves
    // to "ask", and the SDK only routes that "ask" to our canUseTool (where we surface the question
    // card and feed the answer back via updatedInput) when no hook/rule has already decided it.
    // Returning *any* concrete decision here — even "allow" — short-circuits before canUseTool: the
    // tool then runs with empty answers and its result becomes "The user did not answer the
    // questions." (the model continues unanswered). Emit a bare continue so the "ask" reaches
    // canUseTool. (arch §6.6 — see src/agent/questions.ts)
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
  // with no decision so its "ask" verdict reaches canUseTool (where the question card is surfaced).
  // Do not re-add it here: a decision returned from the hook short-circuits before canUseTool (arch §6.6).

  // The protected check (agent-cad-and-browser spec §4.4) runs FIRST — before the remembered-allow
  // lookup and before the `bypass` short-circuit below — so neither an earlier "always allow" nor an
  // autonomy policy can wave a protected action through. With no rule registered (or none with an
  // opinion) `guard` is undefined and everything below behaves exactly as it always has.
  const guard = protectedVerdict({ session, tool, input, cwd: session.data.cwd });
  if (guard?.kind === "deny") {
    return { behavior: "deny", reason: guard.reason };
  }
  if (guard?.kind === "owner-card") {
    // The tool itself asks the owner, on a typed card, every time it runs. Unattended: nobody can answer.
    if (isUnattended(session)) {
      return { behavior: "deny", reason: `${guard.reason} (denied: this session is unattended)` };
    }
    return { behavior: "allow", updatedInput: input, reason: `protected: ${guard.reason}` };
  }
  if (guard?.kind === "always-prompt") {
    // Nobody is there to answer in an unattended (autopilot builder) session: deny without a card
    // rather than park the run forever.
    if (guard.denyWhenUnattended && isUnattended(session)) {
      return { behavior: "deny", reason: `${guard.reason} (denied: this session is unattended)` };
    }
    const requestId = newId("perm");
    const answer = broker.request(requestId, session.id);
    session.requestPermission(requestId, tool, input, PROTECTED_SUGGESTIONS(guard.label));
    const ans = await answer;
    if (ans.decision === "deny") {
      return { behavior: "deny", reason: `denied by user (${guard.reason})` };
    }
    // "allow_always" is not offered; if a client sends it anyway it is an allow-ONCE. Deliberately
    // no session.rememberAllow(): a protected action is never remembered.
    return { behavior: "allow", updatedInput: ans.updatedInput ?? input, reason: `protected: ${guard.reason}` };
  }

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
