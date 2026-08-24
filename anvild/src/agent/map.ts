import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlock, Usage } from "@protocol";
import type { SessionEventBody } from "../session/session";
import type { MarkdownRenderer } from "../render/markdown";

/** Handled via the question card (canUseTool), not the normal tool_use/tool.result path. */
const ASK_USER_QUESTION = "AskUserQuestion";

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
