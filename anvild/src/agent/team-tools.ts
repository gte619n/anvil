import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { TeamInfo, TeamPlanMember } from "@protocol";

/**
 * In-process MCP tools given ONLY to a team **lead** session (see docs/plans/anvil-team-support.md).
 * They let the lead decompose a goal into member sessions, watch them, and integrate their branches.
 * Handlers call back into the daemon through an injected surface (`TeamToolDeps`) closed over the
 * lead's session id — the same pattern as the concierge's `default-tools.ts`.
 */
export interface TeamToolDeps {
  /** The lead session these tools belong to. */
  leadId: string;
  /** Propose a decomposition. Routes through the autonomy gate: auto-approves at `bypass`, otherwise
   *  parks a reviewable team-plan card. Returns a human-readable summary of what happened. */
  proposePlan(members: TeamPlanMember[], integration: "combined-pr" | "pr-per-member"): string;
  /** Spawn one member session off the lead (its own worktree + git lifecycle). Throws on bad args. */
  createMember(args: {
    title: string;
    task: string;
    source: "fresh-worktree" | "existing-dir";
    base?: string;
    brief: string;
  }): { id: string; title: string; cwd: string };
  /** This lead's live team rollup (members + status + git), or null if it has none yet. */
  listMembers(): TeamInfo | null;
  /** Integrate member branches per the team's policy (combined-pr / pr-per-member). Returns a summary. */
  integrate(): string;
  /** Tear a member down: stop it and remove its worktree + branch + state. Returns a summary. */
  dismissMember(sessionId: string): string;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export const TEAM_MCP_SERVER_NAME = "anvil_team";

/** Tool ids as the SDK exposes them (`mcp__<server>__<tool>`), for the driver allowlist. */
export const TEAM_TOOL_IDS = ["propose_team_plan", "create_member", "list_members", "integrate", "dismiss_member"].map(
  (t) => `mcp__${TEAM_MCP_SERVER_NAME}__${t}`,
);

const memberSchema = z.object({
  title: z.string().describe("Short human title for the member (also the branch slug)."),
  task: z.string().describe("The one-line task this member owns; also its opening brief."),
  source: z
    .enum(["fresh-worktree", "existing-dir"])
    .default("fresh-worktree")
    .describe("fresh-worktree (own branch off the lead, preferred) or existing-dir (read-only/research)."),
  dependsOn: z
    .array(z.string())
    .optional()
    .describe("Titles of members that must integrate BEFORE this one (used to order the merge)."),
});

export function buildTeamToolsServer(deps: TeamToolDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: TEAM_MCP_SERVER_NAME, version: "1.0.0", tools: teamTools(deps) });
}

/** The lead tool definitions (exported so tests can invoke handlers without a live SDK server). */
export function teamTools(deps: TeamToolDeps): SdkMcpToolDefinition<any>[] {
  return [
      tool(
        "propose_team_plan",
        "Propose how to split the goal into parallel member sessions. Each member gets its own task " +
          "and (usually) its own git worktree branched off yours. This proposal is GATED: at 'bypass' " +
          "autonomy it auto-approves and members spawn immediately; otherwise it surfaces a plan card " +
          "the user approves/edits first. Call this ONCE you've decided the decomposition.",
        {
          members: z.array(memberSchema).min(1).describe("The members to spawn, in a sensible order."),
          integration: z
            .enum(["combined-pr", "pr-per-member"])
            .default("combined-pr")
            .describe("combined-pr: you merge every member branch into yours and open ONE PR (default). " +
              "pr-per-member: each member opens its own PR; you don't merge."),
        },
        async ({ members, integration }) => {
          try {
            return ok(deps.proposePlan(members as TeamPlanMember[], integration));
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
        },
      ),
      tool(
        "create_member",
        "Directly spawn ONE member session that starts working immediately on its brief. Use this to " +
          "hand-build a team or add a member outside the plan flow. The member branches off your " +
          "current branch HEAD (for fresh-worktree) and shows up nested under you in the sidebar.",
        {
          title: z.string().describe("Short human title (also the branch slug)."),
          task: z.string().describe("The one-line task shown on the member's row."),
          source: z
            .enum(["fresh-worktree", "existing-dir"])
            .default("fresh-worktree")
            .describe("fresh-worktree (own branch, preferred) or existing-dir (read-only/research)."),
          base: z.string().optional().describe("Base branch/commit override (default: your branch HEAD)."),
          brief: z.string().describe("The member's full, self-contained opening instruction."),
        },
        async (a) => {
          try {
            const { id, title, cwd } = deps.createMember({
              title: a.title,
              task: a.task,
              source: a.source as "fresh-worktree" | "existing-dir",
              base: a.base,
              brief: a.brief,
            });
            return ok(`Spawned member "${title}" (${id}) at ${cwd}. It is now working on its task.`);
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
        },
      ),
      tool(
        "list_members",
        "List your team's members with their live status and git state (branch, dirty, ahead, PR). " +
          "Use this to check progress before integrating.",
        {},
        async () => ok(JSON.stringify(deps.listMembers(), null, 2)),
      ),
      tool(
        "integrate",
        "Bring the members' work home per the team policy. combined-pr: merge each member branch into " +
          "yours in dependency order, then open one PR. pr-per-member: no merge (each member PRs its own). " +
          "Call this once members have finished.",
        {},
        async () => {
          try {
            return ok(deps.integrate());
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
        },
      ),
      tool(
        "dismiss_member",
        "Tear a member down when its work is done or unwanted: stops the member and removes its worktree, " +
          "branch, and state. Only members of YOUR team can be dismissed. Use after integrate, or to drop a " +
          "member you no longer need. This is destructive — the member's uncommitted work is discarded.",
        { sessionId: z.string().describe("The member session id to dismiss (from list_members).") },
        async ({ sessionId }) => {
          try {
            return ok(deps.dismissMember(sessionId));
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
        },
      ),
  ];
}
