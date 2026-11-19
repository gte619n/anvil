/**
 * The CAD domain service (agent-cad-and-browser spec §4.2–§4.4, §4.8). Owns the process manager and
 * hands each ordinary session its `anvil_cad` tool server; the Supervisor keeps thin delegates.
 *
 * Capability vs availability (§4.8): `cad-work` in `ANVIL_FEATURES` decides whether a session GETS the
 * server at all. Whether CAD can run right now (is there a binary? later: is it on the fleet pin?)
 * is the `cad.status` event, and the tools refuse with its reason — nothing is withdrawn from a live
 * driver.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import {
  PROTOCOL_VERSION,
  type CadDesignEvent,
  type CadExpectationsRequestEvent,
  type CadExpectationsResolvedEvent,
  type CadExpectationsRow,
  type CadStatusEvent,
  type ServerEvent,
  type Session as SessionInfo,
} from "@protocol";
import { registerCadProtectedRules } from "../agent/cad-protected";
import { buildCadToolsServer, CAD_MCP_SERVER_NAME, type CadToolDeps } from "../agent/cad-tools";
import { buildFileOffer, maybeTaildrop } from "../agent/file-offer";
import { isUnattended } from "../agent/protected";
import { evaluateGate, pendingAdoptions, type GateInput, type GateResult } from "../cadwork/gate";
import { LockStore, LockSync, repoKey, type LockSyncOptions, type PartLock } from "../cadwork/locks";
import { CadManager, type CadManagerOptions, type CadParamInfo, type SlotContext } from "../cadwork/manager";
import { solidcraftEnv } from "../cadwork/mcp-client";
import { gitToplevel, type PartRef } from "../cadwork/partfolder";
import {
  evaluateExpectations,
  expectationsShapeError,
  lockedBlockSha,
  readPartFile,
  stampExpectations,
  toleranceCapErrors,
  writePartFile,
  DEFAULT_TOLERANCE,
  type EvaluatedExpectations,
  type Expectations,
  type ExpectationsInput,
  type PartFile,
} from "../cadwork/partfile";
import { makeRefreshJob, readLocked, type RefreshOutcome } from "../cadwork/refresh";
import { lineDiff } from "../cadwork/rules";
import { newId } from "../util/ids";
import { currentManagedSolidcraft, resolveSolidcraftCli, type ResolvedSolidcraft } from "../solidcraft/binary";
import { now } from "../util/envelope";
import type { Session } from "./session";

export interface CadStatus {
  available: boolean;
  /** Why CAD cannot run (only when unavailable). */
  reason?: string;
  /** The SolidCraft build this machine runs. */
  version?: string;
  /** The fleet-pinned version, once Track B manages the install. */
  pinned?: string;
}

export interface CadworkServiceDeps {
  /** `featureEnabled(config, "cad-work")`. Off → no session gets the server. */
  enabled: boolean;
  getSession: (id: string) => Session | undefined;
  /** Broadcast target for `cad.status` (omitted in unit tests). */
  registry?: { toAll(ev: ServerEvent): void };
  /** Finds the binary; default `resolveSolidcraftCli()`. */
  resolveCli?: () => ResolvedSolidcraft | undefined;
  /** Reads `<cli> --version`; injectable for tests. */
  readVersion?: (cliPath: string) => Promise<string | undefined>;
  /** Passed to the manager (spawn, clock, cap, FAKE_SC_* env in tests). */
  manager?: CadManagerOptions;
  /** The daemon's state dir: the lock store lives in `<stateDir>/cadwork/`. Omitted (unit tests) →
   *  a private temp folder, never the real one. */
  stateDir?: string;
  /** Fetch / timeout overrides for the lock store's hub sync (tests). */
  lockSync?: LockSyncOptions;
  /** Test seams for the refresh (a gate that throws must end as `unverified`). */
  gateImpl?: (input: GateInput) => GateResult;
  beforeMeasure?: (ref: PartRef) => void;
}

/** What the service knows about a part after its last refresh. */
export interface PartSnapshot {
  ref: PartRef;
  rev: number;
  outcome: RefreshOutcome;
  by: "agent" | "panel" | "reload";
  busy: boolean;
}

type CardKind = CadExpectationsRequestEvent["kind"];
interface Card {
  requestId: string;
  sessionId: string;
  ref: PartRef;
  kind: CardKind;
  body: Omit<CadExpectationsRequestEvent, "v" | "ts" | "replay">;
  /** propose: settles the tool call that is waiting on the owner. */
  settle?: (approved: boolean) => void;
  /** adopt: the hash of exactly what the card showed. Approval records THIS and nothing else. */
  sha?: string;
}

export const NO_EXPECTATIONS = "has no expectations yet";
export type ExpectationsReply = { ok: true; note?: string } | { ok: false; error: string };

export const NO_SOLIDCRAFT = "SolidCraft is not installed on this machine (no solidcraft-cli found)";

/** `solidcraft-cli --version` → "0.44.1", with the same bare environment the manager uses. */
export async function readSolidcraftVersion(cliPath: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([cliPath, "--version"], { stdout: "pipe", stderr: "ignore", env: solidcraftEnv() });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    if ((await proc.exited) !== 0) return undefined;
    return /(\d+\.\d+\.\d+\S*)/.exec(out)?.[1];
  } catch {
    return undefined;
  }
}

export class CadworkService {
  readonly manager: CadManager;
  private readonly resolveCli: () => ResolvedSolidcraft | undefined;
  private readonly readVersion: (cliPath: string) => Promise<string | undefined>;
  /** `--version` per binary path: a string, or `null` when the binary would not run. */
  private readonly versions = new Map<string, string | null>();
  private lastBroadcast = "";
  /** What the owner approved (hub-synced; see cadwork/locks.ts). */
  readonly locks: LockStore;
  readonly lockSync: LockSync;
  private readonly snapshots = new Map<string, PartSnapshot>();
  private readonly partSessions = new Map<string, Set<string>>();
  private readonly cards = new Map<string, Card>();
  private readonly nextBy = new Map<string, "panel" | "reload">();
  private readonly offProtected?: () => void;

  constructor(private readonly deps: CadworkServiceDeps) {
    this.resolveCli = deps.resolveCli ?? (() => resolveSolidcraftCli());
    this.readVersion = deps.readVersion ?? readSolidcraftVersion;
    this.manager = new CadManager({ resolveCli: this.resolveCli, ...deps.manager });
    const stateDir = deps.stateDir ?? mkdtempSync(join(tmpdir(), "anvil-cadwork-state-"));
    this.locks = new LockStore(stateDir);
    this.lockSync = new LockSync(this.locks, { ...deps.lockSync, onRemoteChange: () => this.recheckOpenParts() });
    if (deps.enabled) {
      // The protected rules of §4.4, once per daemon (the registry ignores a repeat registration).
      this.offProtected = registerCadProtectedRules(stateDir);
      this.manager.setRefresh(
        makeRefreshJob({
          locks: this.locks,
          pinValues: (lock) => this.lockSync.approvePart(lock),
          onResult: (outcome, slot) => this.onRefreshed(outcome, slot),
          evaluateImpl: deps.gateImpl,
          beforeMeasure: deps.beforeMeasure,
        }),
      );
      this.manager.subscribe((e) => {
        if (e.type === "reloaded") this.nextBy.set(e.key, "reload");
      });
    }
  }

  get enabled(): boolean {
    return this.deps.enabled;
  }

  /** Whether CAD can run on this machine right now. Cheap and synchronous: re-resolved every call,
   *  so an install or a pin change takes effect without a restart. */
  status(): CadStatus {
    const pinned = currentManagedSolidcraft()?.version;
    const cli = this.resolveCli();
    if (!cli) return { available: false, reason: NO_SOLIDCRAFT, ...(pinned ? { pinned } : {}) };
    if (!existsSync(cli.path)) return { available: false, reason: `solidcraft-cli was not found at ${cli.path}`, ...(pinned ? { pinned } : {}) };
    const known = this.versions.get(cli.path);
    if (known === null) return { available: false, reason: `solidcraft-cli at ${cli.path} could not be run`, ...(pinned ? { pinned } : {}) };
    const version = cli.version ?? known;
    return { available: true, ...(version ? { version } : {}), ...(pinned ? { pinned } : {}) };
  }

  /** The reason the tools refuse with, or undefined when CAD is available. */
  unavailableReason(): string | undefined {
    const s = this.status();
    return s.available ? undefined : (s.reason ?? "CAD is unavailable");
  }

  statusEvent(): CadStatusEvent {
    return { v: PROTOCOL_VERSION, type: "cad.status", ts: now(), ...this.status() };
  }

  /** Ask the binary for its version, then broadcast `cad.status` if anything changed. Called at
   *  boot; Track B calls it again whenever the pin moves. */
  async refreshStatus(): Promise<CadStatus> {
    const cli = this.resolveCli();
    if (cli && existsSync(cli.path) && !cli.version) {
      const v = await this.readVersion(cli.path);
      this.versions.set(cli.path, v ?? null);
    }
    const status = this.status();
    const key = JSON.stringify(status);
    if (key !== this.lastBroadcast) {
      this.lastBroadcast = key;
      this.deps.registry?.toAll(this.statusEvent());
    }
    return status;
  }

  /** The worktree a session's parts live in: the git root of its cwd, or undefined outside a repo. */
  worktreeOf(session: Pick<SessionInfo, "cwd">): string | undefined {
    return gitToplevel(session.cwd);
  }

  /**
   * The capability-gated servers an ORDINARY session gets: `{ anvil_cad }` when `cad-work` is on
   * and its cwd is inside a git repo; otherwise undefined. Role sessions (concierge, team lead or
   * member, planner) never get it — their own tool server is chosen by the Supervisor.
   */
  serversFor(session: Pick<SessionInfo, "id" | "cwd" | "isDefault" | "teamRole" | "workUnitRole">): Record<string, McpSdkServerConfigWithInstance> | undefined {
    if (!this.deps.enabled) return undefined;
    if (session.isDefault || session.teamRole || session.workUnitRole === "planner") return undefined;
    const worktree = this.worktreeOf(session);
    if (!worktree) return undefined;
    return { [CAD_MCP_SERVER_NAME]: buildCadToolsServer(this.toolDeps(session.id, worktree)) };
  }

  /** The surface the tools call back into (exported for tests that drive handlers directly). */
  toolDeps(sessionId: string, worktree: string): CadToolDeps {
    return {
      sessionId,
      worktree,
      manager: this.manager,
      unavailable: () => this.unavailableReason(),
      offerFile: (absPath) => this.offerFile(sessionId, absPath),
      touch: (ref) => this.touch(sessionId, ref),
      modelingRefusal: (ref) => this.modelingRefusal(ref),
      recordExpectations: (ref, process, expectations) => this.recordExpectations(sessionId, ref, process, expectations),
      proposeExpectations: (ref, expectations, reason) => this.proposeExpectations(sessionId, ref, expectations, reason),
      checkPart: (ref) => this.checkPart(sessionId, ref),
    };
  }

  // ── expectations, the gate and its cards (spec §4.5, §4.9) ───────────────────────────────────────

  /** Remember that a session works on a part: its chat gets the part card and the adopt cards. */
  touch(sessionId: string, ref: PartRef): void {
    let set = this.partSessions.get(ref.key);
    if (!set) this.partSessions.set(ref.key, (set = new Set()));
    set.add(sessionId);
  }

  /** The last refresh of a part, if it has been refreshed since the daemon started. */
  snapshot(ref: PartRef | string): PartSnapshot | undefined {
    return this.snapshots.get(typeof ref === "string" ? ref : ref.key);
  }

  /**
   * Why modeling is refused on this part right now, or undefined when it may proceed. A part is
   * `dimensioned` unless its (approved) `part.json` says `concept`, and a dimensioned part must have
   * expectations BEFORE its first modeling call — so it cannot be built first and described after.
   */
  modelingRefusal(ref: PartRef): string | undefined {
    const part = readPartFile(ref.dir);
    if (part.kind === "invalid") return `cad/${ref.part}/part.json cannot be read (${part.error}). It was not touched; repair it or restore it from git before modeling.`;
    const none = `cad/${ref.part} ${NO_EXPECTATIONS}: call record_expectations { part, process, expectations } BEFORE modeling — the bounding box, volume, body count and holes the finished part must have — so the result can be checked against what was asked for.`;
    if (part.kind === "missing") return none;
    if (part.file.status === "concept") {
      // `concept` is honoured only when the lock store agrees: writing it into the file by hand does not skip the rule.
      const lock = this.locks.getPart(repoKey(ref.worktree), ref.part);
      if (lock && lock.status === "concept" && lock.sha === lockedBlockSha(part.file)) return undefined;
      return `cad/${ref.part}/part.json says the part is a concept, but that was not approved on this fleet. The owner has to adopt it (a card was shown) before modeling.`;
    }
    return part.file.expectations ? undefined : none;
  }

  /**
   * `record_expectations`: the ONE time an agent may set a part's expectations — for a part that has
   * none, and that nothing was ever approved for. Writes the block and its lock-store entry
   * (`agent-initial`). Formulas over parameters that do not exist yet are pinned by the first refresh
   * in which they all evaluate.
   */
  recordExpectations(sessionId: string, ref: PartRef, process: unknown, input: unknown): ExpectationsReply {
    this.touch(sessionId, ref);
    if (typeof process !== "string" || !process.trim()) return { ok: false, error: "record_expectations: `process` must name a process in cad/rules.json (for example \"fdm-0.4\")" };
    const part = readPartFile(ref.dir);
    if (part.kind === "invalid") return { ok: false, error: `cad/${ref.part}/part.json cannot be read (${part.error}); it was not touched` };
    const repo = repoKey(ref.worktree);
    const lock = this.locks.getPart(repo, ref.part);
    if (lock && !(part.kind === "ok" && part.file.expectations) && lock.status !== "concept") {
      return { ok: false, error: `Expectations were already approved for cad/${ref.part}, but part.json no longer has them. They cannot be recorded again: restore cad/${ref.part}/part.json from git.` };
    }
    if ((part.kind === "ok" && part.file.expectations) || lock?.values) {
      return { ok: false, error: `cad/${ref.part} already has expectations. They can be recorded only once; to change them call propose_expectations { part, expectations, reason }, which asks the owner.` };
    }
    if (part.kind === "ok" && part.file.status === "concept") {
      return { ok: false, error: `cad/${ref.part} is a concept: its dimensions have to be confirmed by the owner (request_dimensions) before expectations are recorded.` };
    }
    const why = expectationsShapeError(input, { stamped: false });
    if (why) return { ok: false, error: `record_expectations: ${why}` };
    const exp = stampExpectations(input as ExpectationsInput, "agent-initial", new Date().toISOString());
    const caps = toleranceCapErrors(exp.tolerance);
    if (caps.length) return { ok: false, error: `record_expectations refused: ${caps.join("; ")}. Defaults are ${DEFAULT_TOLERANCE.length} mm and ${DEFAULT_TOLERANCE.volumeRel}.` };
    const file: PartFile = { schema: 1, process: process.trim(), ...(part.kind === "ok" && part.file.material ? { material: part.file.material } : {}), status: "dimensioned", expectations: exp };
    writePartFile(ref.dir, file);
    this.lockSync.approvePart({ repo, part: ref.part, sha: lockedBlockSha(file), approvedBy: "agent-initial", status: "dimensioned", ...this.valuesNow(ref, exp), at: exp.lockedAt });
    return { ok: true };
  }

  /** `{ values }` when every formula evaluates with the part's current parameters, else `{}`. */
  private valuesNow(ref: PartRef, exp: Expectations, params?: CadParamInfo[]): { values?: EvaluatedExpectations } {
    try {
      return { values: evaluateExpectations(exp, paramMap(params ?? this.manager.status(ref)?.params ?? [])) };
    } catch {
      return {};
    }
  }

  /**
   * `propose_expectations`: park a card showing each old and new value and the agent's reason, and
   * wait for the owner. Deny changes nothing. Approve rewrites `part.json` and the lock store
   * (`owner`). Asked EVERY time, under every autonomy policy; refused when nobody can answer.
   */
  async proposeExpectations(sessionId: string, ref: PartRef, input: unknown, reason: unknown): Promise<ExpectationsReply & { approved?: boolean }> {
    this.touch(sessionId, ref);
    const session = this.deps.getSession(sessionId);
    if (!session) return { ok: false, error: "the session is gone" };
    if (isUnattended(session)) return { ok: false, error: "propose_expectations was denied: this session is unattended, so no one can approve a change to the expectations" };
    if (typeof reason !== "string" || !reason.trim()) return { ok: false, error: "propose_expectations: give a `reason` the owner can judge the change by" };
    const part = readPartFile(ref.dir);
    if (part.kind !== "ok" || !part.file.expectations) return { ok: false, error: `cad/${ref.part} has no expectations to change: call record_expectations first` };
    const why = expectationsShapeError(input, { stamped: false });
    if (why) return { ok: false, error: `propose_expectations: ${why}` };
    const before = part.file.expectations;
    // A proposal that says nothing about tolerance keeps the current one.
    const proposed = stampExpectations({ ...(input as ExpectationsInput), tolerance: { ...before.tolerance, ...((input as ExpectationsInput).tolerance ?? {}) } }, "owner", new Date().toISOString());
    const caps = toleranceCapErrors(proposed.tolerance);
    if (caps.length) return { ok: false, error: `propose_expectations refused: ${caps.join("; ")}` };
    const params = paramMap(this.manager.status(ref)?.params ?? []);
    const requestId = newId("cadx");
    const approved = await new Promise<boolean>((resolve) => {
      this.park({
        requestId,
        sessionId,
        ref,
        kind: "propose",
        settle: resolve,
        body: { type: "cad.expectations.request", requestId, sessionId, cwd: ref.worktree, part: ref.part, kind: "propose", reason: reason.trim(), rows: expectationRows(before, proposed, params) },
      });
      setStatus(session, "awaiting_permission");
    });
    setStatus(session, "running_tool");
    if (!approved) return { ok: true, approved: false };
    // Written only now, from the file as it is now: nothing else in part.json is disturbed.
    const cur = readPartFile(ref.dir);
    if (cur.kind !== "ok") return { ok: false, error: `the owner approved, but cad/${ref.part}/part.json can no longer be read; nothing was written` };
    const file: PartFile = { ...cur.file, expectations: proposed };
    writePartFile(ref.dir, file);
    this.lockSync.approvePart({
      repo: repoKey(ref.worktree),
      part: ref.part,
      sha: lockedBlockSha(file),
      approvedBy: "owner",
      status: file.status,
      ...this.valuesNow(ref, proposed),
      ...(file.ownerParams ? { ownerParams: file.ownerParams } : {}),
      at: proposed.lockedAt,
    });
    this.recheck(ref);
    return { ok: true, approved: true };
  }

  /** `check_part`: force a refresh (so nothing is judged on a stale measurement) and return the gate in full. */
  async checkPart(sessionId: string, ref: PartRef): Promise<GateResult> {
    this.touch(sessionId, ref);
    await this.manager.refreshNow(ref);
    const snap = this.snapshots.get(ref.key);
    if (!snap) throw new Error(`cad/${ref.part} could not be checked: the refresh did not run`);
    return snap.outcome.gate;
  }

  /**
   * The OWNER changes a parameter (Phase A3's panel calls this for `cad.param.set`). Unlike the
   * agent's `set_parameter`, this re-evaluates the expectation formulas AND accepts the new numbers,
   * in the same queue slot as the change, so the gate judges the part against what the owner now
   * asked for. A plain-number expectation stays as it was — and fails visibly if it should have moved.
   */
  async setParamAsOwner(ref: PartRef, name: string, expression: string): Promise<{ ok: boolean; error?: string; gate?: GateResult; notes: string[] }> {
    const reply = await this.manager.request(ref, {
      tool: "execute",
      args: { command: "parameters.change", params: { changes: { [name]: String(expression) } } },
      kind: "mutate",
      afterWrite: (slot, done) => {
        if (done.result.isError) return; // refused (unknown name, bad expression): nothing changed
        this.nextBy.set(ref.key, "panel");
        const locked = readLocked(ref, this.locks);
        if (locked.part.kind !== "ok" || !locked.part.file.expectations || !locked.lock || locked.lock.sha !== lockedBlockSha(locked.part.file)) return;
        const next = this.valuesNow(ref, locked.part.file.expectations, slot.params());
        if (next.values) this.lockSync.approvePart({ ...locked.lock, values: next.values, at: new Date().toISOString() });
      },
    });
    if (reply.result.isError) return { ok: false, error: reply.result.text, notes: reply.notes };
    await this.manager.forceRefresh(ref);
    return { ok: true, gate: this.snapshots.get(ref.key)?.outcome.gate, notes: reply.notes };
  }

  /** Answer an expectations card (`cad.expectations.respond`). False when there is no such card. */
  respond(requestId: string, approve: boolean): boolean {
    const card = this.cards.get(requestId);
    if (!card) return false;
    this.cards.delete(requestId);
    let approved = approve;
    if (card.kind !== "propose" && approve) approved = this.adopt(card);
    this.broadcast({ v: PROTOCOL_VERSION, type: "cad.expectations.resolved", ts: now(), requestId, approved } satisfies CadExpectationsResolvedEvent);
    card.settle?.(approved);
    if (card.kind !== "propose") this.recheck(card.ref, card.kind === "adopt-rules");
    return true;
  }

  /** Deny every card parked for a session (reset, kill): a waiting tool call is released. */
  cancelSession(sessionId: string): void {
    for (const card of [...this.cards.values()]) {
      if (card.sessionId !== sessionId) continue;
      this.cards.delete(card.requestId);
      this.broadcast({ v: PROTOCOL_VERSION, type: "cad.expectations.resolved", ts: now(), requestId: card.requestId, approved: false, superseded: true } satisfies CadExpectationsResolvedEvent);
      card.settle?.(false);
    }
  }

  /** The cards still waiting for an answer, for a socket that just opened. */
  pendingCardEvents(): CadExpectationsRequestEvent[] {
    return [...this.cards.values()].map((c) => ({ ...c.body, v: PROTOCOL_VERSION, ts: now(), replay: true }) as CadExpectationsRequestEvent);
  }

  /** The current `cad.design` of every part refreshed since the daemon started, for a socket that just opened. */
  designEvents(): CadDesignEvent[] {
    return [...this.snapshots.values()].map((s) => this.designEvent(s));
  }

  private designEvent(s: PartSnapshot): CadDesignEvent {
    return {
      v: PROTOCOL_VERSION,
      type: "cad.design",
      ts: now(),
      cwd: s.ref.worktree,
      part: s.ref.part,
      rev: s.rev,
      // `preview` is added by Phase A3 (the newest .cache/preview-<rev>.glb).
      params: s.outcome.params,
      gate: s.outcome.gate,
      busy: s.busy,
      by: s.by,
      sessionIds: [...(this.partSessions.get(s.ref.key) ?? [])],
    };
  }

  private broadcast(ev: ServerEvent): void {
    try {
      this.deps.registry?.toAll(ev);
    } catch {
      /* a dead socket must never break the gate */
    }
  }

  private park(card: Card): void {
    this.cards.set(card.requestId, card);
    this.broadcast({ ...card.body, v: PROTOCOL_VERSION, ts: now() } as CadExpectationsRequestEvent);
  }

  /** Post-step 5: record the outcome, broadcast `cad.design`, and raise or retire adopt cards. */
  private onRefreshed(outcome: RefreshOutcome, _slot: SlotContext): void {
    const { ref } = outcome;
    const prev = this.snapshots.get(ref.key);
    const by = this.nextBy.get(ref.key) ?? "agent";
    this.nextBy.delete(ref.key);
    const snap: PartSnapshot = { ref, rev: (prev?.rev ?? 0) + 1, outcome, by, busy: (this.manager.status(ref)?.queued ?? 0) > 0 };
    this.snapshots.set(ref.key, snap);
    this.broadcast(this.designEvent(snap));
    this.syncAdoptCards(ref, outcome.gate, outcome.params);
  }

  /** One adopt card per pending adoption, in the chat of an attended session working on the part. */
  private syncAdoptCards(ref: PartRef, gate: GateResult, params: CadParamInfo[]): void {
    const wanted = new Set(pendingAdoptions(gate));
    const locked = readLocked(ref, this.locks);
    const attended = [...(this.partSessions.get(ref.key) ?? [])].map((id) => this.deps.getSession(id)).find((s) => s && !isUnattended(s));
    const build: Partial<Record<CardKind, () => { sha: string; rows: CadExpectationsRow[]; rulesDiff?: CadExpectationsRequestEvent["rulesDiff"] } | undefined>> = {
      "adopt-expectations": () => {
        if (locked.part.kind !== "ok") return undefined;
        const f = locked.part.file;
        const p = paramMap(params);
        const rows: CadExpectationsRow[] = [
          { label: "Process", new: f.process },
          { label: "Status", ...(locked.lock ? { old: locked.lock.status } : {}), new: f.status },
          ...(f.expectations ? expectationRows(undefined, f.expectations, p, locked.lock?.values) : [{ label: "Expectations", ...(locked.lock?.values ? { old: valueText(locked.lock.values) } : {}), new: "none" }]),
          ...(f.expectations ? [{ label: "Approved by (as the file claims)", new: f.expectations.lockedBy }] : []),
        ];
        return { sha: lockedBlockSha(f), rows };
      },
      "adopt-ownerParams": () => {
        if (locked.part.kind !== "ok") return undefined;
        const now_ = locked.part.file.ownerParams ?? {};
        const old = locked.lock?.ownerParams ?? {};
        const names = [...new Set([...Object.keys(old), ...Object.keys(now_)])].sort();
        return { sha: JSON.stringify(names.map((n) => [n, now_[n] ?? null])), rows: names.map((n) => ({ label: n, ...(old[n] !== undefined ? { old: String(old[n]) } : {}), ...(now_[n] !== undefined ? { new: String(now_[n]) } : {}) })) };
      },
      "adopt-rules": () => {
        if (locked.rules.kind === "missing") return undefined;
        return {
          sha: locked.rules.sha,
          rows: [{ label: "cad/rules.json", old: locked.rulesLock ? "approved earlier" : "never approved on this fleet", new: locked.rules.kind === "invalid" ? `changed (and unreadable: ${locked.rules.error})` : "changed" }],
          rulesDiff: lineDiff(locked.rulesLock?.text ?? "", locked.rules.text),
        };
      },
    };
    const kindOf = { expectations: "adopt-expectations", ownerParams: "adopt-ownerParams", rules: "adopt-rules" } as const;
    const wantedKinds = new Set([...wanted].map((w) => kindOf[w]));
    // A rules card is per repo: one is enough however many parts of the repo are open.
    const sameScope = (c: Card, kind: CardKind): boolean => c.kind === kind && (kind === "adopt-rules" ? c.ref.worktree === ref.worktree : c.ref.key === ref.key);
    for (const kind of ["adopt-expectations", "adopt-ownerParams", "adopt-rules"] as const) {
      const open = [...this.cards.values()].filter((c) => sameScope(c, kind));
      const next = wantedKinds.has(kind) ? build[kind]!() : undefined;
      for (const c of open) {
        if (next && c.sha === next.sha) continue; // the same question is already on screen
        this.cards.delete(c.requestId);
        this.broadcast({ v: PROTOCOL_VERSION, type: "cad.expectations.resolved", ts: now(), requestId: c.requestId, approved: false, superseded: true } satisfies CadExpectationsResolvedEvent);
      }
      if (!next || !attended) continue; // nothing to adopt, or nobody there to answer (the part stays unverified)
      if ([...this.cards.values()].some((c) => sameScope(c, kind))) continue;
      const requestId = newId("cadx");
      this.park({ requestId, sessionId: attended.id, ref, kind, sha: next.sha, body: { type: "cad.expectations.request", requestId, sessionId: attended.id, cwd: ref.worktree, part: ref.part, kind, rows: next.rows, ...(next.rulesDiff ? { rulesDiff: next.rulesDiff } : {}) } });
    }
  }

  /** The owner tapped Approve on an adopt card: record the hashes of exactly what the card showed. */
  private adopt(card: Card): boolean {
    const { ref } = card;
    const locked = readLocked(ref, this.locks);
    const at = new Date().toISOString();
    if (card.kind === "adopt-rules") {
      if (locked.rules.kind === "missing" || locked.rules.sha !== card.sha) return false; // changed since the card was drawn
      this.lockSync.approveRules({ repo: locked.repo, sha: locked.rules.sha, text: locked.rules.text, at });
      return true;
    }
    if (locked.part.kind !== "ok") return false;
    const file = locked.part.file;
    if (card.kind === "adopt-expectations") {
      if (lockedBlockSha(file) !== card.sha) return false;
      const lock: PartLock = {
        repo: locked.repo,
        part: ref.part,
        sha: card.sha,
        approvedBy: "owner",
        status: file.status,
        ...(file.expectations ? this.valuesNow(ref, file.expectations) : {}),
        ...(file.ownerParams ? { ownerParams: file.ownerParams } : {}),
        at,
      };
      this.lockSync.approvePart(lock);
      return true;
    }
    if (!locked.lock) return false;
    const { ownerParams: _old, ...rest } = locked.lock;
    this.lockSync.approvePart({ ...rest, ...(file.ownerParams ? { ownerParams: file.ownerParams } : {}), at });
    return true;
  }

  /** Re-run the gate for a part (and, for a rules change, for every open part of its worktree). */
  private recheck(ref: PartRef, wholeWorktree = false): void {
    const targets = wholeWorktree ? this.manager.statuses().filter((s) => s.live && s.key.startsWith(ref.worktree + "/")).map((s) => this.snapshots.get(s.key)?.ref ?? partRefOf(s.key, s.part)) : [ref];
    if (wholeWorktree && !targets.some((t) => t.key === ref.key)) targets.push(ref);
    for (const t of targets) void this.manager.refreshNow(t).catch(() => undefined);
  }

  /** Approvals arrived from another machine: every part with a live process is checked again. */
  private recheckOpenParts(): void {
    for (const s of this.manager.statuses()) {
      if (s.live) void this.manager.refreshNow(this.snapshots.get(s.key)?.ref ?? partRefOf(s.key, s.part)).catch(() => undefined);
    }
  }

  /**
   * The gate for a part WITHOUT starting SolidCraft: from the measurement stored in `part.json`. Used
   * where no process is up (a parts list, Phase A5's verify). `staleBuild` is set when that
   * measurement was taken under a different SolidCraft version than the one this machine runs.
   */
  gateFromDisk(ref: PartRef, scriptSha: string | undefined): GateResult {
    const locked = readLocked(ref, this.locks);
    const m = locked.part.kind === "ok" ? locked.part.file.measured : undefined;
    return evaluateGate({
      ...locked,
      measurement: m ? { bbox: m.bbox, volume: m.volume, faces: m.faces, bodies: m.bodies, holes: m.holes, scriptSha: m.scriptSha, solidcraft: m.solidcraft } : undefined,
      scriptSha,
      solidcraft: this.status().version,
      featureErrors: [],
      warnings: m?.warnings ?? [],
    });
  }

  /** Emit a `file.offer` for a file the daemon wrote for this session (an export). False when the
   *  session is gone or the file is outside its cwd (it can only be served from inside it). */
  async offerFile(sessionId: string, absPath: string): Promise<boolean> {
    const s = this.deps.getSession(sessionId);
    if (!s) return false;
    const offer = buildFileOffer(s.id, s.data.cwd, absPath);
    if (!offer) return false;
    try {
      offer.taildropped = await maybeTaildrop(offer.path);
    } catch {
      /* Taildrop is best-effort — the in-chat download card is the reliable path */
    }
    s.emit({ type: "file.offer", file: offer });
    return true;
  }

  /** Stop every SolidCraft process (daemon shutdown). */
  async shutdown(): Promise<void> {
    this.offProtected?.();
    for (const card of [...this.cards.values()]) card.settle?.(false);
    this.cards.clear();
    await this.manager.shutdown();
    await this.lockSync.settled();
  }
}

const paramMap = (params: CadParamInfo[]): Record<string, number> => Object.fromEntries(params.filter((p) => Number.isFinite(p.value)).map((p) => [p.name, p.value]));
const partRefOf = (key: string, part: string): PartRef => ({ key, part, dir: key, worktree: key.slice(0, key.length - `/cad/${part}`.length) });
const num = (v: number): string => String(Math.round(v * 1e4) / 1e4);

function setStatus(session: unknown, status: "awaiting_permission" | "running_tool"): void {
  const s = session as { setStatus?: (st: string) => void; settleStatus?: (st: string) => string };
  try {
    if (typeof s.setStatus === "function") s.setStatus(status === "running_tool" && typeof s.settleStatus === "function" ? s.settleStatus(status) : status);
  } catch {
    /* status is cosmetic here */
  }
}

function valueText(v: EvaluatedExpectations): string {
  const holes = v.holes.length ? v.holes.map((h) => `⌀${num(h.diameter)} ×${h.count}${h.kind ? ` ${h.kind}` : ""}`).join(", ") : "none";
  return `box ${v.bbox.map(num).join(" × ")} mm; volume ${num(v.volume)} mm³; ${v.bodies} bod${v.bodies === 1 ? "y" : "ies"}; holes ${holes}`;
}

/** The rows of an expectations card: each value as written (a formula) with what it evaluates to. */
export function expectationRows(before: Expectations | undefined, after: Expectations, params: Record<string, number>, acceptedBefore?: EvaluatedExpectations): CadExpectationsRow[] {
  const ev = (e: Expectations | undefined): EvaluatedExpectations | undefined => {
    if (!e) return undefined;
    try {
      return evaluateExpectations(e, params);
    } catch {
      return undefined;
    }
  };
  const [vb, va] = [ev(before) ?? acceptedBefore, ev(after)];
  const withValue = (written: string, value: string | undefined): string => (value === undefined || value === written ? written : `${written}  (= ${value})`);
  const side = (e: Expectations | undefined, v: EvaluatedExpectations | undefined) => ({
    bbox: e ? withValue(e.bbox.join(" × "), v?.bbox.map(num).join(" × ")) : v ? v.bbox.map(num).join(" × ") : undefined,
    volume: e ? withValue(String(e.volume), v ? num(v.volume) : undefined) : v ? num(v.volume) : undefined,
    bodies: e ? String(e.bodies) : v ? String(v.bodies) : undefined,
    holes: e
      ? e.holes.map((h) => `⌀${h.diameter} ×${h.count}${h.kind ? ` ${h.kind}` : ""}`).join(", ") || "none"
      : v
        ? v.holes.map((h) => `⌀${num(h.diameter)} ×${h.count}${h.kind ? ` ${h.kind}` : ""}`).join(", ") || "none"
        : undefined,
    tolerance: e ? `${e.tolerance.length} mm, ${e.tolerance.volumeRel * 100}% volume` : undefined,
    refs: e ? (e.noInterferenceWith ?? []).join(", ") || "none" : undefined,
  });
  const [o, n] = [side(before, vb), side(after, va)];
  const row = (label: string, k: keyof typeof o): CadExpectationsRow => ({ label, ...(o[k] !== undefined ? { old: o[k] } : {}), ...(n[k] !== undefined ? { new: n[k] } : {}) });
  return [row("Bounding box (mm)", "bbox"), row("Volume (mm³)", "volume"), row("Bodies", "bodies"), row("Holes", "holes"), row("Tolerance", "tolerance"), row("Must not touch", "refs")];
}

