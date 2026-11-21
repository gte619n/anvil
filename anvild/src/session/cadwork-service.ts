/**
 * The CAD domain service (agent-cad-and-browser spec §4.2–§4.4, §4.8). Owns the process manager and
 * hands each ordinary session its `anvil_cad` tool server; the Supervisor keeps thin delegates.
 *
 * Capability vs availability (§4.8): `cad-work` in `ANVIL_FEATURES` decides whether a session GETS the
 * server at all. Whether CAD can run right now (is there a binary? later: is it on the fleet pin?)
 * is the `cad.status` event, and the tools refuse with its reason — nothing is withdrawn from a live
 * driver.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import {
  CAD_DIMENSION_MAX_MM,
  PROTOCOL_VERSION,
  type CadDesignEvent,
  type CadPartInfo,
  type CadExpectationsRequestEvent,
  type CadExpectationsResolvedEvent,
  type CadExpectationsRow,
  type CadDimensionRow,
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
import { CadManager, sweepOrphanedTmpRoots, type CadManagerOptions, type CadParamInfo, type SlotContext } from "../cadwork/manager";
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
  type GapRecord,
  type PartFile,
  type PartReference,
  type PartRead,
} from "../cadwork/partfile";
import { exprNames } from "../cadwork/expr";
import { gapOf, makeRefreshJob, newestPreview, previewRevs, readDesign, readLocked, PREVIEW_PATH_RE, THUMB_PATH_RE, type RefreshOutcome } from "../cadwork/refresh";
import { embeddedReferences, importFeatureName, liveReferences, readComponentList, readRegularFile, referenceName, referenceOnDisk, referencePlacementChecks, resolveReferenceSource, stepSolidCount, storeReference, REFERENCE_MAX_BYTES, REFS_DIR } from "../cadwork/refs";
import { verifyParts, type VerifyResult } from "../cadwork/verify";
import { canonicalBlock, checkPlanPart, keepsApproval, parseDeclared, planWrite, type ApprovedNumbers, type PlanPartExpectations } from "../cadwork/plan-expectations";
import { releaseFolder, releaseKey, verifyRelease, writeReleasePack, type ReleaseData, type ReleaseVerdict } from "../cadwork/release";
import { holeTable, mergeHoleTables } from "../cadwork/holes";
import { readRules } from "../cadwork/rules";
import { advisoryLines, failingLines, type GateCheck } from "../cadwork/gate";
import { lineDiff } from "../cadwork/rules";
import { newId } from "../util/ids";
import { currentManagedSolidcraft, resolveSolidcraftCli, type ResolvedSolidcraft } from "../solidcraft/binary";
import { now } from "../util/envelope";
import { writeFileAtomic } from "../util/atomic";
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
  /** Test seam: the reference size cap (default 50 MB, owner item 45). */
  referenceMaxBytes?: number;
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
  /** A release pack of the current script that verifies on this machine (Phase A4). */
  released?: { path: string; scriptSha: string; at: string };
  /** part.json's status at the refresh. */
  status?: "concept" | "dimensioned";
}

/** Broadcasts of `cad.design` per part are coalesced to one per this many ms (spec §6: ≤ 2/s). */
export const DESIGN_BROADCAST_MS = 500;

/** How long a part's queue must stay busy before a `cad.design` is sent just to say so. A refresh
 *  that lands sooner carries `busy` itself, so a short burst costs no extra event. */
export const BUSY_NOTICE_MS = 250;
/** Why `cad.param.set` / `cad.parts.list` / `cad.design.refresh` refuse a `cwd`. */
export const CWD_REFUSED = "is not the worktree of a session or a registered environment on this machine";

type CardKind = CadExpectationsRequestEvent["kind"];
/** How an owner card was answered. `stale`: approved, but something the card showed changed while it
 *  was open — nothing is approved and a fresh card is drawn (decision 153). */
export type CardAnswer = "approved" | "denied" | "stale";
/**
 * What an owner card was drawn from (decision 153), stored with the card. Every kind follows one rule:
 * "old" is the ACCEPTED values; each parameter whose current value differs from its accepted value is
 * its own row ("changed by the agent, not approved"); approving approves exactly the rows shown —
 * those parameter rows included — and the lock is written from THESE values, never from the design
 * as it is at approval time. On approval the state is read again and any difference refuses.
 */
export interface CardSnapshot {
  /** The approved parameter values: the lock's `declared`, and for a name never accepted the value
   *  the card was drawn with. */
  accepted: Record<string, number>;
  /** The design's parameter values when the card was drawn. */
  current: Record<string, number>;
  /** Names whose current value differs from (or has no) accepted value: shown as their own rows. */
  changed: string[];
  /** The approval on record had numbers but no parameter values (made before `declared` existed). */
  noDeclared: boolean;
  /** Everything else the card showed (part.json's locked block and refs, the lock, extras). */
  fingerprint: string;
  /** The part.json + lock half of `fingerprint` (what an owner write re-checks inside the queue). */
  core: string;
  /** The card's extra state (a reference file's sha, a script sha) as JSON. */
  extra: string;
  /** part.json as the card was drawn (undefined: there was none). An owner write builds the file it
   *  writes from THIS — its process, status, expectations, refs — never from a re-read. */
  file?: PartFile;
}
interface Card {
  requestId: string;
  sessionId: string;
  ref: PartRef;
  kind: CardKind;
  body: Omit<CadExpectationsRequestEvent, "v" | "ts" | "replay">;
  /** propose / initial / dimensions / release: settles the tool call that is waiting on the owner.
   *  A `dimensions` card also hands over the owner's typed numbers. */
  settle?: (answer: CardAnswer, values?: Record<string, number>) => void;
  /** adopt: the hash of exactly what the card showed. Approval records THIS and nothing else. */
  sha?: string;
  /** adopt / confirm: the identity of the whole card (hash, rows, snapshot). Approval needs it unchanged. */
  key?: string;
  /** What the card was drawn from (decision 153). */
  snap?: CardSnapshot;
  /** adopt-expectations / confirm: the accepted numbers approval writes (evaluated from `snap.current`). */
  values?: EvaluatedExpectations;
  /** True when something the card showed has changed since it was drawn: an approval is refused. */
  stale?: () => boolean;
  /** dimensions: the names the owner must give a number for. */
  dims?: string[];
  /** The session's status before this card held it at `awaiting_permission` (only while a turn ran). */
  prevStatus?: string;
}

export const NO_EXPECTATIONS = "has no expectations yet";
/** `request_dimensions` while this session already has a dimensions card open for the part. */
export const DIMENSIONS_CARD_OPEN = "a dimensions card is already open";
export type ExpectationsReply = { ok: true; note?: string } | { ok: false; error: string };
/** The caution on an `initial` card: the numbers were written after the part existed. */
export const INITIAL_AFTER_GEOMETRY = "this part already has geometry; these numbers were written after it existed";
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z_0-9]*$/;

/** `record_expectations`' `parameters` reader — shared with the autopilot plan's expectations (Phase B3). */
export { parseDeclared } from "../cadwork/plan-expectations";

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
  /** Adopt cards the owner DENIED, by scope (`adoptScope`) → the card's key. The same card is not
   *  drawn again until what it would show changes, or the owner asks again (Rebuild on the part card). */
  private readonly deniedAdopt = new Map<string, string>();
  private readonly nextBy = new Map<string, "panel" | "reload">();
  private readonly offProtected?: () => void;
  private readonly clock: CadClock;
  private readonly busyTimers = new Map<string, unknown>();
  /** What the owner changed in the panel that each session's agent has not been told yet. */
  private readonly ownerNotes = new Map<string, string[]>();
  /** sha256 of every preview the daemon exported, by absolute path (`<stateDir>/cadwork/previews.json`). */
  private readonly previewShas = new Map<string, string>();
  private readonly previewShasFile: string;
  private readonly stateDir: string;
  /** Per part: when the last coalesced `cad.design` went out, in which busy period, and the trailing timer. */
  private readonly emitState = new Map<string, { at: number; epoch: number; timer?: unknown }>();
  private readonly busyEpoch = new Map<string, number>();
  /** A concept part's last picture comparison (advisory, shown on the card). */
  private readonly pictureScores = new Map<string, { overlap: number; picture: string; at: string }>();

  constructor(private readonly deps: CadworkServiceDeps) {
    this.resolveCli = deps.resolveCli ?? (() => resolveSolidcraftCli());
    this.readVersion = deps.readVersion ?? readSolidcraftVersion;
    this.manager = new CadManager({ resolveCli: this.resolveCli, ...deps.manager });
    // Daemon start: the SolidCraft temp roots a daemon that is gone left behind (killed, crashed, a test
    // run that never shut down) are removed — only `anvil-sc-<dead pid>-*`, only when over an hour old.
    if (!deps.manager?.tmpRoot) sweepOrphanedTmpRoots();
    this.clock = deps.manager?.clock ?? realClock;
    const stateDir = deps.stateDir ?? mkdtempSync(join(tmpdir(), "anvil-cadwork-state-"));
    this.stateDir = stateDir;
    this.locks = new LockStore(stateDir);
    this.previewShasFile = join(stateDir, "cadwork", "previews.json");
    try {
      const raw = JSON.parse(readFileSync(this.previewShasFile, "utf8"));
      if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) if (typeof v === "string") this.previewShas.set(k, v);
    } catch {
      /* none yet */
    }
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
          advisoryFor: (ref) => this.advisoryFor(ref),
        }),
      );
      this.manager.subscribe((e) => {
        if (e.type === "reloaded") this.nextBy.set(e.key, "reload");
        else if (e.type === "busy") this.onBusy(e.key, e.part, e.busy);
        else if (e.type === "waiting") this.onWaiting(e.key, e.part, e.waiting);
        else if (e.type === "conflict") this.onConflict(e.key, e.part);
        else if (e.type === "stopped" && e.reason !== "reload") this.onStopped(e.key); // a reload restarts at once, mid-request
      });
    }
  }

  get enabled(): boolean {
    return this.deps.enabled;
  }

  // ── Fleet pin (merge wiring (b); decision 40). Set by ./cadwork-pin.ts when "solidcraft-pin" is on.
  /** Track B's verdict: is this machine on the fleet's pinned SolidCraft? */
  private pinSource?: () => Promise<{ available: boolean; reason?: string; pinned?: string }>;
  /** The last verdict; `undefined` while a source is set but has not answered yet (fail closed). */
  private pinVerdict?: { available: boolean; reason?: string; pinned?: string };

  /** Gate CAD availability on the fleet pin (spec §4.10: a machine off the pin refuses every call). */
  setPinSource(source: (() => Promise<{ available: boolean; reason?: string; pinned?: string }>) | undefined): void {
    this.pinSource = source;
    this.pinVerdict = undefined;
  }

  /** Whether CAD can run on this machine right now. Cheap and synchronous: re-resolved every call,
   *  so an install or a pin change takes effect without a restart. */
  status(): CadStatus {
    const local = this.localStatus();
    if (!this.pinSource) return local;
    const pin = this.pinVerdict;
    if (!pin) return { ...local, available: false, reason: "CAD is unavailable here until this machine has checked the fleet's SolidCraft pin" };
    if (!pin.available) return { ...local, available: false, reason: pin.reason ?? "CAD is unavailable here: this machine is not on the fleet's SolidCraft pin", ...(pin.pinned ? { pinned: pin.pinned } : {}) };
    return { ...local, ...(pin.pinned ? { pinned: pin.pinned } : {}) };
  }

  /** Every SolidCraft process up right now (the pin wiring restarts them after the build changes). */
  liveParts(): PartRef[] {
    return this.manager.liveRefs();
  }

  private localStatus(): CadStatus {
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
    if (this.pinSource) {
      try {
        this.pinVerdict = await this.pinSource();
      } catch (e) {
        this.pinVerdict = { available: false, reason: `CAD is unavailable here: the SolidCraft pin could not be checked (${e instanceof Error ? e.message : String(e)})` };
      }
    }
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
      partRefusal: (ref) => this.partRefusal(sessionId, ref),
      modelingRefusal: (ref) => this.modelingRefusal(ref),
      recordExpectations: (ref, process, parameters, expectations) => this.recordExpectations(sessionId, ref, process, parameters, expectations),
      proposeExpectations: (ref, expectations, reason) => this.proposeExpectations(sessionId, ref, expectations, reason),
      checkPart: (ref) => this.checkPart(sessionId, ref),
      takeOwnerNotes: () => this.takeOwnerNotes(sessionId),
      importReference: (ref, file) => this.importReference(sessionId, ref, file),
      startConcept: (ref, process) => this.startConcept(sessionId, ref, process),
      requestDimensions: (ref, proposed) => this.requestDimensions(sessionId, ref, proposed),
      reportGap: (ref, feature, detail) => this.reportGap(sessionId, ref, feature, detail),
      exportRefusal: (ref) => this.exportRefusal(ref),
      releasePart: (ref) => this.releasePart(sessionId, ref),
      pictureFile: (ref, src) => this.pictureFile(sessionId, ref, src),
      recordPicture: (ref, overlap, picture) => this.recordPicture(ref, overlap, picture),
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

  // ── owner cards: one rule for every kind (decision 153) ─────────────────────────────────────────

  /** The design's parameter values now (the manager's record of the live process). */
  private paramsNow(ref: PartRef): Record<string, number> {
    return paramMap(this.manager.status(ref)?.params ?? []);
  }

  /** Everything an owner card shows about a part besides its parameter values and extras: part.json's
   *  locked block, references, dimensions and material, and the approval on record — from ONE read. */
  private cardCore(ref: PartRef): { core: string; file?: PartFile } {
    const part = readPartFile(ref.dir);
    const lock = this.findLock(ref);
    const core = JSON.stringify({
      part: partKeyOf(part),
      lock: lock ? { sha: lock.sha, by: lock.approvedBy, status: lock.status, values: lock.values ?? null, declared: sortedEntries(lock.declared), ownerParams: sortedEntries(lock.ownerParams) } : null,
    });
    return { core, ...(part.kind === "ok" ? { file: part.file } : {}) };
  }
  private cardFingerprint(ref: PartRef, extra?: () => unknown): string {
    return JSON.stringify([this.cardCore(ref).core, JSON.stringify(extra ? extra() : null)]);
  }

  /**
   * What an owner card is drawn from: the accepted parameter values (the lock's `declared`; where a
   * name has none, the value the card is drawn with), the current ones, the names that differ, and a
   * fingerprint of everything else the card shows. `current` defaults to the design's values now.
   */
  cardSnapshot(ref: PartRef, opts: { current?: Record<string, number>; extra?: () => unknown } = {}): CardSnapshot {
    const current = { ...(opts.current ?? this.paramsNow(ref)) };
    const lock = this.findLock(ref);
    const accepted = { ...current, ...(lock?.declared ?? {}) };
    const changed = Object.keys(accepted)
      .sort()
      .filter((n) => current[n] === undefined || !closeTo(current[n]!, accepted[n]!));
    const { core, file } = this.cardCore(ref);
    const extra = JSON.stringify(opts.extra ? opts.extra() : null);
    return { accepted, current, changed, noDeclared: !!lock && hasValues(lock.values) && !lock.declared, fingerprint: JSON.stringify([core, extra]), core, extra, ...(file ? { file } : {}) };
  }

  /** Does the part still show exactly what the card was drawn from (parameters and everything else)? */
  private stillShows(ref: PartRef, snap: CardSnapshot, extra?: () => unknown): boolean {
    return sameValues(this.paramsNow(ref), snap.current) && this.cardFingerprint(ref, extra) === snap.fingerprint;
  }

  /**
   * The check every owner card's write makes FIRST, inside the part's queue slot and with nothing
   * awaited between it and the write (decisions 153, 204): the design's parameters (`params`, the
   * slot's), part.json's locked block, references and dimensions, the approval on record and the
   * card's extra state are all still what the card showed — except what this card's own action
   * changed: `ownParams` (names it created or set) and `extraExpected` (the extra state its action
   * leaves, e.g. the new reference file's sha).
   */
  private shownNow(ref: PartRef, snap: CardSnapshot, params: CadParamInfo[], opts: { extraNow?: () => unknown; extraExpected?: string; ownParams?: string[] } = {}): boolean {
    const now_ = paramMap(params);
    const want = { ...snap.current };
    for (const n of opts.ownParams ?? []) {
      delete now_[n];
      delete want[n];
    }
    if (!sameValues(now_, want)) return false;
    if (this.cardCore(ref).core !== snap.core) return false;
    return JSON.stringify(opts.extraNow ? opts.extraNow() : null) === (opts.extraExpected ?? snap.extra);
  }

  /**
   * The part.json an owner card writes: the SNAPSHOT's process, material, status, dimensions,
   * expectations and references, with the card's own change on top. Only what the card never
   * showed and the gate never trusts (the last measurement, a reported gap) is taken from disk.
   */
  private fileFromSnapshot(ref: PartRef, snap: CardSnapshot, change: { expectations?: Expectations; refs?: PartReference[]; ownerParams?: Record<string, number> }): PartFile {
    const base = snap.file!;
    const disk = readPartFile(ref.dir);
    const fresh = disk.kind === "ok" ? disk.file : undefined;
    const expectations = "expectations" in change ? change.expectations : base.expectations;
    const refs = "refs" in change ? change.refs : base.refs;
    const ownerParams = "ownerParams" in change ? change.ownerParams : base.ownerParams;
    return {
      schema: 1,
      process: base.process,
      ...(base.material ? { material: base.material } : {}),
      status: base.status,
      ...(ownerParams ? { ownerParams: { ...ownerParams } } : {}),
      ...(expectations ? { expectations } : {}),
      ...(refs?.length ? { refs } : {}),
      ...(fresh?.gap ? { gap: fresh.gap } : {}),
      ...(fresh?.measured ? { measured: fresh.measured } : {}),
    };
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
    // Phase B3: an autopilot builder never sets the numbers of a part its plan covers — those come
    // from the plan, approved by the owner, and were written before its first turn.
    const scope = this.builderPartsOf(sessionId);
    if (scope?.includes(ref.part)) return { ok: false, error: `record_expectations was denied: cad/${ref.part}'s expectations come from this work unit's approved plan (they were applied before you started); build the part to meet them, or call report_gap` };
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
    const ownerParams = part.kind === "ok" ? part.file.ownerParams : undefined;
    if (part.kind === "ok" && part.file.status === "concept") {
      // A concept is promoted only on the dimensions the OWNER typed (request_dimensions), in the file
      // AND the lock store.
      if (!ownerParams || !lock || lock.status !== "concept" || JSON.stringify(sortedEntries(lock.ownerParams)) !== JSON.stringify(sortedEntries(ownerParams))) {
        return { ok: false, error: `cad/${ref.part} is a concept: its dimensions have to be confirmed by the owner (request_dimensions) before expectations are recorded.` };
      }
    }
    const declared = parseDeclared(parameters);
    if (!declared.ok) return { ok: false, error: `record_expectations: ${declared.error}` };
    if (ownerParams) {
      // The owner's typed numbers ARE the dimensions: a record that declares anything else is refused.
      const differ = Object.keys(ownerParams)
        .sort()
        .filter((n) => declared.values[n] === undefined || Math.abs(declared.values[n]! - ownerParams[n]!) > 1e-9 * Math.max(1, Math.abs(ownerParams[n]!)));
      if (differ.length) {
        return { ok: false, error: `record_expectations refused: the declared parameters differ from the dimensions the owner typed (${differ.map((n) => `${n} must be ${num(ownerParams[n]!)}, declared ${declared.values[n] === undefined ? "nothing" : num(declared.values[n]!)}`).join("; ")}). Declare exactly the owner's values.` };
      }
    }
    const why = expectationsShapeError(input, { stamped: false });
    if (why) return { ok: false, error: `record_expectations: ${why}` };
    // Every imported reference is something the part must not touch — those recorded in part.json and
    // those imported before part.json existed (embedded in the design, with their file in refs/).
    const embedded = embeddedReferences(readDesignFile(ref.dir).script).filter((e) => existsSync(join(ref.dir, REFS_DIR, e.file)));
    const refRecords: PartReference[] = [...(part.kind === "ok" ? (part.file.refs ?? []) : [])];
    for (const e of embedded) if (!refRecords.some((r) => r.name === e.file)) refRecords.push({ name: e.file, source: `${REFS_DIR}/${e.file}`, sha256: e.sha256, bodies: e.bodies, at: new Date().toISOString() });
    const refNames = refRecords.map((r) => r.name);
    const asked = (input as ExpectationsInput).noInterferenceWith ?? [];
    const withRefs = refNames.length ? { ...(input as ExpectationsInput), noInterferenceWith: [...new Set([...asked, ...refNames])] } : (input as ExpectationsInput);
    const draft = stampExpectations(withRefs, "agent-initial", new Date().toISOString());
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
      const r = await slot.call("inspect_design", { measure: false, sketches: false, timeline: "summary", bodies: true });
      const j = r.json ?? {};
      const timeline: any[] = Array.isArray(j.timeline) ? j.timeline : [];
      const bodies: any[] = Array.isArray(j.bodies) ? j.bodies : [];
      const imports = new Set(timeline.filter((f) => f?.type === "BaseFeature").map((f) => f.id));
      // Imported reference bodies (import_reference) are not the part: they do not make it "existing".
      return { features: timeline.filter((f) => !imports.has(f?.id)).length, bodies: bodies.filter((b) => !imports.has(b?.feature)).length, onlyReferences: imports.size > 0, params: slot.params() };
    });
    for (const p of live.params) {
      const want = declared.values[p.name];
      if (want !== undefined && Math.abs(p.value - want) > 1e-9 * Math.max(1, Math.abs(want))) {
        return { ok: false, error: `record_expectations refused: the design already has ${p.name} = ${num(p.value)}, not the declared ${num(want)}. Declare the value the design has, or change the parameter first.` };
      }
    }
    const pristine = (!hadDesign || live.onlyReferences) && live.features === 0 && live.bodies === 0 && live.params.length === 0 && !lock;
    const keep = part.kind === "ok" ? part.file : undefined;
    const file = (exp: Expectations): PartFile => ({
      schema: 1,
      process: process.trim(),
      ...(keep?.material ? { material: keep.material } : {}),
      status: "dimensioned",
      ...(keep?.ownerParams ? { ownerParams: keep.ownerParams } : {}),
      expectations: exp,
      ...(refRecords.length ? { refs: refRecords } : {}),
      // An owner-approved record is an approved expectation change: it clears a reported gap.
      ...(keep?.gap && by !== "owner" ? { gap: keep.gap } : {}),
    });
    let exp = draft;
    let by: "agent-initial" | "owner" = "agent-initial";
    /** The owner card's snapshot (decision 153): the write checks the design still has these values. */
    let shown: CardSnapshot | undefined;

    if (!pristine) {
      // The part exists already: only the owner can say what it must be.
      const session = this.deps.getSession(sessionId);
      if (!session) return { ok: false, error: "the session is gone" };
      if (isUnattended(session)) return { ok: false, error: `record_expectations was denied: cad/${ref.part} already has geometry (or an earlier approval), so its expectations need the owner's approval, and this session is unattended` };
      exp = { ...draft, lockedBy: "owner" };
      by = "owner";
      let answer: CardAnswer = "stale";
      for (let round = 0; round < 3 && answer === "stale"; round++) {
        const snap = this.cardSnapshot(ref);
        // The card shows what this call read at its start (part.json's process, refs, dimensions): if
        // part.json moved since, the call starts over rather than show (and write) a mix.
        if (JSON.stringify(JSON.parse(snap.core).part) !== JSON.stringify(partKeyOf(part))) return { ok: false, error: `record_expectations refused: cad/${ref.part}/part.json changed while the call ran. Nothing was recorded; call it again.` };
        for (const [n, want] of Object.entries(declared.values)) {
          if (snap.current[n] !== undefined && !closeTo(snap.current[n]!, want)) return { ok: false, error: `record_expectations refused: the design has ${n} = ${num(snap.current[n]!)}, not the declared ${num(want)}. Nothing was recorded.` };
        }
        const requestId = newId("cadx");
        answer = await new Promise<CardAnswer>((resolve) => {
          this.park({
            requestId,
            sessionId,
            ref,
            kind: "initial",
            snap,
            settle: resolve,
            stale: () => !this.stillShows(ref, snap),
            body: {
              type: "cad.expectations.request",
              requestId,
              sessionId,
              cwd: ref.worktree,
              part: ref.part,
              kind: "initial",
              note: INITIAL_AFTER_GEOMETRY,
              rows: [
                { label: "Process", new: process.trim() },
                { label: "Status", ...(keep?.status === "concept" ? { old: "concept" } : {}), new: "dimensioned" },
                ...parameterRows(snap),
                ...expectationRows(undefined, exp, undefined, values),
                ...(ownerParams ? [{ label: "Dimensions you typed", new: Object.keys(ownerParams).sort().map((n) => `${n} = ${num(ownerParams[n]!)}`).join(", ") }] : []),
              ],
            },
          });
        });
        if (answer === "approved" && !this.stillShows(ref, snap)) answer = "stale";
        if (answer === "approved") shown = snap;
      }
      if (answer === "denied") return { ok: true, approved: false };
      if (answer === "stale") return { ok: false, error: `cad/${ref.part} kept changing while the owner was being asked; nothing was written` };
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
      // Decision 204: everything the owner's card showed still holds — every other parameter, part.json,
      // the approval on record — checked here, in the queue slot, with nothing awaited before the write.
      if (shown && !this.shownNow(ref, shown, params, { ownParams: toAdd })) {
        failure = `cad/${ref.part} changed while the owner's card was open (its parameters, part.json or the approval on record)`;
        return;
      }
      const f = file(exp);
      writePartFile(ref.dir, f);
      this.approve(ref, { sha: lockedBlockSha(f), approvedBy: by, status: "dimensioned", values, declared: declared.values, ...(f.ownerParams ? { ownerParams: f.ownerParams } : {}), at: exp.lockedAt });
      if (by === "owner") this.clearGapRecord(ref);
    };
    if (toAdd.length) {
      await this.manager.request(ref, {
        tool: "batch",
        args: { commands: toAdd.map((name) => ({ command: "parameters.add", params: { name, expression: declared.expressions[name] } })), verbose: false },
        kind: "mutate",
        afterWrite: async (slot, done) => {
          if (done.result.isError) failure = `the declared parameters could not be created: ${done.result.text}`;
          else if (slot.state().conflict) failure = DISK_CONFLICT_REASON;
          else write(slot.params());
          // Leave the design as it was, in the same slot (and not redoable).
          if (failure && !done.result.isError) await slot.revert().catch(() => undefined);
        },
      });
      if (failure) return { ok: false, error: `record_expectations refused: ${failure}. Nothing was recorded.` };
    } else {
      await this.manager.run(ref, async (slot) => write(slot.params()));
      if (failure) return { ok: false, error: `record_expectations refused: ${failure}. Nothing was recorded.` };
    }
    if (by === "owner") this.recheck(ref);
    return { ok: true, approved: true, by };
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
  async proposeExpectations(
    sessionId: string,
    ref: PartRef,
    input: unknown,
    reason: unknown,
    /**
     * `inSlot`: the card's own action (import_reference imports the reference here). It runs after the
     * owner approved, INSIDE the same queue job as the write and only after the card's snapshot was
     * re-checked; a failure (or a snapshot that no longer holds after it) rolls it back and writes
     * nothing. `extraRows` / `reasonFor` are re-drawn on every round; `extraState` is part of what the
     * card shows.
     */
    opts: { inSlot?: (slot: SlotContext) => Promise<CardAction>; extraRows?: () => CadExpectationsRow[]; extraState?: () => unknown; reasonFor?: () => string } = {},
  ): Promise<ExpectationsReply & { approved?: boolean }> {
    this.touch(sessionId, ref);
    const session = this.deps.getSession(sessionId);
    if (!session) return { ok: false, error: "the session is gone" };
    if (isUnattended(session)) return { ok: false, error: "propose_expectations was denied: this session is unattended, so no one can approve a change to the expectations" };
    if (typeof reason !== "string" || !reason.trim()) return { ok: false, error: "propose_expectations: give a `reason` the owner can judge the change by" };
    const why = expectationsShapeError(input, { stamped: false });
    if (why) return { ok: false, error: `propose_expectations: ${why}` };
    await this.manager.open(ref); // the parameters the formulas are evaluated with
    for (let round = 0; round < 3; round++) {
      const part = readPartFile(ref.dir);
      if (part.kind !== "ok" || !part.file.expectations) return { ok: false, error: `cad/${ref.part} has no expectations to change: call record_expectations first` };
      // Decision 153: "old" is the ACCEPTED numbers; "new" is the proposal at the values the card
      // approves — the design's, with every parameter that differs from its accepted value shown.
      // Everything on the card is drawn from this ONE snapshot (its part.json included).
      const snap = this.cardSnapshot(ref, { extra: opts.extraState });
      const shownFile = snap.file;
      if (!shownFile?.expectations) continue;
      const before = shownFile.expectations;
      // A proposal that says nothing about tolerance keeps the current one.
      const proposed = stampExpectations({ ...(input as ExpectationsInput), tolerance: { ...before.tolerance, ...((input as ExpectationsInput).tolerance ?? {}) } }, "owner", new Date().toISOString());
      const caps = toleranceCapErrors(proposed.tolerance);
      if (caps.length) return { ok: false, error: `propose_expectations refused: ${caps.join("; ")}` };
      let values: EvaluatedExpectations;
      try {
        values = evaluateExpectations(proposed, snap.current);
      } catch (e) {
        return { ok: false, error: `propose_expectations refused: ${e instanceof Error ? e.message : String(e)}. Every formula must evaluate against the design's parameters before the owner is asked, so the card can show numbers.` };
      }
      const lock = this.findLock(ref);
      const oldValues = hasValues(lock?.values) ? lock.values : evalOrUndefined(before, snap.accepted);
      const requestId = newId("cadx");
      const answer = await new Promise<CardAnswer>((resolve) => {
        this.park({
          requestId,
          sessionId,
          ref,
          kind: "propose",
          snap,
          settle: resolve,
          stale: () => !this.stillShows(ref, snap, opts.extraState),
          body: {
            type: "cad.expectations.request",
            requestId,
            sessionId,
            cwd: ref.worktree,
            part: ref.part,
            kind: "propose",
            reason: opts.reasonFor ? opts.reasonFor() : reason.trim(),
            rows: [
              { label: "Process", old: shownFile.process, new: shownFile.process },
              { label: "Status", old: shownFile.status, new: shownFile.status },
              ...parameterRows(snap),
              ...expectationRows(before, proposed, oldValues, values),
              ...(opts.extraRows?.() ?? []),
            ],
          },
        });
      });
      if (answer === "denied") return { ok: true, approved: false };
      if (answer === "stale" || !this.stillShows(ref, snap, opts.extraState)) continue; // ask again, showing what is there now
      // ONE queued job: re-check the snapshot, run the card's own action, re-check again (only what
      // that action changed may differ), then write part.json and the approval from the SNAPSHOT.
      let outcome: { kind: "ok" } | { kind: "stale" } | { kind: "error"; error: string };
      try {
        outcome = await this.manager.run(ref, async (slot) => {
          if (!this.shownNow(ref, snap, slot.params(), { extraNow: opts.extraState })) return { kind: "stale" as const };
          let action: Extract<CardAction, { ok: true }> | undefined;
          if (opts.inSlot) {
            const a = await opts.inSlot(slot);
            if (!a.ok) return { kind: "error" as const, error: a.error };
            action = a;
          }
          const undo = async (why: string): Promise<{ kind: "stale" } | { kind: "error"; error: string }> => {
            const err = action ? await action.rollback() : undefined;
            return err ? { kind: "error", error: `the owner approved, but ${why}; the import could not be undone (${err}) — ${action!.leftBehind}` } : { kind: "stale" };
          };
          if (!this.shownNow(ref, snap, slot.params(), { extraNow: opts.extraState, ...(action ? { extraExpected: JSON.stringify(action.extraAfter) } : {}) })) {
            return undo(`cad/${ref.part} changed while the card's action ran`);
          }
          const prevText = readPartFile(ref.dir);
          try {
            const file = this.fileFromSnapshot(ref, snap, { expectations: proposed, ...(action ? { refs: action.refs(shownFile.refs ?? []) } : {}) });
            writePartFile(ref.dir, file);
            this.approve(ref, { sha: lockedBlockSha(file), approvedBy: "owner", status: file.status, values, declared: declaredFor(snap.current, lock, proposed), ...(file.ownerParams ? { ownerParams: file.ownerParams } : {}), at: proposed.lockedAt });
          } catch (e) {
            if (prevText.kind !== "missing") restorePartText(ref.dir, prevText.text);
            const r = await undo(`part.json could not be written (${e instanceof Error ? e.message : String(e)})`);
            return r.kind === "error" ? r : { kind: "error" as const, error: `the owner approved, but cad/${ref.part}/part.json could not be written (${e instanceof Error ? e.message : String(e)}); nothing was changed` };
          }
          return { kind: "ok" as const };
        });
      } catch (e) {
        return { ok: false, error: `the owner approved, but the change could not be made (${e instanceof Error ? e.message : String(e)}); nothing was written` };
      }
      if (outcome.kind === "stale") continue;
      if (outcome.kind === "error") return { ok: false, error: outcome.error };
      this.clearGapRecord(ref); // an approved expectation change clears a reported gap
      this.recheck(ref);
      return { ok: true, approved: true };
    }
    return { ok: false, error: `cad/${ref.part} kept changing while the owner was being asked; nothing was written` };
  }

  // ── Phase A4: references, concepts and dimensions, gaps, release ───────────────────────────────

  /** Record a gap (or, with `gap` undefined, a CLEAR) in the lock store, fleet-synced. */
  private setGap(ref: PartRef, gap: GapRecord | undefined, at = new Date().toISOString()): void {
    const id = repoIdentity(ref.worktree);
    this.lockSync.setGap({ repo: id.key, part: ref.part, ...(gap ? { gap } : {}), at, ...(id.remote ? { remote: id.remote } : {}), path: id.path });
  }
  /** The gap a part is blocked on right now (lock store first, then part.json). */
  gapFor(ref: PartRef): GapRecord | undefined {
    return gapOf(readPartFile(ref.dir), this.locks.findGap(repoIdentity(ref.worktree), ref.part, this.machine()));
  }
  /** Clear a part's gap in the store and in part.json (an owner action, or an approved expectation change). */
  private clearGapRecord(ref: PartRef): boolean {
    const part = readPartFile(ref.dir);
    const had = !!this.gapFor(ref) || (part.kind === "ok" && !!part.file.gap);
    if (!had) return false;
    if (part.kind === "ok" && part.file.gap) {
      const { gap: _g, ...rest } = part.file;
      writePartFile(ref.dir, rest as PartFile);
    }
    this.setGap(ref, undefined);
    return true;
  }

  /**
   * `import_reference {part, file}`: check the source (./refs.ts), then — free while the part has no
   * expectations, else only after the owner approves the standard `propose` card that adds the file to
   * `noInterferenceWith` (denied when unattended) — copy it to `cad/<part>/refs/` and import it as a
   * fixed body with `file.insert_step`. A re-import of the same name replaces the old import feature.
   *
   * With expectations, the import, the re-check of everything the card showed and the write of
   * part.json and the approval are ONE job in the part's queue (decision 204): the snapshot is checked
   * BEFORE anything is imported, and if anything fails after the import began it is rolled back in
   * full — the feature undone (and not redoable), the old `refs/` file put back or the new one
   * removed, part.json untouched — and the tool says so.
   */
  async importReference(sessionId: string, ref: PartRef, file: unknown): Promise<{ ok: true; approved?: boolean; name?: string; bodies?: string[]; sha256?: string; replaced?: boolean } | { ok: false; error: string }> {
    this.touch(sessionId, ref);
    const src = resolveReferenceSource(ref.worktree, file, { maxBytes: this.deps.referenceMaxBytes ?? REFERENCE_MAX_BYTES });
    if (!src.ok) return src;
    const name = referenceName(src.rel);
    const part = readPartFile(ref.dir);
    if (part.kind === "invalid") return { ok: false, error: `cad/${ref.part}/part.json cannot be read (${part.error}); nothing was imported` };

    const exp = part.kind === "ok" ? part.file.expectations : undefined;
    if (!exp) {
      // Free: nothing is locked yet. Checked again inside the job — expectations recorded meanwhile
      // make this the owner's call.
      try {
        return await this.manager.run(ref, async (slot) => {
          const now_ = readPartFile(ref.dir);
          if (now_.kind === "invalid") return { ok: false as const, error: `cad/${ref.part}/part.json cannot be read (${now_.error}); nothing was imported` };
          if (now_.kind === "ok" && now_.file.expectations) return { ok: false as const, error: `cad/${ref.part} got expectations while import_reference waited; nothing was imported. Call import_reference again: it now asks the owner.` };
          const r = await this.insertInSlot(slot, ref, name, src.rel, src.bytes, src.sha256);
          if (!r.ok) return r;
          if (now_.kind === "ok") {
            try {
              writePartFile(ref.dir, { ...now_.file, refs: r.refs(now_.file.refs ?? []) });
            } catch (e) {
              const err = await r.rollback();
              return { ok: false as const, error: `import_reference: cad/${ref.part}/part.json could not be written (${e instanceof Error ? e.message : String(e)}); ${err ? `the import could not be undone (${err}) — ${r.leftBehind}` : "nothing was imported"}` };
            }
          }
          return { ok: true as const, name, bodies: r.bodies, sha256: src.sha256, replaced: r.replaced };
        });
      } catch (e) {
        return { ok: false, error: `import_reference: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    // Expectations are locked: adding what the part must not touch is the owner's call, on the card.
    const input: ExpectationsInput = { bbox: exp.bbox, volume: exp.volume, bodies: exp.bodies, holes: exp.holes, tolerance: exp.tolerance, noInterferenceWith: [...new Set([...(exp.noInterferenceWith ?? []), name])] };
    const onDisk = (): string | null => {
      const d = referenceOnDisk(ref, name);
      return "sha256" in d ? d.sha256 : existsSync(join(ref.dir, REFS_DIR, name)) ? "unreadable" : null;
    };
    // Replacing a reference is said as such — worked out again for EVERY card drawn, from what is
    // there at that moment: which file, its old and new sha, and the body counts.
    const replacing = () => {
      const cur = readPartFile(ref.dir);
      const record = (cur.kind === "ok" ? (cur.file.refs ?? []) : []).find((x) => x.name === name);
      const oldSha = record?.sha256 ?? onDisk() ?? undefined;
      return { record, oldSha, replacing: !!record || oldSha !== undefined };
    };
    const solids = stepSolidCount(src.bytes);
    const replaceRows = (): CadExpectationsRow[] => {
      const r = replacing();
      return r.replacing
        ? [
            { label: "Reference", old: `refs/${name}`, new: `Replaces refs/${name}: old sha ${String(r.oldSha ?? "unknown").slice(0, 12)} → new sha ${src.sha256.slice(0, 12)}`, unapproved: true },
            { label: "Reference bodies", old: r.record ? `${r.record.bodies.length} (${r.record.bodies.join(", ")})` : "unknown", new: solids ? `${solids} (solids declared in the new file)` : "counted when it is imported" },
          ]
        : [{ label: "Reference", new: `adds refs/${name} (sha ${src.sha256.slice(0, 12)}${solids ? `, ${solids} bod${solids === 1 ? "y" : "ies"}` : ""})` }];
    };
    const reasonFor = (): string => {
      const r = replacing();
      return `import_reference: ${src.rel} as refs/${name} (sha256 ${src.sha256.slice(0, 12)}, ${src.bytes.length} bytes)${r.replacing ? `, REPLACING the existing refs/${name} (sha256 ${String(r.oldSha ?? "unknown").slice(0, 12)})` : ""} — the part must not touch it.`;
    };
    let imported: { bodies: string[]; replaced: boolean } | undefined;
    const r = await this.proposeExpectations(sessionId, ref, input, reasonFor(), {
      extraRows: replaceRows,
      extraState: onDisk,
      reasonFor,
      inSlot: async (slot) => {
        imported = undefined;
        const ins = await this.insertInSlot(slot, ref, name, src.rel, src.bytes, src.sha256);
        if (!ins.ok) return ins;
        imported = { bodies: ins.bodies, replaced: ins.replaced };
        return {
          ok: true,
          refs: ins.refs,
          extraAfter: src.sha256,
          leftBehind: ins.leftBehind,
          rollback: async () => {
            imported = undefined;
            return ins.rollback();
          },
        };
      },
    });
    if (!r.ok) return r;
    if (!r.approved) return { ok: true, approved: false };
    if (!imported) return { ok: false, error: `import_reference: the owner approved, but nothing was imported` };
    const done: { bodies: string[]; replaced: boolean } = imported;
    return { ok: true, name, bodies: done.bodies, sha256: src.sha256, replaced: done.replaced };
  }

  /**
   * Import a reference INSIDE a queue slot: copy it to `refs/`, import it (replacing an earlier import
   * of the same name in the same batch), and check what SolidCraft embedded. part.json is NOT written
   * here — the caller does that, in the same job. On failure everything is rolled back; on success the
   * caller gets `rollback` to undo it all if what follows fails.
   */
  private async insertInSlot(slot: SlotContext, ref: PartRef, name: string, source: string, bytes: Buffer, sha256: string): Promise<{ ok: true; bodies: string[]; replaced: boolean; refs: (refs: PartReference[]) => PartReference[]; rollback: () => Promise<string | undefined>; leftBehind: string } | { ok: false; error: string }> {
    const dest = join(ref.dir, REFS_DIR, name);
    let previous: Buffer | undefined;
    try {
      if (existsSync(dest) && !lstatSync(dest).isSymbolicLink()) previous = readFileSync(dest);
    } catch {
      /* none */
    }
    try {
      storeReference(ref, name, bytes);
    } catch (e) {
      return { ok: false, error: `import_reference: ${e instanceof Error ? e.message : String(e)}; nothing was imported` };
    }
    const leftBehind = `the design may still hold refs/${name}; the gate fails the part until it is removed (undo) or approved`;
    let changed = false;
    const rollback = async (): Promise<string | undefined> => {
      let err: string | undefined;
      if (changed) {
        try {
          const u = await slot.revert();
          if (u.isError) err = u.text.slice(0, 300) || "undo failed";
        } catch (e) {
          err = e instanceof Error ? e.message : String(e);
        }
        changed = false;
      }
      try {
        if (previous) storeReference(ref, name, previous);
        else rmSync(dest, { force: true });
      } catch (e) {
        err = `${err ? `${err}; ` : ""}refs/${name} could not be restored (${e instanceof Error ? e.message : String(e)})`;
      }
      return err;
    };
    const fail = async (why: string): Promise<{ ok: false; error: string }> => {
      const err = await rollback();
      return { ok: false, error: err ? `${why}; the import could not be undone (${err}) — ${leftBehind}` : `${why}. Nothing was imported: the design, refs/ and part.json are as they were.` };
    };
    try {
      // An earlier import of the same file is replaced (its feature deleted in the same batch).
      // A reference is imported with the design active, so it lands at the identity in the design —
      // where its STEP file puts it, which is where the gate holds it (refs.ts referencePlacementChecks).
      const before = readComponentList((await slot.call("execute", { command: "component.list", params: {} })).json);
      if (before.active !== 0) return fail(`import_reference: a reference is imported into the design itself, and component ${before.components.find((c) => c.id === before.active)?.name ?? before.active} is active; run execute component.activate {component: 0} first`);
      const old = await slot.call("inspect_design", { measure: false, sketches: false, timeline: "summary", bodies: false });
      const timeline: any[] = Array.isArray(old.json?.timeline) ? old.json.timeline : [];
      const prior = timeline.find((f) => f?.type === "BaseFeature" && f?.name === importFeatureName(name));
      const insert = { command: "file.insert_step", params: { path: dest, name: importFeatureName(name) } };
      const done = prior
        ? await slot.mutate("batch", { commands: [{ command: "timeline.delete", params: { feature: prior.id } }, insert], verbose: true })
        : await slot.mutate("execute", { ...insert, verbose: true });
      changed = !done.result.isError || done.wrote || slot.state().conflict;
      if (done.result.isError) return fail(`import_reference: SolidCraft could not import refs/${name}: ${done.result.text.slice(0, 500)}`);
      if (slot.state().conflict) return fail(`import_reference: ${DISK_CONFLICT_REASON}`);
      const j = prior ? done.result.json?.results?.at?.(-1) : done.result.json;
      const bodies: string[] = Array.isArray(j?.created_bodies) ? j.created_bodies.map(String) : [];
      if (bodies.length === 0) return fail(`import_reference: SolidCraft imported refs/${name} but reported no bodies`);
      if (typeof j?.content_sha256 === "string" && j.content_sha256 !== sha256) return fail(`import_reference: SolidCraft embedded different bytes than refs/${name} holds (${String(j.content_sha256).slice(0, 12)} ≠ ${sha256.slice(0, 12)})`);
      const after = await slot.call("inspect_design", { measure: false, sketches: false, timeline: "summary", bodies: true });
      const list = readComponentList((await slot.call("execute", { command: "component.list", params: {} })).json);
      const live = liveReferences(list, after.json?.timeline ?? [], after.json?.bodies ?? []).filter((r) => r.bodies.some((b) => bodies.includes(b)));
      if (live.length !== 1 || live[0]!.placements.length !== 1) return fail(`import_reference: SolidCraft imported refs/${name} but its component could not be found once in the design`);
      const misplaced = referencePlacementChecks(live, [{ file: name, name: importFeatureName(name), bodies }]);
      if (misplaced.length) return fail(`import_reference: ${misplaced.map((c) => String(c.measured)).join("; ")}`);
      const placed = list.components.find((c) => c.id === live[0]!.component)!.occurrences[0]!;
      const record: PartReference = { name, source, sha256, bodies, placement: { transform: placed.transform, grounded: placed.grounded }, at: new Date().toISOString() };
      return { ok: true, bodies, replaced: !!prior, refs: (refs) => [...refs.filter((x) => x.name !== name), record], rollback, leftBehind };
    } catch (e) {
      return fail(`import_reference: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * `open_part {part, concept: true, process}` (D16): a BRAND-NEW part (no design, no part.json, no
   * approval anywhere, nothing in its process) becomes a concept in part.json AND the lock store, so
   * it may be modeled without expectations. Anything else is left as it is.
   */
  async startConcept(sessionId: string, ref: PartRef, process: unknown): Promise<{ ok: true; note?: string } | { ok: false; error: string }> {
    this.touch(sessionId, ref);
    if (typeof process !== "string" || !process.trim()) return { ok: false, error: "open_part: `concept: true` needs `process` — the id in cad/rules.json the part will be made with" };
    const part = readPartFile(ref.dir);
    const lock = this.findLock(ref);
    if (part.kind === "ok" && part.file.status === "concept" && lock?.status === "concept" && lock.sha === lockedBlockSha(part.file)) return { ok: true, note: `cad/${ref.part} is already a concept` };
    const live = await this.manager.run(ref, async (slot) => {
      const r = await slot.call("inspect_design", { measure: false, sketches: false, timeline: "summary", bodies: "names" });
      return { features: Array.isArray(r.json?.timeline) ? r.json.timeline.length : 0, params: slot.params().length };
    });
    if (part.kind !== "missing" || lock || existsSync(join(ref.dir, DESIGN_FILE)) || live.features || live.params) {
      return { ok: true, note: `concept: true is honoured only when creating a brand-new part; cad/${ref.part} already exists and was left as it is` };
    }
    const file: PartFile = { schema: 1, process: process.trim(), status: "concept" };
    writePartFile(ref.dir, file);
    this.approve(ref, { sha: lockedBlockSha(file), approvedBy: "agent-initial", status: "concept", at: new Date().toISOString() });
    return { ok: true };
  }

  /**
   * `request_dimensions {part, proposed}` (§4.5, D16): a typed `dimensions` card whose numbers the
   * OWNER edits. On submit the daemon stores exactly the owner's numbers as `ownerParams` (part.json
   * and the lock store, fleet-synced) and applies them to the design (parameters.change for existing
   * names, parameters.add for new ones) — the owner's value wins over the proposal. Denied without a
   * card when unattended.
   */
  async requestDimensions(sessionId: string, ref: PartRef, proposed: unknown): Promise<{ ok: true; approved: boolean; ownerParams?: Record<string, number> } | { ok: false; error: string }> {
    this.touch(sessionId, ref);
    const session = this.deps.getSession(sessionId);
    if (!session) return { ok: false, error: "the session is gone" };
    if (isUnattended(session)) return { ok: false, error: "request_dimensions was denied: this session is unattended, so no one can type the dimensions" };
    const part = readPartFile(ref.dir);
    const lock = this.findLock(ref);
    if (part.kind !== "ok" || part.file.status !== "concept" || lock?.status !== "concept" || lock.sha !== lockedBlockSha(part.file)) {
      return { ok: false, error: `request_dimensions is for a concept part (open_part {part, concept: true, process}); cad/${ref.part} is not one` };
    }
    const rows = parseDimensionRows(proposed);
    if (!rows.ok) return { ok: false, error: `request_dimensions: ${rows.error}` };
    // One open dimensions card per part per session: a second request does not pile up cards.
    if ([...this.cards.values()].some((c) => c.kind === "dimensions" && c.sessionId === sessionId && c.ref.key === ref.key)) return { ok: false, error: DIMENSIONS_CARD_OPEN };
    let answer: { answer: CardAnswer; values?: Record<string, number> } = { answer: "stale" };
    let shown: CardSnapshot | undefined;
    for (let round = 0; round < 3 && answer.answer === "stale"; round++) {
      const snap = this.cardSnapshot(ref);
      const requestId = newId("cadx");
      answer = await new Promise<{ answer: CardAnswer; values?: Record<string, number> }>((resolve) => {
        this.park({
          requestId,
          sessionId,
          ref,
          kind: "dimensions",
          snap,
          dims: rows.rows.map((r) => r.name),
          settle: (a, values) => resolve({ answer: a, values }),
          stale: () => !this.stillShows(ref, snap),
          body: {
            type: "cad.expectations.request",
            requestId,
            sessionId,
            cwd: ref.worktree,
            part: ref.part,
            kind: "dimensions",
            note: "The agent built this part from a picture. Type the real dimensions: your numbers are what the part will be checked against.",
            dimensions: rows.rows,
            rows: [...parameterRows(snap), ...rows.rows.map((r) => ({ label: r.name, new: `${num(r.value)}${r.unit ? ` ${r.unit}` : ""}` }))],
          },
        });
      });
      if (answer.answer === "approved" && !this.stillShows(ref, snap)) answer = { answer: "stale" };
      if (answer.answer === "approved") shown = snap;
    }
    if (answer.answer === "stale") return { ok: false, error: `cad/${ref.part} kept changing while the owner was being asked; nothing was written` };
    if (answer.answer !== "approved" || !answer.values || !shown) return { ok: true, approved: false };
    const values = answer.values;
    const drawnWith = shown;
    // Apply exactly the owner's numbers to the design, in one queued change, then record them.
    const have = new Set((this.manager.status(ref)?.params ?? []).map((p) => p.name));
    const unit = new Map(rows.rows.map((r) => [r.name, r.unit]));
    const expr = (n: string): string => `${values[n]}${unit.get(n) ? ` ${unit.get(n)}` : ""}`;
    const change = Object.keys(values).filter((n) => have.has(n));
    const add = Object.keys(values).filter((n) => !have.has(n));
    const commands = [
      ...(change.length ? [{ command: "parameters.change", params: { changes: Object.fromEntries(change.map((n) => [n, expr(n)])) } }] : []),
      ...add.map((n) => ({ command: "parameters.add", params: { name: n, expression: expr(n) } })),
    ];
    let failure: string | undefined;
    const reply = await this.manager.request(ref, {
      tool: "batch",
      args: { commands, verbose: false },
      kind: "mutate",
      afterWrite: async (slot, done) => {
        if (done.result.isError) return void (failure = `the dimensions could not be applied: ${done.result.text.slice(0, 300)}`);
        const apply = (): string | undefined => {
          if (slot.state().conflict) return DISK_CONFLICT_REASON;
          // Decision 204: everything else the card showed still holds — every parameter the owner did
          // not type, part.json, the concept's approval — checked here, in the slot, before the write.
          if (!this.shownNow(ref, drawnWith, slot.params(), { ownParams: Object.keys(values) })) return `cad/${ref.part} changed after the card was drawn (its parameters, part.json or the approval on record)`;
          for (const n of Object.keys(values)) {
            const got = slot.params().find((p) => p.name === n)?.value;
            if (got === undefined || Math.abs(got - values[n]!) > 1e-9 * Math.max(1, Math.abs(values[n]!))) return `SolidCraft made ${n} = ${got ?? "nothing"}, not ${values[n]}`;
          }
          const l = this.findLock(ref);
          if (!l || !drawnWith.file) return "the concept's approval is gone";
          this.nextBy.set(ref.key, "panel");
          writePartFile(ref.dir, this.fileFromSnapshot(ref, drawnWith, { ownerParams: { ...values } }));
          const { repo: _r, part: _p, remote: _m, path: _a, ...rest } = l;
          this.approve(ref, { ...rest, ownerParams: { ...values }, at: new Date().toISOString() });
          return undefined;
        };
        failure = apply();
        if (failure) await slot.revert().catch(() => undefined); // the owner's numbers are not left half-applied
      },
    });
    if (failure || reply.result.isError) return { ok: false, error: `request_dimensions: ${failure ?? reply.result.text}` };
    this.recheck(ref);
    return { ok: true, approved: true, ownerParams: { ...values } };
  }

  /** `report_gap {part, feature, detail}` (D17): the part is `gap` until the owner clears it. */
  async reportGap(sessionId: string, ref: PartRef, feature: unknown, detail: unknown): Promise<{ ok: true; gate?: GateResult } | { ok: false; error: string }> {
    this.touch(sessionId, ref);
    if (typeof feature !== "string" || !feature.trim()) return { ok: false, error: "report_gap: name the `feature` SolidCraft cannot make" };
    if (typeof detail !== "string" || !detail.trim()) return { ok: false, error: "report_gap: give the `detail` — what you tried and what SolidCraft did" };
    const gap: GapRecord = { feature: feature.trim().slice(0, 200), detail: detail.trim().slice(0, 2000), at: new Date().toISOString() };
    const part = readPartFile(ref.dir);
    if (part.kind === "ok") writePartFile(ref.dir, { ...part.file, gap });
    this.setGap(ref, gap, gap.at);
    await this.manager.refreshNow(ref).catch(() => undefined);
    return { ok: true, gate: this.snapshots.get(ref.key)?.outcome.gate };
  }

  /** "Clear gap" on the part card (`cad.gap.clear`): the OWNER says the gap no longer applies. */
  async clearGap(worktree: string, part: unknown): Promise<void> {
    const ref = this.refFor(worktree, part);
    if (!this.clearGapRecord(ref)) throw new Error(`cad/${ref.part} has no gap to clear`);
    if (this.manager.status(ref)?.live) await this.manager.refreshNow(ref).catch(() => undefined);
  }

  /** Why `export_part` is refused (a concept, a gap), or undefined. */
  exportRefusal(ref: PartRef): string | undefined {
    const part = readPartFile(ref.dir);
    if (part.kind === "ok" && part.file.status === "concept") return `export_part is refused: cad/${ref.part} is a concept — its dimensions are not confirmed. Call request_dimensions, then record_expectations.`;
    const gap = this.gapFor(ref);
    if (gap) return `export_part is refused: cad/${ref.part} is blocked on an unsupported feature (${gap.feature}) until the owner clears the gap.`;
    return undefined;
  }

  /** Does `dir` hold a release pack this machine made, unaltered (`verifyRelease` with this machine's key)? */
  verifyReleaseDir(dir: string): ReleaseVerdict {
    return verifyRelease(dir, releaseKey(this.stateDir));
  }
  /** The verified release of a part's current script, if any — what the "Released" badge shows. */
  private releasedOf(ref: PartRef, scriptSha: string | undefined): PartSnapshot["released"] {
    if (!scriptSha) return undefined;
    const dir = releaseFolder(ref, scriptSha);
    if (!existsSync(dir)) return undefined;
    try {
      const v = this.verifyReleaseDir(dir);
      // The folder is named for 7 characters of the script's sha; the badge needs the WHOLE sha (a pack
      // of a different script whose sha shares those 7 characters is not this script's release).
      return v.ok && v.manifest.scriptSha === scriptSha && v.manifest.part === ref.part ? { path: relative(ref.worktree, dir), scriptSha, at: v.manifest.createdAt } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * `release_part {part}` (§4.7) and the card's Release button: force a refresh; require `pass`,
   * `dimensioned` and no gap; then ONE typed `release` card, every time, under every policy (denied
   * when unattended). Approving numbers the agent set also confirms them (approvedBy → owner). Only
   * then is the pack written — exactly the files of §4.7, atomically — and one `file.offer` sent per
   * file. Anything short of that writes nothing.
   */
  async releasePart(sessionId: string, ref: PartRef, opts: { onParked?: () => void; round?: number } = {}): Promise<{ ok: true; approved: boolean; dir?: string; files?: string[]; offered?: number } | { ok: false; error: string }> {
    this.touch(sessionId, ref);
    const session = this.deps.getSession(sessionId);
    if (!session) return { ok: false, error: "the session is gone" };
    if (isUnattended(session)) return { ok: false, error: "release_part was denied: this session is unattended, so no one can approve the release" };
    if (!existsSync(join(ref.dir, DESIGN_FILE)) && !this.manager.status(ref)?.live) return { ok: false, error: `cad/${ref.part} has no design to release` };
    await this.manager.refreshNow(ref);
    const snap = this.snapshots.get(ref.key);
    const part = readPartFile(ref.dir);
    const gate = snap?.outcome.gate;
    const refuse = (why: string) => ({ ok: false as const, error: `release_part refused: ${why}. Nothing was written.` });
    if (!snap || !gate || !snap.outcome.measurement || !snap.outcome.scriptSha) return refuse(`cad/${ref.part} could not be measured`);
    if (part.kind === "ok" && part.file.status === "concept") return refuse(`cad/${ref.part} is a concept — its dimensions are not confirmed (request_dimensions, then record_expectations)`);
    if (gate.gap || gate.state === "gap") return refuse(`cad/${ref.part} is blocked on an unsupported feature (${gate.gap?.feature ?? "a reported gap"})`);
    if (gate.state !== "pass") return refuse(`the gate is ${gate.state}${failingLines(gate).length ? ` — ${failingLines(gate).join("; ")}` : ""}`);
    if (part.kind !== "ok" || part.file.status !== "dimensioned") return refuse(`cad/${ref.part}/part.json is not a dimensioned part`);
    const rules = readRules(ref.worktree);
    const proc = rules.kind === "ok" ? rules.file.processes.find((p) => p.id === part.file.process) : undefined;
    if (!proc) return refuse(`process ${part.file.process} is not in cad/rules.json`);
    const shownSha = snap.outcome.scriptSha;
    const m = snap.outcome.measurement;
    const agentNumbers = gate.approvedBy === "agent-initial";
    const scriptBytes = snap.outcome.scriptBytes ?? 0;
    const rows: CadExpectationsRow[] = [
      { label: "Part", new: ref.part },
      { label: "Process", new: `${proc.id} (${proc.kind})` },
      { label: "Material", new: part.file.material ?? proc.material ?? "not specified" },
      { label: "Numbers approved by", new: agentNumbers ? "the agent — NOT confirmed by you; approving confirms them" : (gate.approvedBy ?? "unknown") },
      { label: "Script", new: `${shownSha.slice(0, 12)} · ${formatBytes(scriptBytes)}` },
      ...gate.checks.filter((c) => c.hard && /^(bbox|volume|bodies|holes|interference)/.test(c.id)).map((c) => ({ label: c.id, old: showVal(c.expected), new: showVal(c.measured) })),
      ...snap.outcome.holes.map((h) => ({ label: `Hole ⌀${num(h.diameter)}`, new: `×${h.count} ${h.kind}, depth ${num(h.depth)}${h.counterbore?.length ? `, counterbore ${h.counterbore.map((c) => `⌀${num(c.diameter)} × ${num(c.depth)}`).join(", ")}` : ""}` })),
      ...[...advisoryLines(gate), ...gate.warnings].map((a) => ({ label: "Advisory", new: a })),
      { label: "Bounding box (measured)", new: `${m.bbox.map(num).join(" × ")} mm` },
    ];
    // Decision 153: the card is drawn from a snapshot (parameters, part.json, the approval on record,
    // the script); if any of it differs when the owner approves, nothing is approved and the call
    // starts over (a fresh refresh, a fresh card).
    const snapCard = this.cardSnapshot(ref, { extra: () => this.manager.status(ref)?.scriptSha ?? null });
    const requestId = newId("cadx");
    const answer = await new Promise<CardAnswer>((resolve) => {
      this.park({
        requestId,
        sessionId,
        ref,
        kind: "release",
        snap: snapCard,
        settle: resolve,
        stale: () => !this.stillShows(ref, snapCard, () => this.manager.status(ref)?.scriptSha ?? null),
        body: {
          type: "cad.expectations.request",
          requestId,
          sessionId,
          cwd: ref.worktree,
          part: ref.part,
          kind: "release",
          ...(agentNumbers ? { note: RELEASE_AGENT_NUMBERS } : {}),
          rows: [...parameterRows(snapCard), ...rows],
        },
      });
      opts.onParked?.();
    });
    if (answer === "stale" && (opts.round ?? 0) < 2) return this.releasePart(sessionId, ref, { round: (opts.round ?? 0) + 1 });
    if (answer === "stale") return refuse(`cad/${ref.part} kept changing while the owner was being asked`);
    if (answer !== "approved") return { ok: true, approved: false };

    await this.manager.refreshNow(ref);
    const after = this.snapshots.get(ref.key);
    if (!after || after.outcome.scriptSha !== shownSha) return refuse("the design changed while the card was open");
    if (after.outcome.gate.state !== "pass") return refuse(`the gate is ${after.outcome.gate.state} now`);
    const key = releaseKey(this.stateDir);
    let written: { dir: string; files: string[] };
    try {
      written = await this.manager.run(ref, async (slot) => {
        if (slot.scriptSha() !== shownSha) throw new Error("the design changed while the card was open");
        // Decision 204: everything the card showed (parameters, part.json, the approval on record, the
        // script) still holds — checked here, in the slot, before anything is written.
        if (!this.shownNow(ref, snapCard, slot.params(), { extraNow: () => slot.scriptSha() ?? null })) throw new Error("part.json, the parameters or the approval changed while the card was open");
        // The owner saw these numbers on the release card: release is never on numbers nobody approved.
        // The confirmation is the approval the card was drawn with (unchanged: just checked), by the owner.
        let unconfirm: (() => void) | undefined;
        if (agentNumbers) {
          const l = this.findLock(ref);
          if (!l || !snapCard.file || l.sha !== lockedBlockSha(snapCard.file)) throw new Error("part.json changed while the card was open");
          const { repo: _r, part: _p, remote: _m, path: _a, ...rest } = l;
          this.approve(ref, { ...rest, approvedBy: "owner", at: new Date().toISOString() });
          unconfirm = () => this.approve(ref, { ...rest, at: new Date().toISOString() });
        }
        try {
          return await this.writePack(slot, ref, { shownSha, proc, file: snapCard.file!, m, gate: after.outcome.gate, agentNumbers, key });
        } catch (e) {
          unconfirm?.(); // nothing was released, so nothing was confirmed
          throw e;
        }
      });
    } catch (e) {
      return { ok: false, error: `release_part failed, nothing was written: ${e instanceof Error ? e.message : String(e)}` };
    }
    let offered = 0;
    for (const f of written.files) if (await this.offerFile(sessionId, f)) offered++;
    const cur = this.snapshots.get(ref.key);
    if (cur) {
      cur.released = this.releasedOf(ref, cur.outcome.scriptSha);
      this.emitDesign(cur, true);
    }
    return { ok: true, approved: true, dir: written.dir, files: written.files, offered };
  }

  /** The release pack, inside the release's queue slot (the card's snapshot was checked by the caller). */
  private async writePack(slot: SlotContext, ref: PartRef, d: { shownSha: string; proc: { id: string; kind: "fdm" | "cnc"; generalTolerance?: string; material?: string }; file: PartFile; m: NonNullable<RefreshOutcome["measurement"]>; gate: GateResult; agentNumbers: boolean; key: Buffer }): Promise<{ dir: string; files: string[] }> {
    const call = (tool: string, args: Record<string, unknown>) => slot.call(tool, args);
    const design = await readDesign(call);
    const tables = [];
    for (const b of design.designBodies) tables.push(await holeTable(call, b, { positions: true }));
    const { proc, file, m, gate: g } = d;
    const data: ReleaseData = {
      part: ref.part,
      scriptSha: d.shownSha,
      solidcraft: design.version,
      process: { id: proc.id, kind: proc.kind, ...(proc.generalTolerance ? { generalTolerance: proc.generalTolerance } : {}) },
      ...(file.material ?? proc.material ? { material: file.material ?? proc.material } : {}),
      bbox: m.bbox,
      volume: m.volume,
      bodies: m.bodies,
      params: design.params,
      holes: mergeHoleTables(tables),
      checks: g.checks,
      advisories: [...advisoryLines(g), ...g.warnings],
      references: (file.refs ?? []).map((r) => ({ name: r.name, sha256: r.sha256 })),
      approvedBy: d.agentNumbers ? "owner (confirmed with this release)" : String(g.approvedBy ?? "owner"),
      createdAt: new Date().toISOString(),
    };
    return writeReleasePack(call, ref, data, design.designBodies, d.key);
  }

  /** `cad.release.request`: raise the release card with no model turn. Resolves once the card is up
   *  (or rejects with the refusal); the release itself follows the owner's answer in the background. */
  requestRelease(sessionId: string, ref: PartRef): Promise<void> {
    return new Promise((resolve, reject) => {
      void this.releasePart(sessionId, ref, { onParked: () => resolve() }).then(
        (r) => (r.ok ? resolve() : reject(new Error(r.error))),
        (e) => reject(e instanceof Error ? e : new Error(String(e))),
      );
    });
  }

  /**
   * A picture for `compare_picture`, copied into `cad/<part>/.cache/pictures/` (SolidCraft reads only
   * the part folder): `picture` names a PNG/JPEG in this repo (the download quarantine included), by
   * the same rules as a reference source; `attachment` is "latest" or the name of an image the user
   * attached in this session.
   */
  pictureFile(sessionId: string, ref: PartRef, src: { picture?: unknown; attachment?: unknown }): { ok: true; abs: string; label: string } | { ok: false; error: string } {
    let bytes: Buffer;
    let label: string;
    if (src.picture !== undefined) {
      const raw = src.picture;
      if (typeof raw !== "string" || !raw || isAbsolute(raw) || raw.includes("\0")) return { ok: false, error: "compare_picture: `picture` must be a path inside this repo, relative to its root" };
      const abs = resolve(ref.worktree, raw);
      const rel = relative(ref.worktree, abs);
      if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split("/").includes(".git")) return { ok: false, error: `compare_picture: ${JSON.stringify(raw)} is outside this repo` };
      if (!/\.(png|jpe?g)$/i.test(rel)) return { ok: false, error: "compare_picture: `picture` must be a PNG or JPEG" };
      try {
        const st = lstatSync(abs);
        if (st.isSymbolicLink() || !st.isFile() || realpathSync(abs) !== abs) return { ok: false, error: `compare_picture: ${JSON.stringify(raw)} is not a regular file in this repo` };
        if (st.size > PICTURE_MAX_BYTES) return { ok: false, error: `compare_picture: ${JSON.stringify(raw)} is larger than ${PICTURE_MAX_BYTES / 1024 / 1024} MB` };
      } catch {
        return { ok: false, error: `compare_picture: ${JSON.stringify(raw)} does not exist` };
      }
      bytes = readFileSync(abs);
      label = rel;
    } else {
      const want = src.attachment;
      if (typeof want !== "string" || !want) return { ok: false, error: "compare_picture: `attachment` is \"latest\" or the name of an image attached in this chat" };
      const dir = join(this.stateDir, "sessions", sessionId, "attachments");
      let picks: { bin: string; name: string; mtime: number }[] = [];
      try {
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".json")) continue;
          const meta = JSON.parse(readFileSync(join(dir, f), "utf8")) as { mediaType?: string; name?: string; ext?: string };
          if (meta.mediaType !== "image/png" && meta.mediaType !== "image/jpeg") continue;
          const ext = /^[a-z0-9]{1,12}$/.test(String(meta.ext)) ? String(meta.ext) : "bin";
          const bin = join(dir, `${f.slice(0, -5)}.${ext}`);
          if (existsSync(bin)) picks.push({ bin, name: String(meta.name ?? ""), mtime: statSync(bin).mtimeMs });
        }
      } catch {
        picks = [];
      }
      const hit = want === "latest" ? picks.sort((a, b) => b.mtime - a.mtime)[0] : picks.filter((p) => p.name === want).sort((a, b) => b.mtime - a.mtime)[0];
      if (!hit) return { ok: false, error: `compare_picture: no image ${want === "latest" ? "has been attached" : `named ${JSON.stringify(want)} was attached`} in this chat` };
      bytes = readFileSync(hit.bin);
      label = `attachment ${hit.name || basename(hit.bin)}`;
    }
    const dir = join(ref.dir, CACHE_DIR, "pictures");
    mkdirSync(dir, { recursive: true });
    const ext = bytes[0] === 0x89 ? ".png" : ".jpg";
    const dest = join(dir, `picture-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}${ext}`);
    const tmp = `${dest}.tmp-${process.pid}`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, dest);
    return { ok: true, abs: dest, label };
  }

  /** A concept part's picture comparison: shown on the card as an ADVISORY line, never a check that blocks. */
  recordPicture(ref: PartRef, overlap: number, picture: string): void {
    if (!Number.isFinite(overlap)) return;
    this.pictureScores.set(ref.key, { overlap, picture, at: new Date().toISOString() });
    void this.manager.refreshNow(ref).catch(() => undefined);
  }
  private advisoryFor(ref: PartRef): GateCheck[] {
    const score = this.pictureScores.get(ref.key);
    if (!score) return [];
    const part = readPartFile(ref.dir);
    if (part.kind !== "ok" || part.file.status !== "concept") return [];
    return [{ id: "picture.overlap", expected: "advisory: the model's outline against the picture", measured: `${Math.round(score.overlap * 1000) / 10}% overlap with ${score.picture}`, ok: true, hard: false }];
  }

  /**
   * Broadcast a part's `cad.design` with the rate bound of spec §6: at most one per
   * DESIGN_BROADCAST_MS per part, with a trailing emit of the latest state. Immediate when forced
   * (check_part, cad.param.set, release), when the last one went out long enough ago, or when it went
   * out in the same busy period (the manager's own debounce already bounds a burst).
   */
  private emitDesign(snap: PartSnapshot, immediate: boolean): void {
    const k = snap.ref.key;
    let st = this.emitState.get(k);
    if (!st) this.emitState.set(k, (st = { at: -Infinity, epoch: -1 }));
    const now_ = this.clock.now();
    const epoch = this.busyEpoch.get(k) ?? 0;
    if (immediate || now_ - st.at >= DESIGN_BROADCAST_MS || st.epoch === epoch) {
      if (st.timer !== undefined) this.clock.clearTimeout(st.timer);
      st.timer = undefined;
      st.at = now_;
      st.epoch = epoch;
      this.broadcast(this.designEvent(snap));
      return;
    }
    if (st.timer !== undefined) return; // the trailing emit will carry the newest state
    const s = st;
    s.timer = this.clock.setTimeout(() => {
      s.timer = undefined;
      const latest = this.snapshots.get(k);
      if (!latest) return;
      s.at = this.clock.now();
      s.epoch = this.busyEpoch.get(k) ?? 0;
      this.broadcast(this.designEvent(latest));
    }, Math.max(0, s.at + DESIGN_BROADCAST_MS - now_));
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
        // The OWNER changed ONE parameter. The accepted numbers are re-derived from the ACCEPTED
        // parameter values with only that one replaced — never from the design as it is now, where
        // the agent may have changed others without approval (those keep failing the gate).
        const value = slot.params().find((p) => p.name === name)?.value;
        if (value === undefined || !Number.isFinite(value)) return;
        const base = { ...acceptedBase(locked.lock, slot.params()), [name]: value };
        let values: EvaluatedExpectations;
        try {
          values = evaluateExpectations(locked.part.file.expectations, base);
        } catch {
          return;
        }
        const { repo: _r, part: _p, remote: _m, path: _a, ...rest } = locked.lock;
        this.approve(ref, { ...rest, values, declared: { ...(rest.declared ?? {}), [name]: value }, at: new Date().toISOString() });
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
    // The owner asking for a rebuild is the owner asking again: a denied adopt card may come back.
    for (const kind of ADOPT_KINDS) this.deniedAdopt.delete(adoptScope(kind, ref));
    await this.manager.reload(ref);
  }

  /**
   * The preview route's answer: the file behind a `cad.design.preview` path AND the sha256 the daemon
   * recorded when it exported it — only while the file on disk still has that sha. A file anyone else
   * wrote (or rewrote) there is never served (A3 review, item 3).
   */
  previewEntry(worktree: string, relPath: string): { abs: string; sha: string } | undefined {
    const abs = this.previewFile(worktree, relPath);
    if (!abs) return undefined;
    const want = this.previewShas.get(abs);
    if (!want) return undefined;
    try {
      return createHash("sha256").update(readFileSync(abs)).digest("hex") === want ? { abs, sha: want } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Remember what the daemon exported (persisted, so a restart keeps serving what it wrote). */
  recordExport(abs: string, sha: string): void {
    this.previewShas.set(abs, sha);
    for (const k of [...this.previewShas.keys()]) if (!existsSync(k)) this.previewShas.delete(k);
    try {
      writeFileAtomic(this.previewShasFile, JSON.stringify(Object.fromEntries(this.previewShas)) + "\n", { mode: 0o600 });
    } catch {
      /* the in-memory record still serves this run */
    }
  }

  /** The absolute file behind a `cad.design.preview` path, or undefined when it is not one (or is gone). */
  previewFile(worktree: string, relPath: string): string | undefined {
    const glb = PREVIEW_PATH_RE.exec(relPath);
    const png = THUMB_PATH_RE.exec(relPath);
    const m = glb ?? png;
    if (!m || isAbsolute(relPath)) return undefined;
    let ref: PartRef;
    try {
      ref = this.refFor(worktree, m[1]);
    } catch {
      return undefined;
    }
    const abs = join(ref.dir, CACHE_DIR, glb ? `preview-${Number(m[2])}.glb` : `thumb-${Number(m[2])}.png`);
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
    if (busy) this.busyEpoch.set(key, (this.busyEpoch.get(key) ?? 0) + 1);
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

  /**
   * A part's process stopped (idle, evicted, exited, reload): drop its per-part timer state — the
   * busy notice and the `cad.design` coalescer — so nothing fires for a process that is gone and the
   * maps do not grow with every part ever opened. A trailing emit still pending goes out now.
   */
  private onStopped(key: string): void {
    const armed = this.busyTimers.get(key);
    if (armed !== undefined) this.clock.clearTimeout(armed);
    this.busyTimers.delete(key);
    const st = this.emitState.get(key);
    if (st?.timer !== undefined) {
      this.clock.clearTimeout(st.timer);
      const latest = this.snapshots.get(key);
      if (latest) this.broadcast(this.designEvent(latest));
    }
    this.emitState.delete(key);
    this.busyEpoch.delete(key);
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
  respond(requestId: string, approve: boolean, values?: unknown): boolean {
    const card = this.cards.get(requestId);
    if (!card) return false;
    // A dimensions card is answered with the owner's numbers: checked here, server-side. A bad set
    // is refused and the card stays open for a corrected answer.
    let typed: Record<string, number> | undefined;
    if (card.kind === "dimensions" && approve) {
      const v = checkDimensionValues(card.dims ?? [], values);
      if (!v.ok) throw new Error(v.error);
      typed = v.values;
    }
    this.cards.delete(requestId);
    // The waiting tool call does the writing for these.
    const toolCard = card.kind === "propose" || card.kind === "initial" || card.kind === "dimensions" || card.kind === "release" || card.kind === "plan";
    // Decision 153: an approval is for exactly what the card showed. If anything on it changed while
    // it was open, nothing is approved and a fresh card is drawn (by the waiting call, or the recheck).
    const stale = approve && !!card.stale?.();
    const approved = approve && !stale;
    if (!toolCard && approved && card.kind !== "adopt-rules") {
      // Decision 204: a part's card is written inside the part's queue slot, after its snapshot is
      // checked again there; the answer is broadcast once that has run.
      void this.manager
        .run(card.ref, async (slot) => (card.kind === "confirm" ? this.confirm(card, slot.params()) : this.adopt(card, slot.params())))
        .catch(() => false)
        .then((ok) => this.finishCard(card, toolCard, ok, !ok, typed));
      return true;
    }
    if (!toolCard && approved) {
      const ok = this.adopt(card);
      this.finishCard(card, toolCard, ok, !ok, typed);
      return true;
    }
    this.finishCard(card, toolCard, approved, stale, typed);
    return true;
  }

  /** Tell every client how a card ended, give the session its status back, and wake its waiter. */
  private finishCard(card: Card, toolCard: boolean, approved: boolean, superseded: boolean, typed?: Record<string, number>): void {
    this.broadcast({ v: PROTOCOL_VERSION, type: "cad.expectations.resolved", ts: now(), requestId: card.requestId, approved, ...(superseded ? { superseded: true } : {}) } satisfies CadExpectationsResolvedEvent);
    this.releaseStatus(card);
    card.settle?.(approved ? "approved" : superseded ? "stale" : "denied", typed);
    if (!toolCard) {
      // A denied adopt card is not redrawn as it was (the recheck below would put it straight back).
      if (!approved && !superseded && card.key !== undefined && isAdoptKind(card.kind)) this.deniedAdopt.set(adoptScope(card.kind, card.ref), card.key);
      if (superseded && card.kind === "confirm") this.confirmNumbers(card.sessionId, card.ref); // redraw it, showing what is there now
      this.recheck(card.ref, card.kind === "adopt-rules");
    }
  }

  /** Deny every card parked for a session (reset, kill): a waiting tool call is released. */
  cancelSession(sessionId: string): void {
    this.ownerNotes.delete(sessionId);
    for (const card of [...this.cards.values()]) {
      if (card.sessionId !== sessionId) continue;
      this.cards.delete(card.requestId);
      this.broadcast({ v: PROTOCOL_VERSION, type: "cad.expectations.resolved", ts: now(), requestId: card.requestId, approved: false, superseded: true } satisfies CadExpectationsResolvedEvent);
      this.releaseStatus(card);
      card.settle?.("denied");
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
      ...(s.outcome.thumbnail ? { thumbnail: s.outcome.thumbnail } : {}),
      ...(s.outcome.scriptBytes !== undefined ? { scriptBytes: s.outcome.scriptBytes } : {}),
      ...(s.released ? { released: s.released } : {}),
      ...(s.status ? { status: s.status } : {}),
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
    if (card.settle) this.holdStatus(card);
  }

  /**
   * A card a tool call waits on shows the session as `awaiting_permission` — but ONLY while a turn is
   * running. A card raised with no turn (the Release button) leaves the status alone, so an idle
   * session is never left looking busy.
   */
  private holdStatus(card: Card): void {
    const s = this.deps.getSession(card.sessionId) as unknown as { data?: { status?: string } } | undefined;
    const prev = s?.data?.status;
    if (!prev || !TURN_STATUSES.has(prev)) return;
    card.prevStatus = prev;
    setStatus(s, "awaiting_permission");
  }
  /** The card is answered or gone: give the session back the status it had, if this card changed it. */
  private releaseStatus(card: Card): void {
    const prev = card.prevStatus;
    card.prevStatus = undefined;
    if (!prev) return;
    const s = this.deps.getSession(card.sessionId) as unknown as { data?: { status?: string } } | undefined;
    if (s?.data?.status !== "awaiting_permission") return; // the turn ended (or moved on) meanwhile: leave it
    if ([...this.cards.values()].some((c) => c.sessionId === card.sessionId && c.prevStatus)) return; // another card still holds it
    setStatus(s, "running_tool"); // the tool call that raised the card goes on (settled against any other parked prompt)
  }

  /** Post-step 5: record the outcome, broadcast `cad.design`, and raise or retire adopt cards. */
  private onRefreshed(outcome: RefreshOutcome, _slot: SlotContext): void {
    const { ref } = outcome;
    const prev = this.snapshots.get(ref.key);
    const by = this.nextBy.get(ref.key) ?? "agent";
    this.nextBy.delete(ref.key);
    if (outcome.preview && outcome.previewSha) this.recordExport(join(ref.worktree, outcome.preview), outcome.previewSha);
    if (outcome.thumbnail && outcome.thumbnailSha) this.recordExport(join(ref.worktree, outcome.thumbnail), outcome.thumbnailSha);
    const pf = readPartFile(ref.dir);
    const released = this.releasedOf(ref, outcome.scriptSha);
    const snap: PartSnapshot = {
      ref,
      rev: outcome.rev ?? (prev?.rev ?? 0) + 1,
      outcome,
      by,
      busy: (this.manager.status(ref)?.queued ?? 0) > 0,
      ...(released ? { released } : {}),
      ...(pf.kind === "ok" ? { status: pf.file.status } : {}),
    };
    this.snapshots.set(ref.key, snap);
    this.emitDesign(snap, outcome.forced);
    this.syncAdoptCards(ref, outcome.gate, outcome.params);
  }

  /** One adopt card per pending adoption, in the chat of an attended session working on the part. */
  private syncAdoptCards(ref: PartRef, gate: GateResult, params: CadParamInfo[]): void {
    const wanted = new Set(pendingAdoptions(gate));
    const locked = readLocked(ref, this.locks, this.machine());
    const attended = [...(this.partSessions.get(ref.key) ?? [])].map((id) => this.deps.getSession(id)).find((s) => s && !isUnattended(s));
    // Decision 153: every part card is drawn from one snapshot — accepted values, the design's values
    // (as just measured), and everything else the card shows. "Old" is the accepted numbers; a
    // parameter the agent moved is its own row; approval writes the snapshot, and refuses (and
    // redraws) if anything on the card changed meanwhile.
    const snap = this.cardSnapshot(ref, { current: paramMap(params) });
    type Built = { sha: string; rows: CadExpectationsRow[]; values?: EvaluatedExpectations; rulesDiff?: CadExpectationsRequestEvent["rulesDiff"] };
    const build: Partial<Record<CardKind, () => Built | undefined>> = {
      "adopt-expectations": () => {
        if (locked.part.kind !== "ok") return undefined;
        const f = locked.part.file;
        // A card always shows evaluated numbers: expectations that do not evaluate cannot be adopted
        // (the gate says which formula fails), so no card is drawn for them.
        const values = f.expectations ? evalOrUndefined(f.expectations, snap.current) : undefined;
        if (f.expectations && !values) return undefined;
        const old = hasValues(locked.lock?.values) ? locked.lock.values : undefined;
        const rows: CadExpectationsRow[] = [
          { label: "Process", new: f.process },
          { label: "Status", ...(locked.lock ? { old: locked.lock.status } : {}), new: f.status },
          ...parameterRows(snap),
          ...(f.expectations ? expectationRows(undefined, f.expectations, old, values) : [{ label: "Expectations", ...(old ? { old: valueText(old) } : {}), new: "none" }]),
          ...(f.expectations ? [{ label: "Approved by (as the file claims)", new: f.expectations.lockedBy }] : []),
        ];
        return { sha: lockedBlockSha(f), rows, ...(values ? { values } : {}) };
      },
      "adopt-ownerParams": () => {
        if (locked.part.kind !== "ok") return undefined;
        const now_ = locked.part.file.ownerParams ?? {};
        const old = locked.lock?.ownerParams ?? {};
        const names = [...new Set([...Object.keys(old), ...Object.keys(now_)])].sort();
        const f = locked.part.file;
        const exp = f.expectations;
        const l = locked.lock;
        // Moved parameters ride on this card only when the approval on record is of this very block and
        // the numbers they lead to can be shown — and then those numbers are rows too, accepted → new,
        // because approving the card approves them.
        const ride = !!exp && snap.changed.length > 0 && !!l && l.sha === lockedBlockSha(f) && hasValues(l.values);
        const values = ride ? evalOrUndefined(exp!, snap.current) : undefined;
        return {
          sha: ownerParamsCardSha(f.ownerParams),
          rows: [
            ...(values ? [...parameterRows(snap), ...expectationRows(exp, exp!, l!.values, values)] : []),
            ...names.map((n) => ({ label: n, ...(old[n] !== undefined ? { old: String(old[n]) } : {}), ...(now_[n] !== undefined ? { new: String(now_[n]) } : {}) })),
          ],
          ...(values ? { values } : {}),
        };
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
      // A card's identity is everything it shows (not just the file's hash): a card whose numbers
      // would read differently now is replaced, never kept open under its old rows.
      const nextKey = next ? JSON.stringify([next.sha, next.rows, next.rulesDiff ?? null]) : undefined;
      for (const c of open) {
        if (nextKey !== undefined && c.key === nextKey && !c.stale?.()) continue; // the same question is already on screen
        this.cards.delete(c.requestId);
        this.broadcast({ v: PROTOCOL_VERSION, type: "cad.expectations.resolved", ts: now(), requestId: c.requestId, approved: false, superseded: true } satisfies CadExpectationsResolvedEvent);
      }
      const scope = adoptScope(kind, ref);
      if (this.deniedAdopt.has(scope) && this.deniedAdopt.get(scope) !== nextKey) this.deniedAdopt.delete(scope); // it changed: ask again
      if (!next || !attended) continue; // nothing to adopt, or nobody there to answer (the part stays unverified)
      if (this.deniedAdopt.get(scope) === nextKey) continue; // the owner said no to exactly this card
      if ([...this.cards.values()].some((c) => sameScope(c, kind))) continue;
      const requestId = newId("cadx");
      const rulesSha = locked.rules.kind === "missing" ? null : locked.rules.sha;
      const stale =
        kind === "adopt-rules"
          ? () => {
              const r = readLocked(ref, this.locks, this.machine()).rules;
              return (r.kind === "missing" ? null : r.sha) !== rulesSha;
            }
          : () => !this.stillShows(ref, snap);
      this.park({ requestId, sessionId: attended.id, ref, kind, sha: next.sha, key: nextKey, snap, stale, ...(next.values ? { values: next.values } : {}), body: { type: "cad.expectations.request", requestId, sessionId: attended.id, cwd: ref.worktree, part: ref.part, kind, rows: next.rows, ...(next.rulesDiff ? { rulesDiff: next.rulesDiff } : {}) } });
    }
  }

  /** The owner tapped Approve on an adopt card: record exactly what the card showed, and nothing
   *  else. A part's card runs INSIDE the part's queue slot (`params` are the slot's) and first checks
   *  the card's whole snapshot again (decision 204); the record is built from the snapshot — its
   *  part.json and the parameter values it was drawn with — never from the design at approval time. */
  private adopt(card: Card, params?: CadParamInfo[]): boolean {
    const { ref } = card;
    const at = new Date().toISOString();
    if (card.kind === "adopt-rules") {
      const locked = readLocked(ref, this.locks, this.machine());
      if (locked.rules.kind === "missing" || locked.rules.sha !== card.sha) return false; // changed since the card was drawn
      this.approveRules(ref.worktree, { sha: locked.rules.sha, text: locked.rules.text, at });
      return true;
    }
    const snap = card.snap;
    if (!snap?.file || !params || !this.shownNow(ref, snap, params)) return false;
    const file = snap.file;
    const lock = this.findLock(ref);
    if (card.kind === "adopt-expectations") {
      if (lockedBlockSha(file) !== card.sha) return false;
      if (file.expectations && !card.values) return false; // formulas that do not evaluate cannot be approved
      this.approve(ref, { sha: card.sha, approvedBy: "owner", status: file.status, ...(card.values ? { values: card.values, declared: declaredFor(snap.current, lock, file.expectations) } : {}), ...(file.ownerParams ? { ownerParams: file.ownerParams } : {}), at });
      return true;
    }
    if (card.kind !== "adopt-ownerParams" || !lock) return false;
    if (ownerParamsCardSha(file.ownerParams) !== card.sha) return false; // not the dimensions the card showed
    const { ownerParams: _old, repo: _r, part: _p, remote: _m, path: _a, ...rest } = lock;
    // Moved parameters and the numbers they lead to were rows on the card (only when they could be
    // shown): approved with it.
    const moved = card.values && snap.changed.length && rest.sha === lockedBlockSha(file) ? { values: card.values, declared: declaredFor(snap.current, lock, file.expectations) } : {};
    this.approve(ref, { ...rest, ...moved, ...(file.ownerParams ? { ownerParams: file.ownerParams } : {}), at });
    return true;
  }

  /**
   * "Confirm numbers" (`cad.expectations.confirm`): raise the standard owner card for a part whose
   * numbers the agent recorded. Approving it makes the owner the approver of exactly that block — and,
   * like every card, of any parameter the agent moved, which is listed as its own row.
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
    const snap = this.cardSnapshot(ref);
    const accepted = locked.lock.values;
    // The numbers approving writes: the accepted ones, or — when a parameter moved — the block at the
    // design's values (shown as "To confirm", with the moved parameter as its own row).
    const values = snap.changed.length ? evalOrUndefined(file.expectations!, snap.current) : accepted;
    if (!values) return { ok: false, error: `cad/${ref.part}'s formulas do not evaluate against the design's parameters; nothing to confirm` };
    const requestId = newId("cadx");
    this.park({
      requestId,
      sessionId,
      ref,
      kind: "confirm",
      sha,
      snap,
      values,
      stale: () => !this.stillShows(ref, snap),
      body: {
        type: "cad.expectations.request",
        requestId,
        sessionId,
        cwd: ref.worktree,
        part: ref.part,
        kind: "confirm",
        rows: [{ label: "Process", new: file.process }, { label: "Status", new: file.status }, ...parameterRows(snap), ...expectationRows(file.expectations, file.expectations!, accepted, values), { label: "Recorded by", old: "the agent", new: "you, once approved" }],
      },
    });
    return { ok: true };
  }

  /** Approve a "Confirm numbers" card: inside the part's queue slot, after the snapshot check (decision 204). */
  private confirm(card: Card, params: CadParamInfo[]): boolean {
    const snap = card.snap;
    if (!snap?.file || !card.values || !this.shownNow(card.ref, snap, params)) return false;
    const lock = this.findLock(card.ref);
    if (!lock || lockedBlockSha(snap.file) !== card.sha || lock.sha !== card.sha || !hasValues(lock.values)) return false;
    const { repo: _r, part: _p, remote: _m, path: _a, ...rest } = lock;
    const moved = snap.changed.length ? { values: card.values, declared: declaredFor(snap.current, lock, snap.file.expectations) } : {};
    this.approve(card.ref, { ...rest, ...moved, approvedBy: "owner", at: new Date().toISOString() });
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

  // ── Phase B3: autopilot builders and plans (spec §4.11, §4.14 item 41) ──────────────────────────

  /** Which parts an autopilot builder session's plan covers (set by the Supervisor from the work unit).
   *  `undefined` for a session that is not a builder (or when no autopilot is wired, e.g. a unit test). */
  private builderScope?: (sessionId: string) => string[] | undefined;
  setBuilderScope(fn: ((sessionId: string) => string[] | undefined) | undefined): void {
    this.builderScope = fn;
  }
  private builderPartsOf(sessionId: string): string[] | undefined {
    const s = this.deps.getSession(sessionId);
    if (!s || !isUnattended(s)) return undefined;
    return this.builderScope?.(sessionId);
  }

  /**
   * Why a session may not address this part at all, or undefined. An autopilot builder works only on
   * the parts its plan has approved dimensions for: it may not open (and so create) any other part.
   */
  partRefusal(sessionId: string, ref: PartRef): string | undefined {
    const covered = this.builderPartsOf(sessionId);
    if (!covered || covered.includes(ref.part)) return undefined;
    return `cad/${ref.part} is not covered by this work unit's plan: an autopilot builder works only on the parts the plan has approved dimensions for (${covered.length ? covered.map((p) => `cad/${p}`).join(", ") : "none"}). If the change needs another part, stop and say so — the owner adds it in a planning session.`;
  }

  /** The approval on record for a part of a worktree (who approved its numbers), if any. */
  approvalOf(worktree: string, part: string): PartLock | undefined {
    try {
      return this.findLock(partRef(worktree, part));
    } catch {
      return undefined;
    }
  }

  /**
   * What is approved for a part right now (decision 183): the repo's single lock entry (shared by every
   * worktree, fleet-synced), with the process / tolerance / references of the block when the part.json
   * in `worktree` still carries exactly that block. Undefined when nothing is approved.
   */
  approvedNumbers(worktree: string, part: string): ApprovedNumbers | undefined {
    let ref: PartRef;
    try {
      ref = partRef(worktree, part);
    } catch {
      return undefined;
    }
    const lock = this.findLock(ref);
    if (!lock) return undefined;
    const pf = readPartFile(ref.dir);
    const file = pf.kind === "ok" && lockedBlockSha(pf.file) === lock.sha ? pf.file : undefined;
    return {
      approvedBy: lock.approvedBy,
      at: lock.at,
      sha: lock.sha,
      ...(lock.values ? { values: lock.values } : {}),
      ...(lock.declared ? { declared: { ...lock.declared } } : {}),
      matchesFile: !!file,
      ...(file ? { process: file.process, block: canonicalBlock({ process: file.process, status: file.status, expectations: file.expectations ?? null, declared: lock.declared ?? {} }) } : {}),
      ...(file?.expectations ? { tolerance: { ...file.expectations.tolerance }, refs: [...(file.expectations.noInterferenceWith ?? [])] } : {}),
      existingRefs: this.existingRefs(ref, pf.kind === "ok" ? pf.file : undefined).map((r) => r.name),
    };
  }

  /** The references a part already has — part.json's records and the design's embedded references whose
   *  file is in `refs/` — each of which a plan's write adds to `noInterferenceWith`. */
  private existingRefs(ref: PartRef, file: PartFile | undefined): PartReference[] {
    const records: PartReference[] = [...(file?.refs ?? [])];
    let embedded: ReturnType<typeof embeddedReferences> = [];
    try {
      embedded = embeddedReferences(readDesignFile(ref.dir).script).filter((e) => existsSync(join(ref.dir, REFS_DIR, e.file)));
    } catch {
      embedded = [];
    }
    for (const e of embedded) if (!records.some((r) => r.name === e.file)) records.push({ name: e.file, source: `${REFS_DIR}/${e.file}`, sha256: e.sha256, bodies: e.bodies, at: new Date().toISOString() });
    return records;
  }

  /** The process ids in a worktree's cad/rules.json (`null`: missing or unreadable). */
  processIds(worktree: string): string[] | null {
    const r = readRules(worktree);
    return r.kind === "ok" ? r.file.processes.map((p) => p.id) : null;
  }

  /** Refresh (measure and record) the named parts of a worktree now, starting their processes if
   *  needed — so `part.json.measured` is the daemon's own measurement of the design on disk before a
   *  verify reads it (what `check_part` does). Parts whose folder is gone are skipped. */
  async settleParts(worktree: string, parts: string[]): Promise<void> {
    for (const p of parts) {
      let ref: PartRef;
      try {
        ref = partRef(worktree, p);
      } catch {
        continue;
      }
      if (!existsSync(ref.dir)) continue;
      await this.manager.refreshNow(ref).catch(() => undefined);
    }
  }

  /**
   * Apply a plan's APPROVED numbers for one part to a worktree, before an autopilot builder's first
   * turn (Phase B3): the declared parameters are set in the design (`parameters.change` for names it
   * has, `parameters.add` for the rest), then `part.json` gets the process and expectations
   * (`lockedBy: "planner"`) and the lock store the approval (`approvedBy: "planner"`, fleet-synced),
   * with the evaluated numbers fixed from the declared values — the same record `record_expectations`
   * writes, in one queued job, so nothing slips in between. The caller has the owner's approval.
   */
  async applyPlanExpectations(worktree: string, part: string, entry: PlanPartExpectations, sessionId?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const why = this.unavailableReason();
    if (why) return { ok: false, error: `CAD is not available on this machine: ${why}` };
    const c = checkPlanPart(part, entry);
    if (!c.ok) return c;
    let ref: PartRef;
    try {
      ref = partRef(worktree, part);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (sessionId) this.touch(sessionId, ref);
    const pf = readPartFile(ref.dir);
    if (pf.kind === "invalid") return { ok: false, error: `cad/${part}/part.json cannot be read (${pf.error}); nothing was applied` };
    const keep = pf.kind === "ok" ? pf.file : undefined;
    if (keep?.ownerParams) {
      const differ = Object.keys(keep.ownerParams).filter((n) => c.declared[n] === undefined || !closeTo(c.declared[n]!, keep.ownerParams![n]!));
      if (differ.length) return { ok: false, error: `cad/${part}: the plan's parameters differ from the dimensions the owner typed (${differ.map((n) => `${n} = ${num(keep.ownerParams![n]!)}`).join(", ")})` };
    }
    await this.manager.open(ref);
    // Every reference the part already has is something it must not touch (as record_expectations does).
    const refRecords = this.existingRefs(ref, keep);
    const exp = planWrite(c.entry, refRecords.map((r) => r.name), new Date().toISOString())!.expectations;
    const have = new Map((this.manager.status(ref)?.params ?? []).map((p) => [p.name, p.value]));
    const change = Object.keys(c.declared).filter((n) => have.has(n) && !closeTo(have.get(n)!, c.declared[n]!));
    const add = Object.keys(c.declared).filter((n) => !have.has(n));
    let failure: string | undefined;
    // Decision 183: the WHOLE block this plan writes (process, every expectation field, tolerances, holes,
    // references, declared values) is byte-identical to the part's current approval (by the owner or a
    // plan), which this worktree's part.json carries → keep both untouched (only the parameters are set),
    // so starting the builder does not make the part unverified on the default branch. Anything else —
    // even one added reference — replaces it. The same `keepsApproval` the card's note is drawn from.
    const keepApproval = keepsApproval(c.entry, this.approvedNumbers(worktree, part));
    const write = (params: CadParamInfo[]): void => {
      for (const n of Object.keys(c.declared)) {
        const got = params.find((p) => p.name === n)?.value;
        if (got === undefined || !closeTo(got, c.declared[n]!)) return void (failure = `SolidCraft made ${n} = ${got === undefined ? "nothing" : num(got)}, not the planned ${num(c.declared[n]!)}`);
      }
      if (keepApproval) return;
      const f: PartFile = {
        schema: 1,
        process: c.entry.process,
        ...(keep?.material ? { material: keep.material } : {}),
        status: "dimensioned",
        ...(keep?.ownerParams ? { ownerParams: keep.ownerParams } : {}),
        expectations: exp,
        ...(refRecords.length ? { refs: refRecords } : {}),
      };
      writePartFile(ref.dir, f);
      this.approve(ref, { sha: lockedBlockSha(f), approvedBy: "planner", status: "dimensioned", values: c.values, declared: { ...c.declared }, ...(f.ownerParams ? { ownerParams: f.ownerParams } : {}), at: exp.lockedAt });
      this.clearGapRecord(ref); // owner-approved numbers are an approved expectation change
    };
    const commands = [
      ...(change.length ? [{ command: "parameters.change", params: { changes: Object.fromEntries(change.map((n) => [n, c.expressions[n]])) } }] : []),
      ...add.map((n) => ({ command: "parameters.add", params: { name: n, expression: c.expressions[n] } })),
    ];
    if (commands.length) {
      const reply = await this.manager.request(ref, {
        tool: "batch",
        args: { commands, verbose: false },
        kind: "mutate",
        afterWrite: (slot, done) => {
          if (done.result.isError) failure = `the planned parameters could not be set: ${done.result.text.slice(0, 300)}`;
          else if (slot.state().conflict) failure = DISK_CONFLICT_REASON;
          else write(slot.params());
        },
      });
      if (failure && !reply.result.isError) await this.manager.request(ref, { tool: "undo", kind: "undo" }).catch(() => undefined);
    } else {
      await this.manager.run(ref, async (slot) => write(slot.params()));
    }
    if (failure) return { ok: false, error: `cad/${part}: ${failure}; nothing was applied` };
    this.recheck(ref);
    return { ok: true };
  }

  /**
   * A typed owner card for an autopilot plan's numbers (`kind: "plan"`, Phase B3): shown in the
   * planning session's chat, Approve / Deny, no "always allow". `stale()` says whether what the card
   * shows has changed since it was drawn; an approval then comes back `stale` and the caller redraws
   * (decision 153). Resolves with the answer; a reset or kill of the session denies it.
   */
  askPlanCard(sessionId: string, cwd: string, part: string, rows: CadExpectationsRow[], opts: { note?: string; stale: () => boolean }): Promise<CardAnswer> {
    const requestId = newId("cadx");
    const ref: PartRef = { key: `plan:${sessionId}:${part}`, worktree: cwd, part, dir: cwd };
    return new Promise<CardAnswer>((resolve) => {
      this.park({
        requestId,
        sessionId,
        ref,
        kind: "plan",
        settle: resolve,
        stale: opts.stale,
        body: { type: "cad.expectations.request", requestId, sessionId, cwd, part, kind: "plan", ...(opts.note ? { note: opts.note } : {}), rows },
      });
    });
  }

  /**
   * The merge guard in-process (spec §4.11; Phase B3's autopilot verify hook calls this): the same
   * `verifyParts` as `verify-cli.ts`, against THIS daemon's lock store, machine id and binary, in
   * fresh sandboxed processes of its own (never the session's live ones). Read only. A machine that
   * cannot run CAD right now (no binary, off the fleet pin) gets `{ ok: false, error }`.
   */
  async verifyParts(worktree: string, opts: { parts?: string[]; changedSince?: string } = {}): Promise<VerifyResult> {
    const why = this.unavailableReason();
    const cli = this.resolveCli();
    const selection = { all: false, named: opts.parts ?? [], changed: [], rulesChanged: false, ...(opts.changedSince !== undefined ? { changedSince: opts.changedSince } : {}) };
    if (why || !cli) return { ok: false, error: `CAD is not available on this machine: ${why ?? NO_SOLIDCRAFT}`, parts: [], selection };
    // Only how processes are spawned (tests point these at the fake); never the live manager's hooks.
    const m = this.deps.manager ?? {};
    const manager = { ...(m.spawn ? { spawn: m.spawn } : {}), ...(m.extraEnv ? { extraEnv: m.extraEnv } : {}), ...(m.requestTimeoutMs ? { requestTimeoutMs: m.requestTimeoutMs } : {}), ...(m.batchTimeoutMs ? { batchTimeoutMs: m.batchTimeoutMs } : {}) };
    return verifyParts({ worktree, ...opts, binary: cli, lockStore: this.locks, machine: this.machine(), manager });
  }

  /** Stop every SolidCraft process (daemon shutdown). */
  async shutdown(): Promise<void> {
    this.offProtected?.();
    for (const t of this.busyTimers.values()) this.clock.clearTimeout(t);
    for (const st of this.emitState.values()) if (st.timer !== undefined) this.clock.clearTimeout(st.timer);
    this.busyTimers.clear();
    for (const card of [...this.cards.values()]) card.settle?.("denied");
    this.cards.clear();
    await this.manager.shutdown();
    await this.lockSync.settled();
  }
}

/** What an owner card's own action did inside the write's queue job (import_reference's import). */
type CardAction =
  | {
      ok: true;
      /** part.json's `refs` after the action, from the snapshot's. */
      refs: (refs: PartReference[]) => PartReference[];
      /** The card's extra state the action leaves behind (the new reference file's sha). */
      extraAfter: unknown;
      /** Undo the action in full; an error string when it could not be. */
      rollback: () => Promise<string | undefined>;
      /** What is left in the design when the rollback fails (said to the agent, truthfully). */
      leftBehind: string;
    }
  | { ok: false; error: string };

const ADOPT_KINDS = ["adopt-expectations", "adopt-ownerParams", "adopt-rules"] as const;
type AdoptKind = (typeof ADOPT_KINDS)[number];
const isAdoptKind = (k: CardKind): k is AdoptKind => (ADOPT_KINDS as readonly string[]).includes(k);
/** Where an adopt card is asked: a rules card per worktree, a part's cards per part. */
const adoptScope = (kind: AdoptKind, ref: PartRef): string => `${kind}\0${kind === "adopt-rules" ? ref.worktree : ref.key}`;

/** The part.json half of an owner card's fingerprint. */
function partKeyOf(part: PartRead): unknown {
  return part.kind === "ok"
    ? { sha: lockedBlockSha(part.file), refs: (part.file.refs ?? []).map((r) => [r.name, r.sha256, r.bodies]), ownerParams: sortedEntries(part.file.ownerParams), material: part.file.material ?? null }
    : part.kind;
}
/** Put part.json's previous bytes back (an owner write that failed half way). */
function restorePartText(dir: string, text: string): void {
  try {
    writeFileAtomic(join(dir, "part.json"), text);
  } catch {
    /* best effort: the gate fails a part.json the lock store does not match */
  }
}
/** The parameter names an expectations block's formulas use. */
function expectationNames(exp: Expectations): Set<string> {
  return new Set([...exp.bbox, exp.volume, ...exp.holes.map((h) => h.diameter)].flatMap((e) => exprNames(e)));
}
/**
 * The parameter values an approval records as accepted (`declared`, A4 re-review): the names the
 * approved expectations use, and the names already accepted. A parameter nothing uses and nobody
 * approved stays out — it is never approved silently.
 */
export function declaredFor(current: Record<string, number>, lock: Pick<PartLock, "declared"> | undefined, exp: Expectations | undefined): Record<string, number> {
  const names = new Set([...Object.keys(lock?.declared ?? {}), ...(exp ? expectationNames(exp) : [])]);
  return Object.fromEntries(Object.entries(current).filter(([n]) => names.has(n)));
}

/** What an adopt-ownerParams card stands for: the dimensions in the file when it was drawn. */
const ownerParamsCardSha = (p: Record<string, number> | undefined): string => JSON.stringify(Object.keys(p ?? {}).sort().map((n) => [n, p![n]]));
/** The parameter values accepted numbers are derived from: the lock's accepted (`declared`) values,
 *  and the design's current value only for a name that was never accepted. */
export function acceptedBase(lock: Pick<PartLock, "declared"> | undefined, params: CadParamInfo[]): Record<string, number> {
  return { ...paramMap(params), ...(lock?.declared ?? {}) };
}
function evalOrUndefined(exp: Expectations, params: Record<string, number>): EvaluatedExpectations | undefined {
  try {
    return evaluateExpectations(exp, params);
  } catch {
    return undefined;
  }
}
const paramMap = (params: CadParamInfo[]): Record<string, number> => Object.fromEntries(params.filter((p) => Number.isFinite(p.value)).map((p) => [p.name, p.value]));
const closeTo = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
/** The same names with the same values. */
function sameValues(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && closeTo(a[k]!, b[k]!));
}
const partRefOf = (key: string, part: string): PartRef => ({ key, part, dir: key, worktree: key.slice(0, key.length - `/cad/${part}`.length) });
const num = (v: number): string => String(Math.round(v * 1e4) / 1e4);

/** The statuses of a session whose turn is running (an owner card may show it as waiting on the owner). */
const TURN_STATUSES = new Set(["thinking", "running_tool", "awaiting_permission", "awaiting_question"]);
function setStatus(session: unknown, status: string): void {
  const s = session as { setStatus?: (st: string) => void; settleStatus?: (st: string) => string } | undefined;
  try {
    if (s && typeof s.setStatus === "function") s.setStatus(status !== "awaiting_permission" && typeof s.settleStatus === "function" ? s.settleStatus(status) : status);
  } catch {
    /* status is cosmetic here */
  }
}

function valueText(v: EvaluatedExpectations): string {
  const holes = v.holes.length ? v.holes.map((h) => `⌀${num(h.diameter)} ×${h.count}${h.kind ? ` ${h.kind}` : ""}`).join(", ") : "none";
  return `box ${v.bbox.map(num).join(" × ")} mm; volume ${num(v.volume)} mm³; ${v.bodies} bod${v.bodies === 1 ? "y" : "ies"}; holes ${holes}`;
}

/** How a parameter row says its value is not the approved one (decision 153). */
export const UNAPPROVED_PARAMETER = "changed by the agent, not approved";
/** The parameter rows of an owner card: one per parameter whose current value is not the accepted
 *  one. Approving the card approves these too — which is why they are shown. */
export function parameterRows(snap: CardSnapshot): CadExpectationsRow[] {
  const rows: CadExpectationsRow[] = snap.changed.map((n) => ({
    label: `Parameter ${n}`,
    old: num(snap.accepted[n]!),
    new: snap.current[n] === undefined ? `removed (${UNAPPROVED_PARAMETER})` : `${num(snap.current[n]!)} (${UNAPPROVED_PARAMETER})`,
    unapproved: true,
  }));
  if (snap.noDeclared) rows.push({ label: "Parameters", old: "not recorded with the earlier approval", new: "approving accepts the design's current values — compare the numbers below", unapproved: true });
  return rows;
}

/**
 * The rows of an expectations card: each value as written (a formula) with what it evaluates to.
 * `oldValues` are the ACCEPTED numbers (the lock's, or the old block evaluated at the accepted
 * parameter values); `newValues` are the new block evaluated at the values the card approves.
 */
export function expectationRows(before: Expectations | undefined, after: Expectations, oldValues: EvaluatedExpectations | undefined, newValues: EvaluatedExpectations | undefined): CadExpectationsRow[] {
  const [vb, va] = [oldValues, newValues];
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

/** What a release card says when the numbers are the agent's own (decision 96). */
export const RELEASE_AGENT_NUMBERS = "The expected numbers were set by the agent and you have not confirmed them. Approving this release also confirms them as yours.";
const PICTURE_MAX_BYTES = 20 * 1024 * 1024;
const sortedEntries = (o: Record<string, number> | undefined): [string, number][] => Object.keys(o ?? {}).sort().map((k) => [k, o![k]!]);
const showVal = (v: number | string): string => (typeof v === "number" ? num(v) : v);
function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${Math.round((n / 1024 / 1024) * 10) / 10} MB` : n >= 1024 ? `${Math.round((n / 1024) * 10) / 10} KB` : `${n} bytes`;
}

/** `request_dimensions.proposed`: 1–50 rows {name, value, unit?, note?}, names unique. */
export function parseDimensionRows(raw: unknown): { ok: true; rows: CadDimensionRow[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) return { ok: false, error: "`proposed` must list 1 to 50 named dimensions: [{name, value, unit?, note?}]" };
  const rows: CadDimensionRow[] = [];
  for (const [i, r] of raw.entries()) {
    const x = r as Record<string, unknown>;
    if (!x || typeof x !== "object") return { ok: false, error: `proposed[${i}] must be {name, value, unit?, note?}` };
    if (typeof x.name !== "string" || !PARAM_NAME_RE.test(x.name) || x.name === "pi") return { ok: false, error: `proposed[${i}].name must be a parameter name` };
    if (rows.some((y) => y.name === x.name)) return { ok: false, error: `proposed[${i}].name ${x.name} is listed twice` };
    const bad = dimensionError(x.value);
    if (bad) return { ok: false, error: `proposed[${i}].value ${bad}` };
    if (x.unit !== undefined && x.unit !== "mm" && x.unit !== "") return { ok: false, error: `proposed[${i}].unit must be "mm" (dimensions are lengths)` };
    if (x.note !== undefined && typeof x.note !== "string") return { ok: false, error: `proposed[${i}].note must be text` };
    rows.push({ name: x.name, value: x.value as number, ...(x.unit ? { unit: "mm" } : {}), ...(typeof x.note === "string" && x.note.trim() ? { note: x.note.trim().slice(0, 200) } : {}) });
  }
  return { ok: true, rows };
}

/** Why a dimension value is refused (decision 154): it must be a finite length above 0 and at most
 *  `CAD_DIMENSION_MAX_MM`. Undefined when it is fine. */
export function dimensionError(x: unknown): string | undefined {
  if (typeof x !== "number" || !Number.isFinite(x)) return "must be a number";
  if (x <= 0) return "must be above 0 mm";
  if (x > CAD_DIMENSION_MAX_MM) return `must be at most ${CAD_DIMENSION_MAX_MM} mm`;
  return undefined;
}

/** The owner's answer to a dimensions card: a positive, bounded number for exactly the card's names. */
export function checkDimensionValues(names: string[], raw: unknown): { ok: true; values: Record<string, number> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "the dimensions card needs a number for every dimension" };
  const v = raw as Record<string, unknown>;
  const extra = Object.keys(v).filter((k) => !names.includes(k));
  if (extra.length) return { ok: false, error: `not on the card: ${extra.join(", ")}` };
  const out: Record<string, number> = {};
  for (const n of names) {
    const x = v[n];
    const bad = dimensionError(x);
    if (bad) return { ok: false, error: `${n} ${bad}` };
    out[n] = x as number;
  }
  return { ok: true, values: out };
}
