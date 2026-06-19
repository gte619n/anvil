import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlock, Usage } from "@protocol";
import type { SessionEventBody } from "../session/session";
import type { MarkdownRenderer } from "../render/markdown";

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
          blocks.push({ kind: "tool_use", toolUseId: b.id, name: b.name, input: b.input });
          toolUses.push({ type: "tool.use", toolUseId: b.id, name: b.name, input: b.input });
        }
      }
      return [{ type: "assistant.message", blocks }, ...toolUses];
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
  if (Array.isArray(c)) return c.map((b: any) => (typeof b?.text === "string" ? b.text : JSON.stringify(b))).join("");
  return c == null ? "" : JSON.stringify(c);
}
