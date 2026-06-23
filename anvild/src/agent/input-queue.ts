import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * A pushable async-iterable of user messages — the streaming-input prompt for `query()`.
 * Streaming-input mode is required for `canUseTool`, `interrupt`, mid-session `setModel`,
 * and durable multi-turn sessions (arch §2, impl plan 1 §4.4).
 */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.items.push(message);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

export interface InlineAttachment {
  mediaType: string;
  name: string;
  data: string; // base64
}

/** Largest text file we inline into the prompt (bytes). Bigger files would blow the context. */
const MAX_INLINE_TEXT = 256 * 1024;

/** Heuristic: bytes are "text" if they decode as UTF-8 with no NUL bytes. */
function looksTextual(mediaType: string, buf: Buffer): boolean {
  if (mediaType.startsWith("text/")) return true;
  if (/^application\/(json|xml|x-yaml|yaml|javascript)/.test(mediaType)) return true;
  // Unknown/octet-stream: sniff for binary (a NUL byte in the first 8KB is a strong binary signal).
  return !buf.subarray(0, 8192).includes(0);
}

/**
 * Turn one uploaded attachment into an Anthropic content block: images → `image`, PDFs →
 * `document`, anything textual → an inline `text` block holding the file's contents (so the model
 * can actually read code/logs/configs), and a short note for binaries we can't inline. (arch §6.5)
 */
function attachmentBlock(att: InlineAttachment): Record<string, unknown> {
  if (att.mediaType.startsWith("image/")) {
    return { type: "image", source: { type: "base64", media_type: att.mediaType, data: att.data } };
  }
  if (att.mediaType === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: att.data } };
  }
  const buf = Buffer.from(att.data, "base64");
  if (looksTextual(att.mediaType, buf)) {
    const truncated = buf.length > MAX_INLINE_TEXT;
    const body = buf.subarray(0, MAX_INLINE_TEXT).toString("utf8");
    const note = truncated ? `\n…[truncated at ${MAX_INLINE_TEXT} bytes of ${buf.length}]` : "";
    return { type: "text", text: `Attached file "${att.name}":\n\n\`\`\`\n${body}${note}\n\`\`\`` };
  }
  return { type: "text", text: `[Attached file "${att.name}" (${att.mediaType}, ${buf.length} bytes) — binary, not inlined.]` };
}

/** Build an SDK user message: text, plus any uploaded attachments as content blocks (arch §6.5). */
export function userMessage(text: string, attachments: InlineAttachment[] = []): SDKUserMessage {
  const content =
    attachments.length === 0
      ? text
      : [...(text ? [{ type: "text", text }] : []), ...attachments.map(attachmentBlock)];
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: "",
  } as unknown as SDKUserMessage;
}
