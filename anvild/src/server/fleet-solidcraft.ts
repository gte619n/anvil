/**
 * Hub-orchestrated SolidCraft pin (agent-cad-and-browser spec §4.10), shaped like the Claude CLI
 * fan-out in fleet-cli-rollout.ts: the hub resolves ONE `{ version, sha256 }` pair and every
 * reachable member installs exactly that pair, reporting `ready` or an error.
 *
 * Two differences from the CLI rollout, both deliberate:
 *   - The hub installs FIRST, not last. Its install is the proof that the pair is real (the sha256
 *     matches, the build is signed by the pinned team and notarized). Only then is the pin recorded
 *     and sent out, so a bad pair never takes CAD away from the whole fleet.
 *   - The pin is a standing rule, not a one-off action. A member that was offline is brought to the
 *     pin later by `reconcile()`, which the daemon runs on a timer.
 *
 * Everything that touches the network or the local machine is injected, so the orchestration is
 * unit-testable. `mountSolidcraft` wires the real pieces into the daemon's route table.
 */
import type { rest, SolidcraftMachineStatus, SolidcraftPin, SolidcraftStatusEvent } from "@protocol";
import { PROTOCOL_VERSION } from "@protocol";
import { featureEnabled } from "../config";
import { CHECK_EVERY_MS, CandidateGate, fetchReleases, type LocalReplay, type MemberReplayClient } from "../solidcraft/candidate";
import type { InstallDeps, Run, SolidcraftRef } from "../solidcraft/install";
import { installedSolidcraft, isSha256, isSolidcraftVersion, pruneSolidcraft } from "../solidcraft/install";
import { SolidcraftPinService, parsePin, pinBackWarning, type RewrittenDesignsProvider, type SetPinResult } from "../solidcraft/pin";
import { resolveReleaseRef, type GithubRelease } from "../solidcraft/release";
import { replayMachine, type ReplayBuild, type ReplayEnvironment, type WorktreeProvider } from "../solidcraft/replay";

export const SOLIDCRAFT_PIN_CAPABILITY = "solidcraft-pin";

/** The subset of a fleet member the coordinator needs. */
export interface SolidcraftTarget {
  serverId: string;
  serverName: string;
  url: string; // base, e.g. "https://host:7701/"
}

/** Transport to one member's SolidCraft REST surface. Injected so tests use in-memory fakes. */
export interface MemberSolidcraftClient {
  /** Reachability + whether the member advertises the "solidcraft-pin" capability. */
  probe(base: string): Promise<{ reachable: boolean; supported: boolean }>;
  /** POST /api/solidcraft/pin/apply. */
  apply(base: string, pin: SolidcraftPin, keep: string[]): Promise<{ ok: boolean; local?: SolidcraftMachineStatus; error?: string }>;
  /** GET /api/solidcraft/status. */
  status(base: string): Promise<{ ok: boolean; pin?: SolidcraftPin; local?: SolidcraftMachineStatus; error?: string }>;
}

/** The hub's own machine: the part of `SolidcraftPinService` the coordinator drives. */
export interface LocalSolidcraft {
  pin(): SolidcraftPin | undefined;
  setPin(ref: SolidcraftRef): Promise<SetPinResult>;
  pinBack(): Promise<SetPinResult>;
  status(): Promise<SolidcraftMachineStatus>;
}

export interface FleetSolidcraftDeps {
  self: { serverId: string; serverName: string };
  members: () => SolidcraftTarget[];
  local: LocalSolidcraft;
  client: MemberSolidcraftClient;
  /** Look up the sha256 for a version when the request carries none (GitHub release metadata). */
  resolveRef: (version: string) => Promise<SolidcraftRef>;
  /** Designs the newer build already rewrote — the "Pin back" warning list. Absent ⇒ the list is
   *  reported as not available (never as empty). */
  rewrittenDesigns?: RewrittenDesignsProvider;
  /** Extra versions members keep on disk (the candidate under evaluation, Phase B2). */
  keepVersions?: () => string[];
  now?: () => number;
  log?: (m: string) => void;
}

type Member = rest.solidcraft.Member;

function memberFromLocal(base: Pick<Member, "serverId" | "serverName" | "isHub">, local: SolidcraftMachineStatus): Member {
  return {
    ...base,
    state: local.state,
    ...(local.version ? { version: local.version } : {}),
    ...(local.source ? { source: local.source } : {}),
    ...(local.pinned ? { pinned: local.pinned } : {}),
    available: local.available,
    ...(local.error || local.reason ? { detail: local.error ?? local.reason } : {}),
  };
}

export class FleetSolidcraftCoordinator {
  private active = false;
  private startedAt: number | undefined;
  private finishedAt: number | undefined;
  private rows = new Map<string, Member>();
  private running: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(private readonly deps: FleetSolidcraftDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? (() => {});
  }

  /** Set the fleet pin: resolve the pair, prove it on the hub, record it, then fan out. */
  async setPin(req: rest.solidcraft.SetPinRequest): Promise<rest.solidcraft.SetPinResponse> {
    const version = String(req.version ?? "").trim().replace(/^v/, "");
    if (!isSolidcraftVersion(version)) return this.refuse("a version like 0.44.1 is required");
    const given = req.sha256?.trim().toLowerCase();
    if (given !== undefined && given !== "" && !isSha256(given)) return this.refuse("sha256 must be 64 hexadecimal characters");
    if (this.active) return this.refuse("a SolidCraft pin change is already in progress");
    this.active = true; // claimed before the first await, so two requests cannot both proceed
    let ref: SolidcraftRef;
    try {
      ref = given ? { version, sha256: given } : await this.deps.resolveRef(version);
    } catch (e) {
      this.active = false;
      return this.refuse(`could not look up SolidCraft ${version}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return this.change(() => this.deps.local.setPin(ref));
  }

  /** What "Pin back" would do, with the designs it puts at risk. Changes nothing. */
  async pinBackPreview(): Promise<rest.solidcraft.PinBackPreviewResponse> {
    const w = await pinBackWarning(this.deps.local.pin(), this.deps.rewrittenDesigns);
    if (!w.previous) return { ok: false, ...(w.current ? { current: w.current } : {}), rewritten: [], error: "there is no previous pin to go back to" };
    return { ok: true, current: w.current, previous: w.previous, rewritten: w.rewritten, ...(w.listError ? { listError: w.listError } : {}), ...(w.listUnavailable ? { listUnavailable: true } : {}) };
  }

  /** Pin back to `previous`, returning the warning list gathered BEFORE the change. Nothing is rewritten. */
  async pinBack(): Promise<rest.solidcraft.PinBackResponse> {
    const w = await pinBackWarning(this.deps.local.pin(), this.deps.rewrittenDesigns);
    const warn = { rewritten: w.rewritten, ...(w.listError ? { listError: w.listError } : {}), ...(w.listUnavailable ? { listUnavailable: true } : {}) };
    if (!w.previous) return { ...this.refuse("there is no previous pin to go back to"), ...warn };
    if (this.active) return { ...this.refuse("a SolidCraft pin change is already in progress"), ...warn };
    this.active = true;
    return { ...(await this.change(() => this.deps.local.pinBack())), ...warn };
  }

  private refuse(error: string, failure?: string): rest.solidcraft.SetPinResponse {
    const pin = this.deps.local.pin();
    return { ok: false, ...(pin ? { pin } : {}), members: this.snapshot(), error, ...(failure ? { failure } : {}) };
  }

  /** Hub first; on success, fan out in the background. `active` is already claimed by the caller. */
  private async change(onHub: () => Promise<SetPinResult>): Promise<rest.solidcraft.SetPinResponse> {
    this.startedAt = this.now();
    this.finishedAt = undefined;
    let r: SetPinResult;
    try {
      r = await onHub();
    } catch (e) {
      r = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!r.ok) {
      this.active = false;
      this.finishedAt = this.now();
      return this.refuse(r.error, r.failure);
    }
    const pin = r.pin;
    this.rows = new Map();
    for (const m of this.deps.members()) this.rows.set(m.serverId, { serverId: m.serverId, serverName: m.serverName, isHub: false, state: "pending" });
    await this.refreshHubRow();
    this.running = this.fanOut(pin).catch((e) => this.log(`[solidcraft] fan-out failed: ${e instanceof Error ? e.message : String(e)}`));
    return { ok: true, pin, members: this.snapshot() };
  }

  /** Await the in-flight fan-out (tests, and callers that want to block until the fleet settles). */
  async settled(): Promise<void> {
    await this.running;
  }

  private async fanOut(pin: SolidcraftPin): Promise<void> {
    try {
      await Promise.all(this.deps.members().map((m) => this.applyMember(m, pin)));
    } finally {
      // ALWAYS release the lock, or a later change is wedged "already in progress" until a restart.
      this.active = false;
      this.finishedAt = this.now();
    }
  }

  /** Drive one member to a terminal state (ready / error / unsupported / pending-offline). */
  private async applyMember(m: SolidcraftTarget, pin: SolidcraftPin): Promise<void> {
    const base = { serverId: m.serverId, serverName: m.serverName, isHub: false };
    const probe = await this.deps.client.probe(m.url).catch(() => ({ reachable: false, supported: false }));
    if (!probe.reachable) {
      this.rows.set(m.serverId, { ...base, state: "pending-offline", detail: "unreachable — the pin is applied when it is back" });
      return;
    }
    if (!probe.supported) {
      this.rows.set(m.serverId, { ...base, state: "unsupported", detail: "this machine does not have the SolidCraft pin switched on (ANVIL_FEATURES=solidcraft-pin)" });
      return;
    }
    this.rows.set(m.serverId, { ...base, state: "installing", pinned: pin.version });
    const r = await this.deps.client
      .apply(m.url, pin, this.deps.keepVersions?.() ?? [])
      .catch((e): { ok: boolean; local?: SolidcraftMachineStatus; error?: string } => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    if (r.local) {
      const row = memberFromLocal(base, r.local);
      // A member that answered but is not on the pin is an error whatever state it reports.
      this.rows.set(m.serverId, r.ok && r.local.state === "ready" ? row : { ...row, state: "error", detail: row.detail ?? r.error ?? "not on the pinned version" });
    } else {
      this.rows.set(m.serverId, { ...base, state: "error", pinned: pin.version, detail: r.error ?? "apply rejected" });
    }
  }

  private async refreshHubRow(): Promise<void> {
    const local = await this.deps.local.status();
    this.rows.set(this.deps.self.serverId, memberFromLocal({ serverId: this.deps.self.serverId, serverName: this.deps.self.serverName, isHub: true }, local));
  }

  /** Ask every member where it stands now (the Settings card's table). Does not change anything. */
  async refresh(): Promise<void> {
    await this.refreshHubRow();
    if (this.active) return; // a fan-out owns the member rows until it settles
    const live = new Set(this.deps.members().map((m) => m.serverId));
    for (const id of [...this.rows.keys()]) if (id !== this.deps.self.serverId && !live.has(id)) this.rows.delete(id);
    await Promise.all(
      this.deps.members().map(async (m) => {
        const base = { serverId: m.serverId, serverName: m.serverName, isHub: false };
        const probe = await this.deps.client.probe(m.url).catch(() => ({ reachable: false, supported: false }));
        if (this.active) return;
        if (!probe.reachable) return void this.rows.set(m.serverId, { ...base, state: "pending-offline", detail: "unreachable" });
        if (!probe.supported) return void this.rows.set(m.serverId, { ...base, state: "unsupported", detail: "this machine does not have the SolidCraft pin switched on (ANVIL_FEATURES=solidcraft-pin)" });
        const s = await this.deps.client.status(m.url).catch((e) => ({ ok: false, local: undefined, error: e instanceof Error ? e.message : String(e) }));
        if (this.active) return;
        if (!s.ok || !s.local) return void this.rows.set(m.serverId, { ...base, state: "error", detail: s.error ?? "no status" });
        this.rows.set(m.serverId, memberFromLocal(base, s.local));
      }),
    );
  }

  /**
   * Bring stragglers to the pin: every reachable member that is not `ready` on the pinned version
   * (it was offline at fan-out, or its install failed) is sent the pin again. Returns the members
   * it re-applied to.
   */
  async reconcile(): Promise<string[]> {
    const pin = this.deps.local.pin();
    if (!pin || this.active) return [];
    await this.refresh();
    if (this.active) return [];
    const behind = this.deps.members().filter((m) => {
      const row = this.rows.get(m.serverId);
      return !!row && row.state !== "pending-offline" && row.state !== "unsupported" && !(row.state === "ready" && row.pinned === pin.version && row.version === pin.version);
    });
    if (behind.length === 0) return [];
    this.active = true;
    this.startedAt = this.now();
    this.finishedAt = undefined;
    try {
      await Promise.all(behind.map((m) => this.applyMember(m, pin)));
    } finally {
      this.active = false;
      this.finishedAt = this.now();
    }
    return behind.map((m) => m.serverId);
  }

  status(): rest.solidcraft.FleetStatusResponse {
    const pin = this.deps.local.pin();
    return {
      ok: true,
      active: this.active,
      ...(pin ? { pin } : {}),
      ...(this.startedAt !== undefined ? { startedAt: this.startedAt } : {}),
      ...(this.finishedAt !== undefined ? { finishedAt: this.finishedAt } : {}),
      members: this.snapshot(),
    };
  }

  private snapshot(): Member[] {
    return [...this.rows.values()].sort((a, b) => Number(b.isHub) - Number(a.isHub) || a.serverName.localeCompare(b.serverName)); // hub first
  }
}

/** The real HTTP transport to a member. Short probe timeout; the apply downloads and verifies ~160 MB. */
export function httpMemberSolidcraftClient(fetchImpl: typeof fetch = fetch): MemberSolidcraftClient & MemberReplayClient {
  const trim = (base: string) => base.replace(/\/+$/, "");
  const timeout = (ms: number) => AbortSignal.timeout(ms);
  return {
    async probe(base) {
      try {
        const r = await fetchImpl(`${trim(base)}/api/health`, { signal: timeout(5_000) });
        if (!r.ok) return { reachable: false, supported: false };
        const h = (await r.json()) as rest.HealthResponse;
        return { reachable: true, supported: !!h.capabilities?.includes(SOLIDCRAFT_PIN_CAPABILITY) };
      } catch {
        return { reachable: false, supported: false };
      }
    },
    async apply(base, pin, keep) {
      try {
        const r = await fetchImpl(`${trim(base)}/api/solidcraft/pin/apply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin, keep } satisfies rest.solidcraft.ApplyRequest),
          signal: timeout(20 * 60_000),
        });
        const j = (await r.json().catch(() => ({}))) as Partial<rest.solidcraft.ApplyResponse>;
        return { ok: !!j.ok, local: j.local, error: j.error ?? (r.ok ? undefined : `member answered ${r.status}`) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    async replay(base, req) {
      // Long: the member may download and verify the candidate, then replays every design twice.
      try {
        const r = await fetchImpl(`${trim(base)}/api/solidcraft/replay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req satisfies rest.solidcraft.ReplayRequest),
          signal: timeout(60 * 60_000),
        });
        const j = (await r.json().catch(() => ({}))) as Partial<rest.solidcraft.ReplayResponse>;
        return { ok: !!j.ok && !!j.report, ...(j.report ? { report: j.report } : {}), ...(j.error || !r.ok ? { error: j.error ?? `member answered ${r.status}` } : {}) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    async status(base) {
      try {
        const r = await fetchImpl(`${trim(base)}/api/solidcraft/status`, { signal: timeout(10_000) });
        const j = (await r.json().catch(() => ({}))) as Partial<rest.solidcraft.StatusResponse>;
        return { ok: !!j.ok, pin: j.pin, local: j.local, error: j.error ?? (r.ok ? undefined : `member answered ${r.status}`) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

// ── Daemon wiring ───────────────────────────────────────────────────────────────────────────────

/** Test-only overrides for the pieces that reach outside the daemon (`ServerOptions.solidcraft`). */
export interface SolidcraftTestHooks {
  install?: Partial<InstallDeps>;
  resolveRef?: (version: string) => Promise<SolidcraftRef>;
  rewrittenDesigns?: RewrittenDesignsProvider;
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
  primeResolver?: boolean;
  /** How often the hub re-applies the pin to stragglers. 0 disables the timer. */
  reconcileMs?: number;
  // ── Replay gate (Phase B2) ──
  /** The clock the candidate gate reads (release age, the 24-hour limit). */
  now?: () => number;
  /** The release list, instead of GitHub. Throwing simulates GitHub being unreachable. */
  listReleases?: () => Promise<GithubRelease[]>;
  /** The zip sha256 for a listed release, instead of digest + SHA256SUMS.txt over the network. */
  releaseSha?: (release: GithubRelease, version: string) => Promise<string>;
  /** Receives the gate's push notification instead of the device registries. */
  notify?: (title: string, body: string, tag: string) => void;
  /** How often the hub checks for a candidate. 0 disables the timer. */
  checkEveryMs?: number;
  environments?: () => ReplayEnvironment[];
  worktrees?: WorktreeProvider;
  replay?: { timeoutMs?: number; concurrency?: number; run?: Run };
}

type Trust = { trust: string; reject?: string };
interface RouteCtx {
  callerIdentity: () => Promise<Trust>;
  localNoIdentityCaller: boolean;
}
type Handler = (req: Request, url: URL, m: RegExpExecArray | null, ctx: RouteCtx) => Promise<Response | undefined> | Response | undefined;

export interface MountSolidcraftOptions {
  stateDir: string;
  features?: readonly string[];
  hooks?: SolidcraftTestHooks;
  self: { serverId: string; serverName: string };
  members: () => SolidcraftTarget[];
  /**
   * PRODUCTION option, supplied by Track A's design store: the designs whose `measured.solidcraft`
   * is the given (newer) version — the "Pin back" warning list. Until it is passed, the card says
   * the list is not available yet; a provider that returns [] means "none are rewritten".
   */
  rewrittenDesigns?: RewrittenDesignsProvider;
  /** The environments this daemon hosts: their default branches are what the replay gate replays. */
  environments?: () => ReplayEnvironment[];
  /** Open session worktrees, replayed as advisory (listed, never holding the pin). */
  worktrees?: WorktreeProvider;
  /** One operational push notification to every registered device: (title, body, tag). */
  notify?: (title: string, body: string, tag: string) => void;
  /** Is this daemon the fleet's hub? Only the hub checks for candidates on a timer. Default: yes. */
  isHub?: () => boolean;
  /** Send an event to every connected client. */
  broadcast: (event: SolidcraftStatusEvent) => void;
  route: (method: string, path: string, handler: Handler) => void;
}

export interface MountedSolidcraft {
  service: SolidcraftPinService;
  coordinator: FleetSolidcraftCoordinator;
  /** The hub's candidate check and replay gate (Phase B2). */
  gate: CandidateGate;
  /** This daemon's `solidcraft.status` event, built fresh. */
  statusEvent: () => Promise<SolidcraftStatusEvent>;
  stop: () => void;
}

/**
 * Build the pin service and the hub coordinator, prime the daemon's SolidCraft from the recorded pin
 * and register the REST routes. Returns undefined, and registers nothing, unless the daemon runs
 * with the "solidcraft-pin" feature: the whole surface then answers 404.
 *
 * Route posture is the managed Claude CLI's: tailnet-gated by the server, a PROVEN different tailnet
 * user is rejected, and POSTs must carry a JSON content type (so a cross-origin "simple request"
 * cannot reach them).
 */
export function mountSolidcraft(o: MountSolidcraftOptions): MountedSolidcraft | undefined {
  if (!featureEnabled({ features: o.features }, SOLIDCRAFT_PIN_CAPABILITY)) return undefined;
  const hooks = o.hooks ?? {};

  const statusEvent = async (): Promise<SolidcraftStatusEvent> => {
    const pin = service.pin();
    return { v: PROTOCOL_VERSION, type: "solidcraft.status", ts: new Date().toISOString(), ...(pin ? { pin } : {}), local: await service.status() };
  };
  const service: SolidcraftPinService = new SolidcraftPinService({
    stateDir: o.stateDir,
    install: hooks.install,
    env: hooks.env,
    exists: hooks.exists,
    primeResolver: hooks.primeResolver,
    onChange: () => void statusEvent().then(o.broadcast, () => {}),
    candidateVersion: () => keptCandidate(),
  });
  // The candidate this machine keeps on disk beside the pin: the one the hub's gate is evaluating
  // (or holding), or the one a hub last asked THIS machine to replay.
  let replayedCandidate: string | undefined;
  const keptCandidate = (): string | undefined => gate.candidateVersion() ?? replayedCandidate;
  const coordinator = new FleetSolidcraftCoordinator({
    self: o.self,
    members: o.members,
    local: service,
    client: httpMemberSolidcraftClient(),
    resolveRef: hooks.resolveRef ?? ((v) => resolveReleaseRef(v)),
    rewrittenDesigns: hooks.rewrittenDesigns ?? o.rewrittenDesigns,
    keepVersions: () => [keptCandidate()].filter((v): v is string => !!v),
    log: (m) => console.log(m),
  });

  /**
   * This machine's part of the replay gate, used for the hub itself and by the member route:
   * install the candidate BESIDE the pinned build (the pin and the running build are not touched),
   * then replay every hosted design under both and report.
   */
  const localReplay: LocalReplay = async (candidate, pinRef) => {
    replayedCandidate = candidate.version;
    const own = service.pin();
    pruneSolidcraft(o.stateDir, [own?.version, own?.previous?.version, pinRef?.version, candidate.version]);
    const inst = await service.installBeside(candidate);
    if (!inst.ok) return { ok: false, error: `SolidCraft ${candidate.version} could not be installed here: ${inst.detail}` };
    // The baseline is the pinned build; with none installed, whatever this machine would run now.
    const want = pinRef ?? own;
    const pinned = want ? installedSolidcraft(o.stateDir, want.version, want.sha256) : undefined;
    let baseline: ReplayBuild | undefined = pinned ? { path: pinned.path, version: pinned.version } : undefined;
    if (!baseline) {
      const l = await service.local();
      if (l.path && l.version) baseline = { path: l.path, version: l.version };
    }
    const selfCompare = baseline?.version === candidate.version;
    if (selfCompare) baseline = undefined; // comparing a build with itself proves nothing
    const report = await replayMachine({
      candidate: { path: inst.path, version: inst.version },
      baseline,
      environments: (hooks.environments ?? o.environments ?? (() => []))(),
      worktrees: hooks.worktrees ?? o.worktrees,
      run: hooks.replay?.run,
      timeoutMs: hooks.replay?.timeoutMs,
      concurrency: hooks.replay?.concurrency,
      env: hooks.env,
    });
    if (selfCompare) report.notes.push(`this machine already runs SolidCraft ${candidate.version}, so there was no other build to compare against`);
    return { ok: true, report };
  };

  const client = httpMemberSolidcraftClient();
  const gate: CandidateGate = new CandidateGate({
    stateDir: o.stateDir,
    self: o.self,
    members: o.members,
    client,
    listReleases: hooks.listReleases ?? (() => fetchReleases()),
    releaseSha: hooks.releaseSha,
    pin: () => service.pin(),
    localVersion: async () => (await service.local()).version,
    replayLocal: localReplay,
    advance: (ref) => coordinator.setPin({ version: ref.version, sha256: ref.sha256 }),
    prune: () => {
      const pin = service.pin();
      if (pin) pruneSolidcraft(o.stateDir, [pin.version, pin.previous?.version]);
    },
    notify: hooks.notify ?? o.notify,
    // Only the hub looks for candidates by itself; a member is told what to replay.
    timerEnabled: () => o.isHub?.() ?? true,
    now: hooks.now,
    // The card re-reads the gate when it sees a status event.
    onChange: () => void statusEvent().then(o.broadcast, () => {}),
    log: (m) => console.log(m),
  });
  service.boot();
  gate.start(hooks.checkEveryMs ?? CHECK_EVERY_MS); // 0 disables the timers

  // A member that was offline when the pin moved is brought to it here.
  const every = hooks.reconcileMs ?? 10 * 60_000;
  const timer = every > 0 ? setInterval(() => void coordinator.reconcile().catch(() => {}), every) : undefined;
  timer?.unref?.();

  const json = (body: unknown, status = 200): Response => Response.json(body, { status });
  /** The mutating-route gate: JSON content type, and not a proven other tailnet user. */
  const gate_ = async (req: Request, ctx: RouteCtx, allowLocal: boolean): Promise<Response | undefined> => {
    const ct = (req.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) return new Response("application/json required", { status: 415 });
    const who = await ctx.callerIdentity();
    if (who.trust === "otherUser" && !(allowLocal && ctx.localNoIdentityCaller)) return json({ ok: false, error: who.reject ?? "different tailnet user" }, 403);
    return undefined;
  };
  const body = async <T>(req: Request): Promise<Partial<T>> => ((await req.json().catch(() => ({}))) ?? {}) as Partial<T>;

  // ── This daemon ──
  o.route("GET", "/api/solidcraft/status", async () => {
    const pin = service.pin();
    return json({ ok: true, ...(pin ? { pin } : {}), local: await service.status() } satisfies rest.solidcraft.StatusResponse);
  });
  o.route("POST", "/api/solidcraft/pin/apply", async (req, _url, _m, ctx) => {
    const denied = await gate_(req, ctx, true);
    if (denied) return denied;
    const b = await body<rest.solidcraft.ApplyRequest>(req);
    const pin = parsePin(b.pin);
    if (!pin) return json({ ok: false, local: await service.status(), error: "a valid pin { version, sha256, pinnedAt } is required" } satisfies rest.solidcraft.ApplyResponse, 400);
    const keep = Array.isArray(b.keep) ? b.keep.filter((k): k is string => typeof k === "string") : [];
    const local = await service.apply(pin, keep);
    const ok = local.state === "ready";
    return json({ ok, pin: service.pin(), local, ...(ok ? {} : { error: local.error ?? local.reason ?? "not on the pinned version" }) } satisfies rest.solidcraft.ApplyResponse, ok ? 200 : 500);
  });

  o.route("POST", "/api/solidcraft/replay", async (req, _url, _m, ctx) => {
    const denied = await gate_(req, ctx, true);
    if (denied) return denied;
    const b = await body<rest.solidcraft.ReplayRequest>(req);
    const ref = (r: unknown): SolidcraftRef | undefined => {
      const x = r as { version?: unknown; sha256?: unknown } | undefined;
      return x && isSolidcraftVersion(x.version) && isSha256(x.sha256) ? { version: x.version, sha256: x.sha256 } : undefined;
    };
    const candidate = ref(b.candidate);
    if (!candidate) return json({ ok: false, error: "a candidate { version, sha256 } is required" } satisfies rest.solidcraft.ReplayResponse, 400);
    if (b.pin !== undefined && !ref(b.pin)) return json({ ok: false, error: "pin must be { version, sha256 }" } satisfies rest.solidcraft.ReplayResponse, 400);
    const r = await localReplay(candidate, ref(b.pin)).catch((e): { ok: false; error: string } => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return json((r.ok ? { ok: true, report: r.report } : { ok: false, error: r.error }) satisfies rest.solidcraft.ReplayResponse, r.ok ? 200 : 500);
  });

  // ── Hub ──
  o.route("GET", "/api/fleet/solidcraft/candidate", () => json(gate.status() satisfies rest.solidcraft.CandidateStatusResponse));
  o.route("POST", "/api/fleet/solidcraft/candidate/check", async (req, _url, _m, ctx) => {
    const denied = await gate_(req, ctx, false);
    if (denied) return denied;
    const check = await gate.check();
    return json({ ...gate.status(), check } satisfies rest.solidcraft.CandidateCheckResponse);
  });
  o.route("POST", "/api/fleet/solidcraft/candidate/advance", async (req, _url, _m, ctx) => {
    const denied = await gate_(req, ctx, false);
    if (denied) return denied;
    const b = await body<rest.solidcraft.AdvanceAnywayRequest>(req);
    const r = await gate.advanceAnyway(String(b.version ?? ""));
    return json(r satisfies rest.solidcraft.AdvanceAnywayResponse, r.ok ? 200 : 409);
  });
  o.route("GET", "/api/fleet/solidcraft/status", async (_req, url) => {
    if (url.searchParams.get("refresh")) await coordinator.refresh();
    return json(coordinator.status() satisfies rest.solidcraft.FleetStatusResponse);
  });
  o.route("POST", "/api/fleet/solidcraft/pin", async (req, _url, _m, ctx) => {
    const denied = await gate_(req, ctx, false);
    if (denied) return denied;
    const b = await body<rest.solidcraft.SetPinRequest>(req);
    const r = await coordinator.setPin({ version: String(b.version ?? ""), ...(typeof b.sha256 === "string" ? { sha256: b.sha256 } : {}) });
    return json(r satisfies rest.solidcraft.SetPinResponse, r.ok ? 200 : 409);
  });
  o.route("GET", "/api/fleet/solidcraft/pin/back", async () => json((await coordinator.pinBackPreview()) satisfies rest.solidcraft.PinBackPreviewResponse));
  o.route("POST", "/api/fleet/solidcraft/pin/back", async (req, _url, _m, ctx) => {
    const denied = await gate_(req, ctx, false);
    if (denied) return denied;
    const r = await coordinator.pinBack();
    return json(r satisfies rest.solidcraft.PinBackResponse, r.ok ? 200 : 409);
  });

  return {
    service,
    coordinator,
    gate,
    statusEvent,
    stop: () => {
      if (timer) clearInterval(timer);
      gate.stop();
    },
  };
}
