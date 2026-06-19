import type { CanUseTool, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionDecision, PermissionSuggestion } from "@protocol";
import { newId } from "../util/ids";
import { isDangerous, isReadOnly } from "./danger-list";
import type { Session } from "../session/session";

interface Pending {
  resolve: (r: PermissionResult) => void;
  sessionId: string;
  defaultInput: Record<string, unknown>;
  suggestions: PermissionUpdate[];
}

/**
 * Holds permission prompts blocked in `canUseTool` until a client answers (arch §6.6).
 * Keyed by `requestId`; resolved by `permission.respond` (possibly from another device).
 */
export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();

  add(requestId: string, p: Pending): void {
    this.pending.set(requestId, p);
  }
  sessionFor(requestId: string): string | undefined {
    return this.pending.get(requestId)?.sessionId;
  }

  resolve(requestId: string, decision: PermissionDecision, updatedInput?: unknown): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);

    if (decision === "deny") {
      p.resolve({ behavior: "deny", message: "Denied by user" });
      return true;
    }
    const result: PermissionResult = {
      behavior: "allow",
      updatedInput: (updatedInput as Record<string, unknown> | undefined) ?? p.defaultInput,
    };
    // "allow_always" → persist the SDK's suggested rules so it won't re-ask this session.
    if (decision === "allow_always") result.updatedPermissions = p.suggestions;
    p.resolve(result);
    return true;
  }
}

const PROMPT_SUGGESTIONS = (tool: string): PermissionSuggestion[] => [
  { decision: "allow", label: "Allow once" },
  { decision: "allow_always", label: `Always allow ${tool}` },
  { decision: "deny", label: "Deny" },
];

/**
 * Build the `canUseTool` callback for a session, applying its autonomy policy:
 *  - mostly-autonomous: auto-allow unless the danger list trips;
 *  - allowlist: auto-allow read-only tools, prompt for the rest;
 *  - prompt-all: always prompt.
 * When a prompt is needed, park on the broker until `permission.respond` arrives.
 */
export function makeCanUseTool(session: Session, broker: PermissionBroker): CanUseTool {
  return async (toolName, input, { suggestions }) => {
    const policy = session.data.autonomy;
    const verdict = isDangerous(toolName, input, session.data.cwd);

    const mustPrompt =
      policy === "prompt-all" ||
      (policy === "allowlist" && !isReadOnly(toolName)) ||
      (policy === "mostly-autonomous" && verdict.danger);

    if (!mustPrompt) {
      return { behavior: "allow", updatedInput: input };
    }

    const requestId = newId("perm");
    return new Promise<PermissionResult>((resolve) => {
      broker.add(requestId, {
        resolve,
        sessionId: session.id,
        defaultInput: input,
        suggestions: suggestions ?? [],
      });
      session.requestPermission(requestId, toolName, input, PROMPT_SUGGESTIONS(toolName));
    });
  };
}
