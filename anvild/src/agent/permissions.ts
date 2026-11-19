import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionDecision, PermissionSuggestion } from "@protocol";
import { newId } from "../util/ids";
import { isDangerous, isReadOnly } from "./danger-list";
import { isUnattended, protectedVerdict, type ProtectedVerdict } from "./protected";
import { isInProcessTool, mcpKindGate, parseMcpTool, type McpHookContext, type McpKindVerdict, type McpSessionGate } from "./mcp-gate";
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

/** The card for an MCP integration (mcp-integrations spec §4.4): the "always" choice covers the whole
 *  integration for this session — rules match on the server key only, never on a tool name. */
const MCP_SUGGESTIONS = (label: string): PermissionSuggestion[] => [
  { decision: "allow", label: "Allow once" },
  { decision: "allow_always", label: `Always allow ${label} this session` },
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
  /** The session's MCP context (its in-process server keys + the integration registry). The driver
   *  always passes one, which switches on the MCP branch in `decide()`; omitted (older unit tests),
   *  every tool takes the pre-registry path. */
  mcp?: McpHookContext,
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

    const out = await decide(session, broker, tool, toolInput, mcp);
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
  mcp?: McpHookContext,
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

  // MCP branch (mcp-integrations spec §4.4). Runs before the remembered-allow lookup and the `bypass`
  // short-circuit below. A tool of one of the session's own in-process servers (`anvil`,
  // `anvil_team`, `anvil_cad`, … — whatever is in the driver's server map) keeps the existing
  // behaviour; every other `mcp__` tool is an integration call and is decided entirely here.
  if (mcp && tool.startsWith("mcp__") && !isInProcessTool(tool, mcp.inProcessKeys)) {
    return decideMcp(session, broker, tool, input, mcp.gate, guard);
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

/**
 * Decide one call to an MCP integration tool (mcp-integrations spec §4.4/§4.5):
 *
 *  1. unknown `mcp__<key>__`, an integration not switched on for this session, or one not enabled → deny
 *     (looked up LIVE on every call, never from a snapshot taken when the driver started);
 *  2. exclusive and held by another session → deny, naming the holder;
 *  3. the integration kind's own gate, if one is registered (Phase C2's browser) → deny / allow / its
 *     own prompt;
 *  4. otherwise: `bypass` allows; an "Always allow <label> this session" allows; else prompt;
 *  5. on allow, re-check 1 (the prompt may have been open for minutes) and take or refresh the
 *     exclusive lock in one synchronous check-and-set. A session parked on a prompt does not hold the
 *     lock, so if another session took it meanwhile the approved call is denied.
 *
 * A protected always-prompt verdict (`guard`) still forces its Allow once / Deny card, under every
 * policy, in place of step 4.
 */
async function decideMcp(
  session: Session,
  broker: PermissionBroker,
  tool: string,
  input: Record<string, unknown>,
  gate: McpSessionGate | undefined,
  guard: ProtectedVerdict,
): Promise<Decision> {
  const parsed = parseMcpTool(tool);
  if (!parsed || !gate) return { behavior: "deny", reason: `${tool}: unknown MCP server (not an integration switched on for this session)` };

  const found = gate.lookup(session, parsed.key);
  if ("deny" in found) return { behavior: "deny", reason: found.deny };
  const integration = found.integration;

  const busy = gate.heldByOther(session, integration);
  if (busy) return { behavior: "deny", reason: `${integration.label} is in use by ${busy.title}` };

  // After approval (or with no prompt needed): the live re-check + the lock.
  const finish = (updatedInput: Record<string, unknown>, reason: string): Decision => {
    const again = gate.lookup(session, parsed.key);
    if ("deny" in again) return { behavior: "deny", reason: again.deny };
    const lock = gate.acquire(session, again.integration);
    if (!lock.ok) return { behavior: "deny", reason: `${again.integration.label} is in use by ${lock.title}` };
    return { behavior: "allow", updatedInput, reason };
  };
  const ask = async (suggestions: PermissionSuggestion[]) => {
    const requestId = newId("perm");
    const answer = broker.request(requestId, session.id);
    session.requestPermission(requestId, tool, input, suggestions);
    return answer;
  };

  if (guard?.kind === "always-prompt") {
    if (guard.denyWhenUnattended && isUnattended(session)) {
      return { behavior: "deny", reason: `${guard.reason} (denied: this session is unattended)` };
    }
    const ans = await ask(PROTECTED_SUGGESTIONS(guard.label));
    if (ans.decision === "deny") return { behavior: "deny", reason: `denied by user (${guard.reason})` };
    return finish(ans.updatedInput ?? input, `protected: ${guard.reason}`);
  }

  let verdict: McpKindVerdict;
  const kindGate = mcpKindGate(integration.kind);
  if (kindGate) {
    try {
      verdict = await kindGate({ session, integration, tool: parsed.tool, fullTool: tool, input, cwd: session.data.cwd });
    } catch (e) {
      // A safety gate that throws fails closed.
      return { behavior: "deny", reason: `${integration.label} check failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  if (verdict?.kind === "deny") return { behavior: "deny", reason: verdict.reason };
  if (verdict?.kind === "allow") return finish(input, verdict.reason ?? `${integration.label}: allowed`);

  const bypass = session.data.autonomy === "bypass";
  if (verdict?.kind === "prompt") {
    if (bypass && !verdict.always) return finish(input, "bypass: permissions skipped");
    if (verdict.denyWhenUnattended && isUnattended(session)) {
      return { behavior: "deny", reason: `${verdict.reason} (denied: this session is unattended)` };
    }
    const ans = await ask(verdict.suggestions);
    if (ans.decision === "deny") return { behavior: "deny", reason: `denied by user (${verdict.reason})` };
    const after = verdict.onAnswer?.(ans.decision);
    if (after && "deny" in after) return { behavior: "deny", reason: after.deny };
    return finish(ans.updatedInput ?? input, verdict.reason);
  }

  if (bypass) return finish(input, "bypass: permissions skipped");
  if (gate.isAllowed(session, integration)) return finish(input, `${integration.label}: allowed for this session`);

  const ans = await ask(MCP_SUGGESTIONS(integration.label));
  if (ans.decision === "deny") return { behavior: "deny", reason: "denied by user" };
  const done = finish(ans.updatedInput ?? input, `${integration.label}: allowed by user`);
  // Remember only an approval that actually went through (not one refused by the lock or a switch-off).
  if (done.behavior === "allow" && ans.decision === "allow_always") gate.rememberAllowed(session, integration);
  return done;
}
