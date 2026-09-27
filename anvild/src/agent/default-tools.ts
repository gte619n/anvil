import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { AutonomyPolicy, Environment, Model, Session as SessionData, SessionSource, rest } from "@protocol";
import type { RepoRequest, RepoResult } from "../fleet/repo-access";

/**
 * In-process MCP tools given ONLY to the persistent "concierge" default chat (§0.6). They let
 * that one session see the whole fleet and hand off real work to fresh sessions. The handlers
 * call back into the daemon through an injected capability surface (`DefaultToolDeps`) rather than
 * importing the Supervisor — that keeps the tool sandbox to an explicit list and avoids a cycle.
 *
 * Fleet reach (anvil-fleet-concierge): on a HUB, `deps.fleet()` exposes the member roster plus
 * REST-backed environment/repo/handoff calls, so this ONE chat covers repos on every machine —
 * `list_environments` aggregates the fleet, `repo_list`/`repo_read`/`repo_grep` route by
 * environment owner, and `create_session` hands off to whichever daemon hosts the environment.
 * On a member or standalone daemon `deps.fleet()` returns undefined and everything stays local.
 */

/** What the concierge needs from the hub's fleet layer. Injected from http.ts (which owns the
 *  FleetStore + identity); every call is remote and may reject — tool handlers report, not throw. */
export interface ConciergeFleetOps {
  /** This daemon's own identity, for labeling local environments in fleet listings. */
  self(): { serverId: string; serverName: string };
  /** The recorded fleet members (empty on a member/standalone daemon). */
  members(): { serverId: string; serverName: string }[];
  memberEnvironments(serverId: string): Promise<rest.FleetEnvironmentsResponse>;
  memberRepo(serverId: string, req: Omit<rest.FleetRepoRequest, "hubServerId">): Promise<rest.FleetRepoResponse>;
  memberHandoff(serverId: string, args: Omit<rest.FleetHandoffRequest, "hubServerId">): Promise<rest.FleetHandoffResponse>;
}

export interface DefaultToolDeps {
  /** supervisor.list() — every session's data. */
  listSessions(): SessionData[];
  /** one session's data by id, or undefined. */
  getSession(id: string): SessionData | undefined;
  /** the registered environments (project repos) ON THIS DAEMON. */
  listEnvironments(): Environment[];
  /** One read-only repo op (list/read/grep) inside a LOCAL environment's repoRoot. */
  localRepo(req: RepoRequest & { environmentId: string }): Promise<RepoResult>;
  /** The fleet layer, or undefined off-hub. A thunk (not a value) because the Supervisor builds this
   *  server at field-init time, before its config lands. */
  fleet(): ConciergeFleetOps | undefined;
  /** Create a session AND auto-start it on a seeded brief. Throws/rejects on bad args. Returns new
   *  ids. [BE2-2] May resolve asynchronously: fresh-worktree creation runs its git ops via Bun.spawn
   *  (the tool handler awaits either shape; test fakes can stay synchronous). */
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
  }): { id: string; title: string; cwd: string } | Promise<{ id: string; title: string; cwd: string }>;
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
export const DEFAULT_TOOL_IDS = ["list_sessions", "get_session", "list_environments", "create_session", "repo_list", "repo_read", "repo_grep"].map(
  (t) => `mcp__${DEFAULT_MCP_SERVER_NAME}__${t}`,
);

/** How stale the envId→owner routing cache may get before a MISS re-fetches the fleet's environment
 *  lists. Hits never re-fetch — an environment's owner effectively never changes. */
const OWNER_CACHE_TTL_MS = 60_000;

/** One handoff argument set, shared by the local and cross-machine paths. */
export interface HandoffArgs {
  environmentId?: string;
  source: SessionSource;
  cwd?: string;
  base?: string;
  title: string;
  model?: Model;
  autonomy?: AutonomyPolicy;
  brief: string;
}

/**
 * The concierge's fleet routing, separated from the MCP wiring so it's directly testable (and so
 * the tool handlers stay one-liners): which machine owns an environment, fan-out environment
 * listings, and owner-routed repo ops / handoffs.
 */
export function conciergeRouter(deps: DefaultToolDeps) {
  // envId → owning member serverId, learned from fleet environment listings. Local environments are
  // resolved against deps.listEnvironments() live and never enter this map.
  const memberEnvOwner = new Map<string, string>();
  let ownerFetchedAt = 0;

  /** Fetch every member's environments (tolerating per-member failures) and refresh the owner map.
   *  Returns per-machine stanzas ready for the list_environments payload. */
  async function fetchFleetEnvironments(fleet: ConciergeFleetOps): Promise<{ machine: string; machineId: string; environments?: unknown[]; error?: string }[]> {
    const members = fleet.members();
    const stanzas = await Promise.all(
      members.map(async (m) => {
        try {
          const r = await fleet.memberEnvironments(m.serverId);
          if (!r.ok || !r.environments) return { machine: m.serverName, machineId: m.serverId, error: r.error ?? "unreachable" };
          for (const e of r.environments) memberEnvOwner.set(e.id, m.serverId);
          return { machine: m.serverName, machineId: m.serverId, environments: r.environments };
        } catch (e) {
          return { machine: m.serverName, machineId: m.serverId, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    ownerFetchedAt = Date.now();
    return stanzas;
  }

  /** The list_environments payload: this machine's repos first, then one stanza per member. */
  async function listStanzas(): Promise<unknown[]> {
    const fleet = deps.fleet();
    const localStanza = {
      machine: fleet ? fleet.self().serverName : "this machine",
      ...(fleet ? { machineId: fleet.self().serverId } : {}),
      environments: deps.listEnvironments(),
    };
    if (!fleet || fleet.members().length === 0) return [localStanza];
    return [localStanza, ...(await fetchFleetEnvironments(fleet))];
  }

  /** Which daemon owns this environment: "local", a member's serverId, or null (unknown anywhere).
   *  Misses re-fetch the fleet listings at most once per TTL, so a just-registered member repo is
   *  routable without the model having to call list_environments first. */
  async function ownerOf(environmentId: string): Promise<"local" | string | null> {
    if (deps.listEnvironments().some((e) => e.id === environmentId)) return "local";
    const fleet = deps.fleet();
    if (!fleet) return null;
    if (!memberEnvOwner.has(environmentId) && Date.now() - ownerFetchedAt > OWNER_CACHE_TTL_MS) {
      await fetchFleetEnvironments(fleet);
    }
    return memberEnvOwner.get(environmentId) ?? null;
  }

  const unknownEnv = (environmentId: string): { ok: false; error: string } => ({
    ok: false,
    error: `no such environment anywhere in the fleet: ${environmentId} (call list_environments to see what exists)`,
  });

  /** Route one read-only repo op to the environment's owner and normalize the result. */
  async function routedRepo(environmentId: string, req: RepoRequest): Promise<RepoResult | rest.FleetRepoResponse> {
    const owner = await ownerOf(environmentId);
    if (owner === null) return unknownEnv(environmentId);
    if (owner === "local") return deps.localRepo({ ...req, environmentId });
    try {
      return await deps.fleet()!.memberRepo(owner, { environmentId, op: req.op, ...(req.path !== undefined ? { path: req.path } : {}), ...(req.pattern !== undefined ? { pattern: req.pattern } : {}) });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Route a handoff to the environment's owner: an environment on a member gets its session
   *  created THERE (the repo only exists on that disk); everything else stays local. */
  async function routedHandoff(a: HandoffArgs): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
    const owner = a.environmentId ? await ownerOf(a.environmentId) : "local";
    if (owner === null) return unknownEnv(a.environmentId!);
    try {
      if (owner !== "local") {
        const fleet = deps.fleet()!;
        const machine = fleet.members().find((m) => m.serverId === owner)?.serverName ?? owner;
        const r = await fleet.memberHandoff(owner, a);
        if (!r.ok) return { ok: false, error: r.error ?? "handoff failed" };
        return { ok: true, message: `Created and started session "${r.title}" (${r.id}) at ${r.cwd} on ${machine}. It is now working on the brief.` };
      }
      const { id, title, cwd } = await deps.handoff(a);
      return { ok: true, message: `Created and started session "${title}" (${id}) at ${cwd}. It is now working on the brief.` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return { listStanzas, ownerOf, routedRepo, routedHandoff };
}

export function buildDefaultToolsServer(deps: DefaultToolDeps): McpSdkServerConfigWithInstance {
  const router = conciergeRouter(deps);
  const truncNote = (r: { truncated?: boolean }): string => (r.truncated ? "\n\n[truncated — narrow the path/pattern for more]" : "");

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
        "List the registered environments (project repos) across EVERY machine in the fleet: id, name, " +
          "repoRoot, whether it's a git repo (isRepo), and the default base branch — grouped by the " +
          "machine that hosts each. Repos on other machines are fully reachable from here: browse them " +
          "with repo_list/repo_read/repo_grep and hand work off with create_session.",
        {},
        async () => ok(JSON.stringify(await router.listStanzas(), null, 2)),
      ),
      tool(
        "repo_list",
        "List a directory inside any registered environment's repo — including repos hosted on OTHER " +
          "machines in the fleet (the call is relayed to the machine that has the checkout). Paths are " +
          "repo-relative; omit `path` for the repo root.",
        {
          environmentId: z.string().describe("Environment id from list_environments."),
          path: z.string().optional().describe("Repo-relative directory (default: the repo root)."),
        },
        async ({ environmentId, path }) => {
          const r = await router.routedRepo(environmentId, { op: "list", path });
          if (!r.ok) return fail(r.error ?? "list failed");
          return ok(JSON.stringify(r.entries, null, 2) + truncNote(r));
        },
      ),
      tool(
        "repo_read",
        "Read a file from any registered environment's repo, wherever in the fleet it lives. " +
          "Repo-relative path; text files only, capped at 256 KB.",
        {
          environmentId: z.string().describe("Environment id from list_environments."),
          path: z.string().describe("Repo-relative file path."),
        },
        async ({ environmentId, path }) => {
          const r = await router.routedRepo(environmentId, { op: "read", path });
          if (!r.ok) return fail(r.error ?? "read failed");
          return ok((r.text ?? "") + truncNote(r));
        },
      ),
      tool(
        "repo_grep",
        "Search (extended regex) inside any registered environment's repo, wherever in the fleet it " +
          "lives. Returns file:line:text matches (capped at 200 lines). Scope with `path` to a subtree.",
        {
          environmentId: z.string().describe("Environment id from list_environments."),
          pattern: z.string().describe("ERE pattern to search for."),
          path: z.string().optional().describe("Repo-relative subtree to search (default: whole repo)."),
        },
        async ({ environmentId, pattern, path }) => {
          const r = await router.routedRepo(environmentId, { op: "grep", pattern, path });
          if (!r.ok) return fail(r.error ?? "grep failed");
          const lines = r.matches ?? [];
          return ok((lines.length === 0 ? "(no matches)" : lines.join("\n")) + truncNote(r));
        },
      ),
      tool(
        "create_session",
        "Create a NEW working session and hand off a task to it — it starts working immediately on the " +
          "brief you provide. Works across the whole fleet: an environment hosted on another machine " +
          "gets its session created ON that machine, right where the repo lives. Prefer a fresh-worktree " +
          "session in a chosen environment for code work (call list_environments first to pick one). " +
          "Returns the new session id and title.",
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
          const r = await router.routedHandoff({
            environmentId: a.environmentId,
            source: a.source as SessionSource,
            cwd: a.cwd,
            base: a.base,
            title: a.title,
            model: a.model as Model | undefined,
            autonomy: a.autonomy as AutonomyPolicy | undefined,
            brief: a.brief,
          });
          return r.ok ? ok(r.message) : fail(r.error);
        },
      ),
    ],
  });
}
