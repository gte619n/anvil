import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdirSync as ensureDir, unwatchFile, watchFile } from "node:fs";
import { basename, join } from "node:path";
import {
  PROTOCOL_VERSION,
  type AttachmentRef,
  type DirEntry,
  type FileContent,
  type AutonomyPolicy,
  type Budget,
  type BudgetEvent,
  type Environment,
  type EnvironmentsEvent,
  type GitCmd,
  type GitResultEvent,
  type Model,
  type PermissionDecision,
  type ServerEvent,
  type Session as SessionData,
  type SessionCreateCmd,
  type SessionListEvent,
} from "@protocol";
import { now } from "../util/envelope";
import { newId } from "../util/ids";
import type { ConnectionRegistry } from "../server/registry";
import { Session } from "./session";
import { SessionStore } from "./store";
import { createWorktree, gitStatus, recreateWorktree, removeWorktree, worktreeHealth } from "./worktree";
import { AgentDriver } from "../agent/driver";
import { buildAgentEnv } from "../agent/env";
import { PermissionBroker } from "../agent/permissions";
import { PassthroughRenderer, type MarkdownRenderer } from "../render/markdown";
import { EventLog } from "../eventlog/log";
import { BudgetTracker } from "../budget/tracker";
import { EnvironmentStore } from "../env/store";
import { AttachmentStore } from "../attach/store";
import { listDir, readFile, resolveInside } from "../fs/session-fs";
import * as git from "../git/ops";
import { pickIcon } from "../agent/icon";
import { WebPush, type PushPayload } from "../push/webpush";
import { Fcm } from "../push/fcm";

/** A client command that can't be honored (bad args, no such session). → command.error. */
export class BadCommand extends Error {}

export interface SupervisorConfig {
  stateDir: string;
  warnFraction?: number;
  softStopFraction?: number;
  renderer?: MarkdownRenderer;
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
  private readonly broker = new PermissionBroker();
  /** Sessions whose awaiting_permission state has been announced to the whole fleet (list badge). */
  private readonly awaitingAnnounced = new Set<string>();
  private readonly renderer: MarkdownRenderer;
  private readonly agentEnv = buildAgentEnv();
  private readonly budgetTracker: BudgetTracker;
  private readonly envStore: EnvironmentStore;
  private readonly attachStore: AttachmentStore;
  readonly webpush: WebPush;
  readonly fcm: Fcm;

  constructor(cfg: SupervisorConfig, private readonly registry: ConnectionRegistry) {
    this.renderer = cfg.renderer ?? new PassthroughRenderer();
    this.store = new SessionStore(cfg.stateDir);
    this.envStore = new EnvironmentStore(cfg.stateDir);
    this.attachStore = new AttachmentStore(cfg.stateDir);
    this.webpush = new WebPush(cfg.stateDir);
    this.fcm = new Fcm(cfg.stateDir);
    this.budgetTracker = new BudgetTracker({
      stateDir: cfg.stateDir,
      warnFraction: cfg.warnFraction ?? 0.8,
      softStopFraction: cfg.softStopFraction ?? 0.95,
    });
    this.restore();
  }

  budget(): Budget {
    return this.budgetTracker.snapshot();
  }
  budgetEvent(): BudgetEvent {
    return { v: PROTOCOL_VERSION, type: "budget", ts: now(), budget: this.budgetTracker.snapshot() };
  }

  environmentsEvent(): EnvironmentsEvent {
    return { v: PROTOCOL_VERSION, type: "environments", ts: now(), environments: this.envStore.list() };
  }
  getEnvironment(id: string): Environment | undefined {
    return this.envStore.get(id);
  }
  addEnvironment(name: string, repoRoot: string, defaultBase?: string): void {
    try {
      this.envStore.add(name, repoRoot, defaultBase);
    } catch (e) {
      throw new BadCommand(e instanceof Error ? e.message : String(e));
    }
    this.registry.toAll(this.environmentsEvent());
  }
  /** Read & render an environment repo's README (arch §8). */
  envReadme(id: string): { markdown?: ReturnType<MarkdownRenderer["render"]>; text?: string; missing?: boolean } {
    const env = this.envStore.get(id);
    if (!env) throw new BadCommand(`no such environment: ${id}`);
    for (const name of ["README.md", "README.markdown", "Readme.md", "readme.md", "README", "README.txt"]) {
      const p = join(env.repoRoot, name);
      if (existsSync(p)) {
        const raw = readFileSync(p, "utf8").slice(0, 256 * 1024);
        const isMd = /\.(md|markdown)$/i.test(name) || name === "README";
        return isMd ? { markdown: this.renderer.render(raw) } : { text: raw };
      }
    }
    return { missing: true };
  }
  updateEnvironment(id: string, fields: { name?: string; defaultBase?: string }): void {
    this.envStore.update(id, fields);
    this.registry.toAll(this.environmentsEvent());
  }
  removeEnvironment(id: string): void {
    this.envStore.remove(id);
    this.registry.toAll(this.environmentsEvent());
  }

  /** Events to send a (re)attaching connection (arch §6.4): replay seq > lastSeq, else snapshot. */
  resume(id: string, lastSeq?: number): ServerEvent[] {
    const s = this.require(id);
    const log = this.logs.get(id);
    if (!log) return [];
    const events = lastSeq === undefined ? [log.snapshot(id, s.lastSeq)] : log.since(lastSeq);
    // Always end with the live status so a re-attaching client's thinking indicator reflects
    // reality (the per-turn `status` events it missed while detached aren't replayed).
    events.push({ v: PROTOCOL_VERSION, type: "status", ts: now(), sessionId: id, seq: s.lastSeq, status: s.data.status });
    // Re-surface an unanswered permission prompt: the snapshot drops permission.request (it isn't
    // conversation history), so without this a client that cold-attaches to a blocked session would
    // never see the prompt — the request would be "lost" and the session stuck forever (arch §6.6).
    const pending = s.permissionRequestEvent();
    if (pending) events.push(pending);
    return events;
  }

  list(): SessionData[] {
    return [...this.sessions.values()].map((s) => s.data);
  }
  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }
  sessionListEvent(): SessionListEvent {
    return { v: PROTOCOL_VERSION, type: "session.list", ts: now(), sessions: this.list() };
  }

  create(cmd: SessionCreateCmd): Session {
    const id = newId("sess");
    let cwd: string;
    let worktree: SessionData["worktree"];

    if (cmd.source === "fresh-worktree") {
      if (!cmd.repoRoot) throw new BadCommand("repoRoot is required for a fresh-worktree session");
      const branch = slugify(cmd.title ?? "session");
      try {
        const created = createWorktree(cmd.repoRoot, cmd.base ?? "HEAD", branch, this.store.worktreeRoot(), id);
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

    mkdirSync(this.store.sessionDir(id), { recursive: true });
    const data: SessionData = {
      id,
      title: cmd.title ?? deriveTitle(cwd),
      environmentId: cmd.environmentId,
      cwd,
      source: cmd.source,
      worktree,
      git: gitStatus(cwd),
      model: cmd.model ?? "opus",
      autonomy: cmd.autonomy ?? "mostly-autonomous",
      status: "idle",
      createdAt: now(),
      lastActivityAt: now(),
      usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
    };

    const session = this.wrap(data, 0);
    this.sessions.set(id, session);
    this.persist();
    void this.assignIcon(session); // async: Sonnet picks an icon from the title (arch §5)
    return session; // dispatch announces session.created (creator gets the cid; others via registry)
  }

  /** Fire-and-forget: ask Sonnet for a fitting icon, then push it via session.updated. */
  private async assignIcon(s: Session): Promise<void> {
    try {
      const icon = await pickIcon(s.data.title, this.agentEnv);
      if (icon && this.sessions.has(s.data.id)) {
        s.data.icon = icon;
        this.persist();
        this.broadcastUpdated(s.data);
      }
    } catch {
      /* keep the client's generic fallback icon */
    }
  }

  // File browser & reader (arch §8.1/§8.2), scoped to the session worktree.
  private readonly watchers = new Map<string, () => void>(); // `${sessionId}:${path}` → stop fn

  fsList(sessionId: string, path: string): { path: string; entries: DirEntry[] } {
    return listDir(this.require(sessionId).data.cwd, path);
  }
  fsRead(sessionId: string, path: string): FileContent {
    return readFile(this.require(sessionId).data.cwd, path, this.renderer, (p) => this.fileUrl(sessionId, p));
  }
  fsResolve(sessionId: string, path: string): string {
    return resolveInside(this.require(sessionId).data.cwd, path);
  }
  fsWatch(sessionId: string, path: string): void {
    const key = `${sessionId}:${path}`;
    if (this.watchers.has(key)) return;
    const s = this.require(sessionId);
    const abs = resolveInside(s.data.cwd, path);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          s.emit({ type: "fs.changed", content: readFile(s.data.cwd, path, this.renderer, (p) => this.fileUrl(sessionId, p)) });
        } catch {
          /* file deleted / unreadable — ignore */
        }
      }, 250);
    };
    watchFile(abs, { interval: 1000 }, onChange);
    this.watchers.set(key, () => unwatchFile(abs, onChange));
  }
  fsUnwatch(sessionId: string, path: string): void {
    const key = `${sessionId}:${path}`;
    this.watchers.get(key)?.();
    this.watchers.delete(key);
  }
  private clearWatchers(sessionId: string): void {
    for (const [key, stop] of this.watchers) {
      if (key.startsWith(`${sessionId}:`)) {
        stop();
        this.watchers.delete(key);
      }
    }
  }
  private fileUrl(sessionId: string, relPath: string): string {
    return `/api/sessions/${sessionId}/files?path=${encodeURIComponent(relPath)}`;
  }

  // Git lifecycle (arch §8): operate on the session worktree, return combined output.
  gitOp(cmd: GitCmd): GitResultEvent {
    const s = this.require(cmd.sessionId);
    const cwd = s.data.cwd;
    const branch = s.data.worktree?.branch ?? "HEAD";
    let ok = true;
    let output = "";
    let url: string | undefined;
    switch (cmd.op) {
      case "status": {
        this.refreshGit(s);
        if (s.data.git) {
          const pr = git.prStatus(cwd); // network: gh pr view
          s.data.git.prState = pr.state;
          s.data.git.prUrl = pr.url;
          this.persist();
          this.broadcastUpdated(s.data);
          output = `${s.data.git.branch} — ${s.data.git.dirtyFileCount} changed, ${s.data.git.ahead} ahead / ${s.data.git.behind} behind${pr.state ? ` · PR ${pr.state}` : ""}`;
        } else {
          output = "(not a git repo)";
        }
        break;
      }
      case "diff": {
        const r = git.diff(cwd);
        ok = r.ok;
        output = r.output;
        break;
      }
      case "commit": {
        const r = git.commit(cwd, cmd.message?.trim() || "update");
        ok = r.ok;
        output = r.output;
        this.refreshGit(s);
        break;
      }
      case "push": {
        const r = git.push(cwd, branch);
        ok = r.ok;
        output = r.output;
        this.refreshGit(s);
        break;
      }
      case "create-pr": {
        const r = git.createPr(cwd, cmd.title?.trim() || s.data.title, cmd.body ?? "");
        ok = r.ok;
        output = r.output;
        url = r.url;
        break;
      }
      case "merge-pr": {
        const r = git.mergePr(cwd, cmd.method ?? "squash");
        ok = r.ok;
        output = r.output;
        break;
      }
    }
    return { v: PROTOCOL_VERSION, type: "git.result", ts: now(), sessionId: cmd.sessionId, op: cmd.op, ok, output, url };
  }
  private refreshGit(s: Session): void {
    const g = gitStatus(s.data.cwd);
    if (g) {
      s.data.git = g;
      this.persist();
      this.broadcastUpdated(s.data);
    }
  }

  /** Archive: stop the agent + terminal/watchers, keep the worktree/branch/history. */
  async archive(id: string): Promise<void> {
    const s = this.require(id);
    await this.drivers.get(id)?.stop();
    this.drivers.delete(id);
    this.clearWatchers(id);
    this.killTerminal(id);
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

  // Terminal channel (arch §7): a persistent PTY per session via Bun.Terminal.
  private readonly terminals = new Map<string, { pty: any; proc: any; scrollback: Buffer }>();

  terminalOpen(sessionId: string, cols: number, rows: number): void {
    const s = this.require(sessionId);
    const existing = this.terminals.get(sessionId);
    if (existing) {
      if (existing.scrollback.length) s.emit({ type: "terminal.data", data: existing.scrollback.toString("base64") });
      try {
        existing.pty.resize(cols, rows);
      } catch {
        /* pty gone */
      }
      return;
    }
    const rec: { pty: any; proc: any; scrollback: Buffer } = { pty: null, proc: null, scrollback: Buffer.alloc(0) };
    const BunAny = Bun as any;
    const term = new BunAny.Terminal({
      cols,
      rows,
      data: (_t: unknown, bytes: Uint8Array) => {
        const buf = Buffer.from(bytes);
        rec.scrollback = Buffer.concat([rec.scrollback, buf]);
        if (rec.scrollback.length > 262144) rec.scrollback = rec.scrollback.subarray(rec.scrollback.length - 262144);
        s.emit({ type: "terminal.data", data: buf.toString("base64") });
      },
    });
    rec.pty = term;
    const shell = process.env.SHELL || "/bin/zsh";
    rec.proc = BunAny.spawn([shell], { terminal: term, cwd: s.data.cwd, env: { ...this.agentEnv, TERM: "xterm-256color" } });
    this.terminals.set(sessionId, rec);
    rec.proc.exited.then((code: number | null) => {
      s.emit({ type: "terminal.exit", code: code ?? 0 });
      this.terminals.delete(sessionId);
    });
  }
  terminalInput(sessionId: string, dataBase64: string): void {
    try {
      this.terminals.get(sessionId)?.pty.write(Buffer.from(dataBase64, "base64"));
    } catch {
      /* no pty */
    }
  }
  terminalResize(sessionId: string, cols: number, rows: number): void {
    try {
      this.terminals.get(sessionId)?.pty.resize(cols, rows);
    } catch {
      /* no pty */
    }
  }
  private killTerminal(sessionId: string): void {
    const t = this.terminals.get(sessionId);
    if (t) {
      try {
        t.pty.close();
      } catch {
        /* already closed */
      }
      this.terminals.delete(sessionId);
    }
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
  prompt(id: string, text: string, attachmentIds: string[] = []): void {
    const s = this.require(id);
    if (s.data.archived) {
      s.data.archived = false; // prompting reactivates an archived session
      this.broadcastUpdated(s.data);
    }
    const attachments = attachmentIds
      .map((aid) => this.attachStore.ref(id, aid))
      .filter((r): r is AttachmentRef => r !== undefined);
    const images = attachmentIds
      .map((aid) => this.attachStore.loadBase64(id, aid))
      .filter((x): x is { mediaType: string; data: string } => x !== undefined);

    // record the user's prompt so history/snapshot includes it and all devices agree (arch §6.4)
    s.emit({ type: "message.user", rendered: this.renderer.render(text), attachments });
    let driver = this.drivers.get(id);
    if (!driver) {
      driver = new AgentDriver(s, this.renderer, this.broker, this.agentEnv, (model, costUsd) =>
        this.onAgentResult(id, model, costUsd),
      );
      this.drivers.set(id, driver);
    }
    driver.prompt(text, images);
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
    s?.clearPermission(requestId); // stop re-surfacing it on reattach
    s?.setStatus(decision === "deny" ? "thinking" : "running_tool");
  }

  setModel(id: string, model: Model): void {
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

  async kill(id: string): Promise<void> {
    const s = this.require(id);
    s.dispose(); // stop accepting events first, so a late-draining turn can't write to a removed dir
    await this.drivers.get(id)?.stop(); // interrupt the agent SDK query + close its input
    this.drivers.delete(id);
    this.clearWatchers(id);
    this.killTerminal(id);
    await s.stop(); // reap any attached process group (PTY in Phase 3)
    if (s.data.source === "fresh-worktree" && s.data.worktree) {
      git.deleteRemoteBranch(s.data.cwd, s.data.worktree.branch); // best-effort, before the worktree goes
      removeWorktree(s.data.worktree.repoRoot, s.data.cwd, s.data.worktree.branch);
    }
    rmSync(this.store.sessionDir(id), { recursive: true, force: true });
    this.sessions.delete(id);
    this.logs.delete(id);
    this.persist();
    this.registry.toAll({ v: PROTOCOL_VERSION, type: "session.deleted", ts: now(), sessionId: id });
  }

  /**
   * Clean process exit (graceful restart, arch §5): interrupt every agent turn, reap terminals, and
   * flush the registry to disk. Called from the SIGTERM/SIGINT handler so a launchd `kickstart -k`
   * (or a manual restart) doesn't leave half-written state or orphaned children.
   */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.drivers.values()].map((d) => d.stop()));
    for (const id of [...this.terminals.keys()]) this.killTerminal(id);
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
    this.clearWatchers(id);
    this.killTerminal(id);
    this.broker.resolveSession(id, "deny"); // unblock any hook parked on this session
    s.clearPermission();

    let recovered: string | undefined;
    if (s.data.source === "fresh-worktree" && s.data.worktree) {
      const { repoRoot, branch, base } = s.data.worktree;
      if (worktreeHealth(s.data.cwd, branch) !== "ok") {
        const r = recreateWorktree(repoRoot, s.data.cwd, branch, base);
        recovered = r.ok ? `restored worktree from \`${branch}\`` : `worktree could not be restored (${r.error})`;
      }
    }
    const g = gitStatus(s.data.cwd);
    if (g) s.data.git = g;
    s.data.status = "idle";
    s.data.lastActivityAt = now();
    this.persist();
    this.broadcastUpdated(s.data);
    s.emit({ type: "assistant.message", blocks: [{ kind: "markdown", rendered: this.renderer.render(`🔄 _Session reset${recovered ? ` — ${recovered}` : ""}. Re-send your message to continue._`) }] });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private wrap(data: SessionData, lastSeq: number): Session {
    const dir = this.store.sessionDir(data.id);
    ensureDir(dir, { recursive: true });
    const log = new EventLog(dir);
    this.logs.set(data.id, log);
    return new Session(
      data,
      lastSeq,
      (sessionId, event) => {
        this.registry.toAttached(sessionId, event);
        this.maybeNotify(sessionId, event);
        this.maybeBroadcastAwaiting(sessionId, event);
      },
      () => this.persist(),
      (event) => log.append(event),
    );
  }

  /**
   * Keep the session-list "awaiting permission" badge correct across the whole fleet. The
   * `status` event is session-scoped (only attached connections get it), so a device viewing a
   * different session would never colour the entry — broadcast a `session.updated` on the in/out
   * transition so every client repaints the list.
   */
  private maybeBroadcastAwaiting(sessionId: string, event: ServerEvent): void {
    if (event.type !== "status") return;
    const isAwaiting = event.status === "awaiting_permission";
    const wasAwaiting = this.awaitingAnnounced.has(sessionId);
    if (isAwaiting === wasAwaiting) return;
    if (isAwaiting) this.awaitingAnnounced.add(sessionId);
    else this.awaitingAnnounced.delete(sessionId);
    const data = this.sessions.get(sessionId)?.data;
    if (data) this.broadcastUpdated(data);
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
      payload = { title, body: ask, dir, sessionId, tag: `perm-${sessionId}`, kind: "permission", requestId: event.requestId, tool: event.tool, ask };
    } else if (event.type === "result") {
      payload = { title, body: "Finished — your turn.", dir, sessionId, tag: `done-${sessionId}`, kind: "result" };
    }
    if (payload) {
      void this.webpush.notify(payload); // desktop browsers
      void this.fcm.notify(payload); // Android client
    }
  }

  /** Per-turn cost → budget tracker; broadcast the new budget; advise once at soft-stop. */
  private onAgentResult(sessionId: string, model: Model, costUsd: number): void {
    const { budget, crossedSoftStop } = this.budgetTracker.record(model, costUsd);
    this.registry.toAll({ v: PROTOCOL_VERSION, type: "budget", ts: now(), budget });
    if (crossedSoftStop) {
      this.sessions
        .get(sessionId)
        ?.emitError(
          `Budget soft-stop: weekly Opus usage near the limit (~${budget.opus.usedHrs}/${budget.opus.limitHrs} hrs). Consider switching sessions to Sonnet.`,
          false,
        );
    }
  }

  private restore(): void {
    const transient: SessionData["status"][] = ["thinking", "running_tool", "awaiting_permission"];
    let recovered = 0;
    let quarantined = 0;
    for (const p of this.store.loadAll()) {
      try {
        // a daemon restart/crash means no live agent process; a session caught mid-turn had its
        // turn interrupted — reset to idle and leave a visible notice so it isn't silently lost.
        const interrupted = transient.includes(p.data.status);
        if (interrupted) p.data.status = "idle";
        const session = this.wrap(p.data, p.lastSeq);
        this.sessions.set(p.data.id, session);

        const notice = this.recoverWorktreeOnRestore(p.data); // returns a notice if anything happened
        if (notice?.recovered) recovered++;
        if (interrupted) {
          session.emit({
            type: "assistant.message",
            blocks: [{ kind: "markdown", rendered: this.renderer.render("⚠️ _The previous turn was interrupted by a daemon restart. Re-send your message to continue._") }],
          });
        }
        if (notice) {
          session.emit({ type: "assistant.message", blocks: [{ kind: "markdown", rendered: this.renderer.render(notice.message) }] });
        }
      } catch (e) {
        // One unloadable session must not crash the daemon (no startup crash-loop). Skip it; its
        // state stays on disk for inspection and the rest of the fleet loads normally.
        quarantined++;
        console.error(`[restore] quarantined session ${p?.data?.id ?? "<unknown>"}: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.persist(); // reconcile disk == memory after status resets / recovery (fixes drift)

    const known = new Set(this.sessions.keys());
    const orphanDirs = this.store.listSessionDirs().filter((d) => !known.has(d));
    console.log(
      `[restore] ${this.sessions.size} session(s) loaded` +
        ` · ${recovered} worktree(s) recovered · ${quarantined} quarantined` +
        (orphanDirs.length ? ` · ${orphanDirs.length} orphan state dir(s)` : ""),
    );
  }

  /**
   * On restore, make sure a fresh-worktree session still has a usable worktree. Missing / non-git
   * dirs are auto-recreated from the branch; a worktree checked out on the wrong branch is left
   * alone (it may hold uncommitted work) but flagged for the user to Reset. Returns a notice to
   * surface in the conversation, or undefined if the worktree was already healthy.
   */
  private recoverWorktreeOnRestore(data: SessionData): { message: string; recovered: boolean } | undefined {
    if (data.source !== "fresh-worktree" || !data.worktree) return undefined;
    const { repoRoot, branch, base } = data.worktree;
    const health = worktreeHealth(data.cwd, branch);
    if (health === "ok") return undefined;
    if (health === "wrong-branch") {
      return { message: `⚠️ _This worktree is checked out on the wrong branch (expected \`${branch}\`). Use **Reset** to restore it._`, recovered: false };
    }
    const r = recreateWorktree(repoRoot, data.cwd, branch, base);
    if (r.ok) {
      data.git = gitStatus(data.cwd);
      return { message: `🔧 _Worktree was ${health} after a restart and has been restored from branch \`${branch}\`._`, recovered: true };
    }
    return { message: `⚠️ _This session's worktree was ${health} and could not be auto-restored (${r.error}). Use **Reset** to retry._`, recovered: false };
  }

  private persist(): void {
    this.store.saveAll([...this.sessions.values()].map((s) => ({ data: s.data, lastSeq: s.lastSeq })));
  }

  private require(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new BadCommand(`no such session: ${id}`);
    return s;
  }

  private broadcastUpdated(data: SessionData): void {
    this.registry.toAll({ v: PROTOCOL_VERSION, type: "session.updated", ts: now(), session: data });
  }
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "session"
  );
}
function deriveTitle(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? "session";
}

/**
 * One-line, human summary of what a tool wants approval for, so the reminder says *what* it's
 * asking — "Run: git push origin main", "Edit Foo.kt" — not just the bare tool name.
 */
function summarizeRequest(tool: string, input: unknown): string {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof obj[k] === "string" ? (obj[k] as string) : undefined);
  const oneLine = (s: string, n = 120): string => {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
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
    default:
      return `Approve ${tool}`;
  }
}
