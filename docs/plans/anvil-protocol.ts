/**
 * Anvil wire protocol — shared contract between `anvild` (daemon) and all clients.
 *
 * Status: 0.5-draft (2026-06-20). Companion to `anvil-native-architecture.md` (§6, §8).
 *   0.5: git lifecycle — `git` command (status/diff/commit/push/create-pr/merge-pr) +
 *        git.result event; session.archive/unarchive + Session.archived.
 *   0.4: added Environment registry — environments event + env.list/env.add/env.remove,
 *        Session/SessionCreateCmd.environmentId. Pick an environment + name → fresh worktree.
 *   0.3: added dirs.list/dirs.list.result (browse the host FS to pick a cwd/repoRoot at
 *        session-create time) + DirEntry.isRepo.
 *   0.2: added fs.list.result/fs.read.result (typed responses), push.unregister,
 *        FileContent.truncated + FsReadCmd.range, and the terminal-seq/log clarification —
 *        gaps surfaced by the implementation plans (anvil-impl-4/6).
 * This is the single source of truth for the WebSocket message shapes. The daemon
 * (TS/Bun) imports it directly; native clients (SwiftUI/Compose) mirror it by hand or
 * via codegen. When this file and the architecture doc disagree, fix one of them — they
 * are meant to stay in lockstep.
 *
 * Transport: one WebSocket per client connection carrying a versioned, per-session
 * SEQUENCED event stream (§6.1/§6.4). Bulk attachment upload is a side REST endpoint
 * (§6.5) — see `rest` namespace at the bottom.
 *
 * Conventions:
 *  - Every message is an envelope discriminated on `type`.
 *  - Server→client *session* events carry `sessionId` + monotonic `seq` (resume backbone).
 *  - Client→server commands may carry `cid` (correlation id) to match an `ack`/`command.error`.
 *  - Markdown is rendered to sanitized HTML by the daemon (§8.3); see `RenderedMarkdown`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 0. Primitives
// ─────────────────────────────────────────────────────────────────────────────

export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** ISO 8601 timestamp, always UTC, e.g. "2026-06-19T14:03:00.000Z". */
export type Iso8601 = string;

// Opaque id aliases (documentation only; all are strings on the wire).
export type SessionId = string; // server-assigned, stable for the session's life
export type Seq = number; // per-session monotonic, starts at 1
export type RequestId = string; // permission request id
export type ToolUseId = string; // matches a tool_use block to its result
export type AttachmentId = string; // returned by the REST upload endpoint
export type Cid = string; // client-chosen correlation id for a command

/** Base envelope shared by every message in both directions. */
export interface Envelope {
  v: ProtocolVersion;
  type: string;
  ts: Iso8601;
}

/** Mixed into every server→client message that belongs to a session. */
export interface SessionScoped {
  sessionId: SessionId;
  seq: Seq;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Domain types (§5)
// ─────────────────────────────────────────────────────────────────────────────

export type Model = "opus" | "sonnet";

export type AutonomyPolicy =
  | "mostly-autonomous" // default: auto-allow; prompt only on the danger list (§6.6)
  | "allowlist" // auto-allow reads/searches/safe cmds; prompt for writes/net
  | "prompt-all" // ask on every tool use
  | "bypass"; // DANGER: never prompt — allow every tool, incl. the danger list
  //           (the daemon equivalent of `claude --dangerously-skip-permissions`)

export type SessionSource = "existing-dir" | "fresh-worktree";

export type SessionStatus =
  | "idle" // waiting for user input
  | "thinking" // model generating
  | "running_tool" // a tool_use is executing
  | "awaiting_permission" // blocked on a permission decision
  | "awaiting_question" // blocked on an AskUserQuestion answer (§6.6)
  | "error"
  | "exited"; // process gone

export interface Worktree {
  repoRoot: string;
  branch: string;
  base: string; // branch/commit it was created from
}

/**
 * A registered project repo (arch §8). Pick an environment + name a session → the daemon
 * spins up a fresh git worktree off `repoRoot` and starts a session there.
 */
export interface Environment {
  id: string;
  name: string; // display name, e.g. "OXOS Bots"
  repoRoot: string; // absolute path
  isRepo: boolean; // git repo → fresh worktree per session; otherwise work in the folder directly
  defaultBase?: string; // branch/commit to branch worktrees from (default "HEAD")
}

/** Live git state for the worktree panel (§8); pushed via `session.updated`. */
export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  dirtyFileCount: number;
  /** Short diffstat lines, e.g. "src/foo.ts | 12 +++--". */
  diffstat: string[];
  /** PR state for the branch (populated by an explicit `git status` op via gh; network). */
  prState?: "open" | "merged" | "closed";
  prUrl?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

/**
 * One rate-limit window's utilization, read from the Agent SDK's usage endpoint (§3) — the same
 * windows shown in claude.ai → Settings → Usage. `utilization` is a percentage, 0–100.
 */
export interface RateWindow {
  utilization: number; // 0–100: percent of the window consumed
  resetsAt?: Iso8601; // when the window rolls over
}
/**
 * Real subscription rate-limit gauge (§3). Reflects the actual plan limits the daemon's OAuth
 * subscription is subject to — NOT a cost→hours estimate. `available` is false for an API-key /
 * Bedrock / Vertex session, or before any turn has reported (windows are then absent). `warn`
 * flips when any populated window passes the configured threshold.
 */
export interface Budget {
  available: boolean;
  subscriptionType?: string; // "pro" | "max" | "team" | "enterprise"
  session?: RateWindow; // 5-hour rolling window ("current session" in the UI)
  week?: RateWindow; // 7-day, all models
  weekOpus?: RateWindow; // 7-day, Opus only
  weekSonnet?: RateWindow; // 7-day, Sonnet only
  warn: boolean;
  updatedAt?: Iso8601; // when these numbers were last refreshed from the SDK
}

export interface Session {
  id: SessionId;
  title: string;
  pending?: boolean; // client-only: created offline, not yet realized on the daemon (never set by the server)
  icon?: string; // Material Symbols name chosen by Sonnet from the session title (arch §5)
  environmentId?: string; // the Environment this session was created from, if any
  archived?: boolean; // archived = inactive (driver stopped), kept for reference; not deleted
  cwd: string;
  source: SessionSource;
  worktree?: Worktree; // present when source === "fresh-worktree"
  git?: GitStatus;
  model: Model; // default "opus" (§3)
  autonomy: AutonomyPolicy; // default "mostly-autonomous" (§6.6)
  claudeSessionId?: string; // Claude Code's own --resume id
  status: SessionStatus;
  createdAt: Iso8601;
  lastActivityAt: Iso8601;
  usage: Usage;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Content & rendering (§8.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Markdown rendered once by the daemon: sanitized HTML plus the original source.
 * `html` carries `data-line` attributes on block elements so a client can resolve a
 * rendered selection back to source lines for select-to-cite (§8.2/§8.3).
 */
export interface RenderedMarkdown {
  source: string; // raw markdown (authoritative for cite ranges)
  html: string; // sanitized (DOMPurify), Shiki code, KaTeX math, data-line attrs
}

/** A finalized assistant turn is an ordered list of these (§6.2). */
export type ContentBlock =
  | { kind: "markdown"; rendered: RenderedMarkdown }
  | { kind: "tool_use"; toolUseId: ToolUseId; name: string; input: unknown };

/** One conversation log entry — what `conversation.snapshot` replays (§6.4).
 *  `ts` is the wall-clock time the entry was first emitted, carried through so a replayed
 *  conversation shows the same timestamps as the live stream. */
export type ConversationEvent =
  | { kind: "user"; ts?: Iso8601; rendered: RenderedMarkdown; attachments: AttachmentRef[] }
  | { kind: "assistant"; ts?: Iso8601; blocks: ContentBlock[] }
  | { kind: "tool_result"; ts?: Iso8601; toolUseId: ToolUseId; content: string; isError: boolean }
  | { kind: "result"; ts?: Iso8601; stopReason: string; usage: Usage }
  | { kind: "file_offer"; ts?: Iso8601; file: FileOffer };

export interface AttachmentRef {
  id: AttachmentId;
  kind: "image" | "file";
  name: string;
  path: string; // server-side path under <cwd>/.anvil/attachments/
}

/**
 * A deliverable file the agent produced in its worktree (a report, export, archive, image…),
 * surfaced in the conversation as a download card "from the model" (§8). `downloadUrl` is a
 * daemon-relative REST path; clients resolve it to absolute. `taildropped` is true when the
 * daemon also pushed the file to the user's device via `tailscale file cp` (best-effort).
 */
export interface FileOffer {
  name: string; // base name, e.g. "report.pdf"
  path: string; // absolute path inside the session worktree
  size: number; // bytes
  mime: string;
  downloadUrl: string; // e.g. "/api/sessions/<id>/download?path=<rel>"
  taildropped?: boolean; // pushed to the device via Taildrop
}

/** A passage the user selected in the reader and is citing into a prompt (§8.2). */
export interface Cite {
  path: string;
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
  excerpt: string; // the selected source text, for display
}

/** File payload for the browser/reader (§8.1/§8.2). */
export interface FileContent {
  path: string;
  rev: string; // changes whenever the file changes; lets clients dedupe
  mime: string;
  markdown?: RenderedMarkdown; // populated for markdown files (reader)
  text?: string; // populated for other text files (may be truncated — see below)
  truncated?: boolean; // text was capped (large file); fetch more via fs.read range
  binaryUrl?: string; // REST URL for images/binaries
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  isRepo?: boolean; // dir contains a .git (useful for the session-create picker)
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Permissions (§6.6)
// ─────────────────────────────────────────────────────────────────────────────

export type PermissionDecision = "allow" | "deny" | "allow_always";

export interface PermissionSuggestion {
  decision: PermissionDecision;
  label: string; // e.g. "Allow once", "Always allow Edit in this session"
}

// 3b. Questions (AskUserQuestion, §6.6)
//
// Claude's AskUserQuestion tool reaches the daemon as a `request_user_dialog` control
// request (NOT a normal tool result): the SDK parks it until the host answers. The daemon
// surfaces it to clients as `question.request`; a client answers with `question.respond`.
// Modeled like permissions (parked broker, re-surfaced on cold attach) but the payload is a
// set of multiple-choice questions rather than an allow/deny.

export interface QuestionOption {
  label: string; // concise choice text shown on the button/row
  description: string; // what the option means / its trade-off
  preview?: string; // optional richer preview (e.g. a code snippet) for the option
}
export interface Question {
  question: string; // the full question text (also the answer key the SDK expects back)
  header: string; // short chip label (≤12 chars), e.g. "Library"
  options: QuestionOption[]; // 2-4 mutually exclusive choices (unless multiSelect)
  multiSelect?: boolean; // true → the user may pick more than one option
}
/** One question's answer: the chosen option label(s), plus any free-text ("Other") the user typed. */
export interface QuestionAnswer {
  question: string; // matches Question.question
  labels: string[]; // chosen option labels (1 for single-select; ≥1 for multiSelect)
  notes?: string; // free-text the user typed in the "Other" field, if any
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Server → Client events
// ─────────────────────────────────────────────────────────────────────────────

// 4a. Global / control (no seq; not session-scoped)

export interface SessionListEvent extends Envelope {
  type: "session.list";
  sessions: Session[];
}
export interface SessionCreatedEvent extends Envelope {
  type: "session.created";
  cid?: Cid;
  session: Session;
}
export interface SessionUpdatedEvent extends Envelope {
  type: "session.updated";
  session: Session;
}
export interface SessionDeletedEvent extends Envelope {
  type: "session.deleted";
  sessionId: SessionId;
}
export interface BudgetEvent extends Envelope {
  type: "budget";
  budget: Budget;
}
export interface EnvironmentsEvent extends Envelope {
  type: "environments";
  environments: Environment[];
}
/** Result of a git/gh operation (arch §8) — carries combined output for display. */
export type GitOp = "status" | "diff" | "commit" | "push" | "create-pr" | "merge-pr";
export interface GitResultEvent extends Envelope {
  type: "git.result";
  cid?: Cid;
  sessionId: SessionId;
  op: GitOp;
  ok: boolean;
  output: string; // combined stdout+stderr
  url?: string; // PR url for create-pr
}
/** Generic ack for a correlated command that has no richer response. */
export interface AckEvent extends Envelope {
  type: "ack";
  cid: Cid;
}
/** A command failed (validation, unknown session, etc.). */
export interface CommandErrorEvent extends Envelope {
  type: "command.error";
  cid?: Cid;
  message: string;
}

// 4b. Conversation (session-scoped)

export interface ConversationSnapshotEvent extends Envelope, SessionScoped {
  type: "conversation.snapshot";
  events: ConversationEvent[];
  lastSeq: Seq; // highest seq represented by this snapshot
}
export interface MessageUserEvent extends Envelope, SessionScoped {
  type: "message.user";
  rendered: RenderedMarkdown;
  attachments: AttachmentRef[];
}
/** Streaming token chunk. Raw markdown text; client renders incrementally (Streamdown-style). */
export interface AssistantDeltaEvent extends Envelope, SessionScoped {
  type: "assistant.delta";
  text: string;
}
/** Finalized assistant turn — authoritative server-rendered HTML; replaces the streamed draft. */
export interface AssistantMessageEvent extends Envelope, SessionScoped {
  type: "assistant.message";
  blocks: ContentBlock[];
}
export interface ToolUseEvent extends Envelope, SessionScoped {
  type: "tool.use";
  toolUseId: ToolUseId;
  name: string;
  input: unknown;
}
export interface ToolResultEvent extends Envelope, SessionScoped {
  type: "tool.result";
  toolUseId: ToolUseId;
  content: string;
  isError: boolean;
}
export interface PermissionRequestEvent extends Envelope, SessionScoped {
  type: "permission.request";
  requestId: RequestId;
  tool: string;
  input: unknown;
  suggestions: PermissionSuggestion[];
}
/** Claude is asking the user to choose among options (AskUserQuestion, §6.6). */
export interface QuestionRequestEvent extends Envelope, SessionScoped {
  type: "question.request";
  requestId: RequestId;
  questions: Question[];
}
export interface StatusEvent extends Envelope, SessionScoped {
  type: "status";
  status: SessionStatus;
}
export interface UsageEvent extends Envelope, SessionScoped {
  type: "usage";
  inputTokens: number;
  outputTokens: number;
}
export interface ResultEvent extends Envelope, SessionScoped {
  type: "result";
  stopReason: string;
  usage: Usage;
}
export interface SessionErrorEvent extends Envelope, SessionScoped {
  type: "error";
  message: string;
  fatal: boolean;
}
/** A deliverable file the agent produced — rendered as a download card in the conversation (§8). */
export interface FileOfferEvent extends Envelope, SessionScoped {
  type: "file.offer";
  file: FileOffer;
}

// 4c. Files (§8.1/§8.2)

// fs.list / fs.read are request/response: these results are correlated by `cid`
// (NOT session-sequenced — they are not part of the ordered conversation stream).
export interface FsListResultEvent extends Envelope {
  type: "fs.list.result";
  cid?: Cid;
  sessionId: SessionId;
  path: string;
  entries: DirEntry[];
}
export interface FsReadResultEvent extends Envelope {
  type: "fs.read.result";
  cid?: Cid;
  content: FileContent;
}
// dirs.list browses the daemon host's filesystem to pick a cwd/repoRoot at session-create
// time (pre-session, so NOT scoped to a worktree). Single-user; the tailnet is the boundary.
export interface DirsListResultEvent extends Envelope {
  type: "dirs.list.result";
  cid?: Cid;
  path: string; // the resolved absolute dir that was listed
  parent?: string; // its parent dir, if any (for an "up" affordance)
  entries: DirEntry[]; // subdirectories only
}
// fs.changed is a live push for watched paths → session-scoped.
export interface FsChangedEvent extends Envelope, SessionScoped {
  type: "fs.changed";
  content: FileContent; // re-rendered markdown for the reader, or updated text
}

// 4d. Terminal (session-scoped; only after terminal.open — §7)
//
// NOTE: terminal.* events carry `seq` for live ordering but are NOT persisted to the
// durable conversation event log used by conversation.snapshot (§6.4). Terminal "resume"
// is scrollback replay on (re)attach, handled by the daemon's TerminalChannel, not by
// snapshot replay. (Impl plan 4, Q1.)
export interface TerminalDataEvent extends Envelope, SessionScoped {
  type: "terminal.data";
  data: string; // base64 PTY bytes
}
export interface TerminalExitEvent extends Envelope, SessionScoped {
  type: "terminal.exit";
  code: number;
}

/** The full set of messages the server may send. */
export type ServerEvent =
  // global
  | SessionListEvent
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | SessionDeletedEvent
  | BudgetEvent
  | EnvironmentsEvent
  | GitResultEvent
  | AckEvent
  | CommandErrorEvent
  // conversation
  | ConversationSnapshotEvent
  | MessageUserEvent
  | AssistantDeltaEvent
  | AssistantMessageEvent
  | ToolUseEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | QuestionRequestEvent
  | StatusEvent
  | UsageEvent
  | ResultEvent
  | SessionErrorEvent
  | FileOfferEvent
  // files
  | FsListResultEvent
  | FsReadResultEvent
  | DirsListResultEvent
  | FsChangedEvent
  // terminal
  | TerminalDataEvent
  | TerminalExitEvent;

// ─────────────────────────────────────────────────────────────────────────────
// 5. Client → Server commands
// ─────────────────────────────────────────────────────────────────────────────

/** Mixed into commands that want a correlated ack / error / result. */
export interface Correlated {
  cid?: Cid;
}

// 5a. Session control (§6.3)

export interface SessionCreateCmd extends Envelope, Correlated {
  type: "session.create";
  source: SessionSource;
  cwd?: string; // required when source === "existing-dir"
  repoRoot?: string; // required when source === "fresh-worktree"
  base?: string; // base branch/commit for a fresh worktree
  title?: string;
  environmentId?: string; // the Environment this came from (for grouping/labeling)
  model?: Model; // defaults to "opus"
  autonomy?: AutonomyPolicy; // defaults to "mostly-autonomous"
}
/** Resume: replay events with seq > lastSeq, else server sends a snapshot (§6.4). */
export interface SessionAttachCmd extends Envelope, Correlated {
  type: "session.attach";
  sessionId: SessionId;
  lastSeq?: Seq;
}
export interface SessionDetachCmd extends Envelope, Correlated {
  type: "session.detach";
  sessionId: SessionId;
}
export interface SessionKillCmd extends Envelope, Correlated {
  type: "session.kill"; // delete: reap the agent, remove the worktree + branch + state
  sessionId: SessionId;
}
export interface SessionArchiveCmd extends Envelope, Correlated {
  type: "session.archive"; // stop the driver, keep the worktree/branch/history
  sessionId: SessionId;
}
export interface SessionUnarchiveCmd extends Envelope, Correlated {
  type: "session.unarchive";
  sessionId: SessionId;
}
export interface SessionResetCmd extends Envelope, Correlated {
  type: "session.reset"; // un-stick: drop stale driver, recover worktree, clear parked perms → idle
  sessionId: SessionId;
}
/** Git / gh operations on the session's worktree (arch §8). */
export interface GitCmd extends Envelope, Correlated {
  type: "git";
  sessionId: SessionId;
  op: GitOp;
  message?: string; // commit
  title?: string; // create-pr
  body?: string; // create-pr
  method?: "merge" | "squash" | "rebase"; // merge-pr
}
export interface SessionSetModelCmd extends Envelope, Correlated {
  type: "session.set_model";
  sessionId: SessionId;
  model: Model;
}
export interface SessionSetAutonomyCmd extends Envelope, Correlated {
  type: "session.set_autonomy";
  sessionId: SessionId;
  policy: AutonomyPolicy;
}

// 5b. Conversation

export interface PromptSendCmd extends Envelope, Correlated {
  type: "prompt.send";
  sessionId: SessionId;
  text: string;
  attachmentIds?: AttachmentId[]; // uploaded via REST first (§6.5)
  cites?: Cite[]; // select-to-cite passages (§8.2)
}
export interface PermissionRespondCmd extends Envelope, Correlated {
  type: "permission.respond";
  requestId: RequestId;
  decision: PermissionDecision;
  updatedInput?: unknown; // optional edited tool input
}
/** Answer a parked AskUserQuestion (§6.6) — may come from any device. */
export interface QuestionRespondCmd extends Envelope, Correlated {
  type: "question.respond";
  requestId: RequestId;
  answers: QuestionAnswer[]; // one per question
  cancelled?: boolean; // user dismissed without answering → the SDK applies its default
}
export interface InterruptCmd extends Envelope, Correlated {
  type: "interrupt";
  sessionId: SessionId; // stop the current turn (native equivalent of Esc)
}

// 5c. File browser & reader (§8.1/§8.2)

export interface FsListCmd extends Envelope, Correlated {
  type: "fs.list";
  sessionId: SessionId;
  path: string;
}
export interface FsReadCmd extends Envelope, Correlated {
  type: "fs.read";
  sessionId: SessionId;
  path: string;
  range?: { startLine: number; endLine: number }; // page large text files (FileContent.truncated)
}
export interface FsWatchCmd extends Envelope, Correlated {
  type: "fs.watch";
  sessionId: SessionId;
  path: string;
}
export interface FsUnwatchCmd extends Envelope, Correlated {
  type: "fs.unwatch";
  sessionId: SessionId;
  path: string;
}
/** Browse the daemon host's directories to pick a session cwd/repoRoot (pre-session). */
export interface DirsListCmd extends Envelope, Correlated {
  type: "dirs.list";
  path?: string; // default: the daemon user's home directory
}

// Environments (registered project repos).
export interface EnvListCmd extends Envelope, Correlated {
  type: "env.list"; // request the current environments (also sent on connect)
}
export interface EnvAddCmd extends Envelope, Correlated {
  type: "env.add";
  name: string;
  repoRoot: string; // must be a git repo
  defaultBase?: string;
}
export interface EnvUpdateCmd extends Envelope, Correlated {
  type: "env.update";
  id: string;
  name?: string;
  defaultBase?: string; // "" clears it (back to HEAD)
}
export interface EnvRemoveCmd extends Envelope, Correlated {
  type: "env.remove";
  id: string;
}

// 5d. Terminal (§7)

export interface TerminalOpenCmd extends Envelope, Correlated {
  type: "terminal.open";
  sessionId: SessionId;
  cols: number;
  rows: number;
}
export interface TerminalInputCmd extends Envelope {
  type: "terminal.input";
  sessionId: SessionId;
  data: string; // base64
}
export interface TerminalResizeCmd extends Envelope {
  type: "terminal.resize";
  sessionId: SessionId;
  cols: number;
  rows: number;
}
export interface TerminalCloseCmd extends Envelope, Correlated {
  type: "terminal.close";
  sessionId: SessionId;
}

// 5e. Notifications (§6.7)

export interface PushRegisterCmd extends Envelope, Correlated {
  type: "push.register";
  platform: "fcm" | "apns";
  token: string;
}
export interface PushUnregisterCmd extends Envelope, Correlated {
  type: "push.unregister";
  token: string; // stop pushing to this device (logout / disable)
}

/** The full set of messages a client may send. */
export type ClientCommand =
  // session
  | SessionCreateCmd
  | SessionAttachCmd
  | SessionDetachCmd
  | SessionKillCmd
  | SessionArchiveCmd
  | SessionUnarchiveCmd
  | SessionResetCmd
  | SessionSetModelCmd
  | SessionSetAutonomyCmd
  | GitCmd
  // conversation
  | PromptSendCmd
  | PermissionRespondCmd
  | QuestionRespondCmd
  | InterruptCmd
  // files
  | FsListCmd
  | FsReadCmd
  | FsWatchCmd
  | FsUnwatchCmd
  | DirsListCmd
  | EnvListCmd
  | EnvAddCmd
  | EnvUpdateCmd
  | EnvRemoveCmd
  // terminal
  | TerminalOpenCmd
  | TerminalInputCmd
  | TerminalResizeCmd
  | TerminalCloseCmd
  // notifications
  | PushRegisterCmd
  | PushUnregisterCmd;

// Convenience maps for exhaustive switch handlers.
export type ServerEventType = ServerEvent["type"];
export type ClientCommandType = ClientCommand["type"];

// ─────────────────────────────────────────────────────────────────────────────
// 6. REST side-channel (§6.5) — attachment upload & binary fetch
// ─────────────────────────────────────────────────────────────────────────────

export namespace rest {
  /** POST /api/sessions/{id}/attachments  (multipart/form-data: `file`) */
  export interface UploadAttachmentResponse {
    attachment: AttachmentRef;
  }

  /** GET /api/sessions/{id}/files?path=...  → raw bytes (images/binaries for the reader). */
  // (no body type; streamed bytes with Content-Type)

  /** GET /api/health → liveness + the auth/billing self-check (§3). */
  export interface HealthResponse {
    ok: boolean;
    /** True only if CLAUDE_CODE_OAUTH_TOKEN is set AND ANTHROPIC_API_KEY is unset (§3). */
    subscriptionAuthOk: boolean;
    version: string;
    serverName: string; // display name for this server (default: hostname) — fleet groundwork
    budget: Budget;
  }
  /** GET /api/environments/:id/readme — the repo's README, rendered (arch §8). */
  export interface EnvReadmeResponse {
    markdown?: RenderedMarkdown;
    text?: string;
    missing?: boolean;
  }
}
