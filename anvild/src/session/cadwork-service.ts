/**
 * The CAD domain service (agent-cad-and-browser spec §4.2–§4.4, §4.8). Owns the process manager and
 * hands each ordinary session its `anvil_cad` tool server; the Supervisor keeps thin delegates.
 *
 * Capability vs availability (§4.8): `cad-work` in `ANVIL_FEATURES` decides whether a session GETS the
 * server at all. Whether CAD can run right now (is there a binary? later: is it on the fleet pin?)
 * is the `cad.status` event, and the tools refuse with its reason — nothing is withdrawn from a live
 * driver.
 */
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import {
  PROTOCOL_VERSION,
  type CadDesignEvent,
  type CadPartInfo,
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
import { evaluateGate, hasValues, pendingAdoptions, type GateInput, type GateResult } from "../cadwork/gate";
import { LockStore, LockSync, repoIdentity, type LockSyncOptions, type PartLock, type RulesLock } from "../cadwork/locks";
import { CadManager, type CadManagerOptions, type CadParamInfo, type SlotContext } from "../cadwork/manager";
import { realClock, solidcraftEnv, type CadClock } from "../cadwork/mcp-client";
import { gitToplevel, listParts, partRef, type PartRef } from "../cadwork/partfolder";
import { CACHE_DIR, DESIGN_FILE, DISK_CONFLICT_REASON, readDesignFile } from "../cadwork/poststep";
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
import { makeRefreshJob, newestPreview, previewRevs, readLocked, PREVIEW_PATH_RE, type RefreshOutcome } from "../cadwork/refresh";
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
  /** Folders under `stateDir` that sessions legitimately write in (their worktrees, cloned repos).
   *  Everything else under the state dir is denied to the file tools. Default: `worktrees`, `repos`. */
  writableStateRoots?: string[];
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
  /** Its next request is held because every SolidCraft slot is taken. */
  waiting?: boolean;
}

/** How long a part's queue must stay busy before a `cad.design` is sent just to say so. A refresh
 *  that lands sooner carries `busy` itself, so a short burst costs no extra event. */
export const BUSY_NOTICE_MS = 250;
/** Why `cad.param.set` / `cad.parts.list` / `cad.design.refresh` refuse a `cwd`. */
export const CWD_REFUSED = "is not the worktree of a session or a registered environment on this machine";

type CardKind = CadExpectationsRequestEvent["kind"];
interface Card {
  requestId: string;
  sessionId: string;
  ref: PartRef;
  kind: CardKind;
  body: Omit<CadExpectationsRequestEvent, "v" | "ts" | "replay">;
  /** propose / initial: settles the tool call that is waiting on the owner. */
  settle?: (approved: boolean) => void;
  /** adopt: the hash of exactly what the card showed. Approval records THIS and nothing else. */
  sha?: string;
}

export const NO_EXPECTATIONS = "has no expectations yet";
export type ExpectationsReply = { ok: true; note?: string } | { ok: false; error: string };
/** The caution on an `initial` card: the numbers were written after the part existed. */
export const INITIAL_AFTER_GEOMETRY = "this part already has geometry; these numbers were written after it existed";
/** A declared parameter value: a number, optionally followed by `mm` or `deg`. Nothing else — the
 *  declared values are what the expectations are evaluated from, so they must be plain numbers. */
const DECLARED_RE = /^\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(mm|deg)?\s*$/;
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z_0-9]*$/;

/** Read `record_expectations`' `parameters` argument: every value a plain number (with an optional
 *  `mm` / `deg`). Returns the numbers and the expressions to create the parameters with. */
export function parseDeclared(raw: unknown): { ok: true; values: Record<string, number>; expressions: Record<string, string> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "`parameters` must be an object mapping every parameter name the expectations use to its value (use {} when every expectation is a plain number)" };
  const values: Record<string, number> = {};
  const expressions: Record<string, string> = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!PARAM_NAME_RE.test(name) || name === "pi") return { ok: false, error: `\`parameters\`: ${JSON.stringify(name)} is not a parameter name` };
    const m = typeof v === "number" ? (Number.isFinite(v) ? [String(v), String(v), undefined] : null) : typeof v === "string" ? DECLARED_RE.exec(v) : null;
    if (!m) return { ok: false, error: `\`parameters.${name}\` must be a number, optionally with mm or deg (e.g. 80 or "80 mm"), not ${JSON.stringify(v)}` };
    values[name] = Number(m[1]);
    expressions[name] = typeof v === "number" ? String(v) : (v as string).trim();
  }
  return { ok: true, values, expressions };
}

/** Why a part that was not refreshed since the daemon started is `unverified`. */
export const NOT_MEASURED = "not measured in this session";
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
  private readonly clock: CadClock;
  private readonly busyTimers = new Map<string, unknown>();
  /** What the owner changed in the panel that each session's agent has not been told yet. */
  private readonly ownerNotes = new Map<string, string[]>();

  constructor(private readonly deps: CadworkServiceDeps) {
    this.resolveCli = deps.resolveCli ?? (() => resolveSolidcraftCli());
    this.readVersion = deps.readVersion ?? readSolidcraftVersion;
    this.manager = new CadManager({ resolveCli: this.resolveCli, ...deps.manager });
    this.clock = deps.manager?.clock ?? realClock;
    const stateDir = deps.stateDir ?? mkdtempSync(join(tmpdir(), "anvil-cadwork-state-"));
    this.locks = new LockStore(stateDir);
    this.lockSync = new LockSync(this.locks, { ...deps.lockSync, onRemoteChange: () => this.recheckOpenParts() });
    if (deps.enabled) {
      // The protected rules of §4.4, once per daemon (the registry ignores a repeat registration).
      this.offProtected = registerCadProtectedRules(stateDir, deps.writableStateRoots ?? [join(stateDir, "worktrees"), join(stateDir, "repos")]);
      this.manager.setRefresh(
        makeRefreshJob({
          locks: this.locks,
          machine: () => this.machine(),
          nextRev: (ref) => this.nextRev(ref),
          onResult: (outcome, slot) => this.onRefreshed(outcome, slot),
          evaluateImpl: deps.gateImpl,
          beforeMeasure: deps.beforeMeasure,
        }),
      );
      this.manager.subscribe((e) => {
        if (e.type === "reloaded") this.nextBy.set(e.key, "reload");
        else if (e.type === "busy") this.onBusy(e.key, e.part, e.busy);
        else if (e.type === "waiting") this.onWaiting(e.key, e.part, e.waiting);
        else if (e.type === "conflict") this.onConflict(e.key, e.part);
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
      recordExpectations: (ref, process, parameters, expectations) => this.recordExpectations(sessionId, ref, process, parameters, expectations),
      proposeExpectations: (ref, expectations, reason) => this.proposeExpectations(sessionId, ref, expectations, reason),
      checkPart: (ref) => this.checkPart(sessionId, ref),
      takeOwnerNotes: () => this.takeOwnerNotes(sessionId),
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
      const lock = this.findLock(ref);
      if (lock && lock.status === "concept" && lock.sha === lockedBlockSha(part.file)) return undefined;
      return `cad/${ref.part}/part.json says the part is a concept, but that was not approved on this fleet. The owner has to adopt it (a card was shown) before modeling.`;
    }
    return part.file.expectations ? undefined : none;
  }

  /** This machine's serverId (a lock found by a repo's path counts only when it was made here). */
  private machine(): string | undefined {
    return this.lockSync.currentRole().serverId;
  }
  /** The approval of a part under ANY identity of its repo. */
  private findLock(ref: PartRef): PartLock | undefined {
    return this.locks.findPart(repoIdentity(ref.worktree), ref.part, this.machine());
  }
  /** Record an approval, stamped with both identities of the repo so a changed remote cannot orphan it. */
  private approve(ref: PartRef, lock: Omit<PartLock, "repo" | "part" | "remote" | "path">): void {
    const id = repoIdentity(ref.worktree);
    this.lockSync.approvePart({ ...lock, repo: id.key, part: ref.part, ...(id.remote ? { remote: id.remote } : {}), path: id.path });
  }
  private approveRules(worktree: string, lock: Omit<RulesLock, "repo" | "remote" | "path">): void {
    const id = repoIdentity(worktree);
    this.lockSync.approveRules({ ...lock, repo: id.key, ...(id.remote ? { remote: id.remote } : {}), path: id.path });
  }

  /**
   * `record_expectations { part, process, parameters, expectations }`.
   *
   * The numbers a part is checked against are fixed HERE, at record time, from the `parameters` the
   * call declares — never later, and never from the design as it happens to be: every formula must
   * evaluate from the declared values alone or the call is refused. The declared parameters are then
   * created in the design (`parameters.add`) in the same queued job, so the design starts from
   * exactly those values, and "moved without owner approval" applies from the first moment.
   *
   * The agent may do this on its own (`agent-initial`) ONLY for a part that does not exist yet: no
   * `design.json`, nothing in the live process (no feature, body or parameter), and no approval on
   * record under any identity of the repo. For a part that already has geometry the same call
   * becomes an OWNER CARD (kind `initial`) — the numbers were written after the part existed — and
   * is refused outright when nobody is there to answer.
   */
  async recordExpectations(sessionId: string, ref: PartRef, process: unknown, parameters: unknown, input: unknown): Promise<ExpectationsReply & { approved?: boolean; by?: "agent-initial" | "owner" }> {
    this.touch(sessionId, ref);
    if (typeof process !== "string" || !process.trim()) return { ok: false, error: "record_expectations: `process` must name a process in cad/rules.json (for example \"fdm-0.4\")" };
    const part = readPartFile(ref.dir);
    if (part.kind === "invalid") return { ok: false, error: `cad/${ref.part}/part.json cannot be read (${part.error}); it was not touched` };
    const lock = this.findLock(ref);
    if (lock && !(part.kind === "ok" && part.file.expectations) && lock.status !== "concept") {
      return { ok: false, error: `Expectations were already approved for cad/${ref.part}, but part.json no longer has them. They cannot be recorded again: restore cad/${ref.part}/part.json from git.` };
    }
    if ((part.kind === "ok" && part.file.expectations) || lock?.values) {
      return { ok: false, error: `cad/${ref.part} already has expectations. They can be recorded only once; to change them call propose_expectations { part, expectations, reason }, which asks the owner.` };
    }
    if (part.kind === "ok" && part.file.status === "concept") {
      return { ok: false, error: `cad/${ref.part} is a concept: its dimensions have to be confirmed by the owner (request_dimensions) before expectations are recorded.` };
    }
    const declared = parseDeclared(parameters);
    if (!declared.ok) return { ok: false, error: `record_expectations: ${declared.error}` };
    const why = expectationsShapeError(input, { stamped: false });
    if (why) return { ok: false, error: `record_expectations: ${why}` };
    const draft = stampExpectations(input as ExpectationsInput, "agent-initial", new Date().toISOString());
    const caps = toleranceCapErrors(draft.tolerance);
    if (caps.length) return { ok: false, error: `record_expectations refused: ${caps.join("; ")}. Defaults are ${DEFAULT_TOLERANCE.length} mm and ${DEFAULT_TOLERANCE.volumeRel}.` };
    // Every formula is evaluated NOW, from the declared values and nothing else.
    let values: EvaluatedExpectations;
    try {
      values = evaluateExpectations(draft, declared.values);
    } catch (e) {
      return { ok: false, error: `record_expectations refused: ${e instanceof Error ? e.message : String(e)}. Every parameter a formula uses must be listed in \`parameters\` with its value (e.g. parameters: { "L": 80 }); the expected numbers are fixed from those values now, before anything is modeled.` };
    }

    // What does the part hold right now? (Starts the process: an existing design.json is replayed.)
    const hadDesign = existsSync(join(ref.dir, DESIGN_FILE));
    const live = await this.manager.run(ref, async (slot) => {
      const r = await slot.call("inspect_design", { measure: false, sketches: false, timeline: "summary", bodies: "names" });
      const j = r.json ?? {};
      return { features: Array.isArray(j.timeline) ? j.timeline.length : 0, bodies: Array.isArray(j.bodies) ? j.bodies.length : 0, params: slot.params() };
    });
    for (const p of live.params) {
      const want = declared.values[p.name];
      if (want !== undefined && Math.abs(p.value - want) > 1e-9 * Math.max(1, Math.abs(want))) {
        return { ok: false, error: `record_expectations refused: the design already has ${p.name} = ${num(p.value)}, not the declared ${num(want)}. Declare the value the design has, or change the parameter first.` };
      }
    }
    const pristine = !hadDesign && live.features === 0 && live.bodies === 0 && live.params.length === 0 && !lock;
    const file = (exp: Expectations): PartFile => ({ schema: 1, process: process.trim(), ...(part.kind === "ok" && part.file.material ? { material: part.file.material } : {}), status: "dimensioned", expectations: exp });
    let exp = draft;
    let by: "agent-initial" | "owner" = "agent-initial";

    if (!pristine) {
      // The part exists already: only the owner can say what it must be.
      const session = this.deps.getSession(sessionId);
      if (!session) return { ok: false, error: "the session is gone" };
      if (isUnattended(session)) return { ok: false, error: `record_expectations was denied: cad/${ref.part} already has geometry (or an earlier approval), so its expectations need the owner's approval, and this session is unattended` };
      exp = { ...draft, lockedBy: "owner" };
      by = "owner";
      const requestId = newId("cadx");
      const approved = await new Promise<boolean>((resolve) => {
        this.park({
          requestId,
          sessionId,
          ref,
          kind: "initial",
          settle: resolve,
          body: {
            type: "cad.expectations.request",
            requestId,
            sessionId,
            cwd: ref.worktree,
            part: ref.part,
            kind: "initial",
            note: INITIAL_AFTER_GEOMETRY,
            rows: [{ label: "Process", new: process.trim() }, { label: "Status", new: "dimensioned" }, ...expectationRows(undefined, exp, declared.values)],
          },
        });
        setStatus(session, "awaiting_permission");
      });
      setStatus(session, "running_tool");
      if (!approved) return { ok: true, approved: false };
      const now_ = readPartFile(ref.dir);
      if (now_.kind === "invalid" || (now_.kind === "ok" && now_.file.expectations)) return { ok: false, error: `the owner approved, but cad/${ref.part}/part.json changed while the card was open; nothing was written` };
    }

    // One queued job: create the declared parameters, check the design really starts from the
    // declared values, then write part.json and the approval. Nothing else can slip in between.
    const have = new Set(live.params.map((p) => p.name));
    const toAdd = Object.keys(declared.values).filter((n) => !have.has(n));
    let failure: string | undefined;
    const write = (params: CadParamInfo[]): void => {
      for (const n of Object.keys(declared.values)) {
        const got = params.find((p) => p.name === n)?.value;
        if (got === undefined || Math.abs(got - declared.values[n]!) > 1e-9 * Math.max(1, Math.abs(declared.values[n]!))) {
          failure = `SolidCraft made ${n} = ${got === undefined ? "nothing" : num(got)}, not the declared ${num(declared.values[n]!)}`;
          return;
        }
      }
      const f = file(exp);
      writePartFile(ref.dir, f);
      this.approve(ref, { sha: lockedBlockSha(f), approvedBy: by, status: "dimensioned", values, declared: declared.values, at: exp.lockedAt });
    };
    if (toAdd.length) {
      const reply = await this.manager.request(ref, {
        tool: "batch",
        args: { commands: toAdd.map((name) => ({ command: "parameters.add", params: { name, expression: declared.expressions[name] } })), verbose: false },
        kind: "mutate",
        afterWrite: (slot, done) => {
          if (done.result.isError) failure = `the declared parameters could not be created: ${done.result.text}`;
          else if (slot.state().conflict) failure = DISK_CONFLICT_REASON;
          else write(slot.params());
        },
      });
      if (failure) {
        if (!reply.result.isError) await this.manager.request(ref, { tool: "undo", kind: "undo" }).catch(() => undefined); // leave the design as it was
        return { ok: false, error: `record_expectations refused: ${failure}. Nothing was recorded.` };
      }
    } else {
      await this.manager.run(ref, async (slot) => write(slot.params()));
      if (failure) return { ok: false, error: `record_expectations refused: ${failure}. Nothing was recorded.` };
    }
    if (by === "owner") this.recheck(ref);
    return { ok: true, approved: true, by };
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
   * `propose_expectations`: park a card showing each old and new value (evaluated), the process and
   * status they are approved under, and the agent's reason, and wait for the owner. Deny changes
   * nothing. Approve rewrites `part.json` and the lock store (`owner`). Asked EVERY time, under every
   * autonomy policy; refused when nobody can answer, and refused before any card is drawn when a
   * formula does not evaluate against the design's parameters (a card always shows numbers).
   *
   * The approval is for exactly what the card showed: if `part.json`'s locked block changed while
   * the card was open, nothing is written and a fresh card is raised.
   */
  async proposeExpectations(sessionId: string, ref: PartRef, input: unknown, reason: unknown): Promise<ExpectationsReply & { approved?: boolean }> {
    this.touch(sessionId, ref);
    const session = this.deps.getSession(sessionId);
    if (!session) return { ok: false, error: "the session is gone" };
    if (isUnattended(session)) return { ok: false, error: "propose_expectations was denied: this session is unattended, so no one can approve a change to the expectations" };
    if (typeof reason !== "string" || !reason.trim()) return { ok: false, error: "propose_expectations: give a `reason` the owner can judge the change by" };
    const why = expectationsShapeError(input, { stamped: false });
    if (why) return { ok: false, error: `propose_expectations: ${why}` };
    const opened = await this.manager.open(ref); // the parameters the formulas are evaluated with
    for (let round = 0; round < 3; round++) {
      const part = readPartFile(ref.dir);
      if (part.kind !== "ok" || !part.file.expectations) return { ok: false, error: `cad/${ref.part} has no expectations to change: call record_expectations first` };
      const before = part.file.expectations;
      // A proposal that says nothing about tolerance keeps the current one.
      const proposed = stampExpectations({ ...(input as ExpectationsInput), tolerance: { ...before.tolerance, ...((input as ExpectationsInput).tolerance ?? {}) } }, "owner", new Date().toISOString());
      const caps = toleranceCapErrors(proposed.tolerance);
      if (caps.length) return { ok: false, error: `propose_expectations refused: ${caps.join("; ")}` };
      const params = paramMap(this.manager.status(ref)?.params ?? opened.params);
      try {
        evaluateExpectations(proposed, params);
      } catch (e) {
        return { ok: false, error: `propose_expectations refused: ${e instanceof Error ? e.message : String(e)}. Every formula must evaluate against the design's parameters before the owner is asked, so the card can show numbers.` };
      }
      const shown = lockedBlockSha(part.file);
      const requestId = newId("cadx");
      const approved = await new Promise<boolean>((resolve) => {
        this.park({
          requestId,
          sessionId,
          ref,
          kind: "propose",
          settle: resolve,
          body: {
            type: "cad.expectations.request",
            requestId,
            sessionId,
            cwd: ref.worktree,
            part: ref.part,
            kind: "propose",
            reason: reason.trim(),
            rows: [{ label: "Process", old: part.file.process, new: part.file.process }, { label: "Status", old: part.file.status, new: part.file.status }, ...expectationRows(before, proposed, params, this.findLock(ref)?.values)],
          },
        });
        setStatus(session, "awaiting_permission");
      });
      setStatus(session, "running_tool");
      if (!approved) return { ok: true, approved: false };
      // Written only now, and only if the file is still what the card showed.
      const cur = readPartFile(ref.dir);
      if (cur.kind !== "ok") return { ok: false, error: `the owner approved, but cad/${ref.part}/part.json can no longer be read; nothing was written` };
      if (lockedBlockSha(cur.file) !== shown) continue; // process, status or the expectations changed meanwhile: ask again, showing what is there now
      const values = this.valuesNow(ref, proposed).values;
      if (!values) return { ok: false, error: `the owner approved, but the formulas no longer evaluate against the design's parameters; nothing was written` };
      const file: PartFile = { ...cur.file, expectations: proposed };
      writePartFile(ref.dir, file);
      this.approve(ref, { sha: lockedBlockSha(file), approvedBy: "owner", status: file.status, values, ...(file.ownerParams ? { ownerParams: file.ownerParams } : {}), at: proposed.lockedAt });
      this.recheck(ref);
      return { ok: true, approved: true };
    }
    return { ok: false, error: `cad/${ref.part}/part.json kept changing while the owner was being asked; nothing was written` };
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
      refreshAfter: true, // measured and broadcast in the same queue slot: one `cad.design` per owner edit
      afterWrite: (slot, done) => {
        if (done.result.isError) return; // refused (unknown name, bad expression): nothing changed
        if (slot.state().conflict) return; // design.json changed on disk meanwhile: the change was not written, so nothing is accepted
        this.nextBy.set(ref.key, "panel");
        const locked = readLocked(ref, this.locks, this.machine());
        if (locked.part.kind !== "ok" || !locked.part.file.expectations || !locked.lock || locked.lock.sha !== lockedBlockSha(locked.part.file) || !hasValues(locked.lock.values)) return;
        const next = this.valuesNow(ref, locked.part.file.expectations, slot.params());
        const { repo: _r, part: _p, remote: _m, path: _a, ...rest } = locked.lock;
        if (next.values) this.approve(ref, { ...rest, values: next.values, at: new Date().toISOString() });
      },
    });
    if (reply.result.isError) return { ok: false, error: reply.result.text, notes: reply.notes };
    if (reply.state.conflict) {
      // Not written (§4.2): the file on disk wins, and the part is `fail` until it is rebuilt from it.
      return { ok: false, error: reply.notes.find((n) => n.includes(DISK_CONFLICT_REASON)) ?? DISK_CONFLICT_REASON, notes: reply.notes };
    }
    // Every agent working on the part hears about it on its next anvil_cad result, once (§4.9).
    const value = this.manager.status(ref)?.params.find((p) => p.name === name)?.value;
    const shown = typeof value === "number" && Number.isFinite(value) && String(value) !== expression.trim() ? ` (= ${num(value)})` : "";
    const note = `owner changed ${name} to ${expression}${shown} in cad/${ref.part} since your last call. Read the parameters again before relying on earlier values; the expectations were re-derived for the new value.`;
    for (const sid of this.partSessions.get(ref.key) ?? []) {
      const list = this.ownerNotes.get(sid) ?? [];
      list.push(note);
      this.ownerNotes.set(sid, list);
    }
    return { ok: true, gate: this.snapshots.get(ref.key)?.outcome.gate, notes: reply.notes };
  }

  /** The owner-change notes a session's agent has not seen yet. Reading them delivers them: once. */
  takeOwnerNotes(sessionId: string): string[] {
    const list = this.ownerNotes.get(sessionId);
    if (!list?.length) return [];
    this.ownerNotes.delete(sessionId);
    return list;
  }

  // ── the panel's commands (spec §4.8, Phase A3) ───────────────────────────────────────────────────

  /**
   * The part a client command names, or a refusal. `worktree` must already have been checked by the
   * caller (see `Supervisor.cadWorktree`): the service trusts it, and only checks the part name.
   */
  private refFor(worktree: string, part: unknown): PartRef {
    return partRef(worktree, part); // throws BadPartName / UnsafePartFolder
  }

  /**
   * `cad.parts.list`: every part folder of a worktree with its gate state. A part whose process is
   * up is refreshed first, so its state is of the design as it is now; any other part is reported
   * `unverified` (never from the numbers stored in `part.json`). Starts no process.
   */
  async listParts(worktree: string): Promise<CadPartInfo[]> {
    const out: CadPartInfo[] = [];
    for (const name of listParts(worktree)) {
      let ref: PartRef;
      try {
        ref = this.refFor(worktree, name);
      } catch {
        continue; // a linked folder is not a part
      }
      if (this.manager.status(ref)?.live && !this.unavailableReason()) await this.manager.refreshNow(ref).catch(() => undefined);
      const st = this.manager.status(ref);
      const refreshed = st?.live ? this.snapshots.get(ref.key) : undefined;
      const snap = refreshed ?? this.diskSnapshot(ref);
      out.push({
        part: name,
        hasDesign: existsSync(join(ref.dir, DESIGN_FILE)),
        live: st?.live ?? false,
        busy: st?.busy ?? false,
        rev: snap.rev,
        ...(snap.outcome.preview ? { preview: snap.outcome.preview } : {}),
        gate: snap.outcome.gate,
      });
    }
    return out;
  }

  /** `cad.param.set`: the owner's change, by name. Refuses a part that does not exist. */
  async setParam(worktree: string, part: unknown, name: unknown, expression: unknown): Promise<{ ok: boolean; error?: string }> {
    const why = this.unavailableReason();
    if (why) return { ok: false, error: `CAD is not available on this machine: ${why}` };
    if (typeof name !== "string" || !name.trim()) return { ok: false, error: "cad.param.set: `name` must be a parameter name" };
    if ((typeof expression !== "string" && typeof expression !== "number") || !String(expression).trim()) return { ok: false, error: "cad.param.set: `expression` must be a value or a formula" };
    const ref = this.refFor(worktree, part);
    if (!existsSync(join(ref.dir, DESIGN_FILE)) && !this.manager.status(ref)?.live) return { ok: false, error: `cad/${ref.part} has no design yet` };
    const r = await this.setParamAsOwner(ref, name.trim(), String(expression).trim());
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? "the change was refused" };
  }

  /** `cad.design.refresh`: rebuild the part from `design.json` on disk. The `cad.design` that follows has `by: "reload"`. */
  async refreshDesign(worktree: string, part: unknown): Promise<void> {
    const why = this.unavailableReason();
    if (why) throw new Error(`CAD is not available on this machine: ${why}`);
    const ref = this.refFor(worktree, part);
    if (!existsSync(ref.dir)) throw new Error(`cad/${ref.part} does not exist`);
    await this.manager.reload(ref);
  }

  /** The absolute file behind a `cad.design.preview` path, or undefined when it is not one (or is gone). */
  previewFile(worktree: string, relPath: string): string | undefined {
    const m = PREVIEW_PATH_RE.exec(relPath);
    if (!m || isAbsolute(relPath)) return undefined;
    let ref: PartRef;
    try {
      ref = this.refFor(worktree, m[1]);
    } catch {
      return undefined;
    }
    const abs = join(ref.dir, CACHE_DIR, `preview-${Number(m[2])}.glb`);
    try {
      // The real file must sit in the part's own cache folder: a link out of it is not served.
      return realpathSync(abs) === abs ? abs : undefined;
    } catch {
      return undefined;
    }
  }

  private nextRev(ref: PartRef): number {
    // Above every preview already on disk, so a daemon restart never reuses (or prunes) a newer file.
    return Math.max(this.snapshots.get(ref.key)?.rev ?? 0, previewRevs(ref.dir).at(-1) ?? 0) + 1;
  }

  /** What is known about a part that has not been refreshed since the daemon started: the gate from
   *  the measurement stored in `part.json`, and the newest preview left on disk. */
  private diskSnapshot(ref: PartRef): PartSnapshot {
    const st = this.manager.status(ref);
    const disk = readDesignFile(ref.dir);
    const newest = newestPreview(ref);
    let gate: GateResult;
    try {
      gate = this.gateFromDisk(ref, disk.scriptSha);
    } catch (e) {
      gate = { state: "unverified", checks: [], warnings: [e instanceof Error ? e.message : String(e)], staleBuild: false };
    }
    return {
      ref,
      rev: newest?.rev ?? 0,
      outcome: { ref, gate, holes: [], params: st?.params ?? [], scriptSha: disk.scriptSha, ms: 0, forced: false, ...(newest ? { preview: newest.path } : {}) },
      by: "agent",
      busy: st?.busy ?? false,
    };
  }

  private ensureSnapshot(key: string, part: string): PartSnapshot {
    let snap = this.snapshots.get(key);
    if (!snap) this.snapshots.set(key, (snap = this.diskSnapshot(partRefOf(key, part))));
    return snap;
  }

  /** The queue of a part started or drained: keep `cad.design.busy` true while it works. */
  private onBusy(key: string, part: string, busy: boolean): void {
    const armed = this.busyTimers.get(key);
    if (armed !== undefined) this.clock.clearTimeout(armed);
    this.busyTimers.delete(key);
    if (busy) {
      // Not at once: most requests finish in milliseconds and their refresh says `busy` itself.
      this.busyTimers.set(
        key,
        this.clock.setTimeout(() => {
          this.busyTimers.delete(key);
          if (!this.manager.status(key)?.busy) return;
          const snap = this.ensureSnapshot(key, part);
          if (snap.busy) return;
          snap.busy = true;
          this.broadcast(this.designEvent(snap));
        }, BUSY_NOTICE_MS),
      );
      return;
    }
    const snap = this.snapshots.get(key);
    if (snap && (snap.busy || snap.waiting)) {
      snap.busy = false;
      snap.waiting = false;
      this.broadcast(this.designEvent(snap));
    }
  }

  /**
   * `design.json` changed on disk while a request ran (§4.2): nothing was overwritten and the part is
   * `fail`. Said at once, without touching the process — the next request reloads from disk, and it
   * is the Rebuild (or that reload) that clears it.
   */
  private onConflict(key: string, part: string): void {
    const snap = this.ensureSnapshot(key, part);
    const gate = snap.outcome.gate;
    snap.outcome = {
      ...snap.outcome,
      gate: { ...gate, state: "fail", checks: [...gate.checks.filter((c) => c.id !== "design"), { id: "design", expected: "design.json loaded as written", measured: DISK_CONFLICT_REASON, ok: false, hard: true }] },
    };
    this.broadcast(this.designEvent(snap));
  }

  /** A part is (or is no longer) held for a SolidCraft slot: said at once, the UI shows "waiting for a CAD slot". */
  private onWaiting(key: string, part: string, waiting: boolean): void {
    const snap = this.ensureSnapshot(key, part);
    if (!!snap.waiting === waiting) return;
    snap.waiting = waiting;
    if (waiting) snap.busy = true;
    this.broadcast(this.designEvent(snap));
  }

  /** Answer an expectations card (`cad.expectations.respond`). False when there is no such card. */
  respond(requestId: string, approve: boolean): boolean {
    const card = this.cards.get(requestId);
    if (!card) return false;
    this.cards.delete(requestId);
    let approved = approve;
    const toolCard = card.kind === "propose" || card.kind === "initial"; // the waiting tool call does the writing
    if (!toolCard && approve) approved = card.kind === "confirm" ? this.confirm(card) : this.adopt(card);
    this.broadcast({ v: PROTOCOL_VERSION, type: "cad.expectations.resolved", ts: now(), requestId, approved } satisfies CadExpectationsResolvedEvent);
    card.settle?.(approved);
    if (!toolCard) this.recheck(card.ref, card.kind === "adopt-rules");
    return true;
  }

  /** Deny every card parked for a session (reset, kill): a waiting tool call is released. */
  cancelSession(sessionId: string): void {
    this.ownerNotes.delete(sessionId);
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
      ...(s.outcome.preview ? { preview: s.outcome.preview } : {}),
      params: s.outcome.params,
      gate: s.outcome.gate,
      busy: s.busy,
      ...(s.waiting ? { waiting: true } : {}),
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
    const snap: PartSnapshot = { ref, rev: outcome.rev ?? (prev?.rev ?? 0) + 1, outcome, by, busy: (this.manager.status(ref)?.queued ?? 0) > 0 };
    this.snapshots.set(ref.key, snap);
    this.broadcast(this.designEvent(snap));
    this.syncAdoptCards(ref, outcome.gate, outcome.params);
  }

  /** One adopt card per pending adoption, in the chat of an attended session working on the part. */
  private syncAdoptCards(ref: PartRef, gate: GateResult, params: CadParamInfo[]): void {
    const wanted = new Set(pendingAdoptions(gate));
    const locked = readLocked(ref, this.locks, this.machine());
    const attended = [...(this.partSessions.get(ref.key) ?? [])].map((id) => this.deps.getSession(id)).find((s) => s && !isUnattended(s));
    const build: Partial<Record<CardKind, () => { sha: string; rows: CadExpectationsRow[]; rulesDiff?: CadExpectationsRequestEvent["rulesDiff"] } | undefined>> = {
      "adopt-expectations": () => {
        if (locked.part.kind !== "ok") return undefined;
        const f = locked.part.file;
        const p = paramMap(params);
        // A card always shows evaluated numbers: expectations that do not evaluate cannot be adopted
        // (the gate says which formula fails), so no card is drawn for them.
        if (f.expectations && !this.valuesNow(ref, f.expectations, params).values) return undefined;
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
        return { sha: ownerParamsCardSha(locked.part.file.ownerParams), rows: names.map((n) => ({ label: n, ...(old[n] !== undefined ? { old: String(old[n]) } : {}), ...(now_[n] !== undefined ? { new: String(now_[n]) } : {}) })) };
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

  /** The owner tapped Approve on an adopt card: record exactly what the card showed, and nothing
   *  else — every kind compares the card's hash with what is on disk now. */
  private adopt(card: Card): boolean {
    const { ref } = card;
    const locked = readLocked(ref, this.locks, this.machine());
    const at = new Date().toISOString();
    if (card.kind === "adopt-rules") {
      if (locked.rules.kind === "missing" || locked.rules.sha !== card.sha) return false; // changed since the card was drawn
      this.approveRules(ref.worktree, { sha: locked.rules.sha, text: locked.rules.text, at });
      return true;
    }
    if (locked.part.kind !== "ok") return false;
    const file = locked.part.file;
    if (card.kind === "adopt-expectations") {
      if (lockedBlockSha(file) !== card.sha) return false;
      // The accepted numbers are fixed here, at approval. Formulas that do not evaluate cannot be approved.
      const values = file.expectations ? this.valuesNow(ref, file.expectations).values : undefined;
      if (file.expectations && !values) return false;
      this.approve(ref, { sha: card.sha, approvedBy: "owner", status: file.status, ...(values ? { values } : {}), ...(file.ownerParams ? { ownerParams: file.ownerParams } : {}), at });
      return true;
    }
    if (card.kind !== "adopt-ownerParams" || !locked.lock) return false;
    if (ownerParamsCardSha(file.ownerParams) !== card.sha) return false; // not the dimensions the card showed
    const { ownerParams: _old, repo: _r, part: _p, remote: _m, path: _a, ...rest } = locked.lock;
    this.approve(ref, { ...rest, ...(file.ownerParams ? { ownerParams: file.ownerParams } : {}), at });
    return true;
  }

  /**
   * "Confirm numbers" (`cad.expectations.confirm`): raise the standard owner card for a part whose
   * numbers the agent recorded. Approving it makes the owner the approver of exactly that block.
   */
  confirmNumbers(sessionId: string, ref: PartRef): ExpectationsReply {
    const session = this.deps.getSession(sessionId);
    if (!session) return { ok: false, error: "no such session" };
    const locked = readLocked(ref, this.locks, this.machine());
    if (locked.part.kind !== "ok" || !locked.part.file.expectations) return { ok: false, error: `cad/${ref.part} has no expectations to confirm` };
    const file = locked.part.file;
    const sha = lockedBlockSha(file);
    if (!locked.lock || locked.lock.sha !== sha || !hasValues(locked.lock.values)) return { ok: false, error: `cad/${ref.part}'s expectations are not approved as they stand; adopt them on their card instead` };
    if (locked.lock.approvedBy !== "agent-initial") return { ok: false, error: `cad/${ref.part}'s numbers are already approved by the ${locked.lock.approvedBy}` };
    this.touch(sessionId, ref);
    for (const c of [...this.cards.values()]) if (c.kind === "confirm" && c.ref.key === ref.key) return { ok: true, note: "a card is already open" };
    const requestId = newId("cadx");
    const v = locked.lock.values;
    this.park({
      requestId,
      sessionId,
      ref,
      kind: "confirm",
      sha,
      body: {
        type: "cad.expectations.request",
        requestId,
        sessionId,
        cwd: ref.worktree,
        part: ref.part,
        kind: "confirm",
        rows: [{ label: "Process", new: file.process }, { label: "Status", new: file.status }, ...expectationRows(undefined, file.expectations!, paramMap(this.manager.status(ref)?.params ?? []), v), { label: "Recorded by", old: "the agent", new: "you, once approved" }],
      },
    });
    return { ok: true };
  }

  private confirm(card: Card): boolean {
    const locked = readLocked(card.ref, this.locks, this.machine());
    if (locked.part.kind !== "ok" || !locked.lock || lockedBlockSha(locked.part.file) !== card.sha || locked.lock.sha !== card.sha || !hasValues(locked.lock.values)) return false;
    const { repo: _r, part: _p, remote: _m, path: _a, ...rest } = locked.lock;
    this.approve(card.ref, { ...rest, approvedBy: "owner", at: new Date().toISOString() });
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
   * What can be said about a part WITHOUT a live measurement of its current script (a parts list for
   * a part whose process is not up). It is NEVER `pass`: `part.json.measured` is a committed file the
   * agent can rewrite, so the last known numbers are shown by whoever reads the file but prove
   * nothing — the state is `unverified` ("not measured in this session") until a refresh has run.
   */
  gateFromDisk(ref: PartRef, scriptSha: string | undefined): GateResult {
    const locked = readLocked(ref, this.locks, this.machine());
    const g = evaluateGate({ ...locked, measurement: undefined, measureError: NOT_MEASURED, scriptSha, solidcraft: this.status().version, featureErrors: [], warnings: [] });
    return g.state === "pass" ? { ...g, state: "unverified" } : g; // belt and braces: without a measurement it cannot pass
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
    for (const t of this.busyTimers.values()) this.clock.clearTimeout(t);
    this.busyTimers.clear();
    for (const card of [...this.cards.values()]) card.settle?.(false);
    this.cards.clear();
    await this.manager.shutdown();
    await this.lockSync.settled();
  }
}

/** What an adopt-ownerParams card stands for: the dimensions in the file when it was drawn. */
const ownerParamsCardSha = (p: Record<string, number> | undefined): string => JSON.stringify(Object.keys(p ?? {}).sort().map((n) => [n, p![n]]));
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

