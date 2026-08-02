import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdirSync as ensureDir } from "node:fs";
import { basename, join } from "node:path";
import {
  PROTOCOL_VERSION,
  type AttachmentRef,
  type DirEntry,
  type FileContent,
  type AutonomyPolicy,
  type Budget,
  type BudgetEvent,
  type DaemonUpdateResultEvent,
  type Environment,
  type EnvironmentsEvent,
  type EnvironmentValidation,
  type PromptsEvent,
  type ModelLabelsEvent,
  type TodoistStatusEvent,
  type TodoistProjectsResultEvent,
  type LapoStatusEvent,
  type LapoAuthorizeEvent,
  type AutopilotPipelineMetricsEvent,
  type AutopilotPlansEvent,
  type TeamInfoEvent,
  type TeamPlan,
  type AutopilotPlanResultEvent,
  type AutopilotStartedEvent,
  type AutopilotSchedule,
  type AutopilotScheduleEvent,
  type AutopilotRunSnapshotEvent,
  type AutopilotMaintenanceResultEvent,
  type AuthProvider,
  type AuthStatusEvent,
  type AuthAccountsEvent,
  type CommandInfo,
  type GitCmd,
  type GitResultEvent,
  isModel,
  type Model,
  type PermissionDecision,
  type QuestionAnswer,
  type ServerEvent,
  type Session as SessionData,
  type SessionCreateCmd,
  type SessionListEvent,
  type SessionSource,
  type SessionGoal,
  type ResumeWatermarksEvent,
  type TelemetrySnapshotEvent,
} from "@protocol";
import { GOAL_MAX_ITERATIONS, parseGoalCommand, type GoalCommand } from "../agent/goal";
import { now } from "../util/envelope";
import { newId } from "../util/ids";
import type { ConnectionRegistry } from "../server/registry";
import { discoverSelfBaseUrl } from "../server/fleet";
import { Session } from "./session";
import { SessionStore } from "./store";
import { TerminalManager } from "./terminal-manager";
import { FileWatchManager } from "./file-watch-manager";
import { createWorktree, gitStatus, gitStatusAsync, recreateWorktree, removeWorktree, worktreeHealth } from "./worktree";
import { AgentDriver, type TurnUsage } from "../agent/driver";
import { skillPlugins } from "../agent/skills";
import type { PlanProposedHook } from "../agent/permissions";
import { buildDefaultToolsServer, DEFAULT_MCP_SERVER_NAME, DEFAULT_TOOL_IDS } from "../agent/default-tools";
import { TEAM_MCP_SERVER_NAME, TEAM_TOOL_IDS } from "../agent/team-tools";
import { MEMBER_MCP_SERVER_NAME, MEMBER_TOOL_IDS } from "../agent/member-tools";
import { PLANNING_MCP_SERVER_NAME, PLANNING_TOOL_IDS } from "../agent/planning-tools";
import { buildAgentEnv, NO_CLAUDE_TOKEN_ERROR } from "../agent/env";
import { fetchModelCatalog, resolveModelLabels } from "../agent/model-catalog";
import { ModelLabelStore } from "../models/store";
import { CLAUDE_TOKEN_KEY } from "../auth/store";
import { PermissionBroker } from "../agent/permissions";
import { QuestionBroker } from "../agent/questions";
import { PassthroughRenderer, type MarkdownRenderer } from "../render/markdown";
import { EventLog } from "../eventlog/log";
import { RateLimitTracker } from "../budget/tracker";
import { EnvironmentStore } from "../env/store";
import { PromptStore } from "../prompts/store";
import { IntegrationStore } from "../integrations/store";
import { IntegrationsFacade } from "./integrations-facade";
import { AccountRosterService } from "./account-roster-service";
import { EnvironmentService } from "./environment-service";
import { GitProjectionService } from "./git-projection-service";
import { AutopilotService } from "./autopilot-service";
import { TeamCoordinator } from "./team-coordinator";
import { slugify } from "./slug";
import type { WorkUnit } from "../integrations/workunit";
import { claudeAuthStatus, clearClaudeToken, setClaudeToken } from "../auth/store";
import { AccountStore } from "../auth/accounts";
import type { PairedHubStore } from "../server/pairing";
import { OPENROUTER_KEY, clearOpenRouterKey, openRouterAuthStatus, setOpenRouterKey } from "../auth/openrouter";
import { OpenRouterClient } from "../integrations/openrouter";
import { reviewPlan, formatReview } from "../integrations/adversarial";
import type { PipelineOutcome } from "../pipeline/orchestrator";
import { AttachmentStore } from "../attach/store";
import { FileNotFound, listDir, locateInside, readFile, resolveInside, writeFile } from "../fs/session-fs";
import * as git from "../git/ops";
import * as selfupdate from "../daemon/selfupdate";
import { UpdateStateStore } from "../daemon/update-state";
import { updateApply, updateCheck, type UpdateApiDeps } from "../daemon/update-api";
import { VERSION } from "../version";
import { pickIcon } from "../agent/icon";
import { classifyBranchKind } from "../agent/branch-kind";
import { AuthDegradeTracker, type DegradeMarker } from "../auth/degrade";
import { WebPush, type PushPayload } from "../push/webpush";
import { Fcm } from "../push/fcm";
import { Apns } from "../push/apns";

// BadCommand moved to ./errors so domain services (IntegrationsFacade, …) can throw it without a
// circular import through supervisor.ts. Imported + re-exported here so existing importers keep working.
import { BadCommand } from "./errors";
export { BadCommand };

/** Stable sentinel id for the single persistent "concierge" default chat (§0.6). `newId` is random
 *  so this can never collide with an ordinary session. */
export const DEFAULT_SESSION_ID = "sess_default";

export interface SupervisorConfig {
  stateDir: string;
  /** The Claude account roster (multi-account §3). Passed in from `createServer()` so there is exactly
   *  one `AccountStore` instance per process; constructed over `stateDir` when omitted (unit tests that
   *  don't exercise accounts). */
  accounts?: AccountStore;
  /** This machine's paired-hub record, so a replica's `auth.accounts` broadcast can name the hub that
   *  owns it (§7.2). Read-only here — pairing itself is unaffected by the roster. */
  pairedHub?: PairedHubStore;
  /** Replicate this hub's roster to its fleet members after a mutation (§7.3). Defined in http.ts,
   *  where the FleetStore lives; omitted in unit tests and on a machine with no members. */
  onRosterChanged?: (reason: string) => void;
  /** Where the roster's default account is mirrored (multi-account §3.2). Defaults to the launcher's
   *  real `~/.config/anvil/env`. Tests MUST override this: a roster mutation mirrors unconditionally,
   *  so without an override `bun test` overwrites the developer's own Claude credential with a
   *  fixture token. */
  envFile?: string;
  /** The tailnet-facing port (== ANVIL_PORT). Used to build this daemon's self-URL for deep links. */
  port?: number;
  /** Where repos added by git URL get cloned (see `Config.clonesDir`). Defaults to `<stateDir>/repos`. */
  clonesDir?: string;
  warnFraction?: number;
  softStopFraction?: number;
  /** Fire one model-label refresh shortly after construction. The real daemon (main.ts) sets this; it
   *  defaults off so tests that spin up a Supervisor never make a live Models API call. The recurring
   *  ~4h refresh is always armed regardless (it just never fires within a test's lifetime). */
  refreshModelLabelsOnBoot?: boolean;
  renderer?: MarkdownRenderer;
  /** Competing models the adversarial panel critiques plans with (OpenRouter slugs). The KEY itself is
   *  read live from the environment at run time (Settings → Models writes it), not passed here. */
  adversarialModels?: string[];
  /** Preferred OpenRouter provider slug for the panel (see `Config.adversarialProvider`). */
  adversarialProvider?: string;
}

/**
 * The session registry + lifecycle owner (arch §5). Creates (existing-dir or fresh-
 * worktree), persists, restores on startup, and kills (process-group reap + worktree
 * cleanup). Broadcasts global `session.*` events; session-scoped events flow through each
 * `Session`'s `emit` to attached connections.
 */
export class Supervisor {
  private readonly store: SessionStore;
  private readonly sessions = new Map<string, Session>();
  private readonly drivers = new Map<string, AgentDriver>();
  private readonly logs = new Map<string, EventLog>();
  /** Resilience telemetry (v4, §5.7): the daemon's own counters + the latest report from each client. */
  private readonly serverCounters: Record<string, number> = { resumeDelta: 0, resumeSnapshot: 0, promptDeduped: 0 };
  // [BE2-23/SEC2-4] Bounded, TTL'd, and validated: keyed by an UNvalidated client-supplied id, this map
  // otherwise grows forever (a leak + a trivial DoS — flood unique ids) and the whole thing is
  // re-serialized into a broadcast on every report. Insertion-ordered LRU (re-set moves to newest);
  // evict oldest past the cap; drop entries past the TTL on read/write.
  private readonly clientTelemetry = new Map<string, { counters: Record<string, number>; at: number }>();
  private static readonly MAX_TELEMETRY_CLIENTS = 50;
  private static readonly TELEMETRY_TTL_MS = 30 * 60_000;
  private telemetryBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly broker = new PermissionBroker();
  private readonly questionBroker = new QuestionBroker();
  /** Sessions whose awaiting_permission state has been announced to the whole fleet (list badge). */
  private readonly awaitingAnnounced = new Set<string>();
  /** Sessions with an outstanding "your turn" push out on devices — so we can send a matching
   *  "clear" push to dismiss it everywhere once the session is viewed/answered (UI refinement §1). */
  private readonly notified = new Set<string>();
  private readonly renderer: MarkdownRenderer;
  /** The §3 allow-list env for spawned agents/terminals. Built fresh per call (not cached) so a token
   *  set/reset via the UI (auth.set), or a roster change, reaches the next session/run without a
   *  daemon restart. `s` resolves the spawn's Claude account (multi-account §4.1); omitted for
   *  short-lived utility spawns (icon/branch-kind), which use the roster default. */
  private agentEnv(s?: Session, opts: { requireToken?: boolean } = {}): Record<string, string> {
    return buildAgentEnv({ accounts: this.accounts, ...(s?.data.accountId ? { accountId: s.data.accountId } : {}), ...opts });
  }
  /** Same allow-list, but tolerant of a missing Claude token — for the session TERMINAL, which must keep
   *  working on a degraded machine (HJ-25/§8.3). Only agent turns are gated on the credential. */
  private shellEnv(s?: Session): Record<string, string> {
    return this.agentEnv(s, { requireToken: false });
  }
  /** In-process MCP tools for the concierge chat (§0.6). The handlers are lazy closures over `this`,
   *  so this initializer is safe even though `envStore` is assigned in the constructor body. */
  private readonly defaultToolsServer = buildDefaultToolsServer({
    listSessions: () => this.list(),
    getSession: (id) => this.sessions.get(id)?.data,
    listEnvironments: () => this.envStore.list(),
    handoff: (a) => this.handoffCreate(a),
  });
  private readonly rateLimits: RateLimitTracker;
  private readonly envStore: EnvironmentStore;
  private readonly promptStore: PromptStore;
  private readonly updateState: UpdateStateStore;
  /** Live model-tier labels (hub-refreshed from the Models API); empty until the first refresh lands. */
  private readonly modelLabels: ModelLabelStore;
  private modelLabelTimer?: ReturnType<typeof setInterval>;
  private readonly integrations: IntegrationStore;
  /** Todoist + lapo integration domain (P7 extraction). Constructed in the ctor once `integrations` exists. */
  private readonly integrationsFacade: IntegrationsFacade;
  /** Claude multi-account roster domain (P7 extraction). Constructed in the ctor once its deps exist. */
  private readonly accountRoster: AccountRosterService;
  /** Environment (project) CRUD + clone + README domain (P7 extraction). */
  private readonly environments: EnvironmentService;
  /** Git projection + PR-badge/sweep domain (P7 extraction). */
  private readonly gitProjection: GitProjectionService;
  /** Team orchestration domain — plan lifecycle, member spawn/queue/drain, relay guard, integration
   *  (P7 extraction; see docs/plans/anvil-team-support.md). */
  private readonly teams: TeamCoordinator;
  /** Autopilot domain — work-unit plans, runs, dev pipeline, schedule, Todoist/lapo sync (P7 extraction). */
  private readonly autopilot: AutopilotService;
  private prSweepTimer?: ReturnType<typeof setInterval>;
  private readonly attachStore: AttachmentStore;
  readonly webpush: WebPush;
  readonly fcm: Fcm;
  readonly apns: Apns;
  private readonly clonesDir: string;
  /** Static adversarial-panel config (models + preferred provider). The OpenRouter KEY and the
   *  ANVIL_ADVERSARIAL kill switch are resolved live from the environment at run time instead — so a key
   *  set from Settings → Models (which updates process.env + the env file) takes effect on the next run
   *  without a daemon restart, mirroring how the Claude token is picked up per agent spawn. */
  private readonly adversarial: { models: string[]; provider?: string };
  private readonly stateDir: string;
  /** The Claude account roster (multi-account §3). Exactly one instance per process — see
   *  `SupervisorConfig.accounts`. */
  readonly accounts: AccountStore;
  private readonly pairedHub?: PairedHubStore;
  private readonly onRosterChanged?: (reason: string) => void;
  private readonly envFile?: string;
  /** Auto-degrade on credential failure (§4.6). Assigned in the constructor — `stateDir` isn't known
   *  at field-initializer time. Also the read model for "is this machine degraded?" everywhere else. */
  readonly authDegrade!: AuthDegradeTracker;
  private readonly selfPort: number;
  /** Cached self base URL (deep-link target) — discovery shells out to `tailscale`, so cache it. */
  private selfBaseUrlCache?: { url: string | undefined; at: number };

  constructor(cfg: SupervisorConfig, private readonly registry: ConnectionRegistry) {
    this.renderer = cfg.renderer ?? new PassthroughRenderer();
    this.selfPort = cfg.port ?? 7701;
    this.clonesDir = cfg.clonesDir ?? join(cfg.stateDir, "repos");
    this.adversarial = {
      models: cfg.adversarialModels ?? [],
      provider: cfg.adversarialProvider,
    };
    this.stateDir = cfg.stateDir;
    this.accounts = cfg.accounts ?? new AccountStore(cfg.stateDir);
    this.pairedHub = cfg.pairedHub;
    this.onRosterChanged = cfg.onRosterChanged;
    this.envFile = cfg.envFile;
    // `(this as …)` — the field is `readonly` for every reader but must be assigned here, after
    // stateDir is known. The push registries aren't constructed yet, so notify lazily through `this`.
    (this as { authDegrade: AuthDegradeTracker }).authDegrade = new AuthDegradeTracker(cfg.stateDir, (marker) =>
      this.notifyAuthDegraded(marker),
    );
    this.store = new SessionStore(cfg.stateDir);
    this.envStore = new EnvironmentStore(cfg.stateDir);
    this.environments = new EnvironmentService({
      envStore: this.envStore,
      registry: this.registry,
      clonesDir: this.clonesDir,
      renderer: this.renderer,
    });
    this.gitProjection = new GitProjectionService({
      require: (id) => this.require(id),
      getSession: (id) => this.sessions.get(id),
      sessions: () => this.sessions.values(),
      persist: () => this.persist(),
      broadcastUpdated: (data) => this.broadcastUpdated(data),
    });
    this.teams = new TeamCoordinator({
      require: (id) => this.require(id),
      getSession: (id) => this.sessions.get(id),
      list: () => this.list(),
      registry: this.registry,
      persist: () => this.persist(),
      broadcastUpdated: (data) => this.broadcastUpdated(data),
      prompt: (sessionId, text) => this.prompt(sessionId, text),
      kill: (id) => this.kill(id),
      budget: () => this.budget(),
      getEnvironment: (id) => this.envStore.get(id),
      handoffCreate: (a) => this.handoffCreate(a),
    });
    this.promptStore = new PromptStore(cfg.stateDir);
    this.updateState = new UpdateStateStore(cfg.stateDir);
    this.modelLabels = new ModelLabelStore(cfg.stateDir);
    this.integrations = new IntegrationStore(cfg.stateDir);
    this.integrationsFacade = new IntegrationsFacade({
      integrations: this.integrations,
      registry: this.registry,
      selfBaseUrl: () => this.selfBaseUrl(),
      cachedSelfBaseUrl: () => this.selfBaseUrlCache?.url,
    });
    this.accountRoster = new AccountRosterService({
      accounts: this.accounts,
      registry: this.registry,
      envFile: this.envFile,
      envStore: this.envStore,
      pairedHub: this.pairedHub,
      sessions: () => this.sessions.values(),
      tokensBySession: () => this.tokensBySession(),
      restartIdleSessionsForNewToken: (before) => this.restartIdleSessionsForNewToken(before),
      ...(this.onRosterChanged ? { onRosterChanged: this.onRosterChanged } : {}),
      broadcastUpdated: (data) => this.broadcastUpdated(data),
      environmentsEvent: () => this.environmentsEvent(),
      persist: () => this.persist(),
    });
    this.autopilot = new AutopilotService({
      registry: this.registry,
      stateDir: cfg.stateDir,
      envStore: this.envStore,
      integrations: this.integrations,
      integrationsFacade: this.integrationsFacade,
      accounts: this.accounts,
      renderer: this.renderer,
      adversarial: this.adversarial,
      worktreeRoot: () => this.store.worktreeRoot(),
      selfBaseUrl: () => this.selfBaseUrl(),
      getSession: (id) => this.sessions.get(id),
      hasSession: (id) => this.sessions.has(id),
      require: (id) => this.require(id),
      budget: () => this.budget(),
      handoffCreate: (a) => this.handoffCreate(a),
      authDegraded: () => this.authDegrade.degraded(),
      claimDegradeEpisodeAlert: () => this.authDegrade.claimEpisodeAlert(),
      pushSystemAlert: (title, body, tag) => this.pushSystemAlert(title, body, tag),
      notifyAll: (payload) => {
        void this.webpush.notify(payload);
        void this.fcm.notify(payload);
        void this.apns.notify(payload);
      },
    });
    this.attachStore = new AttachmentStore(cfg.stateDir);
    this.webpush = new WebPush(cfg.stateDir);
    this.fcm = new Fcm(cfg.stateDir);
    this.apns = new Apns(cfg.stateDir);
    this.rateLimits = new RateLimitTracker({
      stateDir: cfg.stateDir,
      warnFraction: cfg.warnFraction ?? 0.8,
      softStopFraction: cfg.softStopFraction ?? 0.95,
    });
    this.restore();
    this.autopilot.startScheduler();
    this.startPrStateSweeper();
    this.startModelLabelRefresh(cfg.refreshModelLabelsOnBoot ?? false);
    // Warm the self-URL cache so the lapo callback URL is known by the time the UI opens; rebroadcast
    // the lapo status once discovery completes so an already-connected client sees the callback URL.
    void this.selfBaseUrl().then(() => this.registry.toAll(this.lapoStatusEvent()));
  }

  /** Keep the sidebar's PR/merge badges fresh for an already-open app: a connect triggers a sweep, but
   *  if the app stays connected while a PR is merged on GitHub nothing else would catch it. Sweep every
   *  few minutes, but only while a client is actually watching (no point spawning `gh` for nobody).
   *  `unref` so it never holds the process/test open. */
  private startPrStateSweeper(): void {
    this.prSweepTimer = setInterval(() => {
      if (this.registry.all().length > 0) void this.refreshAllPrStates();
    }, 4 * 60_000);
    this.prSweepTimer.unref?.();
  }
  /** Current hub-resolved model labels, broadcast to clients (empty until the first refresh). */
  modelLabelsEvent(): ModelLabelsEvent {
    return { v: PROTOCOL_VERSION, type: "model.labels", ts: now(), labels: this.modelLabels.get() };
  }
  /** Keep the picker's model labels current by re-deriving them from the Models API every ~4h. Fires an
   *  immediate refresh so a fresh install/label bump shows up shortly after boot rather than 4h later;
   *  `unref` so it never holds the process/test open. Any daemon runs this, but the client only applies
   *  the hub's copy (like the prompt library), so members' refreshes are harmless. */
  private startModelLabelRefresh(onBoot: boolean): void {
    if (onBoot) void this.refreshModelLabels();
    this.modelLabelTimer = setInterval(() => void this.refreshModelLabels(), 4 * 60 * 60_000);
    this.modelLabelTimer.unref?.();
  }
  /** Fetch the live catalog with the subscription OAuth token, re-derive the tier labels, and broadcast
   *  iff they changed. No token (unpaired/logged out) or an API error just leaves the last-known labels
   *  in place — never throws into the timer. */
  private async refreshModelLabels(): Promise<void> {
    const token = (process.env[CLAUDE_TOKEN_KEY] ?? "").trim();
    if (!token) return; // no subscription login yet — keep the cached/static labels
    try {
      const labels = resolveModelLabels(await fetchModelCatalog(token));
      if (Object.keys(labels).length > 0 && this.modelLabels.set(labels)) {
        this.registry.toAll(this.modelLabelsEvent());
      }
    } catch (e) {
      console.warn(`[models] label refresh failed: ${(e as Error).message}`);
    }
  }

  budget(): Budget {
    return this.rateLimits.snapshot();
  }
  budgetEvent(): BudgetEvent {
    return { v: PROTOCOL_VERSION, type: "budget", ts: now(), budget: this.rateLimits.snapshot() };
  }

  // ── Environments (projects) — delegated to EnvironmentService (P7 extraction). environmentsEvent is
  // kept here as a thin delegation because several other Supervisor domains + AccountRosterService read it.
  environmentsEvent(): EnvironmentsEvent {
    return this.environments.environmentsEvent();
  }
  getEnvironment(id: string): Environment | undefined {
    return this.environments.getEnvironment(id);
  }
  addEnvironment(name: string, repoRoot: string, defaultBase?: string, color?: string, icon?: string): void {
    this.environments.addEnvironment(name, repoRoot, defaultBase, color, icon);
  }
  cloneEnvironment(url: string, name?: string, defaultBase?: string, color?: string, icon?: string): void {
    this.environments.cloneEnvironment(url, name, defaultBase, color, icon);
  }

  private updating = false; // guards against concurrent applyUpdate (double-click → racing builds)

  /** Deps for the frozen update-API layer (stable-update-service spec §4.3). The legacy `daemon.update`
   *  command now delegates here so it shares ONE code path with `/api/update/v1/*` — crucially, it
   *  records the pre-pull SHA so the watchdog can roll a bad legacy-triggered update back too. */
  private updateDeps(): UpdateApiDeps {
    return { state: this.updateState, isManaged: selfupdate.isManaged, scheduleRestart: selfupdate.scheduleRestart };
  }

  /** Update the daemon itself (arch §5): pull its source, rebuild web, and restart to apply.
   *  `checkOnly` just fetches and reports whether an update is available. Kept for back-compat (the
   *  macOS menu command + native clients speak this); it delegates to the frozen v1 apply, mapping the
   *  richer v1 phases back onto the legacy check|up-to-date|updated|error shape (spec §4.3). */
  async daemonUpdate(checkOnly: boolean): Promise<DaemonUpdateResultEvent> {
    const base = { v: PROTOCOL_VERSION, type: "daemon.update.result" as const, ts: now(), currentVersion: VERSION };
    const deps = this.updateDeps();
    if (checkOnly) {
      const c = await updateCheck(deps);
      if (!c.ok) return { ...base, ok: false, phase: "error", output: c.error ?? "update check failed" };
      return { ...base, ok: true, phase: "check", output: c.output, behind: c.behind };
    }
    if (this.updating) return { ...base, ok: false, phase: "error", output: "an update is already in progress" };
    this.updating = true;
    try {
      // No pinned SHA → resolve the upstream tip (the legacy "latest on branch" behaviour).
      const r = await updateApply({}, deps);
      // v1 "restarting" ⇒ an update (or stale-process restart) is being applied; a restart is now
      // SCHEDULED (a ~1s setTimeout), so DELIBERATELY keep `updating` set — clearing it here would let a
      // second daemon.update slip in during that window and schedule a redundant second kickstart. The
      // guard is released for free when the process dies on restart.
      if (r.ok && r.phase === "restarting") {
        return { ...base, ok: true, phase: "updated", output: r.output, willRestart: r.willRestart };
      }
      // No restart coming (up-to-date, error, or unmanaged) — release the guard so another attempt works.
      this.updating = false;
      if (!r.ok) return { ...base, ok: false, phase: "error", output: r.error ?? r.output };
      return { ...base, ok: true, phase: "up-to-date", output: r.output, behind: 0 };
    } catch (e) {
      this.updating = false; // updateApply shouldn't reject, but never leave the guard stuck on a throw
      return { ...base, ok: false, phase: "error", output: e instanceof Error ? e.message : String(e) };
    }
  }
  envReadme(id: string): { markdown?: ReturnType<MarkdownRenderer["render"]>; text?: string; missing?: boolean } {
    return this.environments.envReadme(id);
  }
  updateEnvironment(
    id: string,
    fields: {
      name?: string;
      defaultBase?: string;
      color?: string;
      icon?: string;
      todoistProjectId?: string | null;
      validation?: EnvironmentValidation | null;
      accountId?: string | null;
    },
  ): void {
    this.environments.updateEnvironment(id, fields);
  }

  // ── Prompt library (saved composer snippets, synced across a user's devices) ───
  promptsEvent(): PromptsEvent {
    return { v: PROTOCOL_VERSION, type: "prompts", ts: now(), prompts: this.promptStore.list() };
  }
  savePrompt(fields: { id?: string; title: string; shortTitle: string; icon: string; body: string }): void {
    try {
      this.promptStore.save(fields);
    } catch (e) {
      throw new BadCommand(e instanceof Error ? e.message : String(e));
    }
    this.registry.toAll(this.promptsEvent());
  }
  removePrompt(id: string): void {
    this.promptStore.remove(id);
    this.registry.toAll(this.promptsEvent());
  }

  // ── Integrations (Todoist + lapo) — delegated to IntegrationsFacade (P7 extraction) ──────────────
  todoistStatusEvent(cid?: string): TodoistStatusEvent {
    return this.integrationsFacade.todoistStatusEvent(cid);
  }
  connectTodoist(token: string, cid?: string): Promise<TodoistStatusEvent> {
    return this.integrationsFacade.connectTodoist(token, cid);
  }
  todoistTokenForFleet(): string | undefined {
    return this.integrationsFacade.todoistTokenForFleet();
  }
  disconnectTodoist(cid?: string): TodoistStatusEvent {
    return this.integrationsFacade.disconnectTodoist(cid);
  }

  // lapo (OAuth2 information-entry reports) — delegated to IntegrationsFacade. `postAutopilotReport`
  // reuses the facade's effectiveLapoConfig()/lapoAccessToken() directly (see below).
  lapoStatusEvent(cid?: string): LapoStatusEvent {
    return this.integrationsFacade.lapoStatusEvent(cid);
  }
  beginLapoAuth(redirectBase: string, cid?: string): Promise<LapoAuthorizeEvent> {
    return this.integrationsFacade.beginLapoAuth(redirectBase, cid);
  }
  completeLapoAuth(code: string, state: string): Promise<{ account?: string }> {
    return this.integrationsFacade.completeLapoAuth(code, state);
  }
  disconnectLapo(cid?: string): LapoStatusEvent {
    return this.integrationsFacade.disconnectLapo(cid);
  }

  /** This daemon's externally-reachable base URL, for deep links in outbound reports. Discovery shells
   *  out to `tailscale`, so cache it (~1h). `ANVIL_BASE_URL` overrides and is read live. */
  async selfBaseUrl(): Promise<string | undefined> {
    const override = process.env.ANVIL_BASE_URL?.trim();
    if (override) return override.replace(/\/+$/, "");
    const now = Date.now();
    if (this.selfBaseUrlCache && now - this.selfBaseUrlCache.at < 3_600_000) return this.selfBaseUrlCache.url;
    const url = await discoverSelfBaseUrl({ port: this.selfPort });
    this.selfBaseUrlCache = { url, at: now };
    return url;
  }

  /** This machine's bare MagicDNS name — what the operator picks on the hub's "Add a machine" list, so
   *  the setup screen can show them exactly which candidate is theirs (§5.1). Derived from
   *  {@link selfBaseUrl} so it agrees with whatever transport actually answers. */
  async selfHost(): Promise<string | undefined> {
    const base = await this.selfBaseUrl();
    if (!base) return undefined;
    try {
      return new URL(base).hostname;
    } catch {
      return undefined;
    }
  }

  /**
   * Drop one session's live driver so the next prompt rebuilds it with a fresh env. `claudeSessionId`
   * is KEPT, so `ensureDriver()`'s `resume` rejoins the same conversation on the new token (§5.3).
   * Returns false when the session is mid-turn and was left alone.
   */
  private async restartDriverForNewToken(id: string): Promise<boolean> {
    const status = this.sessions.get(id)?.data.status;
    if (status && status !== "idle") return false;
    const driver = this.drivers.get(id);
    if (!driver) return true;
    this.drivers.delete(id);
    await driver.stop().catch(() => {}); // best-effort — a dead driver is already what we want
    return true;
  }

  /**
   * A new Claude credential just landed (a pair, a rotation, a paste, or a roster mutation). Sessions
   * build their agent env per spawn, so nothing needs a restart to pick it up — but a session whose
   * DRIVER is already running holds the old env for the life of its `query()`. Drop the drivers of IDLE
   * sessions so the next turn rebuilds with the new token; sessions mid-turn are left alone and flagged
   * instead, since tearing down a running turn would lose its work (HJ-11).
   *
   * `before` — a per-session token snapshot from {@link tokensBySession} taken BEFORE the change —
   * narrows this to only sessions whose OWN resolved token actually changed. With a roster, adding a
   * non-default account (or replacing a token no live session is pinned to) changes nothing for anyone;
   * restarting every driver anyway would drop perfectly good live sessions for no reason. Omit it to
   * restart unconditionally (the pre-roster single-token call sites, where every session shares the one
   * credential).
   */
  async restartIdleSessionsForNewToken(before?: Map<string, string | undefined>): Promise<void> {
    const busy: string[] = [];
    for (const [id] of [...this.drivers]) {
      const s = this.sessions.get(id);
      if (!s) continue;
      if (before) {
        const prev = before.get(id);
        const nowTok = this.accounts.token(s.data.accountId);
        if (prev === nowTok) continue; // this session's resolved token is unchanged — leave it running
      }
      if (!(await this.restartDriverForNewToken(id))) busy.push(id);
    }
    if (busy.length) {
      for (const id of busy) {
        this.sessions
          .get(id)
          ?.emitError("This machine's Claude login changed while this session was mid-turn. Finish or interrupt the turn — the new login applies from the next one.", false);
      }
      console.log(`[fleet] token changed — ${busy.length} session(s) mid-turn kept on the old login until they settle`);
    }
  }

  /** Snapshot every live (driver-holding) session's CURRENTLY resolved token, to diff against after a
   *  roster change — see {@link restartIdleSessionsForNewToken}. */
  tokensBySession(): Map<string, string | undefined> {
    return new Map([...this.drivers.keys()].map((id) => [id, this.accounts.token(this.sessions.get(id)?.data.accountId)]));
  }

  // ── Model-provider auth (Settings → Models) ──────────
  // Two providers share this surface: "claude" (the subscription OAuth token driving the Agent SDK) and
  // "openrouter" (the metered key powering the adversarial planning panel). Each has its own env-file-
  // backed store; the OpenRouter key is deliberately outside the §3 metered-key guard (different provider).
  private authStatusEvent(provider: AuthProvider, cid?: string): AuthStatusEvent {
    const status = provider === "openrouter" ? openRouterAuthStatus() : claudeAuthStatus();
    return { v: PROTOCOL_VERSION, type: "auth.status", ts: now(), ...(cid ? { cid } : {}), ...status };
  }
  /** Current credential state for a provider's Models card (defaults to Claude for back-compat). */
  authStatus(provider: AuthProvider = "claude", cid?: string): AuthStatusEvent {
    return this.authStatusEvent(provider, cid);
  }
  /** Set/replace a provider's token (persisted to the launcher env file + applied live). Throws
   *  BadCommand on an empty or (for Claude) metered-looking key so the UI can surface the reason. */
  setAuthToken(provider: AuthProvider, token: string, cid?: string): AuthStatusEvent {
    try {
      if (provider === "openrouter") setOpenRouterKey(token);
      else setClaudeToken(token);
    } catch (e) {
      throw new BadCommand(e instanceof Error ? e.message : String(e));
    }
    this.registry.toAll(this.authStatusEvent(provider));
    return this.authStatusEvent(provider, cid);
  }
  /** Remove a provider's token from the daemon + env file. */
  clearAuthToken(provider: AuthProvider, cid?: string): AuthStatusEvent {
    if (provider === "openrouter") clearOpenRouterKey();
    else clearClaudeToken();
    this.registry.toAll(this.authStatusEvent(provider));
    return this.authStatusEvent(provider, cid);
  }

  // ── Claude account roster (multi-account §7/§9) — delegated to AccountRosterService (P7 extraction) ──
  sessionsUsingAccount(accountId: string): { sessionId: string; title: string }[] {
    return this.accountRoster.sessionsUsingAccount(accountId);
  }
  accountsEvent(cid?: string): AuthAccountsEvent {
    return this.accountRoster.accountsEvent(cid);
  }
  broadcastAccounts(): void {
    this.accountRoster.broadcastAccounts();
  }
  accountAdd(label: string, token: string, cid?: string): AuthAccountsEvent {
    return this.accountRoster.accountAdd(label, token, cid);
  }
  accountRename(accountId: string, label: string, cid?: string): AuthAccountsEvent {
    return this.accountRoster.accountRename(accountId, label, cid);
  }
  accountReplace(accountId: string, token: string, cid?: string): AuthAccountsEvent {
    return this.accountRoster.accountReplace(accountId, token, cid);
  }
  accountSetDefault(accountId: string, cid?: string): AuthAccountsEvent {
    return this.accountRoster.accountSetDefault(accountId, cid);
  }
  accountRemove(accountId: string, cid?: string): AuthAccountsEvent {
    return this.accountRoster.accountRemove(accountId, cid);
  }

  /** Live-fetch the connected account's projects (with active task counts) for the link UI. */
  listTodoistProjects(cid?: string): Promise<TodoistProjectsResultEvent> {
    return this.integrationsFacade.listTodoistProjects(cid);
  }

  // ── Autopilot — delegated to AutopilotService (P7 extraction). The thin wrappers below are the
  // wire/dispatch entry points; the domain (plan cards, runs, dev pipeline, schedule, Todoist/lapo
  // sync) lives in autopilot-service.ts.
  devPipelineMetricsEvent(cid?: string): AutopilotPipelineMetricsEvent {
    return this.autopilot.devPipelineMetricsEvent(cid);
  }
  autopilotPlansEvent(cid?: string): AutopilotPlansEvent {
    return this.autopilot.autopilotPlansEvent(cid);
  }
  startPlanningSession(workUnitId: string, model?: Model, autonomy?: AutonomyPolicy, cid?: string): Promise<AutopilotStartedEvent> {
    return this.autopilot.startPlanningSession(workUnitId, model, autonomy, cid);
  }
  reassignPlan(workUnitId: string, environmentId: string, cid?: string): Promise<AutopilotPlanResultEvent> {
    return this.autopilot.reassignPlan(workUnitId, environmentId, cid);
  }
  dismissPlan(workUnitId: string): Promise<void> {
    return this.autopilot.dismissPlan(workUnitId);
  }
  resolvePlan(workUnitId: string, status: "completed" | "expired", closeTodoist: boolean): Promise<void> {
    return this.autopilot.resolvePlan(workUnitId, status, closeTodoist);
  }
  reconcileCompletedUnits(): Promise<number> {
    return this.autopilot.reconcileCompletedUnits();
  }
  resetAnvilTags(cid?: string): Promise<AutopilotMaintenanceResultEvent> {
    return this.autopilot.resetAnvilTags(cid);
  }
  clearAutopilot(cid?: string): Promise<AutopilotMaintenanceResultEvent> {
    return this.autopilot.clearAutopilot(cid);
  }
  startPlan(workUnitId: string, model?: Model, autonomy?: AutonomyPolicy, cid?: string): Promise<AutopilotStartedEvent> {
    return this.autopilot.startPlan(workUnitId, model, autonomy, cid);
  }
  linkPlan(workUnitId: string, sessionId: string, cid?: string): AutopilotStartedEvent {
    return this.autopilot.linkPlan(workUnitId, sessionId, cid);
  }
  runAutopilot(opts: {
    environmentId?: string;
    notify?: boolean;
    autoStart?: boolean;
    usePipeline?: boolean;
    maxAutoStart?: number;
  }): Promise<{ created: number; skipped: number; started: number; output: string }> {
    return this.autopilot.runAutopilot(opts);
  }
  runDevPipeline(workUnitId: string, opts: { signal?: AbortSignal; onProgress?: (m: string) => void } = {}): Promise<PipelineOutcome> {
    return this.autopilot.runDevPipeline(workUnitId, opts);
  }
  autopilotScheduleEvent(cid?: string): AutopilotScheduleEvent {
    return this.autopilot.autopilotScheduleEvent(cid);
  }
  autopilotRunSnapshotEvent(cid?: string): AutopilotRunSnapshotEvent {
    return this.autopilot.autopilotRunSnapshotEvent(cid);
  }
  setAutopilotSchedule(patch: Partial<Omit<AutopilotSchedule, "lastRunAt">>, cid?: string): AutopilotScheduleEvent {
    return this.autopilot.setAutopilotSchedule(patch, cid);
  }
  postAutopilotReport(input: {
    units: WorkUnit[];
    skipped: number;
    started: number;
    startedIds: Set<string>;
    trigger: "scheduled" | "manual";
  }): Promise<void> {
    return this.autopilot.postAutopilotReport(input);
  }

  // ── Teams — delegated to TeamCoordinator (P7 extraction). The thin wrappers below are the wire/
  // dispatch entry points; the orchestration (plan lifecycle, spawn/queue/drain, relay guard,
  // integration) lives in team-coordinator.ts.
  /** Derived team tree (team.info) — sent on connect alongside the session list. */
  teamInfoEvent(): TeamInfoEvent {
    return this.teams.teamInfoEvent();
  }
  /** A human prompt to a team session resets that team's relay-loop guard (prompt.send path). */
  noteHumanPrompt(sessionId: string): void {
    this.teams.noteHumanPrompt(sessionId);
  }
  approveTeamPlan(leadId: string, plan?: TeamPlan): Promise<void> {
    return this.teams.approveTeamPlan(leadId, plan);
  }
  rejectTeamPlan(leadId: string): void {
    this.teams.rejectTeamPlan(leadId);
  }
  integrateTeam(leadId: string): string {
    return this.teams.integrateTeam(leadId);
  }

  removeEnvironment(id: string): void {
    this.environments.removeEnvironment(id);
  }

  /** Events to send a (re)attaching connection (arch §6.4): replay seq > lastSeq, else snapshot. */
  resume(id: string, lastSeq?: number): ServerEvent[] {
    const s = this.require(id);
    const log = this.logs.get(id);
    if (!log) return [];
    this.noteServerCounter(lastSeq === undefined ? "resumeSnapshot" : "resumeDelta"); // §5.7: what we served
    const events = lastSeq === undefined ? [log.snapshot(id, s.lastSeq, s.epoch)] : log.since(lastSeq);
    // Always end with the live status so a re-attaching client's thinking indicator reflects
    // reality (the per-turn `status` events it missed while detached aren't replayed).
    events.push({ v: PROTOCOL_VERSION, type: "status", ts: now(), sessionId: id, seq: s.lastSeq, status: s.data.status });
    // Re-surface every unanswered permission prompt: the snapshot drops permission.request (it isn't
    // conversation history), so without this a client that cold-attaches to a blocked session would
    // never see the prompt — the request would be "lost" and the session stuck forever. A session can
    // hold several at once (sub-agent fan-out), so re-surface all of them (arch §6.6).
    for (const pending of s.permissionRequestEvents()) events.push(pending);
    // Same for parked AskUserQuestions — question.request isn't conversation history, so a cold
    // attach would otherwise never see them and the session would look stuck. Re-surface all of them
    // (a session can hold several at once, like permissions). (arch §6.6).
    for (const pendingQuestion of s.questionRequestEvents()) events.push(pendingQuestion);
    return events;
  }

  list(): SessionData[] {
    // The concierge default chat is always pinned first; everything else keeps insertion order.
    return [...this.sessions.values()]
      .map((s) => s.data)
      .sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
  }
  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }
  sessionListEvent(): SessionListEvent {
    return { v: PROTOCOL_VERSION, type: "session.list", ts: now(), sessions: this.list() };
  }
  /** Cheap per-session resume watermarks (v4, §6.4) — sent on connect so a cold-opening client can
   *  verify its cached transcript (epoch + lastSeq) without pulling a full snapshot. In-memory only:
   *  O(sessions), no event-log reads. */
  resumeWatermarksEvent(): ResumeWatermarksEvent {
    return {
      v: PROTOCOL_VERSION,
      type: "resume.watermarks",
      ts: now(),
      watermarks: [...this.sessions.values()].map((s) => ({ sessionId: s.id, epoch: s.epoch, lastSeq: s.lastSeq })),
    };
  }
  /** Whether a prompt with this `cid` was already applied to the session (v4 exactly-once dedupe). */
  isPromptApplied(id: string, cid: string): boolean {
    return this.sessions.get(id)?.isPromptApplied(cid) ?? false;
  }

  // ── Telemetry (v4, §5.7) ──────────────────────────────────────────────────
  /** Bump a daemon-side counter (e.g. a deduped prompt). */
  noteServerCounter(key: string): void {
    this.serverCounters[key] = (this.serverCounters[key] ?? 0) + 1;
  }
  /** Record a client's latest counter report (keyed by its stable clientId). [BE2-23/SEC2-4] The id and
   *  counters are client-supplied, so both are validated; the map is an LRU capped at MAX_TELEMETRY_CLIENTS. */
  recordClientTelemetry(clientId: string, counters: Record<string, number>): void {
    if (typeof clientId !== "string" || !clientId || clientId.length > 200) return; // reject junk/oversized ids
    const clean = sanitizeCounters(counters);
    if (!clean) return; // not a plain object, or too many keys → ignore the report entirely
    this.clientTelemetry.delete(clientId); // re-insert at the end so this id becomes the newest (LRU)
    this.clientTelemetry.set(clientId, { counters: clean, at: Date.now() });
    // Evict the oldest entries past the cap (Map preserves insertion order → first key is the oldest).
    while (this.clientTelemetry.size > Supervisor.MAX_TELEMETRY_CLIENTS) {
      const oldest = this.clientTelemetry.keys().next().value;
      if (oldest === undefined) break;
      this.clientTelemetry.delete(oldest);
    }
  }
  /** The aggregated telemetry snapshot broadcast on connect + whenever a client reports (spec D11). */
  telemetrySnapshotEvent(): TelemetrySnapshotEvent {
    const cutoff = Date.now() - Supervisor.TELEMETRY_TTL_MS;
    const clients: Record<string, Record<string, number>> = {};
    for (const [id, rec] of this.clientTelemetry) {
      if (rec.at < cutoff) {
        this.clientTelemetry.delete(id); // stale — prune lazily on read
        continue;
      }
      clients[id] = rec.counters;
    }
    return {
      v: PROTOCOL_VERSION,
      type: "telemetry.snapshot",
      ts: now(),
      server: { ...this.serverCounters },
      clients,
    };
  }
  /** Broadcast the current telemetry snapshot to every connected client. [BE2-23] Coalesced: a burst of
   *  reports (or a reconnect storm) collapses into at most one broadcast per 250ms instead of
   *  re-serializing + fanning out the whole map on every single report. */
  broadcastTelemetry(): void {
    if (this.telemetryBroadcastTimer) return;
    this.telemetryBroadcastTimer = setTimeout(() => {
      this.telemetryBroadcastTimer = null;
      this.registry.toAll(this.telemetrySnapshotEvent());
    }, 250);
    this.telemetryBroadcastTimer.unref?.(); // never hold the process/test open for a coalesced broadcast
  }

  // [BE2-2] Async: a fresh-worktree create runs a network `git fetch` (base sync) plus the worktree
  // add — those now park this create instead of freezing the daemon, so every other session/client
  // stays live while it runs. Failures still surface as BadCommand to the dispatcher.
  async create(cmd: SessionCreateCmd): Promise<Session> {
    const id = newId("sess");
    let cwd: string;
    let worktree: SessionData["worktree"];

    if (cmd.source === "fresh-worktree") {
      if (!cmd.repoRoot) throw new BadCommand("repoRoot is required for a fresh-worktree session");
      const branch = slugify(cmd.title ?? "session");
      try {
        const created = await createWorktree(cmd.repoRoot, cmd.base ?? "HEAD", branch, this.store.worktreeRoot(), id);
        cwd = created.cwd;
        worktree = created.worktree;
      } catch (e) {
        throw new BadCommand(
          `Couldn't create worktree "${branch}": ${e instanceof Error ? e.message : String(e)} — try a different session name.`,
        );
      }
    } else {
      if (!cmd.cwd) throw new BadCommand("cwd is required for an existing-dir session");
      cwd = cmd.cwd;
    }

    // Resolve the account this session spawns under (multi-account §5): the command's explicit choice,
    // else the environment's default, else the roster default. An explicit accountId that doesn't
    // resolve is rejected outright — silently falling back would bill another subscription.
    const accountId = cmd.accountId ?? (cmd.environmentId ? this.envStore.get(cmd.environmentId)?.accountId : undefined) ?? this.accounts.defaultId();
    if (accountId && !this.accounts.has(accountId)) {
      throw new BadCommand(`unknown Claude account ${accountId} — it may have been removed; pick another in Settings → Models`);
    }

    mkdirSync(this.store.sessionDir(id), { recursive: true });
    const data: SessionData = {
      id,
      title: cmd.title ?? deriveTitle(cwd),
      environmentId: cmd.environmentId,
      cwd,
      source: cmd.source,
      worktree,
      git: await gitStatusAsync(cwd),
      model: cmd.model ?? "opus",
      autonomy: cmd.autonomy ?? "mostly-autonomous",
      adversarialReview: cmd.adversarialReview ?? false,
      status: "idle",
      createdAt: now(),
      lastActivityAt: now(),
      usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
      ...(accountId ? { accountId, accountLabel: this.accounts.labelOf(accountId) } : {}),
    };
    // Teams: a session created as a lead carries its role + integration/concurrency policy (defaults
    // applied here). Members are never created via this command — the lead's MCP tools stamp them.
    if (cmd.teamRole === "lead") {
      data.teamRole = "lead";
      data.team = {
        integration: cmd.team?.integration === "pr-per-member" ? "pr-per-member" : "combined-pr",
        // #3: clamp to >= 1 — a cap of 0/negative would queue every member and start none (wedge).
        maxConcurrentMembers: Math.max(1, Math.floor(cmd.team?.maxConcurrentMembers ?? 3)),
      };
    }

    const session = this.wrap(data, 0);
    this.sessions.set(id, session);
    this.persist();
    void this.assignIcon(session); // async: Sonnet picks an icon from the title (arch §5)
    return session; // dispatch announces session.created (creator gets the cid; others via registry)
  }

  /**
   * Create a session AND auto-start it on a seeded brief — the concierge's handoff path (§0.6).
   * Unlike a client-driven `create()` (announced by dispatch), a tool-driven create has no dispatch
   * frame, so this broadcasts `session.created` itself. `prompt()` emits the brief as `message.user`,
   * so it appears in the new session's history and starts the first turn.
   */
  private async handoffCreate(a: {
    environmentId?: string;
    source: SessionSource;
    cwd?: string;
    base?: string;
    title: string;
    model?: Model;
    autonomy?: AutonomyPolicy;
    brief: string;
    // ── Teams: link the new session to a lead as a member (see docs/plans/anvil-team-support.md) ──
    parentId?: string;
    teamRole?: "lead" | "member";
    memberTask?: string;
    repoRoot?: string; // #7: spawn a fresh-worktree member off this repo when there's no environment
    // ── Autopilot: mark a "Plan with Claude" planning session and link it to its work unit ──
    workUnitId?: string;
    workUnitRole?: "planner";
  }): Promise<{ id: string; title: string; cwd: string }> {
    let cmd: SessionCreateCmd;
    if (a.source === "fresh-worktree") {
      const env = a.environmentId ? this.envStore.get(a.environmentId) : undefined;
      // #7: fall back to an explicit repoRoot (the lead's own repo) when no environment is registered,
      // so a team lead created from a raw folder can still spawn members instead of every spawn failing.
      const repoRoot = env?.repoRoot ?? a.repoRoot;
      if (!repoRoot) {
        throw new BadCommand("a fresh-worktree handoff needs an environment or a repoRoot");
      }
      cmd = {
        v: PROTOCOL_VERSION,
        type: "session.create",
        ts: now(),
        source: "fresh-worktree",
        repoRoot,
        base: a.base ?? env?.defaultBase ?? "HEAD",
        title: a.title,
        environmentId: env?.id,
        model: a.model,
        autonomy: a.autonomy,
      };
    } else {
      if (!a.cwd) throw new BadCommand("cwd is required for an existing-dir handoff");
      cmd = {
        v: PROTOCOL_VERSION,
        type: "session.create",
        ts: now(),
        source: "existing-dir",
        cwd: a.cwd,
        title: a.title,
        environmentId: a.environmentId,
        model: a.model,
        autonomy: a.autonomy,
      };
    }
    const session = await this.create(cmd);
    // Teams: stamp the parent link BEFORE the session.created broadcast so members arrive labeled.
    if (a.parentId || a.teamRole || a.memberTask) {
      session.data.parentId = a.parentId;
      session.data.teamRole = a.teamRole;
      session.data.memberTask = a.memberTask;
      this.persist();
    }
    // Autopilot planning session: stamp its work-unit link (before broadcast) so it's driven with the
    // planning tools (save_plan / run_pipeline) and the card can jump to it.
    if (a.workUnitId || a.workUnitRole) {
      session.data.workUnitId = a.workUnitId;
      session.data.workUnitRole = a.workUnitRole;
      this.persist();
    }
    this.registry.toAll({ v: PROTOCOL_VERSION, type: "session.created", ts: now(), session: session.data });
    this.teams.broadcastTeamInfo(); // a new member/lead reshapes the derived team tree
    this.prompt(session.id, a.brief); // lazily starts the driver and runs the first turn
    return { id: session.id, title: session.data.title, cwd: session.data.cwd };
  }

  /** The driver reported the session's slash-commands/skills (from the SDK `init` message). Store them
   *  on the session and push via session.updated so every device's composer `/` menu can list them. */
  private onSessionCommands(id: string, commands: CommandInfo[]): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.data.commands = commands;
    this.persist();
    this.broadcastUpdated(s.data);
  }

  /** Fire-and-forget: ask Sonnet for a fitting icon, then push it via session.updated. */
  private async assignIcon(s: Session): Promise<void> {
    try {
      const icon = await pickIcon(s.data.title, this.agentEnv());
      if (icon && this.sessions.has(s.data.id)) {
        s.data.icon = icon;
        this.persist();
        this.broadcastUpdated(s.data);
      }
    } catch {
      /* keep the client's generic fallback icon */
    }
  }

  /**
   * Classify the worktree's REMOTE branch prefix from the opening brief and persist it (arch §8) —
   * the local branch keeps its bare slug; the remote reads as intent (`feature/…`/`bugfix/…`/
   * `hotfix/…`). Called eagerly once the first turn ends (the goal is now on the record). Idempotent
   * and safe to skip: no-op for non-worktree sessions, once a prefix is set, or on a branch already
   * pushed under some other name (adopting that upstream instead, so we never orphan a live remote).
   */
  private async ensureRemoteBranch(s: Session): Promise<void> {
    const wt = s.data.worktree;
    if (!wt || wt.remoteBranch) return;
    const existing = git.upstreamRemoteBranch(s.data.cwd);
    if (existing) {
      wt.remoteBranch = existing; // already pushed — keep its remote; re-prefixing would orphan it
      this.persist();
      return;
    }
    const kind = await classifyBranchKind(s.openingPrompt ?? s.data.title ?? "", this.agentEnv());
    // Re-read: the session may have been killed, or a concurrent push may have set the prefix first.
    if (!this.sessions.has(s.data.id) || !s.data.worktree || s.data.worktree.remoteBranch) return;
    s.data.worktree.remoteBranch = `${kind}/${s.data.worktree.branch}`;
    this.persist();
    this.broadcastUpdated(s.data);
  }

  /**
   * The remote branch to push to right now (synchronous). Normally the prefix was already classified
   * by the first turn (`ensureRemoteBranch`); but if a push races ahead of that LLM call, derive a
   * prefix from the keyword heuristic on the spot so we never push a bare, unprefixed remote. The
   * result is persisted so it stays stable. Returns undefined for non-worktree sessions.
   */
  // File browser & reader (arch §8.1/§8.2), scoped to the session worktree. Change-watching is
  // extracted to FileWatchManager (unit-tested); the Supervisor injects locate/read/session access.
  private readonly fileWatchMgr = new FileWatchManager(
    (sessionId) => {
      const s = this.require(sessionId);
      return { cwd: s.data.cwd, emit: (body) => s.emit(body) };
    },
    (cwd, path) => locateInside(cwd, path),
    (sessionId, path) => {
      const s = this.require(sessionId);
      return readFile(s.data.cwd, path, this.renderer, (p) => this.fileUrl(sessionId, p));
    },
  );

  fsList(sessionId: string, path: string): { path: string; entries: DirEntry[] } {
    return listDir(this.require(sessionId).data.cwd, path);
  }
  fsRead(sessionId: string, path: string): FileContent {
    const cwd = this.require(sessionId).data.cwd;
    try {
      return readFile(cwd, path, this.renderer, (p) => this.fileUrl(sessionId, p));
    } catch (e) {
      // A missing file is user-facing ("Couldn't find X"), not an internal error — surface it cleanly.
      if (e instanceof FileNotFound) throw new BadCommand(e.message);
      throw e;
    }
  }
  fsResolve(sessionId: string, path: string): string {
    return resolveInside(this.require(sessionId).data.cwd, path);
  }
  fsWrite(sessionId: string, path: string, data: Uint8Array): { path: string; size: number } {
    return writeFile(this.require(sessionId).data.cwd, path, data);
  }
  fsWatch(sessionId: string, path: string): void {
    this.fileWatchMgr.add(sessionId, path);
  }
  fsUnwatch(sessionId: string, path: string): void {
    this.fileWatchMgr.unwatch(sessionId, path);
  }
  private fileUrl(sessionId: string, relPath: string): string {
    return `/api/sessions/${sessionId}/files?path=${encodeURIComponent(relPath)}`;
  }

  // Git lifecycle + PR projection (arch §8) — delegated to GitProjectionService (P7 extraction).
  gitOp(cmd: GitCmd): GitResultEvent {
    return this.gitProjection.gitOp(cmd);
  }
  refreshPrState(id: string): Promise<void> {
    return this.gitProjection.refreshPrState(id);
  }
  refreshAllPrStates(force = false): Promise<void> {
    return this.gitProjection.refreshAllPrStates(force);
  }

  /** Archive: stop the agent + terminal/watchers, keep the worktree/branch/history. */
  async archive(id: string): Promise<void> {
    if (id === DEFAULT_SESSION_ID) throw new BadCommand("the default chat cannot be archived");
    const s = this.require(id);
    await this.drivers.get(id)?.stop();
    this.drivers.delete(id);
    this.fileWatchMgr.clear(id);
    this.terminalMgr.kill(id);
    s.data.archived = true;
    s.data.status = "idle";
    s.data.lastActivityAt = now();
    this.persist();
    this.broadcastUpdated(s.data);
  }
  unarchive(id: string): void {
    const s = this.require(id);
    s.data.archived = false;
    s.data.lastActivityAt = now();
    this.persist();
    this.broadcastUpdated(s.data);
  }
  /** Apply a sidebar arrangement: explicit order + Finished-group membership. Reordering isn't
   *  activity, so lastActivityAt is left untouched. Sessions not named keep their current order. */
  arrange(order: string[], finished: string[]): void {
    const rank = new Map(order.map((id, i) => [id, i] as const));
    const fin = new Set(finished);
    for (const s of this.sessions.values()) {
      const o = rank.get(s.data.id) ?? s.data.order;
      const f = fin.has(s.data.id);
      if (s.data.order === o && !!s.data.finished === f) continue; // unchanged → no echo
      s.data.order = o;
      s.data.finished = f;
      this.broadcastUpdated(s.data);
    }
    this.persist();
  }

  // Terminal channel (arch §7): a persistent PTY per session via Bun.Terminal. Extracted to
  // TerminalManager (unit-tested); the Supervisor just adapts a session id to {cwd, emit}.
  private readonly terminalMgr = new TerminalManager(
    (sessionId) => {
      const s = this.require(sessionId);
      return { cwd: s.data.cwd, emit: (body) => s.emit(body) };
    },
    (sessionId) => this.shellEnv(this.sessions.get(sessionId)),
  );

  terminalOpen(sessionId: string, cols: number, rows: number): void {
    this.terminalMgr.open(sessionId, cols, rows);
  }
  terminalInput(sessionId: string, dataBase64: string): void {
    this.terminalMgr.input(sessionId, dataBase64);
  }
  terminalResize(sessionId: string, cols: number, rows: number): void {
    this.terminalMgr.resize(sessionId, cols, rows);
  }

  // Attachments (arch §6.5) — uploaded via REST, fed to the agent as image blocks.
  addAttachment(sessionId: string, name: string, mediaType: string, dataBase64: string): AttachmentRef {
    this.require(sessionId);
    return this.attachStore.add(sessionId, name, mediaType, dataBase64);
  }
  attachmentBytes(sessionId: string, id: string): { mediaType: string; path: string } | undefined {
    return this.attachStore.bytes(sessionId, id);
  }

  /** Send a user turn to the session's agent (arch §6.2), starting the driver lazily. */
  prompt(id: string, text: string, attachmentIds: string[] = [], cid?: string): void {
    const s = this.require(id);
    // Exactly-once (v4, spec A5): a re-flushed offline send carries the same cid. If we've already
    // applied it, record nothing new and don't run the turn again — the dispatcher re-acks it.
    if (cid && s.isPromptApplied(cid)) return;
    // Degraded machine (no usable Claude token): stop here with the explicit §4.3 message instead of
    // letting `buildAgentEnv` throw out through the dispatcher as an opaque command error. The user's
    // text is deliberately NOT echoed — nothing consumed it, so a bubble with no reply would be a lie.
    if (this.authDegrade.degraded()) {
      s.emitError(NO_CLAUDE_TOKEN_ERROR, false);
      return;
    }
    if (s.data.archived) {
      s.data.archived = false; // prompting reactivates an archived session
      this.broadcastUpdated(s.data);
    }

    // Built-in context controls are handled by the daemon, not passed through as prose (§context). They
    // must be the WHOLE message (matching Claude Code's slash-command rule) and carry no attachments.
    // These daemon-handled commands apply a real side effect (new topic / compact / goal change) but
    // emit no `message.user`, so they early-return before the record below. Record the cid HERE so a
    // re-flushed offline copy is deduped and the side effect doesn't run twice (v4 exactly-once, A5).
    // (The degraded branch above deliberately does NOT record — nothing was applied, so a re-flush once
    // the token is fixed SHOULD run.)
    const trimmed = text.trim();
    if (trimmed === "/clear") {
      // Same effect as the "New topic" action: null the resume id, reset the context meter, drop a
      // divider. SDK-native /clear would do none of that (the daemon would still resume the old topic
      // on restart), so we route to newTopic instead of forwarding the command.
      if (cid) s.recordPromptCid(cid);
      void this.newTopic(id);
      return;
    }
    if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
      // Forward to the SDK so it actually summarizes the context. We suppress the user-echo (the
      // compact_boundary divider the driver emits is the visible marker) and let the refreshed context
      // meter ride the turn's result. Any `/compact <instructions>` guidance passes through verbatim.
      if (cid) s.recordPromptCid(cid);
      this.ensureDriver(id).prompt(text);
      return;
    }

    // `/goal` (design 2026-07-25) — daemon-handled like the context controls. Sets/clears/reports the
    // session's goal without consuming a turn; the Stop hook registered in the driver enforces it.
    const goalCmd = parseGoalCommand(text);
    if (goalCmd) {
      if (cid) s.recordPromptCid(cid);
      this.handleGoalCommand(s, goalCmd);
      return;
    }

    // Any ordinary prompt is new information: re-arm a restored goal and reset the ceiling, so it
    // means "10 turns without human help" rather than "10 turns ever" (design D8/D5).
    if (s.data.goal) {
      s.data.goal.iterations = 0;
      s.data.goal.paused = undefined;
      this.persist();
      this.broadcastUpdated(s.data);
    }
    // A fresh user turn supersedes any pending goal-resolution push suppression (see onGoalResolved):
    // the next `result` is this turn's, and it deserves its ordinary "your turn" reminder.
    this.goalPushSuppressed.delete(id);

    const attachments = attachmentIds
      .map((aid) => this.attachStore.ref(id, aid))
      .filter((r): r is AttachmentRef => r !== undefined);
    const inline = attachmentIds
      .map((aid) => this.attachStore.loadForAgent(id, aid))
      .filter((x): x is { mediaType: string; name: string; data: string } => x !== undefined);

    // Remember the opening brief (once) so the first turn can classify the remote branch prefix
    // from what the user actually asked for (arch §8) — the local slug alone is too terse.
    if (!s.data.worktree?.remoteBranch && text.trim()) s.openingPrompt ??= text.trim();

    // record the user's prompt so history/snapshot includes it and all devices agree (arch §6.4).
    // Persist the cid (v4) so a re-flushed offline send is deduped even across a daemon restart, and so
    // the client can retire its optimistic bubble instead of double-rendering (spec A5/A6).
    if (cid) s.recordPromptCid(cid);
    s.emit({ type: "message.user", rendered: this.renderer.render(text), attachments, ...(cid ? { cid } : {}) });
    this.ensureDriver(id).prompt(text, inline);
  }

  /** A turn threw. Classify it: two consecutive 401/403-class failures mean the credential is dead, so
   *  the daemon degrades itself back into the pairing flow rather than failing every future turn the
   *  same opaque way (§4.6). Anything else (network, timeout, 429) resets the streak. */
  private onTurnError(err: unknown): void {
    this.authDegrade.recordTurnFailure(err);
  }

  /** Get the session's live driver, creating it lazily on first use (arch §6.2). */
  private ensureDriver(id: string): AgentDriver {
    let driver = this.drivers.get(id);
    if (!driver) {
      const s = this.require(id);
      const isDefault = s.data.isDefault === true;
      const isLead = s.data.teamRole === "lead";
      const isMember = s.data.teamRole === "member" && !!s.data.parentId;
      const isPlanner = s.data.workUnitRole === "planner" && !!s.data.workUnitId;
      driver = new AgentDriver(
        s,
        this.renderer,
        this.broker,
        this.questionBroker,
        this.agentEnv(s),
        (usage) => this.onAgentResult(id, usage),
        isDefault
          ? { [DEFAULT_MCP_SERVER_NAME]: this.defaultToolsServer }
          : isLead
            ? { [TEAM_MCP_SERVER_NAME]: this.teams.buildTeamServer(id) }
            : isMember
              ? { [MEMBER_MCP_SERVER_NAME]: this.teams.buildMemberServer(id) }
              : isPlanner
                ? { [PLANNING_MCP_SERVER_NAME]: this.autopilot.buildPlanningServer(id) }
                : undefined,
        isDefault ? DEFAULT_TOOL_IDS : isLead ? TEAM_TOOL_IDS : isMember ? MEMBER_TOOL_IDS : isPlanner ? PLANNING_TOOL_IDS : undefined,
        this.planReviewer(s),
        undefined, // queryFn — keep the SDK default
        skillPlugins({ cwd: s.data.cwd, sessionId: id, stateDir: this.stateDir }),
        (commands) => this.onSessionCommands(id, commands),
        (err) => this.onTurnError(err),
        (met, goal) => this.onGoalResolved(id, met, goal),
        () => {
          this.persist();
          this.broadcastUpdated(s.data);
        },
      );
      this.drivers.set(id, driver);
    }
    return driver;
  }

  interrupt(id: string): void {
    this.require(id);
    void this.drivers.get(id)?.interrupt();
  }

  /** Answer a parked permission prompt (arch §6.6) — may come from any device. */
  resolvePermission(requestId: string, decision: PermissionDecision, updatedInput?: unknown): void {
    const sessionId = this.broker.sessionFor(requestId);
    if (!this.broker.resolve(requestId, decision, updatedInput)) {
      throw new BadCommand(`no pending permission request: ${requestId}`);
    }
    const s = sessionId ? this.sessions.get(sessionId) : undefined;
    s?.permissionResolved(requestId); // clear + tell every device to retire exactly this card
    if (s) {
      // settleStatus keeps the session "awaiting" if a sibling prompt (permission OR question) is
      // still parked from sub-agent fan-out — only fall back to the working status once all clear.
      s.setStatus(s.settleStatus(decision === "deny" ? "thinking" : "running_tool"));
      // Dismiss the session's reminder only when NOTHING needs the user anymore — clearing it while a
      // sibling is still parked would orphan that prompt (its push vanishes). (arch §6.6)
      if (sessionId && !s.hasPendingPermission() && !s.hasPendingQuestion()) this.clearNotifications(sessionId);
    }
  }

  /** Answer (or cancel) a parked AskUserQuestion (arch §6.6) — may come from any device. */
  resolveQuestion(requestId: string, answers: QuestionAnswer[], cancelled: boolean): void {
    const sessionId = this.questionBroker.sessionFor(requestId);
    if (!this.questionBroker.resolve(requestId, { cancelled, answers })) {
      throw new BadCommand(`no pending question: ${requestId}`);
    }
    const s = sessionId ? this.sessions.get(sessionId) : undefined;
    s?.questionResolved(requestId); // clear + tell every device to retire exactly this card
    if (s) {
      // Keep awaiting if a sibling prompt is still parked (fan-out); else the turn continues.
      s.setStatus(s.settleStatus("running_tool"));
      if (sessionId && !s.hasPendingPermission() && !s.hasPendingQuestion()) this.clearNotifications(sessionId);
    }
  }

  /** A client opened/attached to a session — that's the user acting on it, so dismiss any parked
   *  "your turn" reminder on every device (the notified one and the rest). (UI refinement §1) */
  viewed(id: string): void {
    if (this.sessions.has(id)) this.clearNotifications(id);
  }

  /** Fan a session-less operational alert out to every registered device (web + native). Used for the
   *  fleet-pairing lifecycle: auto-degrade fired, pair succeeded/rejected, scheduled work suppressed
   *  (HJ-29). `tag` coalesces repeats so the shade never stacks duplicates. */
  pushSystemAlert(title: string, body: string, tag: string): void {
    const payload: PushPayload = { title, body, tag };
    void this.webpush.notify(payload);
    void this.fcm.notify(payload);
    void this.apns.notify(payload);
  }

  /** The auto-degrade notification (HJ-29). Also broadcast on the wire so an OPEN client flips to the
   *  setup takeover immediately, rather than only on its next reload. */
  private notifyAuthDegraded(marker: DegradeMarker): void {
    this.broadcastAuthState();
    this.pushSystemAlert(
      "Anvil can't reach Claude",
      `This machine's Claude login stopped working (${marker.reason}). Turns are paused until it's re-paired.`,
      "auth-degraded",
    );
  }

  /** Tell every connected client this machine's auth/pairing state changed, so the setup takeover can
   *  appear (degraded) or disappear (paired) live. */
  broadcastAuthState(): void {
    this.registry.toAll(this.authStatusEvent("claude"));
  }

  /** Send a "clear" push (web + native) that dismisses the session's outstanding reminder on every
   *  device. No-op unless we actually pushed something for this session. */
  private clearNotifications(sessionId: string): void {
    if (!this.notified.delete(sessionId)) return;
    const data = this.sessions.get(sessionId)?.data;
    const payload: PushPayload = { title: data?.title ?? "Anvil", body: "", sessionId, tag: sessionId, kind: "clear" };
    void this.webpush.notify(payload);
    void this.fcm.notify(payload);
    void this.apns.notify(payload);
  }

  setModel(id: string, model: Model): void {
    if (!isModel(model)) return; // ignore an unknown model rather than pass junk to the SDK
    const s = this.require(id);
    s.data.model = model;
    s.data.lastActivityAt = now();
    void this.drivers.get(id)?.setModel(model);
    this.persist();
    this.broadcastUpdated(s.data);
  }
  setAutonomy(id: string, policy: AutonomyPolicy): void {
    const s = this.require(id);
    s.data.autonomy = policy;
    s.data.lastActivityAt = now();
    this.persist();
    this.broadcastUpdated(s.data);
  }
  setAdversarialReview(id: string, enabled: boolean): void {
    const s = this.require(id);
    s.data.adversarialReview = enabled;
    s.data.lastActivityAt = now();
    this.persist();
    this.broadcastUpdated(s.data);
  }

  /** Rebind an IDLE session to another Claude account (multi-account §5.3/§10). Refused mid-turn — the
   *  wording deliberately mirrors `restartIdleSessionsForNewToken()`'s existing message so both paths
   *  read as one behaviour. `claudeSessionId` is untouched, so the SDK's `--resume` (or the Task 23
   *  fresh-context fallback if that's rejected) decides what happens to the conversation. */
  async setSessionAccount(id: string, accountId: string): Promise<void> {
    const s = this.require(id);
    const acct = this.accounts.get(accountId);
    if (!acct) throw new BadCommand(`unknown Claude account ${accountId}`);
    if (s.data.status !== "idle") {
      throw new BadCommand("this session is mid-turn — finish or interrupt the turn, and the new login applies from the next one");
    }
    s.data.accountId = accountId;
    s.data.accountLabel = acct.label;
    delete s.data.accountMissing;
    await this.restartDriverForNewToken(id);
    this.persist();
    this.broadcastUpdated(s.data);
    s.emit({ type: "assistant.message", blocks: [{ kind: "markdown", rendered: this.renderer.render(`🔑 _Switched to **${acct.label}**._`) }] });
  }

  /**
   * The ExitPlanMode hook for a session: run the adversarial panel over the plan the model is about to
   * commit to, and surface its verdict as an assistant message before execution. Advisory only — it
   * never blocks the plan. Self-gates every call (not at construction) so a toggle flip or an OpenRouter
   * key set from Settings → Models mid-session takes effect on the very next plan, mirroring how the
   * autopilot panel resolves its key live (see runAutopilot). (adversarial panel)
   */
  private planReviewer(s: Session): PlanProposedHook {
    return async (plan: string) => {
      if (!s.data.adversarialReview || !plan.trim()) return; // not opted in / nothing to review
      const key = (process.env[OPENROUTER_KEY] ?? "").trim();
      if (!key || process.env.ANVIL_ADVERSARIAL === "0" || !this.adversarial.models.length) return;
      try {
        const client = new OpenRouterClient(key, undefined, this.adversarial.provider);
        const review = await reviewPlan(
          { title: s.data.title, rationale: "Interactive session — plan review before execution.", plan },
          { client, models: this.adversarial.models },
          { repoRoot: s.data.cwd }, // critics read the session's worktree read-only (agentic mode)
        );
        // Surface the verdict as an assistant message so it lands in the conversation right after the
        // plan (and persists in the durable log for resume). formatReview() is the same block the
        // autopilot appends to a stored plan.
        s.emit({ type: "assistant.message", blocks: [{ kind: "markdown", rendered: this.renderer.render(formatReview(review)) }] });
      } catch (e) {
        console.error(`[session ${s.id}] adversarial plan review failed: ${e instanceof Error ? e.message : e}`);
      }
    };
  }

  /**
   * Remove a session (UI refinement §8). The fleet's view is updated FIRST — drop it from the
   * registry, persist, and broadcast `session.deleted` immediately — then the slow, best-effort
   * teardown (interrupt the agent, delete the remote/local branch, remove the worktree + state)
   * runs in the background. Doing the network/git work up front (it shells out synchronously and a
   * `git push --delete` can hang) was what made cleanup "act like it's removing but never update"
   * — and a throw mid-teardown would leave the session resurrectable on the next `session.list`.
   * Now nothing the teardown does can bring the session back; failures are logged, not fatal.
   */
  async kill(id: string): Promise<void> {
    if (id === DEFAULT_SESSION_ID) throw new BadCommand("the default chat cannot be deleted");
    const s = this.require(id);
    const isLead = s.data.teamRole === "lead";
    const parentId = s.data.parentId;
    // Teams (#4): killing a lead cascades to its members — no orphans left running that leak budget and
    // are unreachable by team tools. Drop the lead's orchestration state FIRST so the cascade kills
    // can't re-spawn queued members off a dying lead (#8: clears activeTeamPlans/queue too).
    if (isLead) {
      this.teams.onLeadKilled(id);
      for (const m of this.list().filter((x) => x.parentId === id)) {
        await this.kill(m.id).catch((e) => console.error(`[teams] cascade teardown failed for member ${m.id}:`, e));
      }
    }
    s.dispose(); // stop accepting events first, so a late-draining turn can't write to a removed dir
    this.clearNotifications(id); // dismiss any lingering "your turn" reminder for the gone session
    this.sessions.delete(id);
    this.logs.delete(id);
    // [BE2-24] These per-session Sets were never cleaned on kill — they'd retain a dead session id for
    // the daemon's lifetime (a slow leak keyed by every session ever killed).
    this.awaitingAnnounced.delete(id);
    this.goalPushSuppressed.delete(id);
    this.persist();
    this.registry.toAll({ v: PROTOCOL_VERSION, type: "session.deleted", ts: now(), sessionId: id });
    this.teams.broadcastTeamInfo(); // deleting a lead/member reshapes the derived team tree
    // Teams (#5): a killed member frees a concurrency slot — start a queued member (no-op if the lead
    // is also being torn down, since its queue was cleared above).
    if (parentId && !isLead) void this.teams.drainQueuedMembers(parentId);
    this.trackTeardown(this.teardownSession(id, s));
  }

  /** In-flight background teardowns, so `settle()` (shutdown/tests) can await their completion. */
  private readonly teardowns = new Set<Promise<void>>();
  private trackTeardown(p: Promise<void>): void {
    this.teardowns.add(p);
    void p.finally(() => this.teardowns.delete(p));
  }

  /** Await every in-flight background teardown — for deterministic shutdown and tests. The reap is
   *  best-effort (teardownSession swallows its own errors), so this never rejects. */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.teardowns]);
  }

  /** Best-effort background reap of a killed session's agent, terminal, worktree, branch + state. */
  private async teardownSession(id: string, s: Session): Promise<void> {
    try {
      await this.drivers.get(id)?.stop(); // interrupt the agent SDK query + close its input
      this.drivers.delete(id);
      this.fileWatchMgr.clear(id);
      this.terminalMgr.kill(id);
      await s.stop(); // reap any attached process group (PTY in Phase 3)
      if (s.data.source === "fresh-worktree" && s.data.worktree) {
        // [BE2-4] Async so this background teardown never freezes the event loop on the network
        // `git push --delete` (removeWorktree below is local/bounded). Best-effort, before the worktree goes.
        await git.deleteRemoteBranchAsync(s.data.cwd, s.data.worktree.branch);
        removeWorktree(s.data.worktree.repoRoot, s.data.cwd, s.data.worktree.branch);
      }
      rmSync(this.store.sessionDir(id), { recursive: true, force: true });
    } catch (e) {
      console.error(`[kill ${id}] background cleanup failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Clean process exit (graceful restart, arch §5): interrupt every agent turn, reap terminals, and
   * flush the registry to disk. Called from the SIGTERM/SIGINT handler so a launchd `kickstart -k`
   * (or a manual restart) doesn't leave half-written state or orphaned children.
   */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.drivers.values()].map((d) => d.stop()));
    this.terminalMgr.killAll();
    await this.settle(); // let any in-flight kill finish removing its worktree/state before we exit
    this.persist();
  }

  /**
   * Un-stick a session without deleting it (arch §5): drop any stale driver, recover a missing
   * worktree, deny+clear a parked permission, and reset status to idle. The recovery path for a
   * session wedged by a crash/restart or a removed worktree — answerable from any client.
   */
  async reset(id: string): Promise<void> {
    const s = this.require(id);
    await this.drivers.get(id)?.stop(); // a wedged/stale query is dropped; next prompt starts fresh
    this.drivers.delete(id);
    this.fileWatchMgr.clear(id);
    this.terminalMgr.kill(id);
    this.broker.resolveSession(id, "deny"); // unblock any hook parked on this session
    this.questionBroker.resolveSession(id); // cancel any AskUserQuestion parked on this session
    s.resolveAllPermissions(); // retire every parked card on every device (fan-out: there may be several)
    s.resolveAllQuestions();

    let recovered: string | undefined;
    if (s.data.source === "fresh-worktree" && s.data.worktree) {
      const { repoRoot, branch, base } = s.data.worktree;
      if (worktreeHealth(s.data.cwd, branch) !== "ok") {
        const r = await recreateWorktree(repoRoot, s.data.cwd, branch, base);
        recovered = r.ok ? `restored worktree from \`${branch}\`` : `worktree could not be restored (${r.error})`;
      }
    }
    const g = await gitStatusAsync(s.data.cwd);
    if (g) s.data.git = g;
    s.data.status = "idle";
    s.data.lastActivityAt = now();
    this.persist();
    this.broadcastUpdated(s.data);
    s.emit({ type: "assistant.message", blocks: [{ kind: "markdown", rendered: this.renderer.render(`🔄 _Session reset${recovered ? ` — ${recovered}` : ""}. Re-send your message to continue._`) }] });
  }

  /**
   * Guarantee the single persistent "concierge" default chat exists (§0.6). Called at the end of
   * `restore()` so a previously persisted default (and its `events.ndjson` history) is reused; only
   * created fresh when truly absent. It's an existing-dir session rooted at the user's home, so the
   * worktree recovery/cleanup paths no-op for it.
   */
  private ensureDefaultSession(): void {
    const existing = this.sessions.get(DEFAULT_SESSION_ID);
    if (existing) {
      let healed = false;
      if (!existing.data.isDefault) {
        existing.data.isDefault = true; // heal a pre-0.6 persisted copy
        healed = true;
      }
      if (existing.data.title === "Anvil") {
        existing.data.title = "Claude"; // rename the concierge from its old default title
        healed = true;
      }
      if (healed) this.persist();
      return;
    }
    mkdirSync(this.store.sessionDir(DEFAULT_SESSION_ID), { recursive: true });
    const data: SessionData = {
      id: DEFAULT_SESSION_ID,
      title: "Claude",
      icon: "forum", // fixed curated icon — skip assignIcon for the default
      isDefault: true,
      cwd: process.env.HOME ?? this.store.worktreeRoot(),
      source: "existing-dir",
      model: "opus",
      autonomy: "mostly-autonomous",
      status: "idle",
      createdAt: now(),
      lastActivityAt: now(),
      usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
    };
    const session = this.wrap(data, 0);
    this.sessions.set(DEFAULT_SESSION_ID, session);
    this.persist();
    this.registry.toAll(this.sessionListEvent()); // clients refresh; pin happens via list() ordering
  }

  /** Sessions whose next `result` push is already covered by a goal-resolution push (see
   *  `onGoalResolved`). The Stop hook clears `data.goal` BEFORE the SDK emits `result`, so the
   *  goal-presence check in `maybeNotify` can't suppress the final turn's duplicate on its own. */
  private readonly goalPushSuppressed = new Set<string>();

  /** Apply a parsed `/goal` command. Never consumes a turn. */
  private handleGoalCommand(s: Session, cmd: GoalCommand): void {
    if (cmd.kind === "set") {
      s.data.goal = { condition: cmd.condition, iterations: 0, setAt: now() };
      this.goalDivider(
        s,
        "Goal set",
        `Working toward “${cmd.condition}” — the session keeps going until the goal is met, ` +
          `${GOAL_MAX_ITERATIONS} attempts pass, or you send /goal clear.`,
      );
    } else if (cmd.kind === "clear") {
      if (!s.data.goal) {
        this.goalDivider(s, "No goal set", "Send /goal <condition> to set one.");
        return;
      }
      s.data.goal = undefined;
      this.goalDivider(s, "Goal cleared", "The session will stop normally from now on.");
    } else {
      const g = s.data.goal;
      this.goalDivider(
        s,
        g ? "Goal" : "No goal set",
        g
          ? `“${g.condition}” — ${g.iterations}/${GOAL_MAX_ITERATIONS} attempts` +
            `${g.paused ? " · paused until your next message" : ""}` +
            `${g.lastReason ? ` · last blocker: ${g.lastReason}` : ""}`
          : "Usage: /goal <condition>",
      );
      return; // status is read-only — nothing to persist
    }
    this.persist();
    this.broadcastUpdated(s.data);
  }

  /** A goal lifecycle marker in the transcript — same divider block the compact boundary uses. */
  private goalDivider(s: Session, label: string, note: string): void {
    s.emit({ type: "assistant.message", blocks: [{ kind: "divider", label, note }] });
  }

  /** A goal finished — met, or abandoned at the ceiling. Marks the transcript, persists, and sends
   *  the ONE push the whole goal is allowed (design D3/D4). */
  private onGoalResolved(id: string, met: boolean, goal: SessionGoal): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const label = met ? "Goal met" : `Goal abandoned after ${GOAL_MAX_ITERATIONS} turns`;
    const note = met
      ? `“${goal.condition}” — reached in ${goal.iterations} attempt${goal.iterations === 1 ? "" : "s"}.`
      : `“${goal.condition}” — last blocker: ${goal.lastReason ?? "unknown"}`;
    this.goalDivider(s, label, note);
    this.persist();
    this.broadcastUpdated(s.data);
    // This push IS the turn's notification — swallow the ordinary "your turn" that the `result`
    // arriving moments later would otherwise fire (the goal is already cleared by then).
    this.goalPushSuppressed.add(id);
    const dir = s.data.cwd ? basename(s.data.cwd) : undefined;
    const payload: PushPayload = {
      title: s.data.title,
      body: `${label}: ${goal.condition}`,
      dir,
      sessionId: id,
      tag: `goal-${id}`,
      kind: "result",
    };
    this.notified.add(id); // a later view/answer dismisses it everywhere, like any other reminder
    void this.webpush.notify(payload);
    void this.fcm.notify(payload);
    void this.apns.notify(payload);
  }

  /**
   * Reset the topic (§0.6): start a fresh Claude SDK context (drop `--resume`) WITHOUT touching the
   * visible scrollback. Drops the live driver, clears any parked prompt, and writes a persisted
   * divider into the event log so the boundary survives reload and syncs to all clients. Generic for
   * any session; the UI exposes it on the concierge chat.
   */
  async newTopic(id: string): Promise<void> {
    const s = this.require(id);
    await this.drivers.get(id)?.stop(); // drop the live query so the next prompt starts fresh
    this.drivers.delete(id);
    this.broker.resolveSession(id, "deny"); // unblock any parked permission
    this.questionBroker.resolveSession(id); // cancel any parked AskUserQuestion
    s.resolveAllPermissions(); // retire every parked card on every device (fan-out: there may be several)
    s.resolveAllQuestions();
    s.data.claudeSessionId = undefined; // the key line: forget the prior topic (no resume next turn)
    s.data.context = undefined; // the fresh topic starts with an empty window; the next turn repopulates the meter
    s.data.status = "idle";
    s.data.lastActivityAt = now();
    s.emit({
      type: "assistant.message",
      blocks: [
        {
          kind: "divider",
          label: "New topic",
          note: "The earlier conversation is above for reference; Claude no longer has it in context.",
        },
      ],
    });
    this.persist();
    this.broadcastUpdated(s.data);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private wrap(data: SessionData, lastSeq: number, epoch: string = newId("ep")): Session {
    const dir = this.store.sessionDir(data.id);
    ensureDir(dir, { recursive: true });
    const log = new EventLog(dir);
    this.logs.set(data.id, log);
    const session = new Session(
      data,
      lastSeq,
      (sessionId, event) => {
        this.registry.toAttached(sessionId, event);
        this.maybeNotify(sessionId, event);
        this.maybeBroadcastAwaiting(sessionId, event);
        this.maybeBroadcastTeamStatus(sessionId, event);
      },
      () => this.persistSoon(), // [BE-1] high-frequency emit path is debounced; lifecycle ops flush now
      (event) => log.append(event),
      epoch,
    );
    // Seed exactly-once dedupe from the durable log so a re-flushed offline send is recognised as a
    // duplicate even across the daemon restart that dropped the in-memory set (v4, spec A5).
    for (const cid of log.promptCids()) session.recordPromptCid(cid);
    return session;
  }

  /**
   * Keep the session-list "awaiting permission" badge correct across the whole fleet. The
   * `status` event is session-scoped (only attached connections get it), so a device viewing a
   * different session would never colour the entry — broadcast a `session.updated` on the in/out
   * transition so every client repaints the list.
   */
  private maybeBroadcastAwaiting(sessionId: string, event: ServerEvent): void {
    if (event.type !== "status") return;
    const isAwaiting = event.status === "awaiting_permission" || event.status === "awaiting_question";
    const wasAwaiting = this.awaitingAnnounced.has(sessionId);
    if (isAwaiting === wasAwaiting) return;
    if (isAwaiting) this.awaitingAnnounced.add(sessionId);
    else this.awaitingAnnounced.delete(sessionId);
    const data = this.sessions.get(sessionId)?.data;
    if (data) this.broadcastUpdated(data);
  }

  /** Teams (#2): a member's `status` event is session-scoped (only its attached clients get it), so a
   *  device viewing the LEAD would never see members go idle — the board + rollup would freeze at
   *  "thinking" until a reload. Broadcast a `session.updated` (carries the new status, and refreshes
   *  team.info) on any team session's status change so the tree/board/rollup stay live everywhere. */
  private maybeBroadcastTeamStatus(sessionId: string, event: ServerEvent): void {
    if (event.type !== "status") return;
    const data = this.sessions.get(sessionId)?.data;
    if (!data || (!data.teamRole && !data.parentId)) return; // only sessions that belong to a team
    this.broadcastUpdated(data);
  }

  /** Push a notification on the events that mean "your turn" (arch §6.7). */
  private maybeNotify(sessionId: string, event: ServerEvent): void {
    const data = this.sessions.get(sessionId)?.data;
    const title = data?.title ?? "Anvil";
    // Which project — the cwd basename — so a reminder says *which* session it's for at a glance.
    const dir = data?.cwd ? basename(data.cwd) : undefined;
    let payload: PushPayload | undefined;
    if (event.type === "permission.request") {
      const ask = summarizeRequest(event.tool, event.input);
      payload = { title, body: `Needs your approval — ${ask}`, dir, sessionId, tag: `perm-${sessionId}`, kind: "permission", requestId: event.requestId, tool: event.tool, ask };
    } else if (event.type === "question.request") {
      const q0 = event.questions[0];
      const first = q0?.question ?? "Claude has a question";
      const opts = (q0?.options ?? []).slice(0, 3).map((o) => o.label).filter(Boolean).join(" · ");
      const more = event.questions.length > 1 ? ` (+${event.questions.length - 1} more)` : "";
      payload = { title, body: `${first}${more}${opts ? `\n${opts}` : ""}`, dir, sessionId, tag: `q-${sessionId}`, kind: "question" };
    } else if (event.type === "result") {
      // A goal in flight ends a turn on every iteration. Suppressing the "your turn" push here is
      // what makes a 10-iteration goal send ONE notification instead of ten (design D3). The
      // permission and question branches above are deliberately untouched: a goal blocked on an
      // approval still has to reach the user.
      if (data?.goal && !data.goal.paused) return;
      // The turn that RESOLVED a goal has no `data.goal` left to match on (the hook cleared it before
      // the SDK emitted this `result`), so consume the marker `onGoalResolved` left instead — its
      // "Goal met" push already covered this turn.
      if (this.goalPushSuppressed.delete(sessionId)) return;
      // A short, plain-text summary of what Claude said — no Markdown, no novel — so the reminder
      // carries real context at a glance instead of raw "## heading **bold**" glyphs.
      const snippet = summarize(this.sessions.get(sessionId)?.lastAssistantText ?? "");
      payload = { title, body: snippet || "Finished — your turn.", dir, sessionId, tag: `done-${sessionId}`, kind: "result" };
    }
    if (payload) {
      this.notified.add(sessionId); // remember so a later view/answer can dismiss it everywhere
      void this.webpush.notify(payload); // desktop browsers
      void this.fcm.notify(payload); // Android client
      void this.apns.notify(payload); // iOS/iPadOS client
    }
  }

  /** Per-turn: refresh the shared rate-limit gauge from the real plan windows, broadcast it, and
   *  advise once when the weekly window nears the cap. */
  private onAgentResult(sessionId: string, usage: TurnUsage): void {
    // A turn that produced a result reached Anthropic with a working credential — break any
    // consecutive-auth-failure streak so a 401 hours ago can't pair up with one now (§4.6).
    this.authDegrade.recordTurnSuccess();
    // The agent may have committed, switched/created a branch, or left new changes this turn —
    // refresh git so the worktree panel and session-list badge stay current without a manual
    // "status" press. Local-only and a no-op (no broadcast) when nothing changed.
    const s = this.sessions.get(sessionId);
    if (s) this.gitProjection.refreshGit(s);
    // Teams: a member finishing a turn frees a concurrency slot — start any queued members (subject to
    // the cap + budget). Safe/idempotent: a no-op when this session isn't a member or nothing is queued.
    if (s?.data.parentId) void this.teams.drainQueuedMembers(s.data.parentId, sessionId);
    // Refresh the live context-window meter from this turn's reading (§context). Broadcast so every
    // device's composer gauge updates; skip the push when the SDK didn't report (keep the last value).
    if (s && usage.contextUsage) {
      s.data.context = usage.contextUsage;
      this.broadcastUpdated(s.data);
    }
    // The goal is now on the record — classify the remote branch prefix from the opening brief once
    // (arch §8). Fire-and-forget: a slow/failed LLM call must never hold up the turn's completion.
    if (s?.data.worktree && !s.data.worktree.remoteBranch) void this.ensureRemoteBranch(s);
    const { budget, crossedSoftStop } = this.rateLimits.update(usage.rateLimits, usage.subscriptionType);
    this.registry.toAll({ v: PROTOCOL_VERSION, type: "budget", ts: now(), budget });
    if (crossedSoftStop) {
      const pct = Math.round(budget.week?.utilization ?? 0);
      this.sessions
        .get(sessionId)
        ?.emitError(
          `Heads up: weekly plan usage is at ~${pct}% of the limit. Consider switching sessions to Sonnet or pausing nonessential work.`,
          false,
        );
    }
  }

  /** [BE2-2] Settles when every restore-time worktree recovery (background, async git) has finished.
   *  Restore itself no longer blocks on git — this is the deterministic hook for tests/shutdown. */
  worktreeRecoveriesSettled: Promise<void> = Promise.resolve();

  private restore(): void {
    const transient: SessionData["status"][] = ["thinking", "running_tool", "awaiting_permission", "awaiting_question"];
    let quarantined = 0;
    const recoveries: Promise<unknown>[] = [];
    for (const p of this.store.loadAll()) {
      try {
        // a daemon restart/crash means no live agent process; a session caught mid-turn had its
        // turn interrupted — reset to idle and leave a visible notice so it isn't silently lost.
        const interrupted = transient.includes(p.data.status);
        if (interrupted) p.data.status = "idle";
        // A restored goal is re-armed PAUSED (design D5): a self-update must never resume an
        // unattended loop. The next user prompt un-pauses it (see prompt()).
        if (p.data.goal) p.data.goal.paused = true;
        // Reuse the persisted epoch so a client's cached transcript stays delta-resumable across a
        // daemon restart; a pre-v4 row has none → wrap mints one (forces one harmless full snapshot).
        const session = this.wrap(p.data, p.lastSeq, p.epoch);
        this.sessions.set(p.data.id, session);

        if (interrupted) {
          session.emit({
            type: "assistant.message",
            blocks: [{ kind: "markdown", rendered: this.renderer.render("⚠️ _The previous turn was interrupted by a daemon restart. Re-send your message to continue._") }],
          });
        }
        // [BE2-2] Worktree recovery shells out to (now async) git — fire-and-forget so one repo with a
        // wedged/slow git can't stall the whole restore (and thereby daemon startup). The recovery
        // notice lands in the conversation when it completes; the healed git state is persisted +
        // broadcast then (clients may already be connected by that point).
        recoveries.push(
          this.recoverWorktreeOnRestore(p.data)
            .then((notice) => {
              if (!notice) return;
              if (notice.recovered) {
                console.log(`[restore] recovered worktree for session ${p.data.id}`);
                this.persist();
                this.broadcastUpdated(p.data);
              }
              session.emit({ type: "assistant.message", blocks: [{ kind: "markdown", rendered: this.renderer.render(notice.message) }] });
            })
            .catch((e) => console.error(`[restore] worktree recovery failed for ${p.data.id}: ${e instanceof Error ? e.message : e}`)),
        );
      } catch (e) {
        // One unloadable session must not crash the daemon (no startup crash-loop). Skip it; its
        // state stays on disk for inspection and the rest of the fleet loads normally.
        quarantined++;
        console.error(`[restore] quarantined session ${p?.data?.id ?? "<unknown>"}: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.worktreeRecoveriesSettled = Promise.allSettled(recoveries).then(() => {});
    this.reconcileSessionAccounts(); // §5.4: an account removed while this daemon was down
    this.persist(); // reconcile disk == memory after status resets / recovery (fixes drift)
    this.ensureDefaultSession(); // the concierge chat always exists (reused if persisted, else created)
    this.pruneFollowupBranches(); // reap merge-rollover branches the user never continued (best-effort)

    const known = new Set(this.sessions.keys());
    const orphanDirs = this.store.listSessionDirs().filter((d) => !known.has(d));
    console.log(
      `[restore] ${this.sessions.size} session(s) loaded` +
        ` · ${quarantined} quarantined` +
        (orphanDirs.length ? ` · ${orphanDirs.length} orphan state dir(s)` : ""),
    ); // worktree recoveries log individually when their (async) git ops complete
  }


  /**
   * §5.4, boot half: `accountRemove()` falls live sessions back the moment an account goes, but an
   * account can also disappear while this daemon is DOWN — a hand-edited accounts.json, or (much more
   * likely) a hub push that replaced this member's whole roster. Reconcile once on restore so those
   * sessions carry the same `accountMissing` badge as the live path instead of failing at spawn time
   * with an opaque "unknown Claude account".
   *
   * A REPLICA is deliberately left alone: on a member an unknown id usually means "the hub's push
   * hasn't landed yet", and rewriting the binding would silently repoint the session at the wrong
   * subscription — exactly what §5.4 exists to prevent. `buildAgentEnv` refuses that spawn with the
   * "press Sync now" message instead, and the binding heals itself when the push arrives.
   */
  private reconcileSessionAccounts(): void {
    if (this.accounts.isEmpty() || this.accounts.snapshot().role === "replica") return;
    for (const s of this.sessions.values()) {
      if (!s.data.accountId || this.accounts.has(s.data.accountId)) continue;
      delete s.data.accountId; // follow the default LIVE, never a snapshot of it — see accountRemove
      // accountLabel deliberately keeps the removed account's name, for the badge.
      s.data.accountMissing = true;
      console.log(`[restore] session ${s.data.id} was bound to a removed Claude account — fell back to the default`);
    }
  }

  /**
   * On restore, make sure a fresh-worktree session still has a usable worktree. Missing / non-git
   * dirs are auto-recreated from the branch; a worktree checked out on the wrong branch is left
   * alone (it may hold uncommitted work) but flagged for the user to Reset. Returns a notice to
   * surface in the conversation, or undefined if the worktree was already healthy.
   */
  private async recoverWorktreeOnRestore(data: SessionData): Promise<{ message: string; recovered: boolean } | undefined> {
    if (data.source !== "fresh-worktree" || !data.worktree) return undefined;
    const { repoRoot, branch, base } = data.worktree;
    const health = worktreeHealth(data.cwd, branch);
    if (health === "ok") return undefined;
    if (health === "wrong-branch") {
      return { message: `⚠️ _This worktree is checked out on the wrong branch (expected \`${branch}\`). Use **Reset** to restore it._`, recovered: false };
    }
    const r = await recreateWorktree(repoRoot, data.cwd, branch, base);
    if (r.ok) {
      data.git = await gitStatusAsync(data.cwd);
      return { message: `🔧 _Worktree was ${health} after a restart and has been restored from branch \`${branch}\`._`, recovered: true };
    }
    return { message: `⚠️ _This session's worktree was ${health} and could not be auto-restored (${r.error}). Use **Reset** to retry._`, recovered: false };
  }

  /**
   * Reap `<branch>_followup` branches left by merges the user never continued (see git.mergePr).
   * One pass per repo that still has a worktree session; only deletes branches with no work and no
   * live session on them. Best-effort — never throws, never blocks startup on a bad repo.
   */
  private pruneFollowupBranches(): void {
    const repoRoots = new Set<string>();
    for (const s of this.sessions.values()) {
      if (s.data.source === "fresh-worktree" && s.data.worktree) repoRoots.add(s.data.worktree.repoRoot);
    }
    for (const repoRoot of repoRoots) {
      try {
        const r = git.pruneUnusedFollowupBranches(repoRoot);
        if (r.deleted.length) console.log(`[restore] ${repoRoot}: ${r.output}`);
      } catch (e) {
        console.error(`[restore] follow-up prune failed for ${repoRoot}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // [BE-1] Coalesce the hot emit-driven persistence. A full-registry re-serialize + fsync per
  // emitted event (status/prose/seq, many per turn) is the daemon's hottest path; this window batches
  // a burst into one write. Lifecycle ops (create/kill/shutdown) still call persist() for immediate
  // durability; the event log is the authoritative per-event stream, so at most PERSIST_DEBOUNCE_MS
  // of status/seq updates are at risk on a hard crash (restart reconciles them anyway).
  private static readonly PERSIST_DEBOUNCE_MS = 100;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persistDirty = false;

  /** Immediate, synchronous registry flush. Used by lifecycle ops and satisfies any pending
   *  debounced write (cancels the timer). */
  private persist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.persistDirty = false;
    this.store.saveAll([...this.sessions.values()].map((s) => ({ data: s.data, lastSeq: s.lastSeq, epoch: s.epoch })));
  }

  /** Debounced flush for the high-frequency emit path. */
  private persistSoon(): void {
    this.persistDirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      // The flush runs OUTSIDE the emit try/catch, so guard it: a transient FS error (or a state dir
      // that vanished under a test) must be logged, never thrown as an unhandled rejection.
      try {
        if (this.persistDirty) this.persist();
      } catch (e) {
        console.error(`[supervisor] debounced persist failed: ${e instanceof Error ? e.message : e}`);
      }
    }, Supervisor.PERSIST_DEBOUNCE_MS);
    // Don't let a pending flush hold the process open — shutdown() flushes synchronously.
    this.persistTimer.unref?.();
  }

  private require(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new BadCommand(`no such session: ${id}`);
    return s;
  }

  private broadcastUpdated(data: SessionData): void {
    this.registry.toAll({ v: PROTOCOL_VERSION, type: "session.updated", ts: now(), session: data });
    // [BE2-21] A team's derived rollup can only shift when the changed session is part of a team. For a
    // plain session, skip the team-tree re-derive/broadcast entirely; for a team session, coalesce it.
    if (data.teamRole || data.parentId) this.teams.scheduleTeamInfoBroadcast();
  }
}

/** [BE2-23/SEC2-4] Validate a client-supplied telemetry counters object: a plain object with ≤32 keys
 *  mapping short string names to FINITE numbers. Non-finite/non-number values are dropped; a non-object
 *  or an over-large map returns null (the whole report is ignored). Never trust the wire shape. */
function sanitizeCounters(counters: unknown): Record<string, number> | null {
  if (!counters || typeof counters !== "object" || Array.isArray(counters)) return null;
  const entries = Object.entries(counters as Record<string, unknown>);
  if (entries.length > 32) return null; // a client flooding keys is a DoS vector, not a real report
  const clean: Record<string, number> = {};
  for (const [k, v] of entries) {
    if (typeof k === "string" && k.length <= 64 && typeof v === "number" && Number.isFinite(v)) clean[k] = v;
  }
  return clean;
}
function deriveTitle(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? "session";
}

/**
 * One-line, human summary of what a tool wants approval for, so the reminder says *what* it's
 * asking — "Run: git push origin main", "Edit Foo.kt" — not just the bare tool name.
 */
/** Collapse whitespace and clip to `n` chars with an ellipsis — for one-line notification bodies. */
function oneLine(s: string, n = 120): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Notifications are plain text — Android (and most OSes) show raw Markdown glyphs rather than
 *  rendering them — so reduce the prose to a short, glanceable summary of what was done. */
const NOTIFY_MAX_WORDS = 24;
function stripMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → label only
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
    .replace(/^\s{0,3}>\s?/gm, "") // blockquotes
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "") // list markers
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
    .replace(/(\*|_)(.*?)\1/g, "$2") // italic
    .replace(/~~(.*?)~~/g, "$2"); // strikethrough
}
function summarize(s: string, maxWords = NOTIFY_MAX_WORDS): string {
  const words = stripMarkdown(s).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return "";
  const clipped = words.slice(0, maxWords).join(" ");
  return words.length > maxWords ? `${clipped}…` : clipped;
}
function summarizeRequest(tool: string, input: unknown): string {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof obj[k] === "string" ? (obj[k] as string) : undefined);
  switch (tool) {
    case "Bash": {
      const cmd = str("command");
      return cmd ? `Run: ${oneLine(cmd)}` : "Run a shell command";
    }
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const fp = str("file_path") ?? str("notebook_path") ?? str("path");
      return fp ? `Edit ${basename(fp)}` : "Edit a file";
    }
    case "Read": {
      const fp = str("file_path") ?? str("path");
      return fp ? `Read ${basename(fp)}` : "Read a file";
    }
    case "WebFetch": {
      const url = str("url");
      return url ? `Fetch ${oneLine(url, 80)}` : "Fetch a URL";
    }
    case "Agent":
    case "Task": {
      // The sub-agent launcher (the SDK names it "Agent"; "Task" in older CLIs). Surface what it'll do.
      const what = str("description") ?? str("subagent_type");
      return what ? `Launch sub-agent: ${oneLine(what, 60)}` : "Launch a sub-agent";
    }
    default:
      return `Approve ${tool}`;
  }
}
