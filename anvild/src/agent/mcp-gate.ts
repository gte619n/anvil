/**
 * The seam between the permission gate (`decide()` in permissions.ts), the driver, and the MCP
 * integration registry (session/mcp-integration-service.ts). Types and two tiny registries only — no
 * Supervisor, no Session class — so permissions.ts and driver.ts can import it without a cycle.
 * (mcp-integrations spec §4.4/§4.5; agent-cad-and-browser §4.12)
 */
import type { McpIntegration, McpIntegrationKind, PermissionDecision, PermissionSuggestion, Session as SessionData } from "@protocol";

/** The slice of a session the gate reads. A real `Session` satisfies it. */
export interface McpGateSession {
  id: string;
  data: SessionData;
}

/**
 * What the registry gives the permission gate and the driver for ONE daemon. Every method is
 * synchronous: the gate must look things up live at the moment of each call (never from a snapshot
 * taken when the driver started), and the lock is a check-and-set with no await in between.
 */
export interface McpSessionGate {
  /** Live lookup of `key` for this session. `deny` when the key is not an integration switched on for
   *  this session, the integration is not enabled, or the session is not an ordinary one. */
  lookup(session: McpGateSession, key: string): { integration: McpIntegration } | { deny: string };
  /** The OTHER session holding this integration's exclusive lock, with a name fit to show. */
  heldByOther(session: McpGateSession, integration: McpIntegration): { sessionId: string; title: string } | undefined;
  /** Acquire or refresh the exclusive lock (a no-op success for a non-exclusive integration). */
  acquire(session: McpGateSession, integration: McpIntegration): { ok: true } | { ok: false; sessionId: string; title: string };
  /** Whether the owner answered "Always allow <label> this session". */
  isAllowed(session: McpGateSession, integration: McpIntegration): boolean;
  /** Record "Always allow <label> this session" (persists + broadcasts the session). */
  rememberAllowed(session: McpGateSession, integration: McpIntegration): void;
  /** A tool result arrived from `key`: refresh the lock so a long call does not count as idle. */
  onToolResult(session: McpGateSession, key: string): void;
  /** The session-init message's `mcp_servers` list: record servers the SDK reported `failed`. */
  onInit(session: McpGateSession, servers: { name: string; status: string }[]): void;
  /** A turn ended with a result: release this session's locks and apply any deferred driver rebuild. */
  onTurnEnd(session: McpGateSession): void;
  /** The driver's consume loop exited (error or stop): release this session's locks. */
  onConsumeExit(session: McpGateSession): void;
}

/** What the driver hands the PreToolUse hook. Passing it at all switches the MCP branch on; a hook
 *  built without one (older unit tests) keeps the pre-registry behaviour for every tool. */
export interface McpHookContext {
  /** Keys of the session's IN-PROCESS servers (the daemon's own: `anvil`, `anvil_team`, `anvil_cad`,
   *  …) — whatever is in the driver's server map with `type: "sdk"`. Their tools keep the existing
   *  permission behaviour. */
  inProcessKeys: readonly string[];
  /** Absent → every `mcp__` tool outside `inProcessKeys` is denied. */
  gate?: McpSessionGate;
}

/** Split `mcp__<key>__<tool>` for an INTEGRATION key (no underscores). Undefined when the name is not
 *  of that shape — including every daemon server whose key carries an underscore. */
export function parseMcpTool(name: string): { key: string; tool: string } | undefined {
  const m = /^mcp__([^_]+)__(.+)$/s.exec(name);
  return m ? { key: m[1]!, tool: m[2]! } : undefined;
}

/** Whether `name` is a tool of one of the session's in-process servers. */
export function isInProcessTool(name: string, inProcessKeys: readonly string[]): boolean {
  return inProcessKeys.some((k) => name.startsWith(`mcp__${k}__`));
}

// ── Per-kind gates ──────────────────────────────────────────────────────────────────────────────
// The generic checks in `decide()` (unknown key, not enabled, exclusive lock) apply to every
// integration. A KIND may add its own approval model on top — Phase C2's browser registers one for
// per-site approval and hard stops. It is consulted after the generic checks and before the generic
// "Always allow <label> this session" flow.

export interface McpKindGateContext {
  session: McpGateSession;
  integration: McpIntegration;
  /** The tool's own name, without the `mcp__<key>__` prefix (e.g. `browser_navigate`). */
  tool: string;
  /** The full name as the model called it. */
  fullTool: string;
  input: Record<string, unknown>;
  /** The session's worktree. */
  cwd: string;
}

export type McpKindVerdict =
  /** No opinion: the generic flow applies (bypass allows; `mcpAllowed` allows; otherwise prompt). */
  | undefined
  /** Refuse outright, whatever the policy. */
  | { kind: "deny"; reason: string }
  /** Run with no prompt (the kind already holds an approval that covers this call). The exclusive
   *  lock is still taken. */
  | { kind: "allow"; reason?: string }
  | {
      /** Park a card with the kind's own choices. */
      kind: "prompt";
      reason: string;
      suggestions: PermissionSuggestion[];
      /** Prompt even under `bypass` and even with a session-wide allow (a hard stop). When false or
       *  absent, `bypass` allows without the card. */
      always?: boolean;
      /** Deny with no card when nobody is there to answer (see `isUnattended`). */
      denyWhenUnattended?: boolean;
      /** Called with the owner's answer before the call proceeds, so the kind can record an approval
       *  (e.g. "Allow <site> this session"). `allow_always` is NOT recorded in `session.mcpAllowed`
       *  for a kind prompt — its meaning belongs to the kind. Return `{ deny }` to refuse after all. */
      onAnswer?: (decision: PermissionDecision) => void | { deny: string };
    };

export type McpKindGate = (ctx: McpKindGateContext) => McpKindVerdict | Promise<McpKindVerdict>;

const kindGates = new Map<McpIntegrationKind, McpKindGate>();

/** Register the gate for a kind (one per kind; a second registration replaces the first). Returns a
 *  thunk that removes exactly this registration. */
export function registerMcpKindGate(kind: McpIntegrationKind, gate: McpKindGate): () => void {
  kindGates.set(kind, gate);
  return () => {
    if (kindGates.get(kind) === gate) kindGates.delete(kind);
  };
}

export function mcpKindGate(kind: McpIntegrationKind): McpKindGate | undefined {
  return kindGates.get(kind);
}

/** Test-only: drop every registered kind gate. */
export function resetMcpKindGatesForTest(): void {
  kindGates.clear();
}
