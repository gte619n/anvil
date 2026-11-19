/**
 * Candidate builds and the hub's side of the replay gate (agent-cad-and-browser spec §4.10, §4.14
 * item 16, B0 evidence "Release listing").
 *
 * Every 4 hours (and on "Check now") the hub lists SolidCraft's releases and takes the NEWEST one
 * that qualifies: a plain `vX.Y.Z` tag, not a prerelease, not a draft, published at least 48 hours
 * ago, newer than the pin, and not previously rejected. Releases ship daily, so "the latest" would
 * never be old enough. It then asks every machine to replay the designs it hosts under both the
 * pinned build and the candidate (./replay.ts) and decides:
 *
 *   - every machine that hosts designs passes → the pin advances (at most once per 24 hours);
 *   - a part differs, or replays under the pin and fails under the candidate → the pin holds, the
 *     candidate is recorded as REJECTED with the per-part differences, one push notification names
 *     the first failing part, and that version is never evaluated again;
 *   - a machine that hosts designs cannot be reached (or cannot replay) → the pin HOLDS and the
 *     machine is named; the same candidate is evaluated again on the next check.
 *
 * The pinned build keeps serving throughout: the candidate is installed beside it, and the pin is
 * moved only by the one `advance` call at the end. An evaluation lives in memory until it is
 * decided, so a hub restart in the middle leaves the pin and the rejected list as they were and the
 * evaluation starts from scratch on the next check.
 *
 * With no pin recorded, "newer than the pin" means newer than the build the hub would run now (if
 * it can tell), and machines compare against that build (see replay.ts for the no-baseline case).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  rest,
  SolidcraftCandidateCheck,
  SolidcraftEvaluation,
  SolidcraftGateMachine,
  SolidcraftPin,
  SolidcraftRejectedCandidate,
  SolidcraftReplayReport,
} from "@protocol";
import { writeFileAtomic } from "../util/atomic";
import { isSha256, isSolidcraftVersion, releaseAssetName, type SolidcraftRef } from "./install";
import { SOLIDCRAFT_RELEASES_API, verifiedReleaseSha, type GithubRelease } from "./release";
import { describeFailure, holdsPin, rejectsCandidate } from "./replay";

export const CHECK_EVERY_MS = 4 * 60 * 60_000;
export const MIN_RELEASE_AGE_MS = 48 * 60 * 60_000;
export const ADVANCE_LIMIT_MS = 24 * 60 * 60_000;
/** After a start, the first check waits at least this long (the daemon is still settling). */
export const FIRST_CHECK_DELAY_MS = 2 * 60_000;
/** A daemon that restarts in the middle of a check does not start another within this long of the last start. */
export const RESTART_CHECK_GAP_MS = 60 * 60_000;
/** A hub install that failed for a passing reason is tried again after 4 h, 8 h, 16 h, then every 24 h. */
export const RETRY_BASE_MS = CHECK_EVERY_MS;
export const RETRY_CAP_MS = 24 * 60 * 60_000;
export const MAX_REJECTED = 50;
export const MAX_REFUSED_NOTIFIED = 500;
export const MAX_REJECTED_FAILURES = 50;
/**
 * Install refusals that are about the BUILD, not the moment: the zip is not the recorded one, or
 * it is not a build signed and notarized by the pinned team. Trying again cannot change them, so
 * the candidate is rejected. Everything else (a failed download, Gatekeeper unavailable, a disk
 * error) may pass, and is retried with a growing wait.
 */
export const VERIFICATION_REFUSALS: readonly string[] = ["sha-mismatch", "bad-zip", "unsafe-zip", "missing-binary", "signature-invalid", "wrong-team", "not-notarized", "version-mismatch"];
export const CANDIDATE_FILE = "solidcraft-candidate.json";

// ── Selection ───────────────────────────────────────────────────────────────────────────────────

const TAG_RE = /^v(\d+\.\d+\.\d+)$/;

/** Numeric compare of two `X.Y.Z` versions: negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Every release, all pages. Throws when GitHub cannot be read (the caller then skips the check). */
export async function fetchReleases(fetchImpl: typeof fetch = fetch, opts: { perPage?: number; maxPages?: number } = {}): Promise<GithubRelease[]> {
  const perPage = opts.perPage ?? 100;
  const all: GithubRelease[] = [];
  for (let page = 1; page <= (opts.maxPages ?? 20); page++) {
    const res = await fetchImpl(`${SOLIDCRAFT_RELEASES_API}?per_page=${perPage}&page=${page}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "anvild" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for the release list`);
    const batch = (await res.json()) as GithubRelease[];
    if (!Array.isArray(batch)) throw new Error("GitHub's release list is not a list");
    all.push(...batch);
    if (batch.length < perPage) break;
  }
  return all;
}

export interface PickOptions {
  now: number;
  /** The pinned version (or the hub's local one when nothing is pinned). Absent ⇒ no lower bound. */
  newerThan?: string;
  rejected?: Iterable<string>;
  minAgeMs?: number;
}

/**
 * The newest release that qualifies, or undefined. "Newest" is by `published_at`, sorted here
 * because the API's order is not reliable. A plain-looking tag is not enough: two real releases
 * (`v0.40.0`, `v0.18.0`) carry plain tags and are prereleases.
 */
export function pickCandidate(releases: readonly GithubRelease[], o: PickOptions): { release: GithubRelease; version: string; publishedAt: string } | undefined {
  const rejected = new Set(o.rejected ?? []);
  const minAge = o.minAgeMs ?? MIN_RELEASE_AGE_MS;
  const ok: { release: GithubRelease; version: string; publishedAt: string; at: number }[] = [];
  for (const release of releases) {
    const version = TAG_RE.exec(release?.tag_name ?? "")?.[1];
    if (!version) continue;
    if (release.prerelease !== false || release.draft !== false) continue;
    const at = release.published_at ? Date.parse(release.published_at) : NaN;
    if (!Number.isFinite(at) || o.now - at < minAge) continue;
    if (o.newerThan && isSolidcraftVersion(o.newerThan) && compareVersions(version, o.newerThan) <= 0) continue;
    if (rejected.has(version)) continue;
    if (!release.assets?.some((a) => a.name === releaseAssetName(version))) continue; // no CLI zip to install
    ok.push({ release, version, publishedAt: release.published_at!, at });
  }
  ok.sort((a, b) => b.at - a.at || compareVersions(b.version, a.version));
  const best = ok[0];
  return best ? { release: best.release, version: best.version, publishedAt: best.publishedAt } : undefined;
}

/** May the pin advance now, given when it last did? At most once per 24 hours. */
export function advanceAllowed(lastAdvanceAt: string | undefined, now: number, limitMs: number = ADVANCE_LIMIT_MS): boolean {
  if (!lastAdvanceAt) return true;
  const at = Date.parse(lastAdvanceAt);
  return !Number.isFinite(at) || now - at >= limitMs;
}

// ── Persisted state ─────────────────────────────────────────────────────────────────────────────

interface CandidateState {
  rejected: SolidcraftRejectedCandidate[];
  lastEvaluation?: SolidcraftEvaluation;
  lastCheck?: SolidcraftCandidateCheck;
  lastAdvanceAt?: string;
  /**
   * Written when an evaluation starts and cleared when a check next completes: only a restart
   * leaves it. While it is there its build is kept on disk, so the retry does not download it again.
   */
  inFlight?: { version: string; startedAt: string };
  /** When the last check STARTED (it may never have finished). Bounds re-checking after restarts. */
  lastCheckStartedAt?: string;
  /** The hub could not install this candidate for a passing reason; when it is tried next. */
  retry?: { version: string; attempts: number; nextAt: string; reason: string };
  /** Whether each member hosted designs the last time it answered. Unknown counts as "may host". */
  hosts: Record<string, boolean>;
  /** Committed designs whose refusal was already notified: `environment|part|sha`. Newest last. */
  refusedNotified?: string[];
}

/** `<stateDir>/solidcraft-candidate.json`. An unreadable file is treated as empty (nothing is unsafe about re-evaluating). */
export class CandidateStore {
  readonly file: string;
  state: CandidateState = { rejected: [], hosts: {} };

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, CANDIDATE_FILE);
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<CandidateState>;
      this.state = {
        rejected: Array.isArray(raw.rejected) ? raw.rejected.filter((r) => r && isSolidcraftVersion(r.version)) : [],
        hosts: raw.hosts && typeof raw.hosts === "object" ? raw.hosts : {},
        ...(raw.lastEvaluation ? { lastEvaluation: raw.lastEvaluation } : {}),
        ...(raw.lastCheck ? { lastCheck: raw.lastCheck } : {}),
        ...(typeof raw.lastAdvanceAt === "string" ? { lastAdvanceAt: raw.lastAdvanceAt } : {}),
        ...(raw.inFlight && isSolidcraftVersion(raw.inFlight.version) ? { inFlight: raw.inFlight } : {}),
        ...(typeof raw.lastCheckStartedAt === "string" ? { lastCheckStartedAt: raw.lastCheckStartedAt } : {}),
        ...(Array.isArray(raw.refusedNotified) ? { refusedNotified: raw.refusedNotified.filter((k) => typeof k === "string").slice(-MAX_REFUSED_NOTIFIED) } : {}),
        ...(raw.retry && isSolidcraftVersion(raw.retry.version) && typeof raw.retry.nextAt === "string" ? { retry: raw.retry } : {}),
      };
    } catch {
      /* start empty */
    }
  }

  save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.state, null, 2));
  }

  isRejected(version: string): boolean {
    return this.state.rejected.some((r) => r.version === version);
  }
}

// ── The hub's gate ──────────────────────────────────────────────────────────────────────────────

export interface GateTarget {
  serverId: string;
  serverName: string;
  url: string;
}
/** Transport to one member for the replay gate. Injected so tests use in-memory fakes. */
export interface MemberReplayClient {
  probe(base: string): Promise<{ reachable: boolean; supported: boolean }>;
  /** POST /api/solidcraft/replay. */
  replay(base: string, req: rest.solidcraft.ReplayRequest): Promise<rest.solidcraft.ReplayResponse>;
}

/** `failure` is the installer's typed reason when the candidate (or the pinned build) could not be installed. */
export type LocalReplay = (candidate: SolidcraftRef, pin?: SolidcraftRef) => Promise<{ ok: true; report: SolidcraftReplayReport } | { ok: false; error: string; failure?: string }>;

export interface CandidateGateDeps {
  stateDir: string;
  self: { serverId: string; serverName: string };
  members: () => GateTarget[];
  client: MemberReplayClient;
  /** The release list. Throwing means "GitHub unreachable": the check is skipped. */
  listReleases: () => Promise<GithubRelease[]>;
  /** The zip's sha256: the asset digest, which must equal the SHA256SUMS.txt line. Throws on doubt. */
  releaseSha?: (release: GithubRelease, version: string) => Promise<string>;
  pin: () => SolidcraftPin | undefined;
  /** The version the hub would run now — the lower bound when nothing is pinned. */
  localVersion?: () => Promise<string | undefined>;
  /** Install the candidate beside the pin on the hub and replay the hub's own designs. */
  replayLocal: LocalReplay;
  /** Move the fleet pin (the B1 coordinator's `setPin`). The ONLY thing that changes the pin. */
  advance: (ref: SolidcraftRef) => Promise<{ ok: boolean; pin?: SolidcraftPin; error?: string }>;
  /** Drop builds that are no longer pinned, previous or candidate (after a rejection). */
  prune?: () => void;
  /** One push notification: (title, body, tag). */
  notify?: (title: string, body: string, tag: string) => void;
  onChange?: () => void;
  /** Should the TIMER check now? Only the fleet's hub looks for candidates by itself. Default: yes. */
  timerEnabled?: () => boolean;
  now?: () => number;
  log?: (m: string) => void;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class CandidateGate {
  readonly store: CandidateStore;
  private running: Promise<SolidcraftCandidateCheck> | null = null;
  private evaluating: { ref: SolidcraftRef; startedAt: string } | undefined;
  private interrupted: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private firstTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(private readonly deps: CandidateGateDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? (() => {});
    this.store = new CandidateStore(deps.stateDir);
    const cut = this.store.state.inFlight;
    if (cut) {
      // The process stopped in the middle of an evaluation. Nothing was decided, so no result is
      // kept. The marker stays until the next check completes, so the build already downloaded for
      // it is not pruned in the meantime (see `candidateVersion`).
      this.interrupted = `The evaluation of SolidCraft ${cut.version} that started ${cut.startedAt} was cut short by a restart. It starts again from scratch on the next check.`;
      this.log(`[solidcraft] ${this.interrupted}`);
    }
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /**
   * The version to keep on disk beside the pin: the one being evaluated, or the last one that was
   * held undecided (it is evaluated again on the next check, so re-downloading it would be waste).
   */
  candidateVersion(): string | undefined {
    if (this.evaluating) return this.evaluating.ref.version;
    const s = this.store.state;
    if (s.inFlight) return s.inFlight.version; // interrupted by a restart: evaluated again next
    const last = s.lastEvaluation;
    if (last && (last.result === "held" || last.result === "error") && !last.advancedAnyway) return last.candidate.version;
    return undefined;
  }

  /**
   * When the first check after a start is due: 4 hours after the last one FINISHED, never sooner
   * than 2 minutes from now — and, when a check was started and never finished (the daemon went
   * down in the middle), not within an hour of that start. Without the last rule a daemon that
   * restarts every few minutes would begin a full evaluation after every start.
   */
  firstCheckDelay(everyMs: number = CHECK_EVERY_MS): number {
    const s = this.store.state;
    const finished = Date.parse(s.lastCheck?.at ?? "");
    const started = Date.parse(s.lastCheckStartedAt ?? "");
    let due = Number.isFinite(finished) ? finished + everyMs : 0;
    if (Number.isFinite(started) && !(Number.isFinite(finished) && finished >= started)) due = Math.max(due, started + RESTART_CHECK_GAP_MS);
    return Math.min(everyMs, Math.max(FIRST_CHECK_DELAY_MS, due - this.now()));
  }

  /**
   * Run a check every `everyMs` (4 hours), and once soon after a start so that a daemon which
   * restarts more often than every 4 hours still checks. The timers are injectable for tests.
   */
  start(
    everyMs: number = CHECK_EVERY_MS,
    set: (fn: () => void, ms: number) => ReturnType<typeof setInterval> = setInterval,
    setOnce: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
  ): void {
    this.stop();
    if (everyMs <= 0) return;
    const tick = (): void => {
      if (this.deps.timerEnabled && !this.deps.timerEnabled()) return;
      void this.check().catch((e) => this.log(`[solidcraft] candidate check failed: ${errText(e)}`));
    };
    this.timer = set(tick, everyMs);
    this.firstTimer = setOnce(tick, this.firstCheckDelay(everyMs));
    for (const t of [this.timer, this.firstTimer]) (t as { unref?: () => void })?.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.timer = undefined;
    this.firstTimer = undefined;
  }

  status(): rest.solidcraft.CandidateStatusResponse {
    const s = this.store.state;
    const next = s.lastAdvanceAt && !advanceAllowed(s.lastAdvanceAt, this.now()) ? new Date(Date.parse(s.lastAdvanceAt) + ADVANCE_LIMIT_MS).toISOString() : undefined;
    return structuredClone({
      ok: true,
      ...(this.evaluating ? { evaluating: { version: this.evaluating.ref.version, startedAt: this.evaluating.startedAt } } : {}),
      ...(s.lastCheck ? { lastCheck: s.lastCheck } : {}),
      ...(s.lastEvaluation ? { lastEvaluation: s.lastEvaluation } : {}),
      rejected: s.rejected,
      ...(s.lastAdvanceAt ? { lastAdvanceAt: s.lastAdvanceAt } : {}),
      ...(next ? { nextAdvanceAllowedAt: next } : {}),
      ...(this.interrupted ? { interrupted: this.interrupted } : {}),
      ...(s.retry ? { retry: s.retry } : {}),
    });
  }

  /** One check: list, pick, evaluate, decide. A second call while one runs joins the first. */
  check(): Promise<SolidcraftCandidateCheck> {
    if (this.running) return this.running;
    this.store.state.lastCheckStartedAt = this.iso();
    this.store.save();
    const p = this.doCheck()
      .catch((e): SolidcraftCandidateCheck => ({ at: this.iso(), outcome: "error", detail: `the check failed: ${errText(e)}` }))
      .then((check) => {
        this.store.state.lastCheck = check;
        delete this.store.state.inFlight;
        this.evaluating = undefined;
        this.store.save();
        this.running = null;
        this.deps.onChange?.();
        return check;
      });
    this.running = p;
    return p;
  }

  private async doCheck(): Promise<SolidcraftCandidateCheck> {
    const at = this.iso();
    const s = this.store.state;
    if (!advanceAllowed(s.lastAdvanceAt, this.now())) {
      return { at, outcome: "rate-limited", detail: `The pin advanced at ${s.lastAdvanceAt}. It moves at most once in 24 hours, so nothing is evaluated until then.` };
    }
    let releases: GithubRelease[];
    try {
      releases = await this.deps.listReleases();
    } catch (e) {
      return { at, outcome: "skipped", detail: `GitHub could not be read (${errText(e)}). The pin is unchanged.` };
    }
    const pin = this.deps.pin();
    const floor = pin?.version ?? (await this.deps.localVersion?.().catch(() => undefined));
    const pick = pickCandidate(releases, { now: this.now(), newerThan: floor, rejected: s.rejected.map((r) => r.version) });
    if (s.retry && s.retry.version !== pick?.version) delete s.retry; // another candidate (or none) now
    if (pick && s.retry && this.now() < Date.parse(s.retry.nextAt)) {
      return { at, outcome: "backoff", version: pick.version, detail: `SolidCraft ${pick.version} could not be installed on the hub (${s.retry.reason}); attempt ${s.retry.attempts} failed. It is tried again after ${s.retry.nextAt}.` };
    }
    if (!pick) return { at, outcome: "none", detail: `No release qualifies: it must be a full release, at least 48 hours old, newer than ${floor ?? "the current build"} and not already rejected.` };
    let sha256: string;
    try {
      sha256 = await (this.deps.releaseSha ?? ((r, v) => verifiedReleaseSha(r, v)))(pick.release, pick.version);
      if (!isSha256(sha256)) throw new Error("the release carries no usable sha256");
    } catch (e) {
      return { at, outcome: "error", version: pick.version, detail: `SolidCraft ${pick.version} was not evaluated: ${errText(e)}. The pin is unchanged.` };
    }
    this.interrupted = undefined;
    const evaluation = await this.evaluate({ version: pick.version, sha256 }, pin);
    return { at: evaluation.finishedAt, outcome: evaluation.result, version: pick.version, detail: evaluation.detail };
  }

  /** Ask every machine, then decide. The pin is touched only by the single `advance` at the end. */
  private async evaluate(ref: SolidcraftRef, pin: SolidcraftPin | undefined): Promise<SolidcraftEvaluation> {
    const s = this.store.state;
    const startedAt = this.iso();
    this.evaluating = { ref, startedAt };
    s.inFlight = { version: ref.version, startedAt };
    this.store.save();
    this.deps.onChange?.();
    const pinRef = pin ? { version: pin.version, sha256: pin.sha256 } : undefined;
    const machines: SolidcraftGateMachine[] = [];
    const finish = (result: SolidcraftEvaluation["result"], detail: string): SolidcraftEvaluation => {
      const evaluation: SolidcraftEvaluation = {
        candidate: { version: ref.version, sha256: ref.sha256 },
        ...(pin ? { baseline: pin.version } : {}),
        startedAt,
        finishedAt: this.iso(),
        result,
        detail,
        machines: machines.sort((a, b) => Number(b.isHub) - Number(a.isHub) || a.serverName.localeCompare(b.serverName) || a.serverId.localeCompare(b.serverId)),
      };
      s.lastEvaluation = evaluation;
      return evaluation;
    };
    /** Record the candidate as rejected for good: never evaluated again, one notification. */
    const reject = (reason: string, failures: SolidcraftRejectedCandidate["failures"]): SolidcraftEvaluation => {
      s.rejected.push({
        version: ref.version,
        sha256: ref.sha256,
        rejectedAt: this.iso(),
        reason,
        failures: failures.slice(0, MAX_REJECTED_FAILURES),
        ...(failures.length > MAX_REJECTED_FAILURES ? { failuresTruncated: true } : {}),
      });
      if (s.rejected.length > MAX_REJECTED) s.rejected = s.rejected.slice(-MAX_REJECTED); // the newest
      delete s.retry;
      this.deps.notify?.(
        `SolidCraft ${ref.version} was not adopted`,
        `${reason}. The fleet stays on ${pin?.version ?? "its current build"}; ${ref.version} will not be tried again.`,
        `solidcraft-candidate-${ref.version}`,
      );
      this.deps.prune?.();
      return finish("rejected", `SolidCraft ${ref.version} was rejected: ${reason}. The pin is unchanged.`);
    };
    const fromReport = (base: Pick<SolidcraftGateMachine, "serverId" | "serverName" | "isHub">, report: SolidcraftReplayReport): SolidcraftGateMachine => {
      // FIRST: with a pin, a machine that hosts designs must have compared against exactly the
      // pinned build. One that compared against something else (or nothing) has not compared at
      // all, so nothing in its report — not even a difference — is a verdict on the candidate.
      if (pin && report.hostsDesigns && report.baseline !== pin.version) {
        return { ...base, state: "held", holds: true, detail: `it compared against ${report.baseline ? `SolidCraft ${report.baseline}` : "no build"}, not the pinned ${pin.version}`, report };
      }
      // A replay that ran and differed (or ran and failed) rejects the candidate.
      const rejecting = report.parts.filter(rejectsCandidate);
      if (rejecting.length) return { ...base, state: "fail", holds: true, detail: describeFailure(rejecting[0]!), report };
      // Anything the machine could not vouch for holds the pin without condemning the candidate.
      if (report.errors?.length) return { ...base, state: "held", holds: true, detail: report.errors[0], report };
      const holding = report.parts.filter(holdsPin);
      if (holding.length) return { ...base, state: "held", holds: true, detail: describeFailure(holding[0]!), report };
      return { ...base, state: report.hostsDesigns ? "pass" : "no-designs", holds: false, report };
    };
    /**
     * A committed design the screen refused holds the pin whatever the candidate is, and would do
     * so silently for ever. Tell the owner ONCE per version of the file (environment, part and the
     * file's sha256), naming the design and why.
     */
    const notifyRefused = (): void => {
      const known = new Set(s.refusedNotified ?? []);
      for (const m of machines) {
        for (const p of m.report?.parts ?? []) {
          if (p.outcome !== "refused") continue;
          const key = `${p.environment}|${p.part}|${p.sha ?? p.error ?? ""}`.slice(0, 400);
          if (known.has(key)) continue;
          known.add(key);
          (s.refusedNotified ??= []).push(key);
          this.deps.notify?.(
            `Design ${p.part} is not replayed`,
            `${p.part} (${p.environment}, on ${m.serverName}) was refused by the design-script check: ${p.error ?? "no detail"}. SolidCraft updates are held until it is fixed.`,
            `solidcraft-refused-${p.environment}-${p.part}`.slice(0, 120),
          );
        }
      }
      if (s.refusedNotified && s.refusedNotified.length > MAX_REFUSED_NOTIFIED) s.refusedNotified = s.refusedNotified.slice(-MAX_REFUSED_NOTIFIED);
    };

    // The hub first: its install is the proof that the candidate is a real, verified build.
    const hubBase = { serverId: this.deps.self.serverId, serverName: this.deps.self.serverName, isHub: true };
    const own = await this.deps.replayLocal(ref, pinRef).catch((e): { ok: false; error: string; failure?: string } => ({ ok: false, error: errText(e) }));
    if (!own.ok) {
      machines.push({ ...hubBase, state: "error", holds: true, detail: own.error });
      if (own.failure && VERIFICATION_REFUSALS.includes(own.failure)) {
        // Not this build, or not a build we may run: trying again cannot change that.
        return reject(`the hub refused to install it (${own.error})`, []);
      }
      // A passing failure. Try again later, each time after a longer wait, so that a release whose
      // download keeps failing is not fetched every four hours for ever.
      const attempts = (s.retry?.version === ref.version ? s.retry.attempts : 0) + 1;
      const wait = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
      s.retry = { version: ref.version, attempts, nextAt: new Date(this.now() + wait).toISOString(), reason: own.error.slice(0, 300) };
      return finish("error", `SolidCraft ${ref.version} could not be evaluated on the hub: ${own.error}. The pin is unchanged. Attempt ${attempts}; it is tried again after ${s.retry.nextAt}.`);
    }
    delete s.retry;
    machines.push(fromReport(hubBase, own.report));

    await Promise.all(
      this.deps.members().map(async (m) => {
        const base = { serverId: m.serverId, serverName: m.serverName, isHub: false };
        const probe = await this.deps.client.probe(m.url).catch(() => ({ reachable: false, supported: false }));
        if (!probe.reachable) {
          // A machine that hosted no designs when it last answered cannot be hiding a difference.
          const mayHost = s.hosts[m.serverId] !== false;
          machines.push({ ...base, state: "unreachable", holds: mayHost, detail: mayHost ? "unreachable — it hosts (or may host) designs, so the pin holds" : "unreachable — it hosted no designs when last asked" });
          return;
        }
        if (!probe.supported) {
          machines.push({ ...base, state: "unsupported", holds: false, detail: "this machine does not have the SolidCraft pin switched on, so it takes no part" });
          return;
        }
        const r = await this.deps.client.replay(m.url, { candidate: ref, ...(pinRef ? { pin: pinRef } : {}) }).catch((e): rest.solidcraft.ReplayResponse => ({ ok: false, error: errText(e) }));
        if (!r.ok || !r.report) {
          machines.push({ ...base, state: "error", holds: true, detail: r.error ?? "the replay did not report" });
          return;
        }
        // Only a clean read says whether it hosts designs: a failed read must not record "none".
        if (!r.report.errors?.length) s.hosts[m.serverId] = r.report.hostsDesigns;
        machines.push(fromReport(base, r.report));
      }),
    );

    notifyRefused();
    const failed = machines.filter((m) => m.state === "fail");
    if (failed.length) {
      const failures = failed.flatMap((m) => (m.report?.parts ?? []).filter(rejectsCandidate).map((p) => ({ ...p, serverName: m.serverName })));
      const first = failures[0]!;
      return reject(`${describeFailure(first)} (${first.environment}, on ${first.serverName})`, failures);
    }
    const holding = machines.filter((m) => m.holds);
    if (holding.length) {
      const names = holding.map((m) => `${m.serverName} (${m.state === "unreachable" ? "unreachable" : m.detail ?? m.state})`).join(", ");
      return finish("held", `SolidCraft ${ref.version} is held: ${names}. The pin is unchanged; it is evaluated again on the next check.`);
    }
    // Everything passed. The pin must still be the one the replays compared against.
    const nowPin = this.deps.pin();
    if ((nowPin?.version ?? "") !== (pin?.version ?? "") || (nowPin?.sha256 ?? "") !== (pin?.sha256 ?? "")) {
      return finish("held", `The pin changed while SolidCraft ${ref.version} was being evaluated, so the result no longer applies. It is evaluated again on the next check.`);
    }
    const moved = await this.deps.advance(ref).catch((e) => ({ ok: false, error: errText(e) }));
    if (!moved.ok) return finish("error", `SolidCraft ${ref.version} passed on every machine but the pin could not be moved: ${moved.error ?? "unknown error"}.`);
    s.lastAdvanceAt = this.iso();
    const hosting = machines.filter((m) => m.state === "pass").length;
    return finish("advanced", `SolidCraft ${ref.version} replayed every design identically on ${hosting} machine${hosting === 1 ? "" : "s"} that host${hosting === 1 ? "s" : ""} designs. The pin advanced${pin ? ` from ${pin.version}` : ""}.`);
  }

  /**
   * "Advance anyway": pin a candidate the gate held or rejected. The caller has shown the owner
   * its differences (they are in `status()`). Not subject to the 24-hour limit — that limit is on
   * unattended advances — but it does start the 24 hours again.
   */
  async advanceAnyway(versionIn: string): Promise<rest.solidcraft.AdvanceAnywayResponse> {
    const version = String(versionIn ?? "").trim().replace(/^v/, "");
    const refuse = (error: string): rest.solidcraft.AdvanceAnywayResponse => ({ ...this.status(), ok: false, error });
    if (this.running) return refuse("a candidate check is running; try again when it has finished");
    const s = this.store.state;
    const last = s.lastEvaluation && s.lastEvaluation.candidate.version === version && s.lastEvaluation.result !== "advanced" ? s.lastEvaluation.candidate : undefined;
    const rejected = s.rejected.find((r) => r.version === version);
    const ref = last ?? rejected;
    if (!ref) return refuse(`SolidCraft ${version || "(no version)"} is not a held or rejected candidate`);
    const pin = this.deps.pin();
    if (pin && compareVersions(version, pin.version) <= 0) return refuse(`SolidCraft ${version} is not newer than the pin (${pin.version})`);
    const moved = await this.deps.advance({ version: ref.version, sha256: ref.sha256 }).catch((e) => ({ ok: false, error: errText(e) }) as { ok: boolean; pin?: SolidcraftPin; error?: string });
    if (!moved.ok) return refuse(moved.error ?? "the pin was not changed");
    s.lastAdvanceAt = this.iso();
    delete s.retry;
    if (s.lastEvaluation?.candidate.version === version) s.lastEvaluation.advancedAnyway = s.lastAdvanceAt;
    this.store.save();
    this.deps.onChange?.();
    return { ...this.status(), ok: true, ...(moved.pin ? { pin: moved.pin } : {}) };
  }
}
