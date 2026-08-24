/**
 * Anvil wire protocol — shared contract between `anvild` (daemon) and all clients.
 *
 * Status: 0.7-draft (2026-06-23). Companion to `anvil-native-architecture.md` (§6, §8).
 *   0.9: adversarial plan review in interactive sessions — Session.adversarialReview +
 *        SessionCreateCmd.adversarialReview + session.set_adversarial_review. When a session plans
 *        (ExitPlanMode), competing OpenRouter models critique the plan before execution and the
 *        verdict is emitted as an assistant message. Advisory only; needs an OpenRouter key.
 *        Additive; PROTOCOL_VERSION unchanged.
 *   0.8: prompt library — Prompt + prompts event + prompt.list/save/remove. Saved composer
 *        snippets synced across a user's devices (hub-authoritative). Additive; PROTOCOL_VERSION
 *        unchanged. Gated by the "prompts" server capability.
 *   0.7: fleet identity (anvil-multi-server.md §3/§6) — server.hello event (first frame on
 *        every WS connection) + HealthResponse.serverId. A stable serverId lets one client
 *        federate many servers and namespace sessions/environments by (serverId, …).
 *        Additive; PROTOCOL_VERSION unchanged.
 *   0.6: default "concierge" chat — Session.isDefault (single persistent, pinned,
 *        non-killable general assistant) + session.new_topic (fresh Claude context,
 *        keep scrollback). Both additive; PROTOCOL_VERSION unchanged.
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

// v4 (incremental-offline-resilience.md): adds the resume watermark (`resume.watermarks`), per-session
// `epoch` on the snapshot, and `cid` on `message.user` (exactly-once send dedupe).
//
// Gate semantics (issue #162): the daemon's parseCommandFrame treats this constant as a FLOOR, not an
// equality. Frames from OLDER clients are accepted — the protocol is additive-or-bump, so an older
// envelope still parses — and only frames NEWER than the daemon speaks are rejected (they may rely on
// semantics the daemon predates). Strict equality turned every bump into a fleet-wide outage where a
// one-release-behind peer was unreachable from the UI. Corollary: daemon self-update must never depend
// on the versioned WS channel — the web client's "Update Anvil" rides POST /api/daemon/update (rest.
// DaemonUpdateResponse), which carries no protocol version, so recovery can't be blocked by the very
// skew it exists to repair. The `daemon.update` WS command remains for native clients.
export const PROTOCOL_VERSION = 4 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * Version of the FROZEN update API surface (`/api/update/v1/*`), on its OWN axis independent of
 * PROTOCOL_VERSION (stable-update-service spec §4.3, D12). This surface is the one a hub and a
 * partially-updated fleet call to coordinate updates, so it must stay stable across daemon releases
 * that freely change everything else. Compatibility rule: fields are only ever ADDED, never
 * renamed/removed/retyped; a genuinely breaking change ships under a new path namespace (`/v2/`) and
 * bumps this number. Advertised on `server.hello` + `/api/health` so a hub can tell a stable-updater
 * member from a legacy one (absent ⇒ pre-frozen-API daemon ⇒ drive it via the legacy `daemon.update`).
 */
export const UPDATE_API_VERSION = 1 as const;
export type UpdateApiVersion = typeof UPDATE_API_VERSION;

/** ISO 8601 timestamp, always UTC, e.g. "2026-06-19T14:03:00.000Z". */
export type Iso8601 = string;

// Opaque id aliases (documentation only; all are strings on the wire).
export type SessionId = string; // server-assigned, stable for the session's life
export type Seq = number; // per-session monotonic, starts at 1
export type RequestId = string; // permission request id
export type ToolUseId = string; // matches a tool_use block to its result
export type AttachmentId = string; // returned by the REST upload endpoint
export type Cid = string; // client-chosen correlation id for a command
export type Epoch = string; // per-session resume lineage token; changes only if the log lineage resets (v4)

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

export type Model = "opus" | "sonnet" | "haiku" | "fable";

/** The models a session can run on, in picker order. `label` is the human name shown in the UI;
 *  the daemon maps each `id` to the string the Agent SDK expects (see agent/models.ts). */
export const MODELS: readonly { id: Model; label: string }[] = [
  { id: "opus", label: "Opus 5" },
  { id: "sonnet", label: "Sonnet 4.6" },
  { id: "haiku", label: "Haiku 4.5" },
  { id: "fable", label: "Fable 5" },
];
/** Human label for a session's model (falls back to the raw id for forward-compat). */
export const modelLabel = (m: Model): string => MODELS.find((x) => x.id === m)?.label ?? m;
/** Whether a value is one of the models a session may switch to. */
export const isModel = (m: unknown): m is Model => MODELS.some((x) => x.id === m);

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
  branch: string; // the LOCAL worktree branch — the bare session slug (arch §8)
  base: string; // branch/commit it was created from
  /** The REMOTE branch this pushes to — the local slug under a `feature/`/`bugfix/`/`hotfix/`
   *  prefix, classified from the session's opening prompts once the goal is clear. Absent until
   *  classified (or on pre-existing sessions already pushed under the bare name); pushes then use a
   *  `branch:remoteBranch` refspec so the remote reads as intent. */
  remoteBranch?: string;
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
  color?: string; // base color (hex, e.g. "#335999") for env/session tinting; absent → hue hashed from name
  icon?: string; // Material Symbols name (e.g. "rocket_launch") shown in selectors/cards; absent → folder/account_tree by repo kind
  todoistProjectId?: string; // linked Todoist project; its active tasks feed the nightly planner
  validation?: EnvironmentValidation; // gate a WorkUnit must pass before reaching anvil:review
  /** Default account for new sessions here and for scheduled autopilot runs (§6). */
  accountId?: string;
}

/**
 * Per-environment validation gate for the Todoist autopilot. After implementing a WorkUnit in a
 * worktree, anvil runs these commands (in repoRoot/worktree cwd) in order; all must exit 0 for the
 * unit to advance to `anvil:review`. Otherwise the unit is iterated on or marked `anvil:blocked`.
 */
export interface EnvironmentValidation {
  commands: string[]; // e.g. ["bun run typecheck", "bun test"] — run in order, all must pass
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
  /** The branch `prState`/`prUrl` describe. The PR badge is scoped to this branch: once the
   *  worktree moves to a different branch (e.g. more work after a merge), the stale badge clears. */
  prBranch?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

/**
 * Live context-window occupancy for the current topic, read from the Agent SDK's `getContextUsage()`
 * (the same numbers Claude Code's own context bar shows) — NOT cumulative billing. `used` is the tokens
 * currently in the window (system prompt + tools + messages); `max` is the model's usable window. Absent
 * until the first turn reports, and reset when the topic is cleared or the context is compacted. (§context)
 */
export interface ContextUsage {
  used: number;
  max: number;
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

/** Ceiling on unmet stop attempts before a goal auto-clears (design D4). Shared with the web client. */
export const GOAL_MAX_ITERATIONS = 10;

/**
 * A session's active goal (design 2026-07-25). Set with `/goal <condition>`, cleared with
 * `/goal clear`, and enforced by a Stop hook that blocks the session from going idle until a judge
 * says the condition is met. Display-only on the client — there is no goal command in the protocol;
 * both `/goal` forms arrive as ordinary `prompt.send` text.
 */
export interface SessionGoal {
  condition: string; // natural language, exactly as the user typed it
  iterations: number; // unmet stop attempts since the last reset; auto-clears at GOAL_MAX_ITERATIONS
  lastReason?: string; // the judge's most recent blocker, shown as the chip's tooltip
  paused?: boolean; // restored from disk after a restart; re-arms on the next user prompt (D5)
  setAt: Iso8601;
}

export interface Session {
  id: SessionId;
  title: string;
  isDefault?: boolean; // the single persistent "concierge" chat: pinned first, never killable/archivable (§0.6)
  pending?: boolean; // client-only: created offline, not yet realized on the daemon (never set by the server)
  icon?: string; // Material Symbols name chosen by Sonnet from the session title (arch §5)
  environmentId?: string; // the Environment this session was created from, if any
  // ── Teams (see docs/plans/anvil-team-support.md) ──────────────────────────
  parentId?: SessionId; // present on a member; points at its lead session
  teamRole?: "lead" | "member"; // absent on a plain (non-team) session
  memberTask?: string; // the one-line task the lead assigned this member
  team?: TeamPolicy; // set only on a lead: this team's integration/concurrency policy
  // ── Autopilot planning session (see docs/plans/anvil-improvement-program.md) ──
  workUnitId?: string; // set on a "Plan with Claude" session: the autopilot work unit it plans/builds
  workUnitRole?: "planner"; // marks a session created to plan (then build) an autopilot work unit
  archived?: boolean; // archived = inactive (driver stopped), kept for reference; not deleted
  finished?: boolean; // user-parked in the sidebar's "Finished" group (done, e.g. pending deploy)
  order?: number; // explicit sidebar sort position (lower = higher); unset sorts newest-on-top
  cwd: string;
  source: SessionSource;
  worktree?: Worktree; // present when source === "fresh-worktree"
  git?: GitStatus;
  model: Model; // default "opus" (§3)
  autonomy: AutonomyPolicy; // default "mostly-autonomous" (§6.6)
  adversarialReview?: boolean; // opt-in: when planning, competing OpenRouter models critique the plan
  // before execution (the autopilot adversarial panel, brought to interactive sessions). Advisory only;
  // needs an OpenRouter key. Default off. (§6.6 / adversarial panel)
  claudeSessionId?: string; // Claude Code's own --resume id
  status: SessionStatus;
  createdAt: Iso8601;
  lastActivityAt: Iso8601;
  usage: Usage;
  // Live context-window occupancy for the current topic (§context). Refreshed each turn from the SDK's
  // `getContextUsage()`; drives the composer's context meter. Absent until the first turn; cleared by
  // `session.new_topic` (/clear) and repopulated after a /compact.
  context?: ContextUsage;
  // The slash-commands/skills this session can invoke, reported by the SDK's `init` message and
  // enriched with SKILL.md descriptions — drives the composer's `/` autocomplete. Populated once the
  // driver starts (absent until the first turn); rides session.updated/session.list. (§skills)
  commands?: CommandInfo[];
  // The session's active goal (design 2026-07-25). Absent when no goal is set. Drives the composer's
  // goal chip; updated on every unmet stop attempt so the iteration count is live on every device.
  goal?: SessionGoal;
  /** The Claude account this session's agent spawns under (multi-account §5). Absent = the default. */
  accountId?: string;
  /** Denormalised for display; refreshed on rename. When `accountMissing` is set, this DELIBERATELY
   *  keeps the REMOVED account's old label rather than the fallback's — it's the only place that name
   *  survives, and the client already has the roster snapshot to look up the current default's label. */
  accountLabel?: string;
  /** The bound account no longer resolves; the session fell back to the default (§5.4). */
  accountMissing?: boolean;
  /** Live terminal roster for this session's chip strip (multi-terminal, design 2026-08-08).
   *  Runtime-only — cleared on daemon restart (the PTYs die with the process). Additive. */
  terminals?: TerminalInfo[];
}

/** One live PTY of a session (multi-terminal). */
export interface TerminalInfo {
  id: string; // client-chosen, numeric-string ("1", "2", …); "1" is the default terminal
  title: string; // shell basename, e.g. "zsh"
}

/** A team's policy. Lives on the lead `Session`; a team is otherwise derived from `parentId`. */
export interface TeamPolicy {
  integration: "combined-pr" | "pr-per-member"; // default "combined-pr"
  maxConcurrentMembers: number; // spawn/concurrency cap (default 3)
}

/** A team, computed from the session list by grouping on `parentId`. Sent via `team.info`. */
export interface TeamInfo {
  leadId: SessionId;
  policy: TeamPolicy;
  members: TeamMemberInfo[];
  rollup: { total: number; running: number; awaiting: number; done: number; error: number };
}
export interface TeamMemberInfo {
  sessionId: SessionId;
  task?: string;
  status: SessionStatus;
  git?: GitStatus; // reuse the existing per-session git projection
}
export type TeamPlanMember = { title: string; task: string; source: SessionSource; dependsOn?: string[] };
export interface TeamPlan {
  leadId: SessionId;
  members: TeamPlanMember[];
  integration: TeamPolicy["integration"];
}

/** One entry in a session's `/` autocomplete: an invocable slash-command or skill. `name` is the exact
 *  invocable string (built-ins bare, e.g. "compact"; plugin skills namespaced, e.g. "user:deep-research")
 *  — the composer sends "/" + name verbatim. (§skills) */
export interface CommandInfo {
  name: string;
  description?: string; // one-line SKILL.md summary; absent for built-ins we don't have a blurb for
  source: "builtin" | "user" | "project";
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
  | { kind: "tool_use"; toolUseId: ToolUseId; name: string; input: unknown }
  // A full-width topic boundary (§0.6, "new topic"): a labelled rule that visually clears the pane
  // without deleting scrollback. `note` is an optional muted sub-line under the label.
  | { kind: "divider"; label: string; note?: string };

/** One conversation log entry — what `conversation.snapshot` replays (§6.4).
 *  `ts` is the wall-clock time the entry was first emitted, carried through so a replayed
 *  conversation shows the same timestamps as the live stream. */
export type ConversationEvent =
  | { kind: "user"; ts?: Iso8601; rendered: RenderedMarkdown; attachments: AttachmentRef[] }
  | { kind: "assistant"; ts?: Iso8601; blocks: ContentBlock[] }
  | { kind: "tool_result"; ts?: Iso8601; toolUseId: ToolUseId; content: string; isError: boolean; images?: ToolResultImage[] }
  | { kind: "result"; ts?: Iso8601; stopReason: string; usage: Usage }
  | { kind: "file_offer"; ts?: Iso8601; file: FileOffer };

export interface AttachmentRef {
  id: AttachmentId;
  kind: "image" | "file";
  name: string;
  path: string; // server-side path under <cwd>/.anvil/attachments/
}

/**
 * An image the agent surfaced inside a tool result — a screenshot it captured, a chart it rendered,
 * an image file it Read. The SDK delivers these as base64 image blocks; the daemon persists the bytes
 * as a session attachment (so the event log stays small and survives restarts) and references them by
 * id. Clients fetch the bytes from `/api/sessions/<id>/attachments/<attachmentId>` and render a
 * thumbnail that opens full-size. (§6.5)
 */
export interface ToolResultImage {
  attachmentId: AttachmentId;
  mediaType: string; // e.g. "image/png"
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
  choices?: string[]; // a prose-named file (e.g. "design.md") matched 2+ paths — the client picks one and re-reads
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  mtime?: number; // last-modified epoch ms (files + dirs), for the browser's detail column
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
export interface TeamInfoEvent extends Envelope {
  type: "team.info";
  teams: TeamInfo[];
}
export interface TeamPlanEvent extends Envelope {
  type: "team.plan";
  sessionId: SessionId;
  plan: TeamPlan;
}
export interface TeamPlanResolvedEvent extends Envelope {
  type: "team.plan.resolved";
  sessionId: SessionId;
  approved: boolean;
}
export interface BudgetEvent extends Envelope {
  type: "budget";
  budget: Budget;
}
export interface EnvironmentsEvent extends Envelope {
  type: "environments";
  environments: Environment[];
}
/**
 * A saved prompt snippet the user fires into the composer with one click (a sidebar button). Stored
 * on the daemon and broadcast to every connected client so a user's prompt library syncs across all
 * their devices. Hub-authoritative on the client (like the Todoist link / model auth) — the prompt
 * store lives on the hub daemon and the UI routes prompt.* commands there.
 */
export interface Prompt {
  id: string;
  title: string; // full title (the editor heading)
  shortTitle: string; // the sidebar button label
  icon: string; // Material Symbols name
  body: string; // markdown text appended to the composer
  updatedAt: number; // epoch ms of the last edit (sort/merge aid)
}
export interface PromptsEvent extends Envelope {
  type: "prompts";
  prompts: Prompt[];
}
/**
 * Live human labels for the session model tiers, refreshed by the hub from the Anthropic Models API so
 * the picker tracks new releases (e.g. "Opus 4.8" → "Opus 5") without a code change. A partial map:
 * tiers the hub couldn't resolve are absent, and the client falls back to the static `MODELS` label.
 * Hub-authoritative (like `prompts`) — a fleet member's own copy is ignored by the client.
 */
export interface ModelLabelsEvent extends Envelope {
  type: "model.labels";
  labels: Partial<Record<Model, string>>;
}
/**
 * First frame the server sends on every WS connection (before session.list/budget/
 * environments) — tells the client which server it just connected to (anvil-multi-server.md
 * §3/§6). A client federating many servers keys each socket's sessions/environments by
 * `serverId` so two servers can never collide in the UI. `serverId` is stable across daemon
 * restarts (persisted in the state dir); `serverName` is the display label.
 */
export interface ServerHelloEvent extends Envelope {
  type: "server.hello";
  serverId: string; // stable, persisted (e.g. "srv_…")
  serverName: string; // display name, default: hostname
  version: string; // anvild version
  protocolVersion: ProtocolVersion;
  /** Version of the frozen update API this daemon serves (`/api/update/v1/*`). Absent ⇒ a
   *  pre-frozen-API daemon → a hub drives it via the legacy `daemon.update` path instead (spec §4.3). */
  updateApiVersion?: UpdateApiVersion;
  // Coarse feature flags this build supports (e.g. "autopilot"). Lets a newer client skip commands a
  // member is too old to handle instead of getting `unknown command type` back. Absent on pre-capability
  // builds → the client treats every capability as unsupported for that server (graceful degradation).
  capabilities?: string[];
  /** Fleet position (§7.2). `member` wins when a daemon is both paired and holds members — the
   *  question the client is asking is "should I send roster writes here?". */
  role: "hub" | "member" | "standalone";
  /** Present when role === "member": the hub that owns this machine's roster (PairedHubStore). */
  hubServerId?: string;
}
/** A Todoist project, trimmed to what the link UI / planner needs. */
export interface TodoistProjectInfo {
  id: string;
  name: string;
  parentId?: string; // present for sub-projects
  isInbox?: boolean;
  isFavorite?: boolean;
  taskCount?: number; // active tasks (filled by todoist.projects.list)
}
/** Todoist connection state — broadcast on connect and whenever it changes. */
export interface TodoistStatusEvent extends Envelope {
  type: "todoist.status";
  cid?: Cid;
  connected: boolean;
  account?: string; // email/name of the connected account
}
/** Result of `todoist.projects.list` — the account's projects (live from the API). */
export interface TodoistProjectsResultEvent extends Envelope {
  type: "todoist.projects.result";
  cid?: Cid;
  projects: TodoistProjectInfo[];
}
/** lapo (OAuth2) connection state — broadcast on connect/disconnect and whenever it changes.
 *  `configured` reflects whether the daemon has ANVIL_LAPO_* env set (so the UI shows setup guidance
 *  rather than a dead Connect button when it doesn't). */
export interface LapoStatusEvent extends Envelope {
  type: "lapo.status";
  cid?: Cid;
  connected: boolean;
  configured: boolean;
  account?: string; // email/name of the authorized account
  // The OAuth redirect the daemon will use (its own self-discovered tailnet URL + callback path), shown
  // in the UI. Undefined when the daemon can't determine its own URL. NOT the client's page origin.
  callbackUrl?: string;
}
/** Reply to `lapo.connect`: the authorize URL the client should open to complete the OAuth handshake. */
export interface LapoAuthorizeEvent extends Envelope {
  type: "lapo.authorize";
  cid?: Cid;
  url: string;
}

/** Model-provider auth. Only "claude" is functional today (the Agent SDK is Claude-only); the field
 *  exists so the Settings → Models UI and the daemon can grow Gemini/ChatGPT entries without a
 *  protocol change. The full secret is never sent to clients — only `masked` + the connected flag. */
export type AuthProvider = "claude" | "openrouter";
/** Connection state for a model provider's credential — answer to `auth.status`/`auth.set`/`auth.clear`
 *  (carries cid) and broadcast (no cid) when it changes. */
export interface AuthStatusEvent extends Envelope {
  type: "auth.status";
  cid?: Cid;
  provider: AuthProvider;
  connected: boolean; // a token is present in the daemon's environment (agents can run)
  persisted: boolean; // the token is written to the launcher's env file → survives a service restart
  masked?: string; // e.g. "sk-ant-…lt4f2" — enough to recognise, never the full secret
}

// ── Claude account roster (Settings → Models). Hub-authoritative; members hold replicas (§7). ──
/** A roster entry as clients see it — masked preview only, NEVER the raw token (§11). */
export interface AccountInfo {
  id: string;
  label: string;
  masked: string;
  createdAt: number;
}

/** Broadcast on every roster mutation, like `auth.status`. */
export interface AuthAccountsEvent extends Envelope {
  type: "auth.accounts";
  cid?: Cid;
  rev: number;
  defaultId?: string;
  role: "hub" | "replica";
  /** Set on a replica: the hub that owns this roster, from PairedHubStore (§7.2). */
  hubServerId?: string;
  accounts: AccountInfo[];
  /** False when the default couldn't be written to the launcher env file — "won't survive a restart". */
  persisted: boolean;
  /** Active sessions bound to each account, so the removal confirm can name them without a
   *  second round trip (§9.1). Keyed by accountId; absent keys mean "none". */
  inUse?: Record<string, { sessionId: SessionId; title: string }[]>;
}

// ── Autopilot (task-autopilot plan review UI; see anvil-autopilot-ui.md) ──────────────
/** Rough size estimate the planner emits for a work unit; surfaced on the Autopilot card. */
export type AutopilotSize = "xs" | "s" | "m" | "l" | "xl";
export interface AutopilotEffort {
  size: AutopilotSize;
  filesTouched?: number; // the planner's guess at how many files the unit touches
}
/** The anvil autopilot's status, mirrored from the `anvil:*` Todoist labels. Kept in lockstep with
 *  STATUSES in src/integrations/status.ts (the server is the source of truth). */
export type AnvilStatus = "proposed" | "planned" | "needs-clarification" | "planning" | "building" | "review" | "blocked" | "dismissed" | "completed" | "expired";
/** A focused projection of the autonomous-dev-pipeline trace record (§7), shaped for the reader. The
 *  full plan markdown stays in `AutopilotPlanInfo.plan`; this carries the gate/assignment residue. */
export interface PipelineTraceInfo {
  status: "shipped" | "operator_required" | "blocked";
  phaseReached: string;
  reason?: string;
  riskTier?: string;
  criteria: { id: string; text: string; kind: "automatable" | "human-validates" }[];
  nonGoals: string[];
  verification: { criteriaTests?: string; adversaryTests?: string; lintTypesBuild?: string; coverage?: string };
  validationNote?: string;
  prRef?: string;
  assignments: { phase: string; author: string; adversary?: string }[]; // who authored/adversaried each phase
  loopbacks: { phase: string; count: number }[]; // per-phase revisit counts
}
/** A pending (or just-started) autopilot work unit, shaped for the Autopilot card grid + reader. */
export interface AutopilotPlanInfo {
  id: string; // WorkUnit id
  environmentId: string;
  environmentName?: string;
  todoistProjectId: string;
  title: string;
  rationale?: string;
  summary?: string; // 1–2 line description for the card
  status: AnvilStatus;
  source?: "project" | "label"; // "label" = pulled in account-wide by the Autopilot label (catch-all env)
  sessionId?: SessionId; // the linked session, if any (a live planning session, or the build session)
  effort?: AutopilotEffort;
  taskCount: number; // Todoist tasks bundled into the unit
  plan?: RenderedMarkdown; // full implementation plan (source + sanitized HTML) for the reader
  pipeline?: PipelineTraceInfo; // present once the autonomous dev pipeline (§4) has run on this unit
  // A persisted auto-start hold: the nightly run planned this unit but the auto-start gate held it (e.g.
  // adversarial consensus below the bar). Surfaced on the card so the stop-reason is durable, not just a
  // line in the run log. Cleared when a human starts or dismisses it. (loop-engineering: verify → gate)
  hold?: { reason: string; at: Iso8601 };
  // Present when an event (not the nightly tick) proposed this unit — a CI failure, a labelled task, a
  // webhook. Drives the "proposed" approval tier + the trigger badge on the card. (loop-engineering: Channels)
  trigger?: AutopilotTriggerInfo;
  // The stop-condition seeded onto this unit's build session as a `/goal` (loop-engineering: run-until-done).
  // Display-only on the card; the live iteration count rides the session's `goal`.
  goalCondition?: string;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}
/** Provenance of an event-triggered work unit (structurally matches integrations/event-trigger TriggerInfo). */
export interface AutopilotTriggerInfo {
  kind: string; // "ci-failure" | "github" | "todoist-label" | "webhook" | "manual"
  source: string; // human label for the origin
  at: Iso8601;
}
/** The server's pending plans — answer to `autopilot.plans.list` (carries cid), and broadcast (no cid)
 *  whenever the set changes (a run plans new units, a planning session saves one, a dismiss/start removes one). */
export interface AutopilotPlansEvent extends Envelope {
  type: "autopilot.plans";
  cid?: Cid;
  plans: AutopilotPlanInfo[];
}
/** One updated plan — the result of `autopilot.reassign` (carries cid). */
export interface AutopilotPlanResultEvent extends Envelope {
  type: "autopilot.plan";
  cid?: Cid;
  plan: AutopilotPlanInfo;
}
/** The session created for a plan — by a Go (`autopilot.start`, build) or a "Plan with Claude"
 *  (`autopilot.plan.session`, plan-then-build). Carries the workUnit and the new session id. */
export interface AutopilotStartedEvent extends Envelope {
  type: "autopilot.started";
  cid?: Cid;
  workUnitId: string;
  sessionId: SessionId;
}
/** A streamed progress line from an in-flight `autopilot.run` (broadcast so every open screen follows). */
export interface AutopilotRunProgressEvent extends Envelope {
  type: "autopilot.run.progress";
  line: string;
}
/** Final summary of an `autopilot.run` (carries cid). */
export interface AutopilotRunResultEvent extends Envelope {
  type: "autopilot.run.result";
  cid?: Cid;
  ok: boolean;
  created: number; // new work units planned
  skipped: number; // tasks already in the pipeline
  output: string; // human-readable log (or the error message when ok=false)
}
/** The in-flight run's accumulated progress, sent to a client on connect so a refreshed or late-joining
 *  screen restores the live view (running header + log) instead of blanking. `log` is empty when idle. */
export interface AutopilotPipelineResultEvent extends Envelope {
  type: "autopilot.pipeline.result";
  cid?: Cid;
  ok: boolean;
  workUnitId: string;
  status?: string; // PipelineStatus: shipped | operator_required | blocked
  phaseReached?: string;
  output: string; // human-readable log (or the error message when ok=false)
}
/** One adversary's calibration over all pipeline runs (§6.3 collusion/theater metric). */
export interface PipelineAdversaryStat {
  gate: string;
  adversary: string;
  firstSubmissions: number;
  firstPassRejections: number;
  rejectionRate: number; // 0..1 first-pass rejection rate
  decorative: boolean; // true = suspiciously high approval rate over a real sample (a rubber-stamp)
}
/** The §6.3 adversary metrics — answer to `autopilot.pipeline.metrics` (carries cid). */
export interface AutopilotPipelineMetricsEvent extends Envelope {
  type: "autopilot.pipeline.metrics";
  cid?: Cid;
  adversaries: PipelineAdversaryStat[];
}
export interface AutopilotRunSnapshotEvent extends Envelope {
  type: "autopilot.run.snapshot";
  cid?: Cid;
  running: boolean;
  log: string[]; // progress lines so far, oldest first
}
/** Result of an autopilot maintenance command (`autopilot.tags.reset` / `autopilot.clear`). "reset"
 *  strips anvil:* status labels (keeping the user's Autopilot sourcing label) so tasks re-enter the
 *  candidate pool; "clear" additionally wipes the whole pending pipeline. Carries cid. */
export interface AutopilotMaintenanceResultEvent extends Envelope {
  type: "autopilot.maintenance.result";
  cid?: Cid;
  op: "reset" | "clear";
  tasksCleared: number; // Todoist tasks that had an anvil:* label removed
  unitsRemoved: number; // local work units dropped from the pipeline
}
/** The daemon's autopilot schedule (in-daemon timer; anvil-autopilot-ui.md → Scheduling). Times are
 *  server-local. A run plans the linked projects and, when `autoStart`, launches up to `maxAutoStart`
 *  of the new units (skipped if the subscription budget is warning). */
export interface AutopilotSchedule {
  enabled: boolean;
  timeOfDay: string; // "HH:MM", 24h, server-local
  days?: number[]; // 0=Sun..6=Sat; empty/absent = every day
  autoStart: boolean; // after planning, also start worktree sessions for the new units
  usePipeline?: boolean; // auto-start via the autonomous dev pipeline (§4, Claude+GLM → PR) instead of a plain build session
  maxAutoStart?: number; // cap how many sessions a single run may auto-start (default 3)
  lastRunAt?: Iso8601; // server-set: when the scheduler last fired (read-only to clients)
  // ── Account-wide label sourcing (autopilot-wide settings, carried on the same config object) ──
  label?: string; // a Todoist label (default "Autopilot"): tasks carrying it are pulled in from ANY
  // project, bundled against `defaultEnvironmentId`, and left for review (never auto-started).
  defaultEnvironmentId?: string; // catch-all environment label-sourced tasks are planned/built against
}
/** The current schedule — answer to `autopilot.schedule.get`/`.set` (cid) and broadcast on change.
 *  Also broadcast (to every client) whenever a run starts or finishes, so any device — including one
 *  that didn't trigger the run, or that connected mid-run — can reflect the live `running` state. */
export interface AutopilotScheduleEvent extends Envelope {
  type: "autopilot.schedule";
  cid?: Cid;
  schedule: AutopilotSchedule;
  nextRunAt?: Iso8601; // computed next fire, for display
  running: boolean; // whether an autopilot run is in progress right now (server-authoritative)
}

// ── Loops (loop-engineering: one surface naming every active loop) ────────────────────
// The "draft" kind is a work-unit draft awaiting a human (proposed/planned) — it shows in the Loops
// home's "drafts at your gate" section and converts to a real Loop (Phase 2). "gated"/"paused" statuses
// let a projected row read as at-gate / held.
export type LoopKind = "schedule" | "goal" | "pipeline" | "trigger" | "draft";
export type LoopStatus = "idle" | "armed" | "running" | "waiting" | "gated" | "paused";
/** Autonomy rung = where the human gate sits on the circuit (concept §2). Suggest (report only) → Draft
 *  (writes a branch) → PR (opens a verified PR) → Ship (merges on green, no gate). */
export type LoopRung = "suggest" | "draft" | "pr" | "ship";
/** Where the runner sits on the Trigger → Act ⇄ Check → gate → Ship circuit (for the glyph/SVG). */
export type LoopStation = "trigger" | "act" | "check" | "gate" | "ship";
/** One active loop, projected for the Loops panel. Answers the four questions a loop is framed around:
 *  what triggers it, what stops it, where it is now, and (run-until-done loops) which iteration it's on.
 *  The optional `act`/`rung`/`runnerAt`/`scope` fields feed the circuit renderer (Loops home); when a
 *  daemon omits them the client derives sensible defaults from `kind`/`status`. */
export interface LoopSummary {
  kind: LoopKind;
  id: string; // stable per-loop id (session id, work-unit id, or the synthetic "schedule")
  title: string;
  trigger: string; // what fires it
  stopCondition: string; // when it stops
  status: LoopStatus;
  nextFireAt?: Iso8601; // schedule only
  iteration?: { current: number; max: number }; // goal loops (and pipeline loopbacks) — the lap count
  sessionId?: SessionId; // jump target when the loop owns a session
  detail?: string; // the judge's last blocker, the phase reached, etc.
  act?: string; // the Act-station label (what the loop does), distinct from trigger/stop
  rung?: LoopRung; // autonomy rung → the circuit's gate position (default derived from kind)
  runnerAt?: LoopStation; // where the runner currently sits (default derived from status)
  scope?: string; // scope note for the circuit's shield line (Contract v2)
  environmentId?: string; // owning environment (for env grouping in the Loops home)
  environmentName?: string; // display name of the owning environment
}
/** The set of active loops — answer to `loops.get` (cid) and broadcast (no cid) whenever the set changes
 *  (a run starts/ends, a goal arms/resolves, an event proposes a unit). */
export interface LoopsSnapshotEvent extends Envelope {
  type: "loops.snapshot";
  cid?: Cid;
  loops: LoopSummary[];
}

// ── Loop entity (loops-circuit spec §4.1) — the persisted, first-class Loop + its runs ──────────────
// The spec names the loop's lifecycle field `LoopStatus`; that identifier is already taken by the
// projection `LoopSummary.status` above, so the entity lifecycle is `LoopState` here (Loop.status:
// LoopState). `completed` = the outcome this loop chased is done (possibly finished elsewhere) —
// terminal, stops firing, moved out of the active view but kept for history. `archived` = retired/hidden
// by the human, recoverable (restore → paused). Both are inactive; the scheduler only fires `armed` loops.
export type LoopState = "draft" | "armed" | "paused" | "disabled" | "completed" | "archived";

/** External event channels an `event`-triggered loop can subscribe to (mirrors event-trigger.ts). */
export type TriggerKind = "ci-failure" | "github" | "todoist-label" | "webhook" | "manual";

export type LoopTrigger =
  | { kind: "manual" }
  | { kind: "schedule"; timeOfDay: string; days?: number[] } // per-loop AutopilotScheduleStore due-logic
  | { kind: "event"; eventKind: TriggerKind; dedupeKey?: string }
  | { kind: "chained"; onLoopId: string; on: "success" | "failure" | "any" };

export type LoopAct =
  | { kind: "session-prompt"; prompt: string; model?: Model; autonomy?: AutonomyPolicy }
  | { kind: "autopilot" } // RESERVED: only the daemon-managed Todoist-intake singleton (contract rejects it on user loops)
  | { kind: "pipeline" } // §4 dev pipeline over the linked unit
  | { kind: "skill-check"; command: string }; // deterministic body, no model

// `locks`: globs the acting lap may NOT touch (its own check inputs). The guard denies the union of
// every check's `locks`. Explicit config — intake auto-suggests for command/metric checks.
export type LoopCheck = { locks?: string[] } & (
  | { kind: "judge"; condition: string } // judgeGoal, maker–checker separated
  | { kind: "command"; command: string; expectExit?: number }
  | { kind: "metric"; command: string; op: "gte" | "lte" | "eq"; threshold: number } // Phase 5
  | { kind: "http"; url: string; expectStatus?: number } // Phase 5
);

export interface LoopScope {
  allow: string[]; // globs relative to repo root
  note?: string;
}
export interface LoopHardStops {
  maxLaps: number; // default 10 — hard lap ceiling
  tokenBudget: number; // REQUIRED (contract defaults: 300k session/skill, 500k autopilot/pipeline)
  timeBudgetMs?: number; // optional extra ceiling
  noProgressLaps: number; // default 2 — N identical no-progress laps ends the run terminal
}
export interface LoopNotify {
  onGate: boolean;
  onFailure: boolean;
  onSuccess: boolean;
  dailyDigest: boolean;
}
/** How the `ship` rung auto-merges (loops-circuit follow-up FU-3). `method` mirrors `gh pr merge`;
 *  `requireGreen` gates the merge on `gh pr checks` passing (a red/pending CI leaves the PR open, no
 *  merge). Absent ⇒ the historical default: squash, no CI wait. */
export interface LoopMerge {
  method: "squash" | "merge" | "rebase";
  requireGreen?: boolean;
}
export interface Loop {
  id: string; // "loop_…"
  name: string;
  environmentId?: string; // owning env → executing daemon; absent = hub
  status: LoopState;
  trigger: LoopTrigger;
  act: LoopAct;
  checks: LoopCheck[]; // ≥1 to arm without warning
  checksMode: "all" | "any";
  scope?: LoopScope; // Contract v2: allowed globs + implicit check-file locks
  rung: LoopRung; // gate position = autonomy
  hardStops: LoopHardStops;
  merge?: LoopMerge; // `ship`-rung auto-merge method + optional green-CI gate (FU-3; default squash)
  assumptions: string[]; // logged at intake ("still ambiguous" acceptances)
  notify: LoopNotify;
  cleanGatedLaps: number; // consecutive human-approved laps → promotion suggestion
  configRevision: number; // bumped on every edit; a run pins the revision it started with
  workUnitId?: string; // set when converted from an autopilot draft
  createdAt: Iso8601;
  updatedAt: Iso8601;
}
/** User-editable subset accepted by `loop.save` (id present → update, absent → create). contract.ts
 *  validates + defaults this into a full Loop. */
export interface LoopInput {
  id?: string;
  name: string;
  environmentId?: string;
  trigger: LoopTrigger;
  act: LoopAct;
  checks: LoopCheck[];
  checksMode?: "all" | "any";
  scope?: LoopScope;
  rung?: LoopRung;
  hardStops?: Partial<LoopHardStops>;
  merge?: LoopMerge; // ship-rung merge method + green-CI gate (FU-3)
  assumptions?: string[];
  notify?: Partial<LoopNotify>;
  workUnitId?: string; // link to the autopilot draft this loop was set up from (intake convert path)
}

export type LapVerdict = "pass" | "fail" | "check-error" | "scope-violation" | "check-tampering";
export interface LapCheckResult {
  check: string; // the check's label
  v: LapVerdict;
  detail?: string;
}
export interface Lap {
  n: number;
  summary: string;
  verdicts: LapCheckResult[];
  tokens?: number;
  at: Iso8601;
}
export type LoopRunStatus = "running" | "at-gate" | "shipped" | "failed" | "over-budget" | "no-progress" | "interrupted" | "sent-back";
export interface LoopRun {
  id: string;
  loopId: string;
  configRevision: number;
  trigger: { kind: string; source?: string; at: Iso8601 };
  status: LoopRunStatus;
  laps: Lap[];
  sessionId?: SessionId; // heavy bodies; tapping a lap opens this transcript
  checkpoint?: { lap: number; claudeSessionId?: string; pipelinePhase?: string };
  gate?: { openedAt?: Iso8601; sentBackNote?: string };
  reason?: string; // terminal explanation (budget, no-progress, error)
  dryRun?: boolean; // a throwaway first lap (Phase 3 intake) — report only, gate verbs refuse it
  startedAt: Iso8601;
  endedAt?: Iso8601;
}
// ── Loop entity events (loops-circuit spec §4.3) ────────────────────────────────────────────────────
/** All persisted loops — answer to `loops.list` (cid) and broadcast (no cid) on any catalog change. */
export interface LoopsListEvent extends Envelope {
  type: "loops.list";
  cid?: Cid;
  loops: Loop[];
}
/** A single loop changed (save/arm/pause/convert). Carries the full loop. */
export interface LoopUpdatedEvent extends Envelope {
  type: "loop.updated";
  cid?: Cid;
  loop: Loop;
}
/** A live run/lap update — streamed as laps advance, the run parks at the gate, or reaches a terminal. */
export interface LoopRunEvent extends Envelope {
  type: "loop.run";
  cid?: Cid;
  run: LoopRun;
}
/** Run history for a loop — answer to `loop.runs.get`. */
export interface LoopRunsEvent extends Envelope {
  type: "loop.runs";
  cid?: Cid;
  loopId: string;
  runs: LoopRun[];
}
/** A repo-aware intake proposal (loops-circuit spec §4.4) — Claude's suggested check/scope/stops/gate for
 *  an outcome, plus the "still ambiguous" assumptions. The web's intake conversation drives off this. */
export interface LoopIntakeSuggestion {
  isFeature: boolean; // fix-something-broken vs build-something-new (drives the check-first framing)
  name: string;
  checkCommand?: string; // the proposed command check (e.g. "bun test upload")
  checkLocks?: string[]; // its on-disk inputs to lock (check-tampering guard)
  scopeAllow: string[]; // proposed scope globs
  maxLaps: number;
  tokenBudget: number;
  rung: LoopRung;
  assumptions: string[]; // the "still ambiguous" acceptances to log
}
export interface LoopIntakeResultEvent extends Envelope {
  type: "loop.intake.result";
  cid?: Cid;
  suggestion: LoopIntakeSuggestion;
}
/** Live progress from the repo-reading intake agent (each file it reads / grep it runs), streamed while
 *  the caller awaits the single `loop.intake.result`. Broadcast (no strict correlation), but carries the
 *  request `cid` so the originating client can show only its own run's steps. */
export interface LoopIntakeProgressEvent extends Envelope {
  type: "loop.intake.progress";
  cid?: Cid;
  line: string;
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
/** Result of a `daemon.update` — carries the combined log of fetch/pull/build for display. */
export interface DaemonUpdateResultEvent extends Envelope {
  type: "daemon.update.result";
  cid?: Cid;
  ok: boolean;
  phase: "check" | "up-to-date" | "updated" | "error";
  output: string; // human-readable log (git pull / build output, or the error)
  currentVersion: string; // the daemon VERSION currently running
  behind?: number; // commits behind upstream (phase "check"/"up-to-date")
  willRestart?: boolean; // true → the daemon is about to restart to apply the update
}
/** Generic ack for a correlated command that has no richer response. */
export interface AckEvent extends Envelope {
  type: "ack";
  cid: Cid;
}
/**
 * Heartbeat reply to a client `ping` (§6.4 liveness). A browser can't send native WS ping frames, so the
 * client sends an application-level `ping` and the server echoes `pong`. The client uses the arrival
 * of any frame (this one included) as proof the socket is still alive; if a ping goes unanswered it
 * force-reconnects — otherwise a half-open socket (readyState still OPEN after the transport silently
 * dropped, e.g. a Tailscale tunnel bounce) would strand the outbox on "Syncing…" forever.
 */
export interface PongEvent extends Envelope {
  type: "pong";
}
/** A command failed (validation, unknown session, etc.). */
export interface CommandErrorEvent extends Envelope {
  type: "command.error";
  cid?: Cid;
  message: string;
}

// 4b. Conversation (session-scoped)

/** One session's resume watermark: the client compares its cached `{epoch,lastSeq}` against this to
 *  decide whether it can delta-resume (epoch match) or must take a full snapshot (v4, §6.4). */
export interface ResumeWatermark {
  sessionId: SessionId;
  epoch: Epoch;
  lastSeq: Seq;
}
/** Cheap per-session resume watermarks, broadcast on connect (before `session.list`) so a
 *  cold-opening client can verify its cached transcript without pulling a full snapshot. O(sessions),
 *  no event-log reads. Not session-scoped — it's a single global frame covering every session. */
export interface ResumeWatermarksEvent extends Envelope {
  type: "resume.watermarks";
  watermarks: ResumeWatermark[];
}
/** Resilience telemetry (v4, incremental-offline-resilience.md §5.7 / spec D11). Free-form counter
 *  maps so new metrics can be added without a protocol bump. `server` is the daemon's own view (resume
 *  served delta-vs-snapshot, prompts deduped); `clients` is the latest report from each connected
 *  client keyed by its stable clientId. Broadcast on connect and whenever a client reports. */
export interface TelemetrySnapshotEvent extends Envelope {
  type: "telemetry.snapshot";
  server: Record<string, number>;
  clients: Record<string, Record<string, number>>;
}

export interface ConversationSnapshotEvent extends Envelope, SessionScoped {
  type: "conversation.snapshot";
  events: ConversationEvent[];
  lastSeq: Seq; // highest seq represented by this snapshot
  epoch: Epoch; // resume lineage token — the client caches it and only delta-resumes while it matches (v4)
}
export interface MessageUserEvent extends Envelope, SessionScoped {
  type: "message.user";
  rendered: RenderedMarkdown;
  attachments: AttachmentRef[];
  /** The `cid` of the `prompt.send` that produced this message, when it carried one (v4). Persisted so
   *  the server can dedupe a re-flushed offline send (exactly-once), and echoed so the client can retire
   *  the matching optimistic bubble instead of rendering a duplicate. */
  cid?: Cid;
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
  /** Screenshots / images the agent surfaced in this result — persisted as attachments, referenced
   *  by id, and rendered inline as thumbnails that open full-size. Absent when the result is text-only. */
  images?: ToolResultImage[];
}
export interface PermissionRequestEvent extends Envelope, SessionScoped {
  type: "permission.request";
  requestId: RequestId;
  tool: string;
  input: unknown;
  suggestions: PermissionSuggestion[];
  /** [BE2-8] Set when this event is RE-SURFACED on resume (not a fresh prompt). Its `seq` is the
   *  session's current lastSeq — equal to a delta-resuming client's watermark — so a client that drops
   *  events with `seq <= watermark` would otherwise silently discard a pending permission prompt (the
   *  invisible-prompt / stuck-session failure v4 exists to prevent). A replay:true event must be applied
   *  regardless of its seq. Absent on a fresh prompt. */
  replay?: boolean;
}
/** A parked permission prompt was answered or superseded (reset/kill). Clients retire EXACTLY
 *  that card by requestId — a session can have several prompts parked at once (sub-agent fan-out),
 *  so card lifecycle is per-request, not driven by the session's transient status. (§6.6) */
export interface PermissionResolvedEvent extends Envelope, SessionScoped {
  type: "permission.resolved";
  requestId: RequestId;
}
/** Claude is asking the user to choose among options (AskUserQuestion, §6.6). */
export interface QuestionRequestEvent extends Envelope, SessionScoped {
  type: "question.request";
  requestId: RequestId;
  questions: Question[];
  /** [BE2-8] Set when re-surfaced on resume — see PermissionRequestEvent.replay. Apply regardless of seq. */
  replay?: boolean;
}
/** A parked AskUserQuestion was answered or superseded — clients retire EXACTLY that card by
 *  requestId (sub-agents can fan out several at once, like permissions). (§6.6) */
export interface QuestionResolvedEvent extends Envelope, SessionScoped {
  type: "question.resolved";
  requestId: RequestId;
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
  termId?: string; // multi-terminal (design 2026-08-08); absent = "1", the pre-multi-term default
}
export interface TerminalExitEvent extends Envelope, SessionScoped {
  type: "terminal.exit";
  code: number;
  termId?: string; // multi-terminal (design 2026-08-08); absent = "1", the pre-multi-term default
}

/** The full set of messages the server may send. */
export type ServerEvent =
  // global
  | ServerHelloEvent
  | SessionListEvent
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | SessionDeletedEvent
  | TeamInfoEvent
  | TeamPlanEvent
  | TeamPlanResolvedEvent
  | BudgetEvent
  | EnvironmentsEvent
  | PromptsEvent
  | ModelLabelsEvent
  | TodoistStatusEvent
  | TodoistProjectsResultEvent
  | LapoStatusEvent
  | LapoAuthorizeEvent
  | AuthStatusEvent
  | AuthAccountsEvent
  | AutopilotPlansEvent
  | AutopilotPlanResultEvent
  | AutopilotStartedEvent
  | AutopilotRunProgressEvent
  | AutopilotRunResultEvent
  | AutopilotPipelineResultEvent
  | AutopilotPipelineMetricsEvent
  | AutopilotRunSnapshotEvent
  | AutopilotMaintenanceResultEvent
  | AutopilotScheduleEvent
  | LoopsSnapshotEvent
  | LoopsListEvent
  | LoopUpdatedEvent
  | LoopRunEvent
  | LoopRunsEvent
  | LoopIntakeResultEvent
  | LoopIntakeProgressEvent
  | GitResultEvent
  | DaemonUpdateResultEvent
  | AckEvent
  | PongEvent
  | CommandErrorEvent
  // conversation
  | ResumeWatermarksEvent
  | TelemetrySnapshotEvent
  | ConversationSnapshotEvent
  | MessageUserEvent
  | AssistantDeltaEvent
  | AssistantMessageEvent
  | ToolUseEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | PermissionResolvedEvent
  | QuestionRequestEvent
  | QuestionResolvedEvent
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
  adversarialReview?: boolean; // defaults to false (adversarial plan review; needs an OpenRouter key)
  // ── Teams: create this session as a team lead (see docs/plans/anvil-team-support.md). A lead is an
  //    ordinary session that also gets the lead orchestration MCP tools + an integration/concurrency
  //    policy. Members are created via the lead's tools, not this command. ──
  teamRole?: "lead"; // set to "lead" to make this a team lead; members are stamped by handoffCreate
  team?: TeamPolicy; // the lead's integration/concurrency policy (defaults applied server-side)
  accountId?: string; // defaults to the environment's account, else the roster default
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
export interface SessionArrangeCmd extends Envelope, Correlated {
  type: "session.arrange"; // set the sidebar order + "Finished" membership in one shot (drag-to-reorder)
  order: SessionId[]; // full desired display order, active group followed by the finished group
  finished: SessionId[]; // which sessions belong to the Finished group
}
export interface SessionResetCmd extends Envelope, Correlated {
  type: "session.reset"; // un-stick: drop stale driver, recover worktree, clear parked perms → idle
  sessionId: SessionId;
}
export interface SessionNewTopicCmd extends Envelope, Correlated {
  type: "session.new_topic"; // start a fresh Claude context (drop --resume) but keep the visible scrollback (§0.6)
  sessionId: SessionId;
}
export interface SessionAccountSetCmd extends Envelope, Correlated {
  type: "session.account.set";
  sessionId: SessionId;
  accountId: string;
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
export interface SessionSetAdversarialReviewCmd extends Envelope, Correlated {
  type: "session.set_adversarial_review";
  sessionId: SessionId;
  enabled: boolean;
}
// ── Teams (see docs/plans/anvil-team-support.md) ──────────────────────────
export interface TeamPlanApproveCmd extends Envelope, Correlated {
  type: "team.plan.approve";
  sessionId: SessionId;
  plan: TeamPlan;
}
export interface TeamPlanRejectCmd extends Envelope, Correlated {
  type: "team.plan.reject";
  sessionId: SessionId;
}
export interface TeamIntegrateCmd extends Envelope, Correlated {
  type: "team.integrate";
  sessionId: SessionId;
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
  color?: string; // base color (hex) for tinting
  icon?: string; // Material Symbols name
}
export interface EnvCloneCmd extends Envelope, Correlated {
  type: "env.clone";
  url: string; // git URL (ssh or https); cloned into ~/Development/<repo-name> using host git auth
  name?: string; // display name; defaults to the repo name from the URL
  defaultBase?: string;
  color?: string; // base color (hex) for tinting
  icon?: string; // Material Symbols name
}
export interface EnvUpdateCmd extends Envelope, Correlated {
  type: "env.update";
  id: string;
  name?: string;
  defaultBase?: string; // "" clears it (back to HEAD)
  color?: string; // base color (hex); "" clears it (back to hashed hue)
  icon?: string; // Material Symbols name; "" clears it (back to the default by repo kind)
  todoistProjectId?: string; // link to a Todoist project; "" unlinks
  validation?: EnvironmentValidation | null; // null clears the validation gate
  accountId?: string; // default Claude account for this environment; "" clears it (roster default)
}
export interface EnvRemoveCmd extends Envelope, Correlated {
  type: "env.remove";
  id: string;
}

// Prompt library (saved composer snippets, synced across a user's devices). Hub-authoritative.
export interface PromptListCmd extends Envelope, Correlated {
  type: "prompt.list"; // request the current prompts (also sent on connect)
}
export interface PromptSaveCmd extends Envelope, Correlated {
  type: "prompt.save"; // create (no id) or update (existing id) a prompt
  id?: string; // omit to create; the daemon mints one
  title: string;
  shortTitle: string;
  icon: string; // Material Symbols name
  body: string;
}
export interface PromptRemoveCmd extends Envelope, Correlated {
  type: "prompt.remove";
  id: string;
}

// Todoist integration (task autopilot). The token can be set in-app (todoist.connect) or
// out-of-band (scripts/todoist.ts); these commands drive the link UI and the planner.
export interface TodoistStatusCmd extends Envelope, Correlated {
  type: "todoist.status"; // request the current connection state
}
export interface TodoistConnectCmd extends Envelope, Correlated {
  type: "todoist.connect"; // set/replace the personal API token; validated against the API before it's stored
  token: string;
}
export interface TodoistDisconnectCmd extends Envelope, Correlated {
  type: "todoist.disconnect"; // clear the stored token
}
export interface TodoistPropagateCmd extends Envelope, Correlated {
  // Hub-only: replicate the hub's stored token to fleet members (so autopilot can run where the
  // repo lives). `targets` = member serverIds; omit to push to every member. A no-op off the hub.
  type: "todoist.propagate";
  targets?: string[];
}
export interface TodoistProjectsListCmd extends Envelope, Correlated {
  type: "todoist.projects.list"; // fetch the account's projects (live from the API)
}

// lapo integration (OAuth2 authorization-code). Anvil authorizes against a lapo instance and posts a
// well-formatted markdown "information entry" when an autopilot run finishes. Hub-scoped, like Todoist.
export interface LapoStatusCmd extends Envelope, Correlated {
  type: "lapo.status"; // request the current connection + configured state
}
export interface LapoConnectCmd extends Envelope, Correlated {
  type: "lapo.connect"; // begin the OAuth handshake → replies with a lapo.authorize URL to open
  // The web origin the browser will be redirected back to (window.location.origin); the daemon's
  // OAuth callback hangs off it, so lapo redirects land back on the same daemon that started the flow.
  redirectBase: string;
}
export interface LapoDisconnectCmd extends Envelope, Correlated {
  type: "lapo.disconnect"; // clear the stored tokens
}

// Model-provider auth (Settings → Models). Set/reset the daemon's Claude subscription OAuth token from
// the UI without SSHing in to edit the launcher env. The token is persisted to the launcher's env file
// (survives a service restart) and applied live to the next agent run. `provider` defaults to "claude".
export interface AuthStatusCmd extends Envelope, Correlated {
  type: "auth.status"; // request the current credential state → auth.status
  provider?: AuthProvider;
}
export interface AuthSetCmd extends Envelope, Correlated {
  type: "auth.set"; // set/replace the provider's token (rejected if it looks like a metered API key) → auth.status
  provider?: AuthProvider;
  token: string;
}
export interface AuthClearCmd extends Envelope, Correlated {
  type: "auth.clear"; // remove the provider's token from the daemon + env file → auth.status
  provider?: AuthProvider;
}

// ── Claude account roster (Settings → Models). Hub-authoritative; members hold replicas (§7). ──
export interface AuthAccountsGetCmd extends Envelope, Correlated {
  type: "auth.accounts.get"; // request the current roster → auth.accounts
}
export interface AuthAccountAddCmd extends Envelope, Correlated {
  type: "auth.account.add"; // add a new labelled account (rejected if the token looks like a metered key)
  label: string;
  token: string;
}
export interface AuthAccountRenameCmd extends Envelope, Correlated {
  type: "auth.account.rename";
  accountId: string;
  label: string;
}
export interface AuthAccountReplaceCmd extends Envelope, Correlated {
  type: "auth.account.replace"; // rotate an account's token in place
  accountId: string;
  token: string;
}
export interface AuthAccountRemoveCmd extends Envelope, Correlated {
  type: "auth.account.remove"; // refused if it's the last account
  accountId: string;
}
export interface AuthAccountDefaultCmd extends Envelope, Correlated {
  type: "auth.account.default";
  accountId: string;
}

// Autopilot plan review (anvil-autopilot-ui.md). These drive the Autopilot section: list/refine/
// dismiss pending plans, launch one into a worktree session, or re-plan the linked projects.
export interface AutopilotPlansListCmd extends Envelope, Correlated {
  type: "autopilot.plans.list"; // this server's pending plans → autopilot.plans
}
export interface AutopilotPlanSessionCmd extends Envelope, Correlated {
  type: "autopilot.plan.session"; // open an interactive planning session seeded with the Todoist prompt,
  // the design so far, and any open questions; Claude works the plan out (and can build) → autopilot.started
  workUnitId: string;
  model?: Model; // defaults to "opus"
  autonomy?: AutonomyPolicy; // defaults to "mostly-autonomous" (interactive: it asks the open questions, doesn't blast ahead)
}
export interface AutopilotDismissCmd extends Envelope, Correlated {
  type: "autopilot.dismiss"; // reject a plan: label its tasks anvil:dismissed, drop the card
  workUnitId: string;
}
export interface AutopilotStartCmd extends Envelope, Correlated {
  type: "autopilot.start"; // create a worktree session seeded with the plan and start it → autopilot.started
  workUnitId: string;
  model?: Model; // defaults to "opus"
  autonomy?: AutonomyPolicy; // defaults to "bypass" (auto-start working without permission stalls)
}
export interface AutopilotPipelineStartCmd extends Envelope, Correlated {
  type: "autopilot.pipeline.start"; // run the autonomous dev pipeline (§4) for a unit → autopilot.pipeline.result
  workUnitId: string;
}
export interface AutopilotPipelineMetricsCmd extends Envelope, Correlated {
  type: "autopilot.pipeline.metrics"; // request the §6.3 adversary calibration metrics → autopilot.pipeline.metrics
}
export interface AutopilotResolveCmd extends Envelope, Correlated {
  type: "autopilot.resolve"; // mark a plan completed/expired (drops the card); optionally close its Todoist tasks
  workUnitId: string;
  status: "completed" | "expired";
  closeTodoist: boolean; // also close the member tasks in Todoist (not just relabel them)
}
export interface AutopilotLinkCmd extends Envelope, Correlated {
  type: "autopilot.link"; // attach a plan to an existing session already doing the work → autopilot.started
  workUnitId: string;
  sessionId: string; // an active session in the plan's environment
}
export interface AutopilotReassignCmd extends Envelope, Correlated {
  type: "autopilot.reassign"; // move a plan to a different environment and re-evaluate it there → autopilot.plan
  workUnitId: string;
  environmentId: string; // the environment (repo) to re-plan the unit's tasks against
}
export interface AutopilotRunCmd extends Envelope, Correlated {
  type: "autopilot.run"; // re-plan linked Todoist projects on this server → autopilot.run.result
  environmentId?: string; // limit to one environment; omitted = every linked environment
}
/** Ingest an external event as a PROPOSED work unit (loop-engineering: Channels/event intake). Defaults
 *  to needing a human approve; a trusted source may set autoApprove. → autopilot.plans + loops.snapshot. */
export interface AutopilotTriggerCmd extends Envelope, Correlated {
  type: "autopilot.trigger";
  kind: "ci-failure" | "github" | "todoist-label" | "webhook" | "manual";
  source: string; // human label for the origin
  title: string; // the proposed unit's title
  body?: string; // detail (failure log, comment) — seeds the summary + planning brief
  environmentId?: string; // route to a specific environment; omitted → the schedule's default env
  dedupeKey?: string; // idempotency key; auto-derived from kind+title when absent
  autoApprove?: boolean; // trusted source → skip the propose gate (still bounded by budget)
}
/** Approve a proposed (event-triggered) work unit: promote it to `planned` and, when `start`, launch it.
 *  Reject via the existing autopilot.dismiss. → autopilot.plans / autopilot.started. */
export interface AutopilotApproveCmd extends Envelope, Correlated {
  type: "autopilot.approve";
  workUnitId: string;
  start?: boolean; // also start a build session immediately (else it lands on the grid as `planned`)
}
export interface AutopilotTagsResetCmd extends Envelope, Correlated {
  type: "autopilot.tags.reset"; // strip anvil:* labels (keep the Autopilot sourcing label) so tasks re-plan → autopilot.maintenance.result
}
export interface AutopilotClearCmd extends Envelope, Correlated {
  type: "autopilot.clear"; // wipe the whole pending pipeline AND strip anvil:* labels → autopilot.maintenance.result
}
export interface AutopilotScheduleGetCmd extends Envelope, Correlated {
  type: "autopilot.schedule.get"; // current schedule → autopilot.schedule
}
export interface LoopsGetCmd extends Envelope, Correlated {
  type: "loops.get"; // the current set of active loops (Phase 0 projection) → loops.snapshot
}
// ── Loop entity commands (loops-circuit spec §4.3) ──────────────────────────────────────────────────
export interface LoopsListCmd extends Envelope, Correlated {
  type: "loops.list"; // all persisted loops → loops.list
}
export interface LoopSaveCmd extends Envelope, Correlated {
  type: "loop.save"; // create (no id) or update (id) → loop.updated + loops.list broadcast
  loop: LoopInput;
}
export interface LoopRemoveCmd extends Envelope, Correlated {
  type: "loop.remove";
  loopId: string;
}
export interface LoopArmCmd extends Envelope, Correlated {
  type: "loop.arm"; // draft/paused → armed → loop.updated
  loopId: string;
}
export interface LoopPauseCmd extends Envelope, Correlated {
  type: "loop.pause"; // armed → paused (edit-when-paused) → loop.updated
  loopId: string;
}
export interface LoopCompleteCmd extends Envelope, Correlated {
  type: "loop.complete"; // → completed (work done, possibly elsewhere); optionally close the linked Todoist source task(s) → loop.updated
  loopId: string;
  closeTodoist?: boolean; // when the loop has a linked work unit, also close its Todoist task(s)
}
export interface LoopArchiveCmd extends Envelope, Correlated {
  type: "loop.archive"; // retire a loop out of the active view (recoverable: restore → paused) → loop.updated
  loopId: string;
}
export interface LoopRunCmd extends Envelope, Correlated {
  type: "loop.run"; // start a manual run (or a lap now) → loop.run stream
  loopId: string;
}
export interface LoopDryRunCmd extends Envelope, Correlated {
  type: "loop.dryrun"; // first lap in a throwaway worktree, report only (Phase 3) → loop.run stream
  loopId: string;
}
export interface LoopGateOpenCmd extends Envelope, Correlated {
  type: "loop.gate.open"; // ship per rung (Suggest report / Draft branch / PR PR) → loop.run
  runId: string;
}
export interface LoopGateSendbackCmd extends Envelope, Correlated {
  type: "loop.gate.sendback"; // record the note + run exactly one more lap with it injected → loop.run
  runId: string;
  note: string;
}
export interface LoopRunsGetCmd extends Envelope, Correlated {
  type: "loop.runs.get"; // run history for a loop → loop.runs
  loopId: string;
}
export interface LoopConvertCmd extends Envelope, Correlated {
  type: "loop.convert"; // an autopilot draft → a real Loop (keeps the unit; drives its tags) → loop.updated
  workUnitId: string;
}
export interface LoopIntakeCmd extends Envelope, Correlated {
  type: "loop.intake"; // repo-aware intake proposal for an outcome → loop.intake.result
  prompt: string;
  environmentId?: string;
}
export interface AutopilotScheduleSetCmd extends Envelope, Correlated {
  type: "autopilot.schedule.set"; // update fields (omitted fields unchanged) → autopilot.schedule
  enabled?: boolean;
  timeOfDay?: string;
  days?: number[];
  autoStart?: boolean;
  usePipeline?: boolean; // auto-start via the autonomous dev pipeline (§4) instead of a build session
  maxAutoStart?: number;
  label?: string; // "" clears it (disables label sourcing)
  defaultEnvironmentId?: string; // "" clears it
}

// Daemon self-management. `daemon.update` pulls the daemon's own source repo, rebuilds the web
// bundle, and (when running under the launchd service) restarts itself to apply the new code.
export interface DaemonUpdateCmd extends Envelope, Correlated {
  type: "daemon.update";
  checkOnly?: boolean; // fetch + report whether an update is available; don't pull/build/restart
}

// 5d. Terminal (§7)

export interface TerminalOpenCmd extends Envelope, Correlated {
  type: "terminal.open";
  sessionId: SessionId;
  cols: number;
  rows: number;
  termId?: string; // multi-terminal (design 2026-08-08); absent = "1", the pre-multi-term default
}
export interface TerminalInputCmd extends Envelope {
  type: "terminal.input";
  sessionId: SessionId;
  data: string; // base64
  termId?: string; // multi-terminal (design 2026-08-08); absent = "1", the pre-multi-term default
}
export interface TerminalResizeCmd extends Envelope {
  type: "terminal.resize";
  sessionId: SessionId;
  cols: number;
  rows: number;
  termId?: string; // multi-terminal (design 2026-08-08); absent = "1", the pre-multi-term default
}
/** Kills that PTY (the kill/respawn escape hatch, design 2026-08-08) — previously a documented
 *  client-side no-op that no released client ever sent, so the repurpose is not a breaking change. */
export interface TerminalCloseCmd extends Envelope, Correlated {
  type: "terminal.close";
  sessionId: SessionId;
  termId?: string; // multi-terminal (design 2026-08-08); absent = "1", the pre-multi-term default
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

// 5g. Liveness (§6.4)

/** Application-level heartbeat; the server replies `pong`. See PongEvent for the why. */
export interface PingCmd extends Envelope {
  type: "ping";
}

// 5h. Telemetry (v4, §5.7)

/** A client reports its resilience counters; the daemon aggregates them and rebroadcasts a
 *  `telemetry.snapshot`. Free-form counter map so metrics can evolve without a protocol bump. */
export interface TelemetryReportCmd extends Envelope, Correlated {
  type: "telemetry.report";
  clientId: string; // stable per-device id so the daemon keys the latest report per client
  counters: Record<string, number>;
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
  | SessionArrangeCmd
  | SessionResetCmd
  | SessionNewTopicCmd
  | SessionAccountSetCmd
  | SessionSetModelCmd
  | SessionSetAutonomyCmd
  | SessionSetAdversarialReviewCmd
  | TeamPlanApproveCmd
  | TeamPlanRejectCmd
  | TeamIntegrateCmd
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
  | EnvCloneCmd
  | EnvUpdateCmd
  | EnvRemoveCmd
  | PromptListCmd
  | PromptSaveCmd
  | PromptRemoveCmd
  | TodoistStatusCmd
  | TodoistConnectCmd
  | TodoistDisconnectCmd
  | TodoistPropagateCmd
  | TodoistProjectsListCmd
  | LapoStatusCmd
  | LapoConnectCmd
  | LapoDisconnectCmd
  | AuthStatusCmd
  | AuthSetCmd
  | AuthClearCmd
  | AuthAccountsGetCmd
  | AuthAccountAddCmd
  | AuthAccountRenameCmd
  | AuthAccountReplaceCmd
  | AuthAccountRemoveCmd
  | AuthAccountDefaultCmd
  | AutopilotPlansListCmd
  | AutopilotPlanSessionCmd
  | AutopilotDismissCmd
  | AutopilotStartCmd
  | AutopilotPipelineStartCmd
  | AutopilotPipelineMetricsCmd
  | AutopilotResolveCmd
  | AutopilotLinkCmd
  | AutopilotReassignCmd
  | AutopilotRunCmd
  | AutopilotTriggerCmd
  | AutopilotApproveCmd
  | AutopilotTagsResetCmd
  | AutopilotClearCmd
  | AutopilotScheduleGetCmd
  | AutopilotScheduleSetCmd
  | LoopsGetCmd
  | LoopsListCmd
  | LoopSaveCmd
  | LoopRemoveCmd
  | LoopArmCmd
  | LoopPauseCmd
  | LoopCompleteCmd
  | LoopArchiveCmd
  | LoopRunCmd
  | LoopDryRunCmd
  | LoopGateOpenCmd
  | LoopGateSendbackCmd
  | LoopRunsGetCmd
  | LoopConvertCmd
  | LoopIntakeCmd
  | DaemonUpdateCmd
  // terminal
  | TerminalOpenCmd
  | TerminalInputCmd
  | TerminalResizeCmd
  | TerminalCloseCmd
  // notifications
  | PushRegisterCmd
  | PushUnregisterCmd
  // liveness
  | PingCmd
  // telemetry
  | TelemetryReportCmd;

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
    /**
     * A plausible subscription token is present AND no metered key outranks it (§3). False means the
     * daemon is UP but DEGRADED — it serves the API, the terminal, and files, but refuses agent turns
     * until it's paired or a token is set. `ok` and this field have always been separate for exactly
     * this state; anvil-headless-join.md is what made it reachable.
     *
     * This is a SHAPE check, not a validity check: a well-formed but revoked token still reports true
     * here until a turn fails (auto-degrade then flips it — headless-join §4.2/§4.6).
     */
    subscriptionAuthOk: boolean;
    version: string;
    serverId: string; // stable id for this server, persisted in the state dir — fleet identity (§3)
    serverName: string; // display name for this server (default: hostname) — fleet groundwork
    budget: Budget;
    /**
     * Coarse feature flags this build supports (`SERVER_CAPABILITIES`) — the same list `server.hello`
     * carries, exposed on REST because discovery is REST: a hub has no WS session with a machine it
     * hasn't joined yet, and it needs "does this peer speak :7701 pairing?" to route a credential push
     * (headless-join §3.5). Absent ⇒ a pre-capability daemon ⇒ treat every capability as unsupported.
     */
    capabilities?: string[];
    /** Version of the frozen update API this daemon serves. Read by a hub over REST (discovery is
     *  REST) to route a member through the stable path vs the legacy `daemon.update` (spec §4.3).
     *  Absent ⇒ pre-frozen-API daemon. */
    updateApiVersion?: UpdateApiVersion;
    /** Part of the boot smoke self-check (spec D14): the built web bundle (web/dist/index.html) is
     *  present and being served. False ⇒ this process is up but can't serve the app — the watchdog
     *  treats a health probe with `webBundleOk:false` as NOT-healthy and will roll back. Absent on a
     *  daemon predating the smoke check. */
    webBundleOk?: boolean;
  }
  /**
   * The FROZEN update API v1 (`/api/update/v1/*`) — stable-update-service spec §4.3. Additive-only:
   * every field here is guaranteed to keep its name+type across daemon releases (enforced by the
   * OpenAPI contract test). A hub and a partially-updated fleet coordinate updates over this surface.
   */
  export namespace update {
    /** Phase of an in-flight (or last) update on a single daemon, reported by `/api/update/v1/status`. */
    export type UpdatePhase =
      | "idle"
      | "checking"
      | "pulling"
      | "building"
      | "restarting"
      | "healthy"
      | "rolled-back"
      | "error";
    /** GET /api/update/v1/check → how far behind + stale-process detection, without mutating anything. */
    export interface CheckResponse {
      ok: boolean;
      updateApiVersion: UpdateApiVersion;
      currentSha: string; // the git short SHA the running process was built from ("" if git-less)
      targetSha: string; // the SHA the resolved upstream ref points at ("" when it can't be resolved)
      behind: number; // commits HEAD is behind the resolved upstream ref
      needsRestart: boolean; // on-disk build is newer than the running process (a prior restart never landed)
      output: string; // human-readable summary
      error?: string; // present when ok === false
    }
    /** POST /api/update/v1/apply — update to an EXPLICIT target SHA (spec D13: deterministic fleet
     *  convergence). Omitting `targetSha` means "resolve the upstream tip and use that" (the legacy
     *  latest-on-branch behaviour), so scripts and the macOS menu keep working. */
    export interface ApplyRequest {
      targetSha?: string;
    }
    export interface ApplyResponse {
      ok: boolean;
      updateApiVersion: UpdateApiVersion;
      phase: UpdatePhase; // "restarting" (willRestart), "healthy"/"idle" (up-to-date), or "error"
      willRestart: boolean; // true → the daemon is about to restart to apply
      currentVersion: string; // VERSION currently running (pre-restart)
      prePullSha: string; // the SHA recorded before pulling — what a failed boot rolls back to
      targetSha: string; // the SHA this apply moved (or is moving) the checkout to
      output: string; // combined pull/build/typecheck log, or the error
      error?: string;
    }
    /** GET /api/update/v1/status → the live phase, for a hub to OBSERVE a member's rollout (spec D10).
     *  Read-only; never mutates. */
    export interface StatusResponse {
      ok: boolean;
      updateApiVersion: UpdateApiVersion;
      phase: UpdatePhase;
      currentSha: string; // running process's short SHA
      currentVersion: string; // full VERSION string
      targetSha: string; // desired target if an update is in flight/last-attempted ("" if none)
      prePullSha: string; // known-good SHA to roll back to ("" if none recorded)
      webBundleOk: boolean; // smoke: is the web bundle being served
      reason?: string; // why, when phase is "rolled-back" or "error"
      updatedAt?: number; // ms epoch of the last phase transition
    }
  }
  /** An Anvil server found on the tailnet by discovery (anvil-multi-server.md §4.1). */
  export interface DiscoveredServer {
    serverId: string; // stable identity (dedup key)
    serverName: string; // display name (falls back to the MagicDNS host)
    url: string; // https://<magicdns>:<port> — what the client would connect to
    version: string; // anvild version reported by /api/health
    online: boolean;
    isSelf: boolean; // this hub's own daemon (already connected)
    /** From that peer's /api/health. False ⇒ it's up but has no Claude login, so the Fleet UI can
     *  label it "needs setup" and offer to pair it (headless-join HJ-9). Absent on a peer whose
     *  health predates the field. */
    subscriptionAuthOk?: boolean;
    /** That peer's `SERVER_CAPABILITIES` (see HealthResponse.capabilities). Contains "pairing" when the
     *  hub can push credentials to its :7701 API instead of the macOS :7702 listener. */
    capabilities?: string[];
  }
  /** GET /api/fleet/discover → Anvil servers on the tailnet (anvil-multi-server.md §4.1). The hub
   *  daemon enumerates Tailscale peers and probes each for /api/health, returning the ones that
   *  answered as Anvil daemons (deduped by serverId) so the client can offer one-tap additions to
   *  its registry. Discovery suggests; the explicit join is what makes a server a durable member. */
  export interface FleetDiscoverResponse {
    ok: boolean;
    servers: DiscoveredServer[];
    /** Set when discovery couldn't run (e.g. Tailscale CLI missing / not logged in). */
    warning?: string;
  }
  /** A Mac the hub has paired into the fleet (anvil-server-app.md §6). */
  export interface FleetMember {
    serverId: string;
    serverName: string;
    host: string; // tailnet MagicDNS host (where :7702 pairing + :7701 daemon live)
    url: string; // https://host:7701/ (for the client to connect to)
    /** The account roster `rev` last confirmed pushed to this member (multi-account §7.3). Absent ⇒
     *  never pushed, or the member predates the "accounts" capability. */
    accountsRev?: number;
  }
  /** GET /api/fleet/members → the hub's recorded fleet (for the clients' Fleet UI). */
  export interface FleetMembersResponse {
    members: FleetMember[];
  }
  /** GET /api/fleet/peers → the other Macs on this tailnet, so a client picks one by name (no IPs). */
  export interface FleetPeer {
    name: string; // short label, e.g. "mac-mini-m1"
    host: string; // full MagicDNS name
    online: boolean;
  }
  export interface FleetPeersResponse {
    ok: boolean;
    peers: FleetPeer[];
    warning?: string;
  }
  /** POST /api/fleet/invite { host, code } → push the hub's OAuth token to a joiner's pairing
   *  listener (first join, code-gated). The token is read from the daemon env and never returned. */
  export interface FleetInviteRequest {
    host: string; // joiner's tailnet name
    code: string; // the 6-digit code the joiner is showing
  }
  export interface FleetInviteResponse {
    ok: boolean;
    member?: FleetMember;
    error?: string;
  }
  /** POST /api/fleet/rotate → push the current hub token to every member (identity-gated). */
  export interface FleetRotateResponse {
    ok: boolean;
    results: { host: string; ok: boolean; error?: string }[];
    /** Set when the fan-out itself failed to run (as opposed to per-member failures in `results`). */
    error?: string;
  }

  /**
   * [BE2-15] Async fleet-job envelope. `POST /api/fleet/rotate|invite` accept `?async=1` to start (or
   * join) the fan-out as a background JOB and answer immediately with this envelope, instead of holding
   * the request open for the whole fan-out (one sleeping Mac used to pin the POST for ~14s of pairing
   * timeouts per member — the reason the server's idleTimeout had to be raised to 120s). Progress is
   * polled from `GET /api/fleet/jobs/<jobId>`. WITHOUT `?async=1` both POSTs keep their original
   * synchronous response shapes — bundled native web UIs (Android/iOS ship their own copy) predate the
   * job model and must keep working against a newer daemon.
   */
  export interface FleetJobStartResponse {
    ok: boolean;
    jobId: string;
    kind: "rotate" | "invite";
    state: "running" | "done";
  }
  /** GET /api/fleet/jobs/:id → job progress. Once `state` is "done", `result` carries EXACTLY the body
   *  the synchronous POST would have returned: a {@link FleetRotateResponse} for kind "rotate", a
   *  {@link FleetInviteResponse} for kind "invite" — same information content, just delivered async.
   *  An unknown/expired id answers 404 with `ok:false` (e.g. the daemon restarted mid-job). */
  export interface FleetJobStatusResponse {
    ok: boolean;
    jobId?: string;
    kind?: "rotate" | "invite";
    state?: "running" | "done";
    startedAt?: number;
    finishedAt?: number;
    result?: FleetRotateResponse | FleetInviteResponse;
    error?: string;
  }

  /**
   * Hub-orchestrated fleet update (stable-update-service spec §4.4). The hub pins ONE target SHA and
   * fans it out to every reachable member (each self-updates + self-heals locally via its frozen
   * update API); the hub updates itself LAST. Unreachable members are skipped and reconciled on
   * reconnect. `POST /api/fleet/update` kicks it off; `GET /api/fleet/update/status` polls progress.
   */
  export type FleetRolloutMemberState =
    | "pending" // queued, not yet contacted
    | "pending-offline" // unreachable at fan-out time; will reconcile on reconnect
    | "legacy" // no updateApiVersion → driven via the legacy daemon.update path
    | "updating" // apply accepted, member self-updating
    | "healthy" // reached target and passed its smoke gate
    | "rolled-back" // failed its gate; self-healed to the prior build
    | "error"; // could not be updated (apply rejected / failed)
  export interface FleetRolloutMember {
    serverId: string;
    serverName: string;
    isHub: boolean; // the hub updates itself last
    state: FleetRolloutMemberState;
    fromSha?: string;
    toSha?: string;
    detail?: string; // human-readable note (error text, "offline", …)
  }
  export interface FleetUpdateRequest {
    /** Pin to this exact SHA. Omit ⇒ the hub resolves the upstream tip once and pins that (spec D13). */
    targetSha?: string;
  }
  export interface FleetUpdateResponse {
    ok: boolean;
    targetSha: string; // the pinned SHA the whole fleet is converging to
    members: FleetRolloutMember[]; // initial snapshot (hub last)
    error?: string;
  }
  export interface FleetUpdateStatusResponse {
    ok: boolean;
    active: boolean; // a rollout is in progress
    targetSha: string; // last/current pinned target ("" if never run)
    startedAt?: number;
    finishedAt?: number;
    members: FleetRolloutMember[];
  }

  // ── Joiner-side pairing on :7701 (anvil-headless-join.md §5.3) ───────────────────────────────
  // The macOS Server.app's :7702 listener only exists on a Mac, so a headless Linux box had no way to
  // be handed a fleet credential. These routes are the daemon's own equivalent, gated identically:
  // first join is code-gated, rotation is identity-gated. Advertised via the "pairing" capability.

  /** POST /api/fleet/arm → open a join window on THIS machine and show its code (HJ-13: the code lives
   *  in exactly one place — the joiner's own UI). Default-closed: without this, /pair rejects. */
  export interface FleetArmRequest {
    /** Window lifetime in ms; the daemon clamps it to a sane maximum. Omit for the default. */
    ttlMs?: number;
  }
  export interface FleetArmResponse {
    ok: boolean;
    code?: string; // 6 digits, shown to the operator
    expiresAt?: string; // ISO8601 — drives the countdown
    /** This machine's MagicDNS name, so the operator knows which candidate to pick on the hub. */
    host?: string;
    error?: string;
  }
  /** GET /api/fleet/arm → the joiner's own setup state, for its takeover screen. Deliberately NOT part
   *  of /api/health: arm-state on unauthenticated health would broadcast an open credential window to
   *  the whole tailnet (HJ-9). */
  export interface FleetArmStatusResponse {
    armed: boolean;
    code?: string;
    expiresAt?: string;
    host?: string;
    /** A credential is already present — pairing would REPLACE it (HJ-10, consented at the joiner). */
    hasToken: boolean;
    /** The hub this machine is currently joined to, if any. Re-pairing to a different hub detaches
     *  from this one (HJ-14). */
    hubServerId?: string;
    serverId: string;
    serverName: string;
  }
  /** POST /api/fleet/pair — the hub pushes credentials to an ARMED joiner. Code + tailnet identity are
   *  both required (§7/§8.2). Mirrors the :7702 `/anvil-pair` body so the two paths stay recognisable. */
  export interface FleetPairRequest {
    code: string;
    token: string; // the fleet's Claude subscription OAuth token
    hubServerId: string;
    fleetName?: string;
    /** Sibling secrets pushed in the same payload — joining a fleet means adopting its config
     *  (HJ-24/HJ-27). Present keys OVERWRITE; absent keys are left alone. */
    todoistToken?: string;
    openRouterKey?: string;
    /** Optional roster carried on a credential push (§7.3). Absent from an older hub → today's
     *  behaviour exactly; ignored by an older joiner. */
    accounts?: RosterPush;
  }
  /** The wire shape of a roster push, hub → member (multi-account §7.3). */
  export interface RosterPush {
    rev: number;
    defaultId: string;
    entries: { id: string; label: string; token: string; createdAt: number }[];
  }
  /** GET /api/fleet/accounts — read-only, masked previews only. */
  export interface FleetAccountsResponse {
    rev: number;
    defaultId?: string;
    role: "hub" | "replica";
    hubServerId?: string;
    accounts: { id: string; label: string; masked: string; createdAt: number }[];
  }
  /** The joiner's reply — its own identity, so the hub can record a real member (not a bare host). */
  export interface FleetPairResponse {
    ok: boolean;
    serverId?: string;
    serverName?: string;
    url?: string;
    error?: string;
  }
  /** POST /api/fleet/pair/ack — the hub confirms the member is recorded and the joiner disarms (HJ-16).
   *  Gated exactly as /pair is, and must carry the same hubServerId AND code the window locked to —
   *  otherwise any tailnet peer could cancel someone else's pairing window mid-flow. Idempotent. */
  export interface FleetPairAckRequest {
    code: string;
    hubServerId: string;
  }
  /** POST /api/fleet/token — rotation counterpart: identity-gated (no code), persistent rather than
   *  armed. See headless-join §8.6 for what `hubServerId` does and does not prove. */
  export interface FleetTokenRequest {
    token: string;
    hubServerId: string;
    todoistToken?: string;
    openRouterKey?: string;
    /** Optional roster carried on a credential push (§7.3). Absent from an older hub → today's
     *  behaviour exactly; ignored by an older joiner. */
    accounts?: RosterPush;
  }
  /** GET /api/environments/:id/readme — the repo's README, rendered (arch §8). */
  export interface EnvReadmeResponse {
    markdown?: RenderedMarkdown;
    text?: string;
    missing?: boolean;
  }
  /** GET /api/daemon/update (check) · POST /api/daemon/update (apply) — daemon self-update (§5).
   *  Lets native clients (macOS menu command) and scripts trigger an update without a WebSocket. */
  export interface DaemonUpdateResponse {
    ok: boolean;
    phase: "check" | "up-to-date" | "updated" | "error";
    output: string;
    currentVersion: string;
    behind?: number;
    willRestart?: boolean;
  }
}
