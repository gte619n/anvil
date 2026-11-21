import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";

/**
 * In-process MCP tools given ONLY to an autopilot **planning** session — the interactive
 * "Plan with Claude" session that replaces the old refine chat (see docs/plans/anvil-improvement-program.md).
 *
 * The session opens seeded with the Todoist prompt, the design so far, and any open questions. Once the
 * plan is settled it calls `save_plan` to write the revised plan back to the work unit (un-holding a
 * needs-clarification unit), and — when the user says go — `run_pipeline` to engage the autonomous
 * review→development→testing loop. Handlers close over the session id through `PlanningToolDeps`, the
 * same injection pattern as `team-tools.ts` / `default-tools.ts`.
 */
export interface PlanningToolDeps {
  /** The planning session these tools belong to (scopes every call to its work unit). */
  sessionId: string;
  /** Persist the settled plan onto the work unit (and post it to Todoist). When `ready`, promote a held
   *  (needs-clarification / planning) unit back to `planned` so it's startable. Returns a summary. */
  savePlan(plan: string, ready: boolean): string;
  /** Engage the autonomous dev pipeline (§4 review→dev→test loop) for this unit in a fresh worktree.
   *  Fire-and-forget: returns once the run is launched; progress streams to the Autopilot screen. */
  runPipeline(): string;
  /** Phase B3: lock the expected numbers of ONE CAD part onto the work unit. Always parks a typed owner
   *  card showing exactly the numbers it will lock; resolves with what happened. Absent: not offered. */
  saveCadExpectations?(input: { part: unknown; process: unknown; parameters: unknown; expectations: unknown }): Promise<string>;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export const PLANNING_MCP_SERVER_NAME = "anvil_planning";

/** Tool ids as the SDK exposes them (`mcp__<server>__<tool>`), for the driver allowlist. */
export const PLANNING_TOOL_IDS = ["save_plan", "run_pipeline", "save_cad_expectations"].map((t) => `mcp__${PLANNING_MCP_SERVER_NAME}__${t}`);

const exprSchema = z.union([z.number(), z.string()]);

export function buildPlanningToolsServer(deps: PlanningToolDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: PLANNING_MCP_SERVER_NAME, version: "1.0.0", tools: planningTools(deps) });
}

/** The planning tool definitions (exported so tests can invoke handlers without a live SDK server). */
export function planningTools(deps: PlanningToolDeps): SdkMcpToolDefinition<any>[] {
  return [
    tool(
      "save_plan",
      "Save the settled implementation plan back to this autopilot work unit (and post it as a Todoist " +
        "comment). Call this once you and the user have worked out HOW to build the task — before you start " +
        "implementing, and again if the plan changes materially. Set ready=true once the plan is complete " +
        "and any open questions are answered: that un-holds the card so it can be built. Pass the FULL " +
        "markdown plan each time (it replaces the stored plan, it isn't appended).",
      {
        plan: z.string().min(1).describe("The full, markdown-formatted implementation plan (replaces the stored one)."),
        ready: z
          .boolean()
          .default(true)
          .describe("true = the plan is complete and any open questions are answered (un-holds the card). false = a work-in-progress checkpoint."),
      },
      async ({ plan, ready }) => {
        try {
          return ok(deps.savePlan(plan, ready ?? true));
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    ),
    ...(deps.saveCadExpectations
      ? [
          tool(
            "save_cad_expectations",
            "Lock the expected numbers of ONE CAD part (cad/<part>/) onto this work unit, for the autopilot builder " +
              "that will build it. The owner is ALWAYS shown a card with exactly these numbers and must approve it; " +
              "nothing is saved if they deny. Same rules as record_expectations: `parameters` declares the literal " +
              "value of every parameter a formula uses (e.g. {\"L\": \"80 mm\"}), the expected numbers are fixed from " +
              "those values, tolerances may not be looser than 0.1 mm / 1%. When the builder starts, the daemon writes " +
              "these into cad/<part>/part.json and creates the parameters; the builder cannot change them. Call once per " +
              "part the plan builds or changes; a unit whose plan touches CAD cannot start until every part is approved.",
            {
              part: z.string().describe('The part name, e.g. "plate". Not a path.'),
              process: z.string().describe('The process id from cad/rules.json, e.g. "fdm-0.4".'),
              parameters: z.record(z.string(), z.union([z.string(), z.number()])).describe('Every parameter the formulas use, with its literal value, e.g. {"L": "80 mm", "W": "50 mm"}; {} if all are plain numbers.'),
              expectations: z.object({
                bbox: z.array(exprSchema).length(3),
                volume: exprSchema,
                bodies: z.number().int(),
                holes: z.array(z.object({ diameter: exprSchema, count: z.number().int(), kind: z.enum(["through", "blind"]).optional() })),
                tolerance: z.object({ length: z.number().optional(), volumeRel: z.number().optional() }).optional(),
                noInterferenceWith: z.array(z.string()).optional(),
              }),
            },
            async (a) => {
              try {
                return ok(await deps.saveCadExpectations!(a));
              } catch (e) {
                return fail(e instanceof Error ? e.message : String(e));
              }
            },
          ),
        ]
      : []),
    tool(
      "run_pipeline",
      "Engage the autonomous review→development→testing pipeline for this work unit: it implements the " +
        "saved plan in a fresh worktree with multi-model author/adversary gates and opens a PR. Call this " +
        "when the plan is settled and the user wants it built end-to-end without further hands-on work. " +
        "Save the plan first (save_plan) so the pipeline builds the agreed design.",
      {},
      async () => {
        try {
          return ok(deps.runPipeline());
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    ),
  ];
}
