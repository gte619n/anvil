import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Session as SessionData } from "@protocol";
import type { PartsFetchOutcome, PartsSearchOutcome } from "../integrations/parts/service";

/**
 * The part-source tools (agent-cad-and-browser §4.12 "Part sources", Phase C5): the in-process server
 * `anvil_parts` with `parts_search` and `parts_fetch`, given to ordinary sessions while at least one
 * source is configured. The work is `integrations/parts/`; this file is the tool surface only.
 *
 * Permission: neither tool has an `allowedTools` entry (spec §6: integration tools never do), so
 * both go through the PreToolUse hook. `parts_search` is in the autonomy policy's read-only set
 * (`danger-list.ts`), so the hook allows it without a prompt under every policy but `prompt-all`;
 * `parts_fetch` writes into the worktree's quarantine, so the hook decides it as an ordinary write
 * under the session's autonomy policy. If the hook ever fails, the `canUseTool` backstop denies both.
 */

export const PARTS_MCP_SERVER_NAME = "anvil_parts";
export const PARTS_SEARCH_TOOL_ID = `mcp__${PARTS_MCP_SERVER_NAME}__parts_search`;
export const PARTS_FETCH_TOOL_ID = `mcp__${PARTS_MCP_SERVER_NAME}__parts_fetch`;

/** What a session with these tools gets in its system prompt (see `browserSessionPrompt`). */
export const PARTS_SESSION_PROMPT =
  ` For electronic or mechanical part data (datasheets, stock, CAD/STEP models), call \`${PARTS_SEARCH_TOOL_ID}\` ` +
  `before using the browser, and \`${PARTS_FETCH_TOOL_ID}\` to download a datasheet or model link it returned ` +
  `(it lands in \`.anvil-downloads/\`). When you show part results, show each one's attribution with it.`;

export interface PartsSession {
  id: string;
  data: SessionData;
}

/** What the tools drive. `PartsService` satisfies it. */
export interface PartsControl {
  search(sessionId: string, query: unknown, opts: { sources?: unknown; limit?: unknown; manufacturer?: unknown }): Promise<PartsSearchOutcome>;
  fetch(session: { id: string; cwd: string }, url: unknown): Promise<PartsFetchOutcome>;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

export function partsTools(control: PartsControl, session: PartsSession): SdkMcpToolDefinition<any>[] {
  return [
    tool(
      "parts_search",
      "Search the configured part sources (DigiKey, Mouser, TraceParts) for a part: manufacturer, part number, " +
        "description, datasheet URL, model (STEP) URLs, product page and stock, each with its source's attribution. " +
        "Sources without a key are skipped with a note; one source failing does not fail the search. " +
        "TraceParts (STEP models) looks up part numbers per manufacturer: give `manufacturer` when the query is a part number.",
      {
        query: z.string().describe("Keywords or a manufacturer part number"),
        sources: z.array(z.enum(["digikey", "mouser", "traceparts"])).optional().describe("Only these sources (default: every configured one)"),
        limit: z.number().int().min(1).max(20).optional().describe("Results per source (default 5)"),
        manufacturer: z.string().optional().describe("The manufacturer whose part number the query is"),
      },
      async (args) => {
        try {
          const out = await control.search(session.id, args.query, { sources: args.sources, limit: args.limit, manufacturer: args.manufacturer });
          const body = JSON.stringify({ results: out.results, notes: out.notes }, null, 1);
          const lead = out.results.length ? `${out.results.length} result(s). Show each result's attribution with it.` : "No results.";
          return text(`${lead}\n${body}`);
        } catch (e) {
          return text(e instanceof Error ? e.message : String(e), true);
        }
      },
    ),
    tool(
      "parts_fetch",
      "Download a datasheet or model file that parts_search returned in this session (https only) into the worktree's " +
        "download quarantine `.anvil-downloads/`, under the same limits as browser downloads (200 MB; step stp iges igs 3mf " +
        "stl pdf zip png jpg jpeg csv json txt). Any other URL is refused: this is not a general fetcher.",
      { url: z.string().describe("A datasheetUrl or modelUrls[].url from a parts_search result") },
      async (args) => {
        const out = await control.fetch({ id: session.id, cwd: session.data.cwd }, args.url);
        if (!out.ok) return text(`parts_fetch refused or failed: ${out.error}`, true);
        return text(`Saved ${out.kept} (${out.size} bytes) from ${out.from}. It is in quarantine: never run it; copy it out deliberately to use it.`);
      },
    ),
  ];
}

export function buildPartsToolsServer(control: PartsControl, session: PartsSession): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: PARTS_MCP_SERVER_NAME, version: "1.0.0", tools: partsTools(control, session) });
}
