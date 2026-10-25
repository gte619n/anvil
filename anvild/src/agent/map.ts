import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlock, Usage } from "@protocol";
import type { SessionEventBody } from "../session/session";
import type { SubAgentSignal } from "./subagents";
import type { MarkdownRenderer } from "../render/markdown";

/** Handled via the question card (canUseTool), not the normal tool_use/tool.result path. */
const ASK_USER_QUESTION = "AskUserQuestion";

/** The sub-agent launcher tool: the SDK names it "Agent"; older CLIs used "Task" (see supervisor.ts). */
const AGENT_TOOLS = new Set(["Agent", "Task"]);
/** Main-turn shell tools whose background runs are tracked as rows (§sub-agents, background shell). */
const SHELL_TOOLS = new Set(["Bash", "Monitor"]);
/** The launching message's `parent_tool_use_id` (null on the main turn, an ancestor id when nested). */
const parentToolUseId = (m: SDKMessage): string | null => (m as any).parent_tool_use_id ?? null;

/** The ids of any AskUserQuestion tool_use blocks in this message — so the driver can drop the
 *  matching tool.result (the answers echo), keeping all SDK-shape knowledge in this module. */
export function askUserQuestionToolIds(m: SDKMessage): string[] {
  if (m.type !== "assistant") return [];
  const content: any[] = (m as any).message?.content ?? [];
  return content.filter((b) => b?.type === "tool_use" && b.name === ASK_USER_QUESTION).map((b) => b.id as string);
}

/**
 * Pure translator: one `SDKMessage` → the session-scoped events to emit (arch §6.2).
 * This is the SDK-drift containment point — keep all SDK-shape knowledge here and
 * fixture-test it offline (test/unit/map.test.ts).
 */
export function mapMessage(m: SDKMessage, renderer: MarkdownRenderer): SessionEventBody[] {
  switch (m.type) {
    case "stream_event": {
      const ev = (m as any).event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        return [{ type: "assistant.delta", text: ev.delta.text }];
      }
      return [];
    }

    case "assistant": {
      // A sub-agent's INTERNAL messages carry `parent_tool_use_id` (ID1). Suppress them from the normal
      // conversation flow — otherwise a sub-agent's tool churn flattens indistinguishably into the parent's
      // activity block (today's bug). Their signal lives on `subAgentSignals` → the sub-agent tracker instead.
      if (parentToolUseId(m) != null) return [];
      const content: any[] = (m as any).message?.content ?? [];
      const blocks: ContentBlock[] = [];
      const toolUses: SessionEventBody[] = [];
      for (const b of content) {
        if (b?.type === "text" && typeof b.text === "string") {
          blocks.push({ kind: "markdown", rendered: renderer.render(b.text) });
        } else if (b?.type === "tool_use") {
          // AskUserQuestion is rendered as an interactive question card (driven by the
          // question.request event), not as a tool block — suppress its raw tool_use here so
          // the transcript doesn't also dump the questions JSON. (arch §6.6)
          if (b.name === ASK_USER_QUESTION) continue;
          blocks.push({ kind: "tool_use", toolUseId: b.id, name: b.name, input: b.input });
          toolUses.push({ type: "tool.use", toolUseId: b.id, name: b.name, input: b.input });
        }
      }
      // Skip an assistant.message that held only an AskUserQuestion (now empty) so the client
      // doesn't render a blank bubble.
      const events: SessionEventBody[] = blocks.length ? [{ type: "assistant.message", blocks }] : [];
      return [...events, ...toolUses];
    }

    case "user": {
      // Sub-agent tool_results (parent_tool_use_id set) are suppressed like the assistant side (ID1) —
      // the main-turn Task tool_result (parent null) is the durable sub-agent completion, handled in the driver.
      if (parentToolUseId(m) != null) return [];
      const content = (m as any).message?.content;
      if (!Array.isArray(content)) return [];
      const out: SessionEventBody[] = [];
      for (const b of content) {
        if (b?.type === "tool_result") {
          out.push({
            type: "tool.result",
            toolUseId: b.tool_use_id,
            content: stringifyContent(b.content),
            isError: Boolean(b.is_error),
          });
        }
      }
      return out;
    }

    case "result": {
      const r = m as any;
      return [{ type: "result", stopReason: r.stop_reason ?? r.subtype ?? "end_turn", usage: resultUsage(r) }];
    }

    default:
      return [];
  }
}

/**
 * Extract the sub-agent tracker signals from one `SDKMessage` (§sub-agents, ID2/ID3/ID7/ID8). The
 * SECOND SDK-shape seam alongside `mapMessage` — all knowledge of `parent_tool_use_id`, the
 * `Agent`/`Task` launcher, and `task_progress` lives here and is fixture-tested offline. Returns []
 * for anything sub-agents don't care about (the common case), so the driver can call it on every message.
 */
export function subAgentSignals(m: SDKMessage): SubAgentSignal[] {
  const out: SubAgentSignal[] = [];
  if (m.type === "assistant") {
    const parent = parentToolUseId(m);
    const content: any[] = (m as any).message?.content ?? [];
    for (const b of content) {
      if (b?.type !== "tool_use") continue;
      if (AGENT_TOOLS.has(b.name)) {
        // A sub-agent launch — main-turn (parent null → new row) or nested (parent set → rolled up, ID7).
        const input = (b.input ?? {}) as Record<string, unknown>;
        out.push({
          kind: "start",
          taskId: b.id,
          launchedBy: parent,
          type: typeof input.subagent_type === "string" ? input.subagent_type : undefined,
          label: typeof input.description === "string" ? input.description : undefined,
          ...(input.run_in_background === true ? { background: true } : {}),
        });
      } else if (parent != null) {
        // A (non-Task) tool the sub-agent is running → a step on it, and its current tool.
        out.push({ kind: "step", parent, tool: typeof b.name === "string" ? b.name : undefined });
      } else if (SHELL_TOOLS.has(b.name)) {
        // A main-turn shell command — a candidate background task (a CI watcher, a long build). It becomes
        // a row only if its tool.result says it went to the background (asyncLaunchedToolIds).
        const input = (b.input ?? {}) as Record<string, unknown>;
        const label = [input.description, input.command].find((x): x is string => typeof x === "string" && x.trim().length > 0);
        out.push({ kind: "shell_use", taskId: b.id, tool: b.name, ...(label ? { label: label.length > 80 ? `${label.slice(0, 79)}…` : label } : {}) });
      }
    }
    // Message-level metadata the SDK stamps on sub-agent messages (best label/type source).
    if (parent != null) {
      const type = (m as any).subagent_type;
      const label = (m as any).task_description;
      if (typeof type === "string" || typeof label === "string") {
        out.push({ kind: "meta", parent, type: typeof type === "string" ? type : undefined, label: typeof label === "string" ? label : undefined });
      }
    }
  } else if (m.type === "user") {
    const parent = parentToolUseId(m);
    if (parent != null) {
      const content = (m as any).message?.content;
      if (Array.isArray(content)) {
        for (const b of content) if (b?.type === "tool_result") out.push({ kind: "step_done", parent });
      }
    }
  } else if (m.type === "system" && (m as any).subtype === "task_progress") {
    // SDKTaskProgressMessage — a rich per-agent heartbeat overlay (ID8). Keyed by the Task tool_use id.
    const p = m as any;
    const taskId = typeof p.tool_use_id === "string" ? p.tool_use_id : undefined;
    if (taskId) {
      const dur = p.usage?.duration_ms;
      out.push({
        kind: "progress",
        taskId,
        type: typeof p.subagent_type === "string" ? p.subagent_type : undefined,
        label: typeof p.description === "string" ? p.description : undefined,
        steps: typeof p.usage?.tool_uses === "number" ? p.usage.tool_uses : undefined,
        currentTool: typeof p.last_tool_name === "string" ? p.last_tool_name : undefined,
        elapsedSeconds: typeof dur === "number" ? Math.round(dur / 1000) : undefined,
      });
    }
  } else if (m.type === "system" && (m as any).subtype === "task_started") {
    // SDKTaskStartedMessage — binds the CLI's task id to the launching tool_use id.
    const p = m as any;
    if (typeof p.task_id === "string" && typeof p.tool_use_id === "string") out.push({ kind: "task", taskId: p.tool_use_id, sdkTaskId: p.task_id });
  } else if (m.type === "system" && (m as any).subtype === "task_updated") {
    // SDKTaskUpdatedMessage — a patch keyed only by the CLI's task id.
    const p = m as any;
    const sdkTaskId = typeof p.task_id === "string" ? p.task_id : undefined;
    const patch = p.patch ?? {};
    if (sdkTaskId && patch.is_backgrounded === true) out.push({ kind: "backgrounded", sdkTaskId });
    const st = patch.status;
    if (sdkTaskId && (st === "completed" || st === "failed" || st === "killed")) {
      out.push({ kind: "settle", sdkTaskId, status: st === "killed" ? "stopped" : st, ...(typeof patch.error === "string" ? { error: patch.error } : {}) });
    }
  } else if (m.type === "system" && (m as any).subtype === "task_notification") {
    // SDKTaskNotificationMessage — the CLI's authoritative "this task ended" (the ONLY end signal a
    // background sub-agent gets; its tool.result was the instant launch ack).
    const p = m as any;
    const st = p.status;
    if (st === "completed" || st === "failed" || st === "stopped") {
      out.push({
        kind: "settle",
        ...(typeof p.tool_use_id === "string" ? { taskId: p.tool_use_id } : {}),
        ...(typeof p.task_id === "string" ? { sdkTaskId: p.task_id } : {}),
        status: st,
        ...(st === "failed" && typeof p.summary === "string" && p.summary ? { error: p.summary } : {}),
      });
    }
  }
  return out;
}

/** Whether `m` is main-thread activity that can only mean a turn is underway: an assistant message or
 *  stream frame with no `parent_tool_use_id`, or the CLI's own `session_state_changed: running`. Used
 *  to catch a turn the CLI starts ON ITS OWN — after a background sub-agent's task_notification — which
 *  never passes through `prompt()`, so nothing else would flip the session out of idle. */
export function signalsTurnActivity(m: SDKMessage): boolean {
  if (m.type === "system") return (m as any).subtype === "session_state_changed" && (m as any).state === "running";
  return (m.type === "assistant" || m.type === "stream_event") && parentToolUseId(m) == null;
}

/** Tool results that are a BACKGROUND launch ack, not the work's end (§sub-agents, background):
 *  - an `Agent`/`Task` launched in the background (at launch via `run_in_background`, or backgrounded
 *    mid-run) — structured `tool_use_result.status: "async_launched"`, else the ack's fixed wording;
 *  - a shell command running in the background (`Bash` with `run_in_background`, or backgrounded
 *    mid-run) — structured `tool_use_result.backgroundTaskId`, else the CLI's "running in background"
 *    trailer (appended after any output, so matched anywhere). (`Monitor` is always background — the
 *    tracker knows that from the tool name, see SubAgentTracker.finish.)
 *  Callers only act on ids they track, so a stray match on an unrelated tool is inert. */
const ASYNC_ACK = /^(Async agent launched successfully|Cloud agent launched)\b/;
const SHELL_BG = /Command running in background with ID:|Command was manually backgrounded by user with ID:/;
export function asyncLaunchedToolIds(m: SDKMessage): Set<string> {
  const out = new Set<string>();
  if (m.type !== "user" || parentToolUseId(m) != null) return out;
  const content = (m as any).message?.content;
  if (!Array.isArray(content)) return out;
  const r = (m as any).tool_use_result;
  const structured =
    r && typeof r === "object" && (r.status === "async_launched" || r.status === "remote_launched" || r.isAsync === true || (typeof r.backgroundTaskId === "string" && r.backgroundTaskId.length > 0));
  for (const b of content) {
    if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string" || b.is_error) continue;
    const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("") : "";
    if (structured || ASYNC_ACK.test(text.trimStart()) || SHELL_BG.test(text)) out.add(b.tool_use_id);
  }
  return out;
}

/** A base64 image block pulled off a tool_result, awaiting persistence by the driver. */
export interface ExtractedToolImage {
  mediaType: string;
  dataBase64: string;
}

/**
 * Image blocks carried in this message's tool_results, grouped by tool_use id (SDK-shape knowledge
 * stays here, mirroring {@link askUserQuestionToolIds}). A tool that returns a screenshot — Read on
 * an image, a Playwright/Puppeteer capture, any MCP screenshot tool — delivers it as a base64 image
 * block. The driver persists these as attachments and stitches the ids onto the matching tool.result
 * event; we deliberately keep the base64 OUT of the emitted/persisted event (it would bloat the log).
 */
export function toolResultImages(m: SDKMessage): { toolUseId: string; images: ExtractedToolImage[] }[] {
  if (m.type !== "user") return [];
  const content = (m as any).message?.content;
  if (!Array.isArray(content)) return [];
  const out: { toolUseId: string; images: ExtractedToolImage[] }[] = [];
  for (const b of content) {
    if (b?.type !== "tool_result" || !Array.isArray(b.content)) continue;
    const images: ExtractedToolImage[] = [];
    for (const c of b.content) {
      if (c?.type === "image" && c.source?.type === "base64" && typeof c.source.data === "string") {
        images.push({ mediaType: typeof c.source.media_type === "string" ? c.source.media_type : "image/png", dataBase64: c.source.data });
      }
    }
    if (images.length) out.push({ toolUseId: b.tool_use_id, images });
  }
  return out;
}

/** The SDK session id (used as `claudeSessionId` for resume). */
export function extractSessionId(m: SDKMessage): string | undefined {
  const sid = (m as any).session_id;
  return typeof sid === "string" && sid.length > 0 ? sid : undefined;
}

export function extractResultUsage(m: SDKMessage): Usage | undefined {
  if (m.type !== "result") return undefined;
  return resultUsage(m as any);
}

function resultUsage(r: any): Usage {
  return {
    inputTokens: r.usage?.input_tokens ?? 0,
    outputTokens: r.usage?.output_tokens ?? 0,
    turns: r.num_turns ?? 1,
  };
}

function stringifyContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((b: any) => {
        if (typeof b?.text === "string") return b.text;
        // Image blocks are surfaced as inline thumbnails (see toolResultImages) — never dump the
        // base64 into the text body, or a screenshot becomes a megabyte of gibberish in the transcript.
        if (b?.type === "image") return "";
        return JSON.stringify(b);
      })
      .join("");
  return c == null ? "" : JSON.stringify(c);
}
