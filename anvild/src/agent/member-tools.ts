import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";

/**
 * In-process MCP tool given to a team **member** session so it can talk back to its lead
 * (anvil-team-support.md — lead↔member is a full two-way conversation; member↔member peer messaging
 * stays deferred, so a member can message ONLY its lead, never a sibling). Mirrors the lead's
 * `team-tools.ts`. A relay guard in the supervisor caps runaway lead↔member ping-pong.
 */
export interface MemberToolDeps {
  memberId: string;
  /** Send a message to this member's lead (queues for the lead's next turn). Returns a summary. */
  messageLead(text: string): string;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export const MEMBER_MCP_SERVER_NAME = "anvil_member";
export const MEMBER_TOOL_IDS = ["message_lead"].map((t) => `mcp__${MEMBER_MCP_SERVER_NAME}__${t}`);

export function buildMemberToolsServer(deps: MemberToolDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: MEMBER_MCP_SERVER_NAME, version: "1.0.0", tools: memberTools(deps) });
}

/** The member tool definitions (exported so tests can invoke handlers without a live SDK server). */
export function memberTools(deps: MemberToolDeps): SdkMcpToolDefinition<any>[] {
  return [
    tool(
      "message_lead",
      "Message your team LEAD — report progress, ask a clarifying question, flag a blocker, propose a " +
        "change, or hand back a result. Your lead receives it on its next turn and can reply (a full " +
        "two-way conversation). You can only message your lead, not sibling members.",
      { text: z.string().describe("What to tell your lead.") },
      async ({ text }) => {
        try {
          return ok(deps.messageLead(text));
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    ),
  ];
}
