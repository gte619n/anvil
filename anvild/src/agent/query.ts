import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { buildAgentEnv } from "./env";
import { makePipelineGuardHook } from "./pipeline-guard";
import type { ModelSpec } from "./model-roster";
import type { AccountStore } from "../auth/accounts";

/**
 * The dual-model Agent SDK primitive. Any pipeline phase drives EITHER model through this one path:
 * the `ModelSpec` selects both the SDK `model` id and the env profile (Claude subscription vs GLM over
 * OpenRouter's Anthropic Skin — see agent/env.ts). This is the generalized successor to autopilot.ts's
 * private `runQuery`, which is Claude-only; the pipeline uses this so authorship can flip by phase.
 *
 * `readonly` uses plan mode (reads/greps allowed, edits blocked): the model delivers its plan via an
 * `ExitPlanMode` tool call, so `plan` captures that input and `text` captures the closing message.
 * Write phases (Implementation, adversarial test-gen) run with `readonly: false`.
 */
export interface AgentQueryResult {
  text: string;
  plan?: string;
}

/** Minimal shape of the SDK's `query` we depend on — injectable so tests don't spawn a subprocess. */
export type QueryLike = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<unknown>;

export async function runAgentQuery(
  prompt: string,
  opts: {
    model: ModelSpec;
    cwd?: string;
    readonly?: boolean;
    signal?: AbortSignal;
    queryFn?: QueryLike;
    /** The Claude account roster + which account this run bills to (multi-account §6). Absent ⇒ the
     *  pre-roster env-var path. */
    accounts?: AccountStore;
    accountId?: string;
    /** Fired once per tool the model invokes (Read/Grep/Glob/…), so a caller can stream the run's real
     *  activity as it happens. `tool` is the SDK tool name; `detail` is a short target (a path/pattern). */
    onStep?: (step: { tool: string; detail: string }) => void;
  },
): Promise<AgentQueryResult> {
  // Bridge the run-level signal to the SDK's AbortController so a cancelled/timed-out run tears down the
  // subprocess instead of leaving it spinning.
  const ac = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  const run = opts.queryFn ?? (sdkQuery as unknown as QueryLike);
  const q = run({
    prompt,
    options: {
      model: opts.model.sdkModel,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      permissionMode: opts.readonly ? "plan" : "default",
      settingSources: [], // the daemon is the authority; don't load ambient Claude Code config
      // [SEC-H4] Unattended runs have no human to prompt, so gate EVERY tool through the danger list
      // and hard-deny anything it flags. Write phases (readonly:false) otherwise ran a third-party
      // model with Write/Edit/Bash and no backstop; readonly phases keep this too (cheap, and reads
      // that touch secret paths are still denied). 3600s timeout matches the interactive gate.
      hooks: {
        PreToolUse: [{ hooks: [makePipelineGuardHook(opts.cwd)], timeout: 3600 }],
      },
      executable: "bun",
      abortController: ac,
      // Built per-call from the model's profile so the right provider/token drives this spawn, and so a
      // key set/reset via the UI reaches the next run without a daemon restart.
      env: buildAgentEnv({ profile: opts.model.profile, accounts: opts.accounts, accountId: opts.accountId }),
    },
  });

  let text = "";
  let plan: string | undefined;
  for await (const raw of q) {
    const msg = raw as { type?: string; message?: { content?: unknown[] }; result?: unknown };
    if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
        if (block.type === "tool_use" && block.name === "ExitPlanMode") {
          const p = block.input?.plan;
          if (typeof p === "string" && p.trim()) plan = p.trim();
        } else if (block.type === "tool_use" && block.name && opts.onStep) {
          opts.onStep({ tool: block.name, detail: toolDetail(block.input) });
        }
      }
    }
    if (msg.type === "result" && typeof msg.result === "string") text = msg.result;
  }
  return { text: text.trim(), ...(plan ? { plan } : {}) };
}

/** Best-effort one-liner for what a tool call is targeting (a path/pattern), for progress streaming. */
function toolDetail(input?: Record<string, unknown>): string {
  if (!input) return "";
  const pick = input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.query ?? input.url;
  return typeof pick === "string" ? pick : "";
}
