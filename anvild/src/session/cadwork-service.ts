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
  type GapRecord,
  type PartFile,
  type PartReference,
} from "../cadwork/partfile";
import { gapOf, makeRefreshJob, newestPreview, previewRevs, readDesign, readLocked, PREVIEW_PATH_RE, THUMB_PATH_RE, type RefreshOutcome } from "../cadwork/refresh";
import { embeddedReferences, importFeatureName, referenceName, resolveReferenceSource, storeReference, REFERENCE_MAX_BYTES, REFS_DIR } from "../cadwork/refs";
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
interface Card {
  requestId: string;
  sessionId: string;
  ref: PartRef;
  kind: CardKind;
  body: Omit<CadExpectationsRequestEvent, "v" | "ts" | "replay">;
  /** propose / initial / dimensions / release: settles the tool call that is waiting on the owner.
   *  A `dimensions` card also hands over the owner's typed numbers. */
  settle?: (approved: boolean, values?: Record<string, number>) => void;
  /** adopt: the hash of exactly what the card showed. Approval records THIS and nothing else. */
  sha?: string;
  /** dimensions: the names the owner must give a number for. */
  dims?: string[];
}

export const NO_EXPECTATIONS = "has no expectations yet";
export type ExpectationsReply = { ok: true; note?: string } | { ok: false; error: string };
/** The caution on an `initial` card: the numbers were written after the part existed. */
export const INITIAL_AFTER_GEOMETRY = "this part already has geometry; these numbers were written after it existed";
/** A declared parameter value: a number, optionally followed by `mm`. Nothing else — the declared
 *  values are what the expectations (lengths, volumes) are evaluated from, so they are lengths or
 *  plain numbers; an angle (`deg`) is not accepted. */
const DECLARED_RE = /^\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(mm)?\s*$/;
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
    if (!m) return { ok: false, error: `\`parameters.${name}\` must be a number, optionally with mm (e.g. 80 or "80 mm"), not ${JSON.stringify(v)}` };
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
            rows: [{ label: "Process", new: process.trim() }, { label: "Status", ...(keep?.status === "concept" ? { old: "concept" } : {}), new: "dimensioned" }, ...expectationRows(undefined, exp, declared.values), ...(ownerParams ? [{ label: "Dimensions you typed", new: Object.keys(ownerParams).sort().map((n) => `${n} = ${num(ownerParams[n]!)}`).join(", ") }] : [])],
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
      this.approve(ref, { sha: lockedBlockSha(f), approvedBy: by, status: "dimensioned", values, declared: declared.values, ...(f.ownerParams ? { ownerParams: f.ownerParams } : {}), at: exp.lockedAt });
      if (by === "owner") this.clearGapRecord(ref);
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
  async proposeExpectations(
    sessionId: string,
    ref: PartRef,
    input: unknown,
    reason: unknown,
    /** Runs after the owner approved and before anything is written; an error string writes nothing
     *  (import_reference imports the reference here, so a failed import changes no expectation). */
    opts: { beforeWrite?: () => Promise<string | undefined> } = {},
  ): Promise<ExpectationsReply & { approved?: boolean }> {
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
      if (opts.beforeWrite) {
        const err = await opts.beforeWrite();
        if (err) return { ok: false, error: err };
      }
      const now2 = readPartFile(ref.dir);
      const file: PartFile = { ...(now2.kind === "ok" ? now2.file : cur.file), expectations: proposed };
      writePartFile(ref.dir, file);
      // The parameter values the approved numbers were evaluated with (shown on the card) are now the accepted ones.
      const declared = paramMap(this.manager.status(ref)?.params ?? []);
      this.approve(ref, { sha: lockedBlockSha(file), approvedBy: "owner", status: file.status, values, declared, ...(file.ownerParams ? { ownerParams: file.ownerParams } : {}), at: proposed.lockedAt });
      this.clearGapRecord(ref); // an approved expectation change clears a reported gap
      this.recheck(ref);
      return { ok: true, approved: true };
    }
    return { ok: false, error: `cad/${ref.part}/part.json kept changing while the owner was being asked; nothing was written` };
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
   * fixed body with `file.insert_step` in the part's queue. A re-import of the same name replaces the
   * old import feature. A failed import puts the old `refs/` file back and records nothing.
   */
  async importReference(sessionId: string, ref: PartRef, file: unknown): Promise<{ ok: true; approved?: boolean; name?: string; bodies?: string[]; sha256?: string; replaced?: boolean } | { ok: false; error: string }> {
    this.touch(sessionId, ref);
    const src = resolveReferenceSource(ref.worktree, file, { maxBytes: this.deps.referenceMaxBytes ?? REFERENCE_MAX_BYTES });
    if (!src.ok) return src;
    const name = referenceName(src.rel);
    const part = readPartFile(ref.dir);
    if (part.kind === "invalid") return { ok: false, error: `cad/${ref.part}/part.json cannot be read (${part.error}); nothing was imported` };

    let outcome: { ok: true; name: string; bodies: string[]; sha256: string; replaced: boolean } | { ok: false; error: string } = { ok: false, error: "not imported" };
    const doImport = async (): Promise<string | undefined> => {
      outcome = await this.insertReference(ref, name, src.rel, src.bytes, src.sha256);
      return outcome.ok ? undefined : outcome.error;
    };
    const exp = part.kind === "ok" ? part.file.expectations : undefined;
    if (!exp) {
      await doImport();
      return outcome;
    }
    // Expectations are locked: adding what the part must not touch is the owner's call, on the card.
    const input: ExpectationsInput = { bbox: exp.bbox, volume: exp.volume, bodies: exp.bodies, holes: exp.holes, tolerance: exp.tolerance, noInterferenceWith: [...new Set([...(exp.noInterferenceWith ?? []), name])] };
    const reason = `import_reference: ${src.rel} as refs/${name} (sha256 ${src.sha256.slice(0, 12)}, ${src.bytes.length} bytes) — the part must not touch it.`;
    const r = await this.proposeExpectations(sessionId, ref, input, reason, { beforeWrite: doImport });
    if (!r.ok) return r;
    if (!r.approved) return { ok: true, approved: false };
    return outcome;
  }

  private async insertReference(ref: PartRef, name: string, source: string, bytes: Buffer, sha256: string): Promise<{ ok: true; name: string; bodies: string[]; sha256: string; replaced: boolean } | { ok: false; error: string }> {
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
      return { ok: false, error: `import_reference: ${e instanceof Error ? e.message : String(e)}` };
    }
    const restore = (): void => {
      try {
        if (previous) storeReference(ref, name, previous);
        else rmSync(dest, { force: true });
      } catch {
        /* best effort */
      }
    };
    try {
      // An earlier import of the same file is replaced (its feature deleted in the same batch).
      const old = await this.manager.request(ref, { tool: "inspect_design", args: { measure: false, sketches: false, timeline: "summary", bodies: false }, kind: "read" });
      const timeline: any[] = Array.isArray(old.result.json?.timeline) ? old.result.json.timeline : [];
      const prior = timeline.find((f) => f?.type === "BaseFeature" && f?.name === importFeatureName(name));
      const insert = { command: "file.insert_step", params: { path: dest, name: importFeatureName(name) } };
      const reply = prior
        ? await this.manager.request(ref, { tool: "batch", args: { commands: [{ command: "timeline.delete", params: { feature: prior.id } }, insert], verbose: true }, kind: "mutate" })
        : await this.manager.request(ref, { tool: "execute", args: { ...insert, verbose: true }, kind: "mutate" });
      if (reply.result.isError) {
        restore();
        return { ok: false, error: `import_reference: SolidCraft could not import refs/${name}: ${reply.result.text.slice(0, 500)}` };
      }
      if (reply.state.conflict) {
        restore();
        return { ok: false, error: `import_reference: ${DISK_CONFLICT_REASON}; nothing was recorded` };
      }
      const j = prior ? reply.result.json?.results?.at?.(-1) : reply.result.json;
      const bodies: string[] = Array.isArray(j?.created_bodies) ? j.created_bodies.map(String) : [];
      if (bodies.length === 0) {
        restore();
        return { ok: false, error: `import_reference: SolidCraft imported refs/${name} but reported no bodies` };
      }
      if (typeof j?.content_sha256 === "string" && j.content_sha256 !== sha256) {
        restore();
        return { ok: false, error: `import_reference: SolidCraft embedded different bytes than refs/${name} holds (${String(j.content_sha256).slice(0, 12)} ≠ ${sha256.slice(0, 12)})` };
      }
      const cur = readPartFile(ref.dir);
      if (cur.kind === "ok") {
        const record: PartReference = { name, source, sha256, bodies, at: new Date().toISOString() };
        writePartFile(ref.dir, { ...cur.file, refs: [...(cur.file.refs ?? []).filter((x) => x.name !== name), record] });
      }
      return { ok: true, name, bodies, sha256, replaced: !!prior };
    } catch (e) {
      restore();
      return { ok: false, error: `import_reference: ${e instanceof Error ? e.message : String(e)}` };
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
    const requestId = newId("cadx");
    const answer = await new Promise<{ approved: boolean; values?: Record<string, number> }>((resolve) => {
      this.park({
        requestId,
        sessionId,
        ref,
        kind: "dimensions",
        dims: rows.rows.map((r) => r.name),
        settle: (approved, values) => resolve({ approved, values }),
        body: {
          type: "cad.expectations.request",
          requestId,
          sessionId,
          cwd: ref.worktree,
          part: ref.part,
          kind: "dimensions",
          note: "The agent built this part from a picture. Type the real dimensions: your numbers are what the part will be checked against.",
          dimensions: rows.rows,
          rows: rows.rows.map((r) => ({ label: r.name, new: `${num(r.value)}${r.unit ? ` ${r.unit}` : ""}` })),
        },
      });
      setStatus(session, "awaiting_permission");
    });
    setStatus(session, "running_tool");
    if (!answer.approved || !answer.values) return { ok: true, approved: false };
    const values = answer.values;
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
      afterWrite: (slot, done) => {
        if (done.result.isError) return void (failure = `the dimensions could not be applied: ${done.result.text.slice(0, 300)}`);
        if (slot.state().conflict) return void (failure = DISK_CONFLICT_REASON);
        for (const n of Object.keys(values)) {
          const got = slot.params().find((p) => p.name === n)?.value;
          if (got === undefined || Math.abs(got - values[n]!) > 1e-9 * Math.max(1, Math.abs(values[n]!))) return void (failure = `SolidCraft made ${n} = ${got ?? "nothing"}, not ${values[n]}`);
        }
        this.nextBy.set(ref.key, "panel");
        const cur = readPartFile(ref.dir);
        if (cur.kind !== "ok") return void (failure = "part.json can no longer be read");
        writePartFile(ref.dir, { ...cur.file, ownerParams: { ...values } });
        const l = this.findLock(ref);
        if (!l) return void (failure = "the concept's approval is gone");
        const { repo: _r, part: _p, remote: _m, path: _a, ...rest } = l;
        this.approve(ref, { ...rest, ownerParams: { ...values }, at: new Date().toISOString() });
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
      return v.ok ? { path: relative(ref.worktree, dir), scriptSha, at: v.manifest.createdAt } : undefined;
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
  async releasePart(sessionId: string, ref: PartRef, opts: { onParked?: () => void } = {}): Promise<{ ok: true; approved: boolean; dir?: string; files?: string[]; offered?: number } | { ok: false; error: string }> {
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
    const requestId = newId("cadx");
    const approved = await new Promise<boolean>((resolve) => {
      this.park({
        requestId,
        sessionId,
        ref,
        kind: "release",
        settle: resolve,
        body: {
          type: "cad.expectations.request",
          requestId,
          sessionId,
          cwd: ref.worktree,
          part: ref.part,
          kind: "release",
          ...(agentNumbers ? { note: RELEASE_AGENT_NUMBERS } : {}),
          rows,
        },
      });
      setStatus(session, "awaiting_permission");
      opts.onParked?.();
    });
    setStatus(session, "running_tool");
    if (!approved) return { ok: true, approved: false };

    // The owner saw these numbers on the release card: release is never on numbers nobody approved.
    if (agentNumbers) {
      const locked = readLocked(ref, this.locks, this.machine());
      if (locked.part.kind !== "ok" || !locked.lock || locked.lock.sha !== lockedBlockSha(locked.part.file)) return refuse("part.json changed while the card was open");
      const { repo: _r, part: _p, remote: _m, path: _a, ...rest } = locked.lock;
      this.approve(ref, { ...rest, approvedBy: "owner", at: new Date().toISOString() });
    }
    await this.manager.refreshNow(ref);
    const after = this.snapshots.get(ref.key);
    if (!after || after.outcome.scriptSha !== shownSha) return refuse("the design changed while the card was open");
    if (after.outcome.gate.state !== "pass") return refuse(`the gate is ${after.outcome.gate.state} now`);
    const key = releaseKey(this.stateDir);
    let written: { dir: string; files: string[] };
    try {
      written = await this.manager.run(ref, async (slot) => {
        if (slot.scriptSha() !== shownSha) throw new Error("the design changed while the card was open");
        const call = (tool: string, args: Record<string, unknown>) => slot.call(tool, args);
        const design = await readDesign(call);
        const tables = [];
        for (const b of design.designBodies) tables.push(await holeTable(call, b, { positions: true }));
        const g = after.outcome.gate;
        const data: ReleaseData = {
          part: ref.part,
          scriptSha: shownSha,
          solidcraft: design.version,
          process: { id: proc.id, kind: proc.kind, ...(proc.generalTolerance ? { generalTolerance: proc.generalTolerance } : {}) },
          ...(part.file.material ?? proc.material ? { material: part.file.material ?? proc.material } : {}),
          bbox: m.bbox,
          volume: m.volume,
          bodies: m.bodies,
          params: design.params,
          holes: mergeHoleTables(tables),
          checks: g.checks,
          advisories: [...advisoryLines(g), ...g.warnings],
          references: (part.file.refs ?? []).map((r) => ({ name: r.name, sha256: r.sha256 })),
          approvedBy: agentNumbers ? "owner (confirmed with this release)" : String(g.approvedBy ?? "owner"),
          createdAt: new Date().toISOString(),
        };
        return writeReleasePack(call, ref, data, design.designBodies, key);
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
    let approved = approve;
    // The waiting tool call does the writing for these.
    const toolCard = card.kind === "propose" || card.kind === "initial" || card.kind === "dimensions" || card.kind === "release";
    if (!toolCard && approve) approved = card.kind === "confirm" ? this.confirm(card) : this.adopt(card);
    this.broadcast({ v: PROTOCOL_VERSION, type: "cad.expectations.resolved", ts: now(), requestId, approved } satisfies CadExpectationsResolvedEvent);
    card.settle?.(approved, typed);
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
    const build: Partial<Record<CardKind, () => { sha: string; rows: CadExpectationsRow[]; rulesDiff?: CadExpectationsRequestEvent["rulesDiff"] } | undefined>> = {
      "adopt-expectations": () => {
        if (locked.part.kind !== "ok") return undefined;
        const f = locked.part.file;
        // Evaluated from the ACCEPTED parameter values where there are any (an agent's unapproved
        // change does not ride in on an adoption), the design's for names never accepted.
        const p = acceptedBase(locked.lock, params);
        // A card always shows evaluated numbers: expectations that do not evaluate cannot be adopted
        // (the gate says which formula fails), so no card is drawn for them.
        if (f.expectations && !evalOrUndefined(f.expectations, p)) return undefined;
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
      // The accepted numbers are fixed here, at approval, from the same values the card showed.
      // Formulas that do not evaluate cannot be approved.
      const base = acceptedBase(locked.lock, this.manager.status(ref)?.params ?? []);
      const values = file.expectations ? evalOrUndefined(file.expectations, base) : undefined;
      if (file.expectations && !values) return false;
      this.approve(ref, { sha: card.sha, approvedBy: "owner", status: file.status, ...(values ? { values, declared: base } : {}), ...(file.ownerParams ? { ownerParams: file.ownerParams } : {}), at });
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
    for (const st of this.emitState.values()) if (st.timer !== undefined) this.clock.clearTimeout(st.timer);
    this.busyTimers.clear();
    for (const card of [...this.cards.values()]) card.settle?.(false);
    this.cards.clear();
    await this.manager.shutdown();
    await this.lockSync.settled();
  }
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
    if (typeof x.value !== "number" || !Number.isFinite(x.value)) return { ok: false, error: `proposed[${i}].value must be a number` };
    if (x.unit !== undefined && x.unit !== "mm" && x.unit !== "") return { ok: false, error: `proposed[${i}].unit must be "mm" (dimensions are lengths)` };
    if (x.note !== undefined && typeof x.note !== "string") return { ok: false, error: `proposed[${i}].note must be text` };
    rows.push({ name: x.name, value: x.value, ...(x.unit ? { unit: "mm" } : {}), ...(typeof x.note === "string" && x.note.trim() ? { note: x.note.trim().slice(0, 200) } : {}) });
  }
  return { ok: true, rows };
}

/** The owner's answer to a dimensions card: a finite number for exactly the card's names. */
export function checkDimensionValues(names: string[], raw: unknown): { ok: true; values: Record<string, number> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "the dimensions card needs a number for every dimension" };
  const v = raw as Record<string, unknown>;
  const extra = Object.keys(v).filter((k) => !names.includes(k));
  if (extra.length) return { ok: false, error: `not on the card: ${extra.join(", ")}` };
  const out: Record<string, number> = {};
  for (const n of names) {
    const x = v[n];
    if (typeof x !== "number" || !Number.isFinite(x)) return { ok: false, error: `${n} must be a number` };
    out[n] = x;
  }
  return { ok: true, values: out };
}
