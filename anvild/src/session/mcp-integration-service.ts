/**
 * MCP integration domain (mcp-integrations spec §4.2–§4.5, amended by agent-cad-and-browser §4.12 and
 * §4.14 items 20–35): owns the per-machine store, the health loop, the exclusive lock and the
 * `mcp.integration.*` / `session.set_mcp_integrations` commands, and implements the gate the
 * permission hook and the driver call (`McpSessionGate`). Follows `EnvironmentService`: the supervisor
 * injects the little session/driver state this needs and keeps thin delegates.
 *
 * With the "mcp-integrations" feature off (`enabled: false`) the service is inert: commands are
 * refused, nothing is probed or broadcast, no integration is ever attached, and the gate denies every
 * integration tool call.
 */
import type { McpSdkServerConfigWithInstance, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { PROTOCOL_VERSION, type McpIntegration, type McpIntegrationStatus, type McpIntegrationsEvent, type ServerEvent, type Session as SessionData } from "@protocol";
import { now } from "../util/envelope";
import { buildMcpServers, isOrdinarySession, type McpChildEnv } from "../agent/mcp-external";
import { mcpKindResultHook, type McpGateSession, type McpSessionGate } from "../agent/mcp-gate";
import { BrowserService, isBrowserPreset, type BrowserServiceDeps } from "../browser/service";
import { mcpPreset } from "../mcp/presets";
import { defaultMcpChildEnv } from "../agent/mcp-external";
import { McpHealthTracker, defaultMcpProber, type McpProbeTrigger, type McpProber } from "../mcp/health";
import { McpLock } from "../mcp/lock";
import { McpIntegrationStore, type McpIntegrationFields, type McpIntegrationInput } from "../mcp/store";
import { BadCommand } from "./errors";

export const MCP_HEALTH_INTERVAL_MS = 60_000;

/** The slice of a live session the service touches. A real `Session` satisfies it. */
export interface McpServiceSession extends McpGateSession {
  data: SessionData;
}

export interface McpIntegrationServiceDeps {
  stateDir: string;
  /** Whether the "mcp-integrations" feature is switched on (`ANVIL_FEATURES`). */
  enabled: boolean;
  /** Whether the "browser" feature is ALSO on. Only then does the browser preset exist on this daemon
   *  (its proxy, its allowed-sites list, its gate); otherwise nothing of it is created or written. */
  browserEnabled?: boolean;
  /** Test seams for the browser (fake desktop probe, resolver, …). */
  browser?: Partial<Pick<BrowserServiceDeps, "desktopProbe" | "resolver" | "commandExists" | "chromeInstalled" | "proxyFactory" | "onProxyDecision" | "selfHosts" | "fetchImpl" | "sitesIntervalMs" | "nodePath" | "npmPath" | "runtimeInstaller" | "agentBrowserLauncher" | "chromePath" | "hardStopTimeoutMs" | "maxDownloadBytes" | "testDaemon">>;
  /** Persist an image as an attachment of a session, returning its id (the agent browser's hard-stop
   *  and hand-off cards show a page screenshot). */
  saveImage?: (sessionId: string, mediaType: string, dataBase64: string) => string;
  /** Send an event to every connected client. */
  broadcast: (event: ServerEvent) => void;
  /** How many clients are connected — the health loop only runs while there is one. */
  clientCount: () => number;
  sessions: () => Iterable<McpServiceSession>;
  getSession: (id: string) => McpServiceSession | undefined;
  persist: () => void;
  broadcastUpdated: (data: SessionData) => void;
  /** Drop the session's live driver if the session is idle, so its next turn rebuilds the server map
   *  (`claudeSessionId` is kept, so the conversation resumes). Returns false when the session is
   *  mid-turn and was left alone. */
  dropIdleDriver: (sessionId: string) => boolean;
  /** Deny every permission card parked in `sessionId` for a tool of the server `key` (the integration
   *  behind them was edited or removed, so an answer would be for something else). */
  denyParked?: (sessionId: string, key: string) => void;
  /** Put one notice line in the session's transcript. */
  notice: (sessionId: string, markdown: string) => void;
  /** The session's consume loop exited (its turn died or was stopped): nothing parked on behalf of
   *  that turn can be answered any more (Phase C3: a `request_human` card). */
  onConsumeExit?: (sessionId: string) => void;
  // ── test seams ──
  prober?: McpProber;
  clock?: () => number;
  /** Health-loop period; 0 disables the timer (tests drive `tick()` themselves). */
  intervalMs?: number;
  /** Runs a deferred driver rebuild after a turn ends. Default: next macrotask. */
  defer?: (fn: () => void) => void;
  childEnv?: McpChildEnv;
}

export class McpIntegrationService {
  readonly store: McpIntegrationStore;
  readonly lock: McpLock;
  readonly health: McpHealthTracker;
  /** The agent browser (Phase C2). Defined only with both "mcp-integrations" and "browser" on. */
  readonly browser: BrowserService | undefined;
  /** Sessions whose driver must be rebuilt once their current turn ends. */
  private readonly pendingRebuild = new Set<string>();
  private lastBroadcast: string;
  private probing: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: McpIntegrationServiceDeps) {
    const clock = deps.clock ?? Date.now;
    this.store = new McpIntegrationStore(deps.stateDir, clock);
    this.lock = new McpLock(clock);
    // A kind's own health check (the browser's: node, Chrome, the proxy) refines a generic `ready`.
    const generic = deps.prober ?? defaultMcpProber;
    this.health = new McpHealthTracker(async (i) => {
      const base = await generic(i);
      return base.state === "ready" ? (mcpPreset(i.kind)?.health?.(i) ?? base) : base;
    }, clock);
    if (deps.enabled && deps.browserEnabled) {
      this.browser = new BrowserService({
        stateDir: deps.stateDir,
        childEnv: deps.childEnv ?? defaultMcpChildEnv(),
        broadcast: deps.broadcast,
        dropIdleDriver: deps.dropIdleDriver,
        requestRebuild: (id) => this.requestRebuild(id),
        hasIntegration: (id) => this.store.get(id) !== undefined,
        notice: deps.notice,
        clock,
        reprobe: () => void this.probe("change"),
        lockHeld: () => this.store.list().some((i) => i.kind === "browser" && this.lock.holder(i.id) !== undefined),
        statusChanged: () => this.broadcastIfChanged(),
        saveImage: deps.saveImage,
        ...deps.browser,
      });
      this.browser.start();
    }
    this.lastBroadcast = this.signature();
    const every = deps.intervalMs ?? MCP_HEALTH_INTERVAL_MS;
    if (deps.enabled && every > 0) {
      this.timer = setInterval(() => void this.tick(), every);
      (this.timer as { unref?: () => void }).unref?.(); // never keeps the process (or a test run) alive
    }
  }

  get enabled(): boolean {
    return this.deps.enabled;
  }

  /** Call once the supervisor has restored its sessions: prune stale ids, then probe (daemon start). */
  start(): void {
    if (!this.enabled) return;
    this.sanitizeSessions();
    void this.probe("start");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.browser?.stop();
  }

  // ── read side ─────────────────────────────────────────────────────────────────────────────────

  statuses(): McpIntegrationStatus[] {
    if (!this.enabled) return [];
    return this.store.list().map((i) => {
      const h = this.health.get(i);
      const heldBy = i.exclusive ? this.lock.holder(i.id) : undefined;
      return { ...i, health: h.health, checkedAt: h.checkedAt, ...(heldBy ? { heldBy } : {}), ...(mcpPreset(i.kind)?.statusExtra?.(i) ?? {}) };
    });
  }

  integrationsEvent(): McpIntegrationsEvent {
    return { v: PROTOCOL_VERSION, type: "mcp.integrations", ts: now(), integrations: this.statuses() };
  }

  /** Everything but `checkedAt`, so a probe that found nothing new broadcasts nothing. */
  private signature(): string {
    return JSON.stringify(this.statuses().map(({ checkedAt: _checkedAt, ...rest }) => rest));
  }

  /** Broadcast `mcp.integrations` only when something a client shows has changed. */
  private broadcastIfChanged(): void {
    if (!this.enabled) return;
    const sig = this.signature();
    if (sig === this.lastBroadcast) return;
    this.lastBroadcast = sig;
    this.deps.broadcast(this.integrationsEvent());
  }

  // ── health ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Probe every integration now. A health flip drops the idle drivers of every session that
   * references the integration (a mid-turn one is rebuilt when its turn ends) and is broadcast once.
   * Calls made while a probe is in flight share it. Never rejects.
   */
  probe(trigger: McpProbeTrigger): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.probing) return this.probing;
    const run = (async () => {
      try {
        const changed = await this.health.probeAll(this.store.list(), trigger);
        if (changed.length) this.rebuildReferencing(changed);
        this.broadcastIfChanged();
      } catch (e) {
        console.error(`[mcp] health probe failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.probing = undefined;
      }
    })();
    this.probing = run;
    return run;
  }

  /** The 60 s loop body: expire idle locks; probe while any client is connected. */
  async tick(): Promise<void> {
    if (!this.enabled) return;
    if (this.lock.sweep().length) this.broadcastIfChanged();
    if (this.deps.clientCount() > 0) await this.probe("timer");
  }

  /** A client connected: refresh health so what it is about to show is current. */
  onClientConnected(): void {
    void this.probe("connect");
  }

  /** Whether a turn on this session must wait for a fresh probe first (it has integrations on). */
  needsProbeBeforeTurn(data: SessionData): boolean {
    return this.enabled && isOrdinarySession(data) && (data.mcpIntegrations?.length ?? 0) > 0;
  }

  // ── driver wiring ─────────────────────────────────────────────────────────────────────────────

  /**
   * The full MCP server map for a session's driver: `inProcess` (the role server and any other
   * in-process server, unchanged) plus the session's ready integrations. Emits one notice line in the
   * session for each integration that had to be left out.
   */
  serversFor(session: McpServiceSession, inProcess: Record<string, McpSdkServerConfigWithInstance> | undefined): Record<string, McpServerConfig> | undefined {
    const built = buildMcpServers(session.data, inProcess, this.statuses(), this.deps.childEnv);
    for (const s of built.skipped) this.deps.notice(session.id, `⚠️ _${s.label} is not available in this turn: ${s.reason}._`);
    return Object.keys(built.servers).length ? built.servers : undefined;
  }

  private referencing(ids: readonly string[]): McpServiceSession[] {
    const want = new Set(ids);
    return [...this.deps.sessions()].filter((s) => (s.data.mcpIntegrations ?? []).some((id) => want.has(id)));
  }

  private rebuildReferencing(ids: readonly string[]): void {
    for (const s of this.referencing(ids)) this.requestRebuild(s.id);
  }

  /** Rebuild a session's driver with the current server set: now if idle, else when its turn ends. */
  private requestRebuild(sessionId: string): void {
    if (this.deps.dropIdleDriver(sessionId)) this.pendingRebuild.delete(sessionId);
    else this.pendingRebuild.add(sessionId);
  }

  /** Whether a rebuild is waiting for this session's turn to end (the UI's "applies after this turn"). */
  rebuildPending(sessionId: string): boolean {
    return this.pendingRebuild.has(sessionId);
  }

  /** Apply a deferred rebuild if the session has gone idle. */
  applyPendingRebuild(sessionId: string): void {
    if (this.pendingRebuild.has(sessionId) && this.deps.dropIdleDriver(sessionId)) this.pendingRebuild.delete(sessionId);
  }

  // ── commands ──────────────────────────────────────────────────────────────────────────────────

  private requireEnabled(): void {
    if (!this.enabled) throw new BadCommand("MCP integrations are not enabled on this server");
  }

  add(input: McpIntegrationInput): McpIntegration {
    this.requireEnabled();
    let added: McpIntegration;
    try {
      // The browser exists only on a daemon with the "browser" feature on (the preset registry is
      // per process; this is the per-daemon check).
      if (input && typeof input === "object" && !this.browser && isBrowserPreset(mcpPreset(input.kind))) throw new Error('the "browser" integration is not available on this server');
      // A fixed kind (the browser) takes its key, transport and exclusivity from its preset.
      const preset = input && typeof input === "object" ? mcpPreset(input.kind) : undefined;
      const fixed = preset?.fixed ? preset.defaults?.() : undefined;
      added = this.store.add(fixed ? { ...fixed, label: typeof input.label === "string" && input.label.trim() ? input.label : fixed.label, enabled: input.enabled !== false } : input);
    } catch (e) {
      throw new BadCommand(e instanceof Error ? e.message : String(e));
    }
    this.broadcastIfChanged();
    void this.probe("change");
    return added;
  }

  update(id: string, fields: McpIntegrationFields): void {
    this.requireEnabled();
    if (!fields || typeof fields !== "object") throw new BadCommand("fields is required");
    try {
      const current = this.store.get(id);
      if (current && mcpPreset(current.kind)?.fixed) {
        // Only the name and the on/off switch of a fixed kind can change.
        const { transport: _transport, exclusive: _exclusive, ...rest } = fields;
        fields = rest;
      }
      this.store.update(id, fields);
    } catch (e) {
      throw new BadCommand(e instanceof Error ? e.message : String(e));
    }
    // An updated integration is a different thing than the one the owner allowed — or is being asked
    // about on a card that is still open.
    this.denyParked(this.store.get(id)?.key);
    this.forgetAllowed(id);
    if (this.store.get(id)?.enabled === false || this.store.get(id)?.exclusive === false) this.lock.release(id);
    this.health.forget(id); // the old result describes the old definition
    this.rebuildReferencing([id]);
    this.deps.persist();
    this.broadcastIfChanged();
    void this.probe("change");
  }

  remove(id: string): void {
    this.requireEnabled();
    const key = this.store.get(id)?.key;
    const removedKind = this.store.get(id)?.kind;
    if (!this.store.remove(id)) throw new BadCommand(`no such integration: ${id}`);
    this.denyParked(key);
    this.lock.release(id);
    this.health.forget(id);
    for (const s of this.referencing([id])) {
      if (removedKind === "browser") this.browser?.forgetSession(s.id);
      s.data.mcpIntegrations = without(s.data.mcpIntegrations, id);
      s.data.mcpAllowed = without(s.data.mcpAllowed, id);
      this.requestRebuild(s.id);
      this.deps.broadcastUpdated(s.data);
    }
    this.forgetAllowed(id); // a session may hold a stale allow without the id in its list
    this.deps.persist();
    this.broadcastIfChanged();
  }

  /** `mcp.integration.check`: re-probe now. Resolves when the probe has finished. */
  async check(): Promise<void> {
    this.requireEnabled();
    if (this.probing) await this.probing; // an automatic probe in flight must not swallow the operator's
    for (const i of this.store.list()) mcpPreset(i.kind)?.onCheck?.(i);
    await this.probe("check");
  }

  /** `session.set_mcp_integrations`: replace the session's list. Deduped; unknown ids dropped. */
  setSessionIntegrations(sessionId: string, ids: unknown): void {
    this.requireEnabled();
    const s = this.deps.getSession(sessionId);
    if (!s) throw new BadCommand(`no such session: ${sessionId}`);
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) throw new BadCommand("ids must be a list of integration ids");
    if (!isOrdinarySession(s.data)) throw new BadCommand("integrations are only available in ordinary sessions");
    const next = [...new Set(ids as string[])].filter((id) => this.store.get(id));
    const before = s.data.mcpIntegrations ?? [];
    for (const id of before) {
      if (next.includes(id)) continue;
      // Switched off for this session: the allow and the lock go with it, immediately.
      s.data.mcpAllowed = without(s.data.mcpAllowed, id);
      this.lock.release(id, sessionId);
      if (this.store.get(id)?.kind === "browser") this.browser?.forgetSession(sessionId); // its proxy and site approvals too
    }
    const changed = before.length !== next.length || before.some((id, i) => next[i] !== id);
    s.data.mcpIntegrations = next.length ? next : undefined;
    s.data.lastActivityAt = now();
    this.deps.persist();
    this.deps.broadcastUpdated(s.data);
    if (changed) this.requestRebuild(sessionId);
    this.broadcastIfChanged();
    void this.probe("set");
  }

  // ── session lifecycle ─────────────────────────────────────────────────────────────────────────

  /** Drop ids that no longer name an integration from every session (on load). */
  sanitizeSessions(): void {
    let dirty = false;
    for (const s of this.deps.sessions()) {
      const d = s.data;
      const list = d.mcpIntegrations ? [...new Set(d.mcpIntegrations)].filter((id) => this.store.get(id) && isOrdinarySession(d)) : undefined;
      const allowed = d.mcpAllowed ? [...new Set(d.mcpAllowed)].filter((id) => list?.includes(id)) : undefined;
      const sameList = (list?.length ?? 0) === (d.mcpIntegrations?.length ?? 0);
      const sameAllowed = (allowed?.length ?? 0) === (d.mcpAllowed?.length ?? 0);
      if (sameList && sameAllowed) continue;
      d.mcpIntegrations = list?.length ? list : undefined;
      d.mcpAllowed = allowed?.length ? allowed : undefined;
      dirty = true;
    }
    if (dirty) this.deps.persist();
  }

  /** The session was reset: its approvals and locks are gone. The caller persists and broadcasts. */
  onSessionReset(sessionId: string): void {
    const s = this.deps.getSession(sessionId);
    if (s) s.data.mcpAllowed = undefined;
    this.browser?.forgetSession(sessionId);
    this.pendingRebuild.delete(sessionId);
    if (this.lock.releaseSession(sessionId).length) this.broadcastIfChanged();
  }

  /** The session was deleted or archived. */
  onSessionGone(sessionId: string): void {
    this.browser?.forgetSession(sessionId);
    this.pendingRebuild.delete(sessionId);
    if (this.lock.releaseSession(sessionId).length) this.broadcastIfChanged();
  }

  /** Deny the cards parked for `key`'s tools in every session. */
  private denyParked(key: string | undefined): void {
    if (!key || !this.deps.denyParked) return;
    for (const s of this.deps.sessions()) this.deps.denyParked(s.id, key);
  }

  private forgetAllowed(integrationId: string): void {
    for (const s of this.deps.sessions()) {
      if (!s.data.mcpAllowed?.includes(integrationId)) continue;
      s.data.mcpAllowed = without(s.data.mcpAllowed, integrationId);
      this.deps.broadcastUpdated(s.data);
    }
  }

  private title(sessionId: string): string {
    return this.deps.getSession(sessionId)?.data.title || "another session";
  }

  // ── the gate the permission hook and the driver call ──────────────────────────────────────────

  readonly gate: McpSessionGate = {
    lookup: (session, key) => {
      const i = this.enabled ? this.store.byKey(key) : undefined;
      if (!i) return { deny: `mcp__${key}: unknown MCP server (not an integration on this machine)` };
      if (!isOrdinarySession(session.data)) return { deny: `${i.label} is not available in this kind of session` };
      if (!session.data.mcpIntegrations?.includes(i.id)) return { deny: `${i.label} is not switched on for this session` };
      if (!i.enabled) return { deny: `${i.label} is switched off in Settings` };
      return { integration: i };
    },
    heldByOther: (session, integration) => {
      if (!integration.exclusive) return undefined;
      const holder = this.lock.holder(integration.id);
      return holder && holder !== session.id ? { sessionId: holder, title: this.title(holder) } : undefined;
    },
    acquire: (session, integration) => {
      if (!integration.exclusive) return { ok: true };
      const had = this.lock.holder(integration.id) === session.id;
      const r = this.lock.acquire(integration.id, session.id);
      if (!r.ok) return { ok: false, sessionId: r.heldBy, title: this.title(r.heldBy) };
      if (!had) this.broadcastIfChanged(); // "in use by" changed
      return { ok: true };
    },
    isAllowed: (session, integration) => session.data.mcpAllowed?.includes(integration.id) ?? false,
    rememberAllowed: (session, integration) => {
      if (session.data.mcpAllowed?.includes(integration.id)) return;
      session.data.mcpAllowed = [...(session.data.mcpAllowed ?? []), integration.id];
      this.deps.persist();
      this.deps.broadcastUpdated(session.data);
    },
    onToolResult: (session, key, result) => {
      const i = this.store.byKey(key);
      if (!i) return;
      this.lock.refresh(i.id, session.id);
      if (!result) return;
      try {
        mcpKindResultHook(i.kind)?.({ session, integration: i, result });
      } catch (e) {
        console.error(`[mcp] ${i.label} result hook failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    onInit: (session, servers) => {
      if (!this.enabled) return;
      const failed: string[] = [];
      for (const srv of servers) {
        if (srv.status !== "failed") continue;
        const i = this.store.byKey(srv.name);
        if (!i || !session.data.mcpIntegrations?.includes(i.id)) continue;
        if (this.health.markFailed(i, "it failed to start when a session last tried it (fix it, then press Check)")) failed.push(i.id);
        this.deps.notice(session.id, `⚠️ _${i.label} failed to start, so its tools are missing from this turn. It stays off until you press Check in Settings → Integrations._`);
      }
      if (failed.length) {
        this.rebuildReferencing(failed);
        this.broadcastIfChanged();
      }
    },
    onTurnEnd: (session) => this.afterTurn(session.id),
    onConsumeExit: (session) => {
      this.afterTurn(session.id);
      this.deps.onConsumeExit?.(session.id);
    },
  };

  private afterTurn(sessionId: string): void {
    this.browser?.onTurnEnd(sessionId); // Phase C3: downloads left in the output folder go to quarantine
    if (this.lock.releaseSession(sessionId).length) this.broadcastIfChanged();
    if (this.pendingRebuild.has(sessionId)) (this.deps.defer ?? defaultDefer)(() => this.applyPendingRebuild(sessionId));
  }
}

const defaultDefer = (fn: () => void): void => void setTimeout(fn, 0);

function without(list: string[] | undefined, id: string): string[] | undefined {
  if (!list) return undefined;
  const next = list.filter((x) => x !== id);
  return next.length ? next : undefined;
}
