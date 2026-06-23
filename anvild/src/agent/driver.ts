import { query, type McpSdkServerConfigWithInstance, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { Model } from "@protocol";
import { InputQueue, userMessage, type InlineAttachment } from "./input-queue";
import { askUserQuestionToolIds, extractResultUsage, extractSessionId, mapMessage } from "./map";
import { buildFileOffer, deliverablePath, maybeTaildrop } from "./file-offer";
import { makePreToolUseHook, type PermissionBroker } from "./permissions";
import { ASK_USER_QUESTION_DIALOG, makeUserDialogHandler, type QuestionBroker } from "./questions";
import type { Session } from "../session/session";
import type { MarkdownRenderer } from "../render/markdown";

/** What a completed turn reports for the rate-limit gauge (arch §3). */
export interface TurnUsage {
  model: Model;
  costUsd: number; // the turn's USD-equivalent cost (informational)
  /** The SDK's `rate_limits` payload (opaque here), or null when unavailable this turn. */
  rateLimits: unknown;
  subscriptionType: string | null; // "max" | "pro" | … | null (API-key / 3P session)
}
/** Called once per completed turn so the supervisor can refresh the shared rate-limit gauge. */
export type ResultRecorder = (usage: TurnUsage) => void;

/**
 * Drives one Claude Code session via the Agent SDK in streaming-input mode (arch §2).
 * One long-lived `query()` for the session's life; pushes user turns into an InputQueue;
 * the consume loop maps `SDKMessage`s → session events. (impl plan 1 §4.4)
 */
export class AgentDriver {
  private readonly input = new InputQueue();
  private q: Query | undefined;

  /** tool_use ids of in-flight AskUserQuestions — their tool.result (answers echo) is dropped. */
  private readonly askQuestionIds = new Set<string>();

  /** Deliverable files written this turn (toolUseId → worktree path), realized into a download
   *  card once the write's tool.result confirms success (UI refinement §8). */
  private readonly pendingOffers = new Map<string, string>();

  constructor(
    private readonly session: Session,
    private readonly renderer: MarkdownRenderer,
    private readonly broker: PermissionBroker,
    private readonly questionBroker: QuestionBroker,
    private readonly env: Record<string, string>,
    private readonly onResult: ResultRecorder,
    /** In-process MCP servers exposed to this session — set ONLY for the default concierge chat (§0.6). */
    private readonly mcpServers?: Record<string, McpSdkServerConfigWithInstance>,
    /** Extra `allowedTools` (the concierge's `mcp__anvil__*` ids) auto-allowed by the SDK layer. */
    private readonly extraAllowedTools?: string[],
  ) {}

  prompt(text: string, attachments: InlineAttachment[] = []): void {
    this.ensureStarted();
    this.session.setStatus("thinking");
    this.input.push(userMessage(text, attachments));
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

  /**
   * Tooling guidance applied to every session: don't pester the user about whether ordinary CLI
   * tools exist — assume they're installed and probe the environment (PATH, `command -v`, package
   * manifests) to find or invoke them. Only surface a question when something genuinely has to be
   * downloaded/installed first, or truly can't be found after looking. (UI refinement §tools)
   */
  private static readonly TOOLING_GUIDANCE =
    `\n\nTOOLING: Assume the command-line tools you need are already installed and discover them in the ` +
    `environment (check PATH with \`command -v\`/\`which\`, look at the project's package manifests / lockfiles, ` +
    `try the obvious invocation) before concluding a tool is missing. Do NOT stop to ask the user whether a ` +
    `common tool is available — just look. Only ask the user when a tool genuinely needs to be installed or ` +
    `downloaded first, or when it truly cannot be found after searching.`;

  /**
   * Keep Claude Code's default system prompt, but for worktree sessions pin it to the worktree
   * so it doesn't wander into the original checkout it can discover via `git worktree list`/docs
   * (which breaks isolation and the sandboxed reader). (arch §5)
   */
  private systemPrompt(): { type: "preset"; preset: "claude_code"; append?: string } {
    const s = this.session.data;
    let append = AgentDriver.TOOLING_GUIDANCE;
    if (s.isDefault) {
      append +=
        "\n\nYOU ARE THE ANVIL CONCIERGE. You are a single, persistent, general-purpose assistant for the " +
        "user's whole Anvil fleet on this machine — NOT scoped to one project. Answer general questions and act " +
        "as mission control across every environment and session.\n\n" +
        "CROSS-SESSION VISIBILITY: Use `mcp__anvil__list_sessions`, `mcp__anvil__get_session`, and " +
        "`mcp__anvil__list_environments` to see the live state of ALL ongoing work — titles, status, model, and " +
        "git branch/dirty/ahead-behind/PR — and to answer 'what's in flight?' style questions. Prefer these tools " +
        "over guessing; the data is live.\n\n" +
        "HANDOFF: When the user wants real work done in a project, use `mcp__anvil__create_session` to spin up a " +
        "fresh-worktree session in the right environment (call `mcp__anvil__list_environments` first to choose), " +
        "passing a clear, self-contained `brief` as the first instruction. That session starts working immediately " +
        "and independently — confirm which session you started and what you asked it to do, then let it run. Do NOT " +
        "do heavy project edits yourself from here; hand off instead.\n\n" +
        "Your working directory is the user's home directory; treat it as scratch space, not a project repo.";
      return { type: "preset", preset: "claude_code", append };
    }
    if (s.source === "fresh-worktree") {
      const where = s.worktree ? ` (branch "${s.worktree.branch}", based on "${s.worktree.base}")` : "";
      append +=
        `\n\nWORKING DIRECTORY: You are operating inside an isolated git worktree at "${s.cwd}"${where}. ` +
        `This worktree is your ONLY workspace and already contains the full checkout. Always read, search, and edit files ` +
        `within this directory (use relative paths, or absolute paths under it). NEVER read from or write to the original ` +
        `repository checkout or any absolute path outside this worktree — even if you discover its location via ` +
        "`git worktree list`, git metadata, or documentation. All work for this task must stay in this worktree so it can be reviewed as a branch.";
    }
    return { type: "preset", preset: "claude_code", append };
  }

  private ensureStarted(): void {
    if (this.q) return;
    const s = this.session;
    this.q = query({
      prompt: this.input,
      options: {
        model: s.data.model, // "opus" | "sonnet" — Claude Code accepts the aliases
        cwd: s.data.cwd,
        systemPrompt: this.systemPrompt(),
        resume: s.data.claudeSessionId,
        includePartialMessages: true,
        permissionMode: "default",
        // Load NO on-disk settings, so the daemon — not the user's ambient Claude Code
        // allow-rules — is the permission authority (arch §6.6). (Trade-off: the repo's
        // CLAUDE.md isn't auto-loaded; project context can be injected later.)
        settingSources: [],
        // PreToolUse fires on EVERY tool → the autonomy policy + danger list govern all
        // tools, and a blocked prompt parks here (timeout high enough to answer from a
        // phone). This is the authoritative gate (M7); canUseTool alone only sees ops the
        // CLI already flags.
        hooks: {
          PreToolUse: [{ hooks: [makePreToolUseHook(s, this.broker)], timeout: 3600 }],
        },
        // AskUserQuestion arrives as a request_user_dialog control request, not a tool result.
        // We must BOTH provide onUserDialog AND declare the dialog kind — the SDK fails closed
        // (degrades to "user did not answer") without the kind in supportedDialogKinds. (§6.6)
        onUserDialog: makeUserDialogHandler(s, this.questionBroker),
        supportedDialogKinds: [ASK_USER_QUESTION_DIALOG],
        executable: "bun",
        env: this.env, // §3 allow-list; no ANTHROPIC_API_KEY
        ...(this.mcpServers ? { mcpServers: this.mcpServers } : {}),
        ...(this.extraAllowedTools ? { allowedTools: this.extraAllowedTools } : {}),
      },
    });
    void this.consume();
  }

  /** Realize a deliverable write into a download card (and Taildrop it if configured). */
  private async offerFile(rawPath: string): Promise<void> {
    const s = this.session;
    const offer = buildFileOffer(s.id, s.data.cwd, rawPath);
    if (!offer) return;
    try {
      offer.taildropped = await maybeTaildrop(offer.path);
    } catch {
      /* Taildrop is best-effort — the in-chat download card is the reliable path */
    }
    s.emit({ type: "file.offer", file: offer });
  }

  private async consume(): Promise<void> {
    if (!this.q) return;
    try {
      for await (const m of this.q) {
        const sid = extractSessionId(m);
        if (sid) this.session.data.claudeSessionId = sid;

        for (const id of askUserQuestionToolIds(m)) this.askQuestionIds.add(id);
        // Stash the assistant's prose so a "your turn" push can quote it (real context, not a
        // generic "Finished"). Cheap: read text blocks straight off the SDK message.
        if (m.type === "assistant") {
          const text = ((m as any).message?.content ?? [])
            .filter((b: any) => b?.type === "text" && typeof b.text === "string")
            .map((b: any) => b.text as string)
            .join(" ")
            .trim();
          if (text) this.session.lastAssistantText = text;
        }
        const bodies = mapMessage(m, this.renderer);
        let sawToolUse = false;
        let sawToolResult = false;
        for (const body of bodies) {
          // Drop the AskUserQuestion tool.result (the answers echo) — the question card already
          // shows the user's choice; the raw result would just re-dump the answers as JSON.
          if (body.type === "tool.result" && this.askQuestionIds.delete(body.toolUseId)) continue;
          if (body.type === "tool.use") {
            sawToolUse = true;
            const p = deliverablePath(body.name, body.input);
            if (p) this.pendingOffers.set(body.toolUseId, p);
          }
          if (body.type === "tool.result") sawToolResult = true;
          this.session.emit(body);
          // A successful write of a deliverable file → surface it as a download card.
          if (body.type === "tool.result" && this.pendingOffers.has(body.toolUseId)) {
            const path = this.pendingOffers.get(body.toolUseId)!;
            this.pendingOffers.delete(body.toolUseId);
            if (!body.isError) void this.offerFile(path);
          }
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
          const costUsd = Number((m as any).total_cost_usd ?? 0);
          // Read the plan's real rate-limit windows (the same numbers as claude.ai → Usage). This
          // is the authoritative budget signal for an OAuth subscription. The endpoint is flagged
          // experimental by the SDK, so tolerate it being absent or throwing.
          let rateLimits: unknown = null;
          let subscriptionType: string | null = null;
          try {
            const u = await this.q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
            if (u?.rate_limits_available) rateLimits = u.rate_limits;
            subscriptionType = u?.subscription_type ?? null;
          } catch {
            /* experimental usage endpoint unavailable — keep the last-known gauge */
          }
          this.onResult({ model: this.session.data.model, costUsd, rateLimits, subscriptionType });
          this.session.setStatus("idle");
        }
      }
    } catch (e) {
      this.session.emitError(e instanceof Error ? e.message : String(e), false);
    }
  }
}
