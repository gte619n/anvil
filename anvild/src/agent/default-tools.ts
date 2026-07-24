import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { AutonomyPolicy, Environment, Model, Session as SessionData, SessionSource } from "@protocol";

/**
 * In-process MCP tools given ONLY to the persistent "concierge" default chat (§0.6). They let
 * that one session see the whole fleet and hand off real work to fresh sessions. The handlers
 * call back into the daemon through an injected capability surface (`DefaultToolDeps`) rather than
 * importing the Supervisor — that keeps the tool sandbox to an explicit list and avoids a cycle.
 */
export interface DefaultToolDeps {
  /** supervisor.list() — every session's data. */
  listSessions(): SessionData[];
  /** one session's data by id, or undefined. */
  getSession(id: string): SessionData | undefined;
  /** the registered environments (project repos). */
  listEnvironments(): Environment[];
  /** Create a session AND auto-start it on a seeded brief. Throws on bad args. Returns new ids. */
  handoff(args: {
    environmentId?: string;
    source: SessionSource;
    cwd?: string;
    base?: string;
    title: string;
    model?: Model;
    autonomy?: AutonomyPolicy;
    brief: string;
    // ── Teams: stamp the new session as a member of a lead (see docs/plans/anvil-team-support.md) ──
    parentId?: string;
    teamRole?: "lead" | "member";
    memberTask?: string;
  }): { id: string; title: string; cwd: string };
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

/** A compact, model-friendly projection of a session (drops heavy/irrelevant fields). */
function summarize(s: SessionData) {
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    model: s.model,
    autonomy: s.autonomy,
    environmentId: s.environmentId,
    source: s.source,
    archived: !!s.archived,
    cwd: s.cwd,
    lastActivityAt: s.lastActivityAt,
    git: s.git && {
      branch: s.git.branch,
      dirty: s.git.dirtyFileCount,
      ahead: s.git.ahead,
      behind: s.git.behind,
      pr: s.git.prState,
      prUrl: s.git.prUrl,
    },
  };
}

export const DEFAULT_MCP_SERVER_NAME = "anvil";

/** Tool ids as the SDK exposes them (`mcp__<server>__<tool>`), for the driver allowlist. */
export const DEFAULT_TOOL_IDS = ["list_sessions", "get_session", "list_environments", "create_session"].map(
  (t) => `mcp__${DEFAULT_MCP_SERVER_NAME}__${t}`,
);

export function buildDefaultToolsServer(deps: DefaultToolDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: DEFAULT_MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [
      tool(
        "list_sessions",
        "List every Anvil session across ALL environments with title, environment, status, model, " +
          "last activity, and git state (branch, dirty count, ahead/behind, PR). Use this to answer " +
          "questions about ongoing work anywhere on this machine. The data is live.",
        {},
        async () => {
          // Never report the concierge itself — it isn't a work session and can't be a handoff target.
          const all = deps.listSessions().filter((s) => !s.isDefault).map(summarize);
          return ok(JSON.stringify(all, null, 2));
        },
      ),
      tool(
        "get_session",
        "Get the detail for one session by id (same fields as list_sessions, for a single session).",
        { id: z.string().describe("The session id, e.g. sess_…") },
        async ({ id }) => {
          const s = deps.getSession(id);
          if (!s || s.isDefault) return fail(`no such session: ${id}`);
          return ok(JSON.stringify(summarize(s), null, 2));
        },
      ),
      tool(
        "list_environments",
        "List the registered environments (project repos) the user can spin sessions up in: id, name, " +
          "repoRoot, whether it's a git repo (isRepo), and the default base branch.",
        {},
        async () => ok(JSON.stringify(deps.listEnvironments(), null, 2)),
      ),
      tool(
        "create_session",
        "Create a NEW working session and hand off a task to it — it starts working immediately on the " +
          "brief you provide. Prefer a fresh-worktree session in a chosen environment for code work " +
          "(call list_environments first to pick one). Returns the new session id and title.",
        {
          environmentId: z
            .string()
            .optional()
            .describe("Environment id from list_environments. Required for a fresh-worktree session."),
          source: z
            .enum(["fresh-worktree", "existing-dir"])
            .default("fresh-worktree")
            .describe("fresh-worktree (isolated git branch, preferred) or existing-dir (work in place)."),
          cwd: z.string().optional().describe("Absolute working directory. Required when source is existing-dir."),
          base: z.string().optional().describe("Base branch/commit for the worktree (default: the env's default base)."),
          title: z.string().describe("Short human title for the session (also used as the branch slug)."),
          model: z.enum(["opus", "sonnet"]).optional().describe("Model for the new session (default opus)."),
          autonomy: z
            .enum(["mostly-autonomous", "allowlist", "prompt-all", "bypass"])
            .optional()
            .describe("Permission posture for the new session (default mostly-autonomous)."),
          brief: z
            .string()
            .describe("The handoff brief: the full, self-contained first instruction the new session should act on."),
        },
        async (a) => {
          try {
            const { id, title, cwd } = deps.handoff({
              environmentId: a.environmentId,
              source: a.source as SessionSource,
              cwd: a.cwd,
              base: a.base,
              title: a.title,
              model: a.model as Model | undefined,
              autonomy: a.autonomy as AutonomyPolicy | undefined,
              brief: a.brief,
            });
            return ok(`Created and started session "${title}" (${id}) at ${cwd}. It is now working on the brief.`);
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
        },
      ),
    ],
  });
}
