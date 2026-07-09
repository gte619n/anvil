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

export type Model = "opus" | "sonnet" | "haiku" | "fable";

/** The models a session can run on, in picker order. `label` is the human name shown in the UI;
 *  the daemon maps each `id` to the string the Agent SDK expects (see agent/models.ts). */
export const MODELS: readonly { id: Model; label: string }[] = [
  { id: "opus", label: "Opus 4.8" },
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
  isDefault?: boolean; // the single persistent "concierge" chat: pinned first, never killable/archivable (§0.6)
  pending?: boolean; // client-only: created offline, not yet realized on the daemon (never set by the server)
  icon?: string; // Material Symbols name chosen by Sonnet from the session title (arch §5)
  environmentId?: string; // the Environment this session was created from, if any
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
  choices?: string[]; // a prose-named file (e.g. "design.md") matched 2+ paths — the client picks one and re-reads
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
  // Coarse feature flags this build supports (e.g. "autopilot"). Lets a newer client skip commands a
  // member is too old to handle instead of getting `unknown command type` back. Absent on pre-capability
  // builds → the client treats every capability as unsupported for that server (graceful degradation).
  capabilities?: string[];
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

// ── Autopilot (task-autopilot plan review UI; see anvil-autopilot-ui.md) ──────────────
/** Rough size estimate the planner emits for a work unit; surfaced on the Autopilot card. */
export type AutopilotSize = "xs" | "s" | "m" | "l" | "xl";
export interface AutopilotEffort {
  size: AutopilotSize;
  filesTouched?: number; // the planner's guess at how many files the unit touches
}
/** The anvil autopilot's status, mirrored from the `anvil:*` Todoist labels. Kept in lockstep with
 *  STATUSES in src/integrations/status.ts (the server is the source of truth). */
export type AnvilStatus = "planned" | "needs-clarification" | "building" | "review" | "blocked" | "dismissed" | "completed" | "expired";
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
  effort?: AutopilotEffort;
  taskCount: number; // Todoist tasks bundled into the unit
  plan?: RenderedMarkdown; // full implementation plan (source + sanitized HTML) for the reader
  pipeline?: PipelineTraceInfo; // present once the autonomous dev pipeline (§4) has run on this unit
  createdAt: Iso8601;
  updatedAt: Iso8601;
}
/** The server's pending plans — answer to `autopilot.plans.list` (carries cid), and broadcast (no cid)
 *  whenever the set changes (a run plans new units, a refine updates one, a dismiss/start removes one). */
export interface AutopilotPlansEvent extends Envelope {
  type: "autopilot.plans";
  cid?: Cid;
  plans: AutopilotPlanInfo[];
}
/** One updated plan — the result of `autopilot.refine` (carries cid). */
export interface AutopilotPlanResultEvent extends Envelope {
  type: "autopilot.plan";
  cid?: Cid;
  plan: AutopilotPlanInfo;
}
/** The session a Go (`autopilot.start`) created to implement a plan. */
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
}
export interface TerminalExitEvent extends Envelope, SessionScoped {
  type: "terminal.exit";
  code: number;
}

/** The full set of messages the server may send. */
export type ServerEvent =
  // global
  | ServerHelloEvent
  | SessionListEvent
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | SessionDeletedEvent
  | BudgetEvent
  | EnvironmentsEvent
  | PromptsEvent
  | TodoistStatusEvent
  | TodoistProjectsResultEvent
  | LapoStatusEvent
  | LapoAuthorizeEvent
  | AuthStatusEvent
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
  | GitResultEvent
  | DaemonUpdateResultEvent
  | AckEvent
  | PongEvent
  | CommandErrorEvent
  // conversation
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

// Autopilot plan review (anvil-autopilot-ui.md). These drive the Autopilot section: list/refine/
// dismiss pending plans, launch one into a worktree session, or re-plan the linked projects.
export interface AutopilotPlansListCmd extends Envelope, Correlated {
  type: "autopilot.plans.list"; // this server's pending plans → autopilot.plans
}
export interface AutopilotRefineCmd extends Envelope, Correlated {
  type: "autopilot.refine"; // Claude rewrites the plan from the user's feedback → autopilot.plan
  workUnitId: string;
  feedback: string;
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
export interface AutopilotTagsResetCmd extends Envelope, Correlated {
  type: "autopilot.tags.reset"; // strip anvil:* labels (keep the Autopilot sourcing label) so tasks re-plan → autopilot.maintenance.result
}
export interface AutopilotClearCmd extends Envelope, Correlated {
  type: "autopilot.clear"; // wipe the whole pending pipeline AND strip anvil:* labels → autopilot.maintenance.result
}
export interface AutopilotScheduleGetCmd extends Envelope, Correlated {
  type: "autopilot.schedule.get"; // current schedule → autopilot.schedule
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

// 5g. Liveness (§6.4)

/** Application-level heartbeat; the server replies `pong`. See PongEvent for the why. */
export interface PingCmd extends Envelope {
  type: "ping";
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
  | SessionSetModelCmd
  | SessionSetAutonomyCmd
  | SessionSetAdversarialReviewCmd
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
  | AutopilotPlansListCmd
  | AutopilotRefineCmd
  | AutopilotDismissCmd
  | AutopilotStartCmd
  | AutopilotPipelineStartCmd
  | AutopilotPipelineMetricsCmd
  | AutopilotResolveCmd
  | AutopilotLinkCmd
  | AutopilotReassignCmd
  | AutopilotRunCmd
  | AutopilotTagsResetCmd
  | AutopilotClearCmd
  | AutopilotScheduleGetCmd
  | AutopilotScheduleSetCmd
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
  | PingCmd;

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
    serverId: string; // stable id for this server, persisted in the state dir — fleet identity (§3)
    serverName: string; // display name for this server (default: hostname) — fleet groundwork
    budget: Budget;
  }
  /** An Anvil server found on the tailnet by discovery (anvil-multi-server.md §4.1). */
  export interface DiscoveredServer {
    serverId: string; // stable identity (dedup key)
    serverName: string; // display name (falls back to the MagicDNS host)
    url: string; // https://<magicdns>:<port> — what the client would connect to
    version: string; // anvild version reported by /api/health
    online: boolean;
    isSelf: boolean; // this hub's own daemon (already connected)
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
