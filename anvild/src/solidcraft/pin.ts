/**
 * The SolidCraft fleet pin (agent-cad-and-browser spec §4.10).
 *
 * The hub records ONE build, `{ version, sha256, pinnedAt, previous }`, and hands it to every
 * member. Each machine keeps the pin it was last given in `<stateDir>/solidcraft-pin.json`, installs
 * exactly that build (./install.ts) and points the daemon at it (./binary.ts). A machine that is not
 * on the pinned version must not do CAD, so no design is written by a build the rest of the fleet
 * cannot read; `pinAvailability` is that rule as a pure function.
 *
 * Three things live here:
 *   - `PinStore`            the persisted record, on the hub and on each member;
 *   - `pinAvailability`     may CAD run on this machine, given its version and the pin;
 *   - `SolidcraftPinService` one machine's side of the pin: apply, set, pin back, status, boot.
 *
 * The hub's fan-out to members is in server/fleet-solidcraft.ts.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SolidcraftMachineStatus, SolidcraftPin, SolidcraftPinRef, SolidcraftRewrittenDesign } from "@protocol";
import { writeFileAtomic } from "../util/atomic";
import { APP_BUNDLE_SOLIDCRAFT_CLI, setManagedSolidcraftCli, type ManagedSolidcraft, type SolidcraftSource } from "./binary";
import {
  binaryEnv,
  installSolidcraft,
  installedSolidcraft,
  isSha256,
  isSolidcraftVersion,
  pruneSolidcraft,
  spawnRun,
  type InstallDeps,
  type InstallFailure,
  type InstallResult,
  type Run,
  type SolidcraftRef,
} from "./install";

export type { SolidcraftPin, SolidcraftPinRef };

export const PIN_FILE = "solidcraft-pin.json";

// ── Store ───────────────────────────────────────────────────────────────────────────────────────

function parseRef(raw: unknown): SolidcraftPinRef | undefined {
  const r = raw as { version?: unknown; sha256?: unknown; pinnedAt?: unknown } | null;
  if (!r || typeof r !== "object" || !isSolidcraftVersion(r.version) || !isSha256(r.sha256)) return undefined;
  return { version: r.version, sha256: r.sha256, ...(typeof r.pinnedAt === "string" ? { pinnedAt: r.pinnedAt } : {}) };
}

/** A well-formed pin, or undefined. Used for the file on disk and for a pin arriving from the hub. */
export function parsePin(raw: unknown): SolidcraftPin | undefined {
  const ref = parseRef(raw);
  if (!ref || typeof ref.pinnedAt !== "string" || !ref.pinnedAt) return undefined;
  const prevRaw = (raw as { previous?: unknown }).previous;
  let previous: SolidcraftPinRef | undefined;
  if (prevRaw !== undefined && prevRaw !== null) {
    previous = parseRef(prevRaw);
    if (!previous) return undefined;
  }
  return { version: ref.version, sha256: ref.sha256, pinnedAt: ref.pinnedAt, ...(previous ? { previous } : {}) };
}

/**
 * The pin record. A missing file means "no pin". A file that does not parse is NOT treated as "no
 * pin": that would silently lift the fleet's format guard. It is left in place, `corrupt()` reports
 * it, and the machine stays unavailable for CAD until a pin is written again.
 */
export class PinStore {
  readonly file: string;
  private pin: SolidcraftPin | undefined;
  private problem: string | undefined;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, PIN_FILE);
    this.load();
  }

  get(): SolidcraftPin | undefined {
    return this.pin ? structuredClone(this.pin) : undefined;
  }

  /** Why the file on disk could not be used, if it could not. */
  corrupt(): string | undefined {
    return this.problem;
  }

  /**
   * Make `ref` the pin. The pin it replaces becomes `previous`. Setting the build that is already
   * pinned changes nothing (a repeated broadcast must not erase `previous`).
   */
  set(ref: SolidcraftRef, now: Date = new Date()): SolidcraftPin {
    const cur = this.pin;
    if (cur && cur.version === ref.version && cur.sha256 === ref.sha256) return this.get()!;
    const next: SolidcraftPin = {
      version: ref.version,
      sha256: ref.sha256,
      pinnedAt: now.toISOString(),
      ...(cur ? { previous: { version: cur.version, sha256: cur.sha256, pinnedAt: cur.pinnedAt } } : {}),
    };
    this.write(next);
    return this.get()!;
  }

  /** Store a pin exactly as the hub sent it (a member does not compute its own `previous`). */
  replace(pin: SolidcraftPin): SolidcraftPin {
    const clean = parsePin(pin);
    if (!clean) throw new Error("not a valid SolidCraft pin");
    this.write(clean);
    return this.get()!;
  }

  private write(pin: SolidcraftPin): void {
    writeFileAtomic(this.file, JSON.stringify(pin, null, 2));
    this.pin = pin;
    this.problem = undefined;
  }

  private load(): void {
    this.pin = undefined;
    this.problem = undefined;
    if (!existsSync(this.file)) return;
    try {
      const pin = parsePin(JSON.parse(readFileSync(this.file, "utf8")));
      if (!pin) throw new Error("it is not a pin record");
      this.pin = pin;
    } catch (e) {
      this.problem = `${PIN_FILE} is unreadable (${e instanceof Error ? e.message : String(e)})`;
    }
  }
}

/** Read a machine's pin without building a service (for callers that only need the record). */
export function readLocalPin(stateDir: string): SolidcraftPin | undefined {
  return new PinStore(stateDir).get();
}

// ── Availability ────────────────────────────────────────────────────────────────────────────────

export interface PinAvailability {
  available: boolean;
  reason?: string;
  pinned?: string;
}

/**
 * May CAD run on this machine (spec §4.8 `cad.status`)?
 *
 *   - no pin recorded          → available (Track A works before a pin exists);
 *   - on the pinned version    → available;
 *   - any other local version, or none → unavailable, with a reason a person can act on.
 *
 * `localVersion` is the version of the build the daemon would run (`resolveSolidcraftCli()`), which
 * is the managed build once an install succeeds. `installError` is the last install failure, if any,
 * and is only used to explain why the machine is off the pin.
 */
export function pinAvailability(localVersion: string | undefined, pin: Pick<SolidcraftPin, "version"> | undefined, installError?: string): PinAvailability {
  if (!pin) return { available: true };
  if (localVersion === pin.version) return { available: true, pinned: pin.version };
  const why = installError ? ` (${installError})` : "";
  const reason = localVersion
    ? `CAD is unavailable here: this machine runs SolidCraft ${localVersion} but the fleet is pinned to ${pin.version}${why}`
    : `CAD is unavailable here: the fleet is pinned to SolidCraft ${pin.version} and it is not installed on this machine${why}`;
  return { available: false, reason, pinned: pin.version };
}

// ── Pin back ────────────────────────────────────────────────────────────────────────────────────

/**
 * Lists the designs whose `measured.solidcraft` is `newerVersion`: those were rewritten by the build
 * being left, and may not open under the one being returned to. The design store belongs to Track A,
 * so the list is supplied from outside; the default knows of none.
 */
export type RewrittenDesignsProvider = (newerVersion: string) => Promise<SolidcraftRewrittenDesign[]> | SolidcraftRewrittenDesign[];

export const noRewrittenDesigns: RewrittenDesignsProvider = () => [];

export interface PinBackWarning {
  current?: SolidcraftPinRef;
  previous?: SolidcraftPinRef;
  rewritten: SolidcraftRewrittenDesign[];
  /** Set when the provider failed: the list is then incomplete, and the caller must say so. */
  listError?: string;
}

/** What "Pin back" would do and which designs it puts at risk. Nothing is changed. */
export async function pinBackWarning(pin: SolidcraftPin | undefined, provider: RewrittenDesignsProvider = noRewrittenDesigns): Promise<PinBackWarning> {
  if (!pin) return { rewritten: [] };
  const current: SolidcraftPinRef = { version: pin.version, sha256: pin.sha256, pinnedAt: pin.pinnedAt };
  if (!pin.previous) return { current, rewritten: [] };
  try {
    const all = await provider(pin.version);
    return { current, previous: pin.previous, rewritten: all.filter((d) => d.version === pin.version) };
  } catch (e) {
    return { current, previous: pin.previous, rewritten: [], listError: e instanceof Error ? e.message : String(e) };
  }
}

// ── One machine's side of the pin ───────────────────────────────────────────────────────────────

export interface PinServiceDeps {
  stateDir: string;
  /** Downloader / runner overrides for the installer (tests). */
  install?: Partial<InstallDeps>;
  /** Asks a non-managed build its version with `--version`. Defaults to the installer's runner. */
  run?: Run;
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
  /** Called after anything a client would want to re-read (pin, install progress, result). */
  onChange?: () => void;
  now?: () => Date;
  /** The candidate version under evaluation (Phase B2), kept on disk beside the pin. */
  candidateVersion?: () => string | undefined;
  /** Prime the process-wide resolver in ./binary.ts. Off only for tests that run several daemons. */
  primeResolver?: boolean;
  log?: (msg: string) => void;
}

export type SetPinResult = { ok: true; pin: SolidcraftPin } | { ok: false; error: string; failure?: InstallFailure };

interface ResolvedLocal {
  path: string;
  source: SolidcraftSource;
  version?: string;
}

export class SolidcraftPinService {
  readonly store: PinStore;
  private managed: ManagedSolidcraft | undefined;
  private installing: string | undefined;
  private lastError: { version: string; failure: InstallFailure; detail: string } | undefined;
  private readonly probed = new Map<string, string | undefined>();
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: PinServiceDeps) {
    this.store = new PinStore(deps.stateDir);
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((m) => console.log(m));
  }

  /** The pin this machine holds. */
  pin(): SolidcraftPin | undefined {
    return this.store.get();
  }

  /** The managed build this service put in effect, if any. */
  currentManaged(): ManagedSolidcraft | undefined {
    return this.managed;
  }

  /**
   * Daemon start. If a pin is recorded and its version folder is a verified install, that build
   * becomes the daemon's SolidCraft. If the folder is missing (a wiped state dir, a failed install
   * before the restart), the install is retried in the background.
   */
  boot(opts: { retryInstall?: boolean } = {}): void {
    const pin = this.store.get();
    if (!pin) return;
    const have = installedSolidcraft(this.deps.stateDir, pin.version, pin.sha256);
    if (have) this.useManaged({ path: have.path, version: have.version });
    else if (opts.retryInstall ?? true) void this.apply(pin).catch((e) => this.log(`[solidcraft] boot install failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  private useManaged(m: ManagedSolidcraft): void {
    this.managed = m;
    if (this.deps.primeResolver ?? true) setManagedSolidcraftCli(m);
  }

  private install(ref: SolidcraftRef): Promise<InstallResult> {
    return installSolidcraft(this.deps.stateDir, ref, { log: this.log, ...this.deps.install });
  }

  private keepList(pin: SolidcraftPin, extra: readonly string[] = []): (string | undefined)[] {
    return [pin.version, pin.previous?.version, this.deps.candidateVersion?.(), ...extra];
  }

  /** Install a build beside the pinned one without touching the pin (Phase B2's candidate). */
  installBeside(ref: SolidcraftRef): Promise<InstallResult> {
    return this.install(ref);
  }

  /**
   * Member side: take the hub's pin as given, install exactly that build and switch to it. The pin
   * is recorded BEFORE the install, so a machine whose install fails is off the pin (unavailable),
   * never quietly still "on" the old one.
   */
  async apply(pinIn: SolidcraftPin, keep: readonly string[] = []): Promise<SolidcraftMachineStatus> {
    const pin = this.store.replace(pinIn);
    this.installing = pin.version;
    this.deps.onChange?.();
    let result: InstallResult;
    try {
      result = await this.install(pin);
    } finally {
      if (this.installing === pin.version) this.installing = undefined;
    }
    const still = this.store.get();
    if (still && still.version === pin.version && still.sha256 === pin.sha256) {
      if (result.ok) {
        this.useManaged({ path: result.path, version: result.version });
        this.lastError = undefined;
        pruneSolidcraft(this.deps.stateDir, this.keepList(pin, keep.filter(isSolidcraftVersion)));
      } else {
        this.lastError = { version: pin.version, failure: result.reason, detail: result.detail };
      }
    }
    this.deps.onChange?.();
    return this.status();
  }

  /**
   * Hub side: make `ref` the fleet pin. The hub installs and verifies the build FIRST and records
   * the pin only if that passes, so a wrong sha256 or an unsigned zip never becomes the fleet's pin.
   */
  async setPin(ref: SolidcraftRef): Promise<SetPinResult> {
    if (!isSolidcraftVersion(ref.version) || !isSha256(ref.sha256)) return { ok: false, error: "a version like 0.44.1 and its 64-character sha256 are required", failure: "bad-request" };
    const corrupt = this.store.corrupt();
    this.installing = ref.version;
    this.deps.onChange?.();
    let result: InstallResult;
    try {
      result = await this.install(ref);
    } finally {
      if (this.installing === ref.version) this.installing = undefined;
    }
    if (!result.ok) {
      this.deps.onChange?.();
      return { ok: false, error: `SolidCraft ${ref.version} was not pinned: ${result.detail}`, failure: result.reason };
    }
    if (corrupt) this.log(`[solidcraft] replacing an unreadable pin record: ${corrupt}`);
    const pin = this.store.set(ref, this.now());
    this.useManaged({ path: result.path, version: result.version });
    this.lastError = undefined;
    pruneSolidcraft(this.deps.stateDir, this.keepList(pin));
    this.deps.onChange?.();
    return { ok: true, pin };
  }

  /** Hub side: return to `previous`. The build being left becomes the new `previous`. */
  async pinBack(): Promise<SetPinResult> {
    const prev = this.store.get()?.previous;
    if (!prev) return { ok: false, error: "there is no previous pin to go back to" };
    return this.setPin({ version: prev.version, sha256: prev.sha256 });
  }

  private resolved(): ResolvedLocal | undefined {
    const env = this.deps.env ?? process.env;
    const override = env.ANVIL_SOLIDCRAFT_CLI?.trim();
    if (override) return { path: override, source: "env" };
    if (this.managed) return { path: this.managed.path, source: "managed", version: this.managed.version };
    if ((this.deps.exists ?? existsSync)(APP_BUNDLE_SOLIDCRAFT_CLI)) return { path: APP_BUNDLE_SOLIDCRAFT_CLI, source: "app" };
    return undefined;
  }

  /** `--version` of a build the daemon did not install itself (env override, app bundle). */
  private async probe(path: string): Promise<string | undefined> {
    if (this.probed.has(path)) return this.probed.get(path);
    const r = await (this.deps.run ?? this.deps.install?.run ?? spawnRun)([path, "--version"], { env: binaryEnv(this.deps.env ?? process.env), timeoutMs: 30_000 });
    const version = r.code === 0 ? r.stdout.trim().match(/^solidcraft-cli (\d+\.\d+\.\d+)$/)?.[1] : undefined;
    if (version) this.probed.set(path, version); // an unreadable version is asked again next time
    return version;
  }

  /** The build this machine would run now. */
  async local(): Promise<{ version?: string; source?: SolidcraftSource; path?: string }> {
    const r = this.resolved();
    if (!r) return {};
    return { path: r.path, source: r.source, version: r.version ?? (await this.probe(r.path)) };
  }

  /** May CAD run here right now? Track A's `cad.status` and tool refusals read this. */
  async availability(): Promise<{ available: boolean; reason?: string; version?: string; pinned?: string }> {
    const { version } = await this.local();
    const corrupt = this.store.corrupt();
    if (corrupt) return { available: false, reason: `CAD is unavailable here: the SolidCraft pin record cannot be read (${corrupt}). Set the pin again from the hub.`, ...(version ? { version } : {}) };
    const pin = this.store.get();
    const err = this.lastError && pin && this.lastError.version === pin.version ? this.lastError.detail : undefined;
    return { ...pinAvailability(version, pin, err), ...(version ? { version } : {}) };
  }

  async status(): Promise<SolidcraftMachineStatus> {
    const { version, source } = await this.local();
    const pin = this.store.get();
    const avail = await this.availability();
    const err = this.lastError && pin && this.lastError.version === pin.version ? this.lastError : undefined;
    const corrupt = this.store.corrupt();
    const state: SolidcraftMachineStatus["state"] =
      this.installing ? "installing" : corrupt ? "error" : !pin ? "unpinned" : avail.available ? "ready" : "error";
    return {
      state,
      ...(version ? { version } : {}),
      ...(source ? { source } : {}),
      ...(pin ? { pinned: pin.version } : {}),
      available: avail.available,
      ...(avail.reason ? { reason: avail.reason } : {}),
      ...(err ? { error: err.detail, failure: err.failure } : corrupt ? { error: corrupt } : {}),
    };
  }
}
