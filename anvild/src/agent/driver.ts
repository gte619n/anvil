import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { InputQueue, userMessage } from "./input-queue";
import { extractResultUsage, extractSessionId, mapMessage } from "./map";
import { makeCanUseTool, type PermissionBroker } from "./permissions";
import type { Session } from "../session/session";
import type { MarkdownRenderer } from "../render/markdown";

/**
 * Drives one Claude Code session via the Agent SDK in streaming-input mode (arch §2).
 * One long-lived `query()` for the session's life; pushes user turns into an InputQueue;
 * the consume loop maps `SDKMessage`s → session events. (impl plan 1 §4.4)
 */
export class AgentDriver {
  private readonly input = new InputQueue();
  private q: Query | undefined;

  constructor(
    private readonly session: Session,
    private readonly renderer: MarkdownRenderer,
    private readonly broker: PermissionBroker,
    private readonly env: Record<string, string>,
  ) {}

  prompt(text: string): void {
    this.ensureStarted();
    this.session.setStatus("thinking");
    this.input.push(userMessage(text));
  }

  async interrupt(): Promise<void> {
    try {
      await this.q?.interrupt();
    } catch {
      /* nothing in flight */
    }
  }

  async setModel(model: string): Promise<void> {
    try {
      await this.q?.setModel(model);
    } catch {
      /* not started yet — picked up at next start */
    }
  }

  async stop(): Promise<void> {
    this.input.close();
    await this.interrupt();
    this.q = undefined;
  }

  private ensureStarted(): void {
    if (this.q) return;
    const s = this.session;
    this.q = query({
      prompt: this.input,
      options: {
        model: s.data.model, // "opus" | "sonnet" — Claude Code accepts the aliases
        cwd: s.data.cwd,
        resume: s.data.claudeSessionId,
        includePartialMessages: true,
        permissionMode: "default",
        // Load NO on-disk settings, so the daemon — not the user's ambient Claude Code
        // allow-rules — is the permission authority. This is what makes the autonomy
        // policy + danger list (arch §6.6) actually govern every tool. (Trade-off: the
        // repo's CLAUDE.md isn't auto-loaded; project context can be injected later.)
        settingSources: [],
        canUseTool: makeCanUseTool(s, this.broker),
        executable: "bun",
        env: this.env, // §3 allow-list; no ANTHROPIC_API_KEY
      },
    });
    void this.consume();
  }

  private async consume(): Promise<void> {
    if (!this.q) return;
    try {
      for await (const m of this.q) {
        const sid = extractSessionId(m);
        if (sid) this.session.data.claudeSessionId = sid;

        const bodies = mapMessage(m, this.renderer);
        let sawToolUse = false;
        let sawToolResult = false;
        for (const body of bodies) {
          if (body.type === "tool.use") sawToolUse = true;
          if (body.type === "tool.result") sawToolResult = true;
          this.session.emit(body);
        }
        if (sawToolUse) this.session.setStatus("running_tool");
        if (sawToolResult) this.session.setStatus("thinking");

        if (m.type === "result") {
          const usage = extractResultUsage(m);
          if (usage) {
            this.session.data.usage.inputTokens += usage.inputTokens;
            this.session.data.usage.outputTokens += usage.outputTokens;
            this.session.data.usage.turns += usage.turns;
          }
          this.session.setStatus("idle");
        }
      }
    } catch (e) {
      this.session.emitError(e instanceof Error ? e.message : String(e), false);
    }
  }
}
