/**
 * Hub-orchestrated fleet rollout (stable-update-service spec §4.4). The hub pins ONE target SHA and
 * fans it out to every reachable member over the frozen update API; each member self-updates and
 * self-heals locally (the hub only OBSERVES — spec D10). The hub updates ITSELF LAST (spec D6). Members
 * that are unreachable at fan-out time are skipped and marked pending-offline, then reconciled to the
 * pinned target when they next reconnect (spec D18/D19).
 *
 * Everything the coordinator touches the network/service-manager through is injected (MemberUpdateClient,
 * resolveTargetSha, applySelf, a fake clock/sleep), so the whole orchestration is exercised by the
 * multi-daemon fleet-sim without real hosts.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { rest } from "@protocol";
import { writeFileAtomic } from "../util/atomic";

/** What a member's health probe yields. `reachable:false` leaves the optional fields undefined. */
export interface ProbeInfo {
  reachable: boolean;
  updateApiVersion?: number;
  currentSha?: string;
}

/** The subset of a fleet member the coordinator needs. */
export interface RolloutTarget {
  serverId: string;
  serverName: string;
  url: string; // base, e.g. "https://host:7701/"
}

/** Transport to a single member's frozen update API. Injected so tests use in-memory fakes. */
export interface MemberUpdateClient {
  /** Reachability + which update path the member speaks. `updateApiVersion` absent ⇒ legacy. */
  probe(base: string): Promise<ProbeInfo>;
  /** POST /api/update/v1/apply {targetSha}. */
  apply(base: string, targetSha: string): Promise<{ ok: boolean; error?: string }>;
  /** GET /api/update/v1/status. null ⇒ unreachable this poll. */
  status(base: string): Promise<rest.update.StatusResponse | null>;
  /** Legacy fallback for a pre-frozen-API member: POST /api/daemon/update. */
  legacyUpdate(base: string): Promise<{ ok: boolean; error?: string }>;
}

export interface FleetRolloutDeps {
  self: { serverId: string; serverName: string };
  members: () => RolloutTarget[];
  /** Resolve the upstream tip once → the SHA to pin (used when the request omits one). */
  resolveTargetSha: () => Promise<string>;
  /** Update the hub itself, last. */
  applySelf: (targetSha: string) => Promise<{ ok: boolean; error?: string }>;
  client: MemberUpdateClient;
  desired: DesiredTargetStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Per-member health gate (spec D11: 180s). */
  memberTimeoutMs?: number;
  pollIntervalMs?: number;
  log?: (m: string) => void;
}

interface RolloutState {
  active: boolean;
  targetSha: string;
  startedAt: number;
  finishedAt?: number;
  members: Map<string, rest.FleetRolloutMember>;
}

const DEFAULT_TIMEOUT_MS = 180_000; // spec D11
const DEFAULT_POLL_MS = 3_000;

export class FleetRolloutCoordinator {
  private state: RolloutState | null = null;
  private running: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly log: (m: string) => void;

  constructor(private readonly deps: FleetRolloutDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = deps.memberTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.log = deps.log ?? (() => {});
  }

  /** Kick off a rollout; returns the initial snapshot. The actual fan-out runs in the background — the
   *  hub updates itself LAST, after the reachable set settles. `await`able via {@link run} in tests. */
  async start(req: rest.FleetUpdateRequest): Promise<rest.FleetUpdateResponse> {
    if (this.state?.active) {
      return { ok: false, targetSha: this.state.targetSha, members: this.snapshotMembers(), error: "a fleet rollout is already in progress" };
    }
    let targetSha: string;
    try {
      targetSha = (req.targetSha?.trim() || (await this.deps.resolveTargetSha())).trim();
    } catch (e) {
      return { ok: false, targetSha: "", members: [], error: e instanceof Error ? e.message : String(e) };
    }
    if (!targetSha) return { ok: false, targetSha: "", members: [], error: "could not resolve a target SHA" };

    this.deps.desired.set(targetSha); // desired-state for reconcile-on-reconnect (spec D19)

    const members = new Map<string, rest.FleetRolloutMember>();
    for (const m of this.deps.members()) {
      members.set(m.serverId, { serverId: m.serverId, serverName: m.serverName, isHub: false, state: "pending", toSha: targetSha });
    }
    members.set(this.deps.self.serverId, { serverId: this.deps.self.serverId, serverName: this.deps.self.serverName, isHub: true, state: "pending", toSha: targetSha });
    this.state = { active: true, targetSha, startedAt: this.now(), members };

    this.running = this.run(targetSha).catch(() => {}); // fire-and-forget; observers poll status()
    return { ok: true, targetSha, members: this.snapshotMembers() };
  }

  /** Await the in-flight rollout body (tests + a caller that wants to block until the fleet settles). */
  async settled(): Promise<void> {
    await this.running;
  }

  /** The rollout body (awaitable for tests). Fans out to reachable members in PARALLEL, waits for the
   *  reachable set to settle, then updates the hub last. */
  async run(targetSha: string): Promise<void> {
    const targets = this.deps.members();
    await Promise.all(targets.map((m) => this.rollMember(m, targetSha)));
    // Hub last (spec D6): only after every reachable member has settled.
    this.setMember(this.deps.self.serverId, { state: "updating" });
    try {
      const r = await this.deps.applySelf(targetSha);
      this.setMember(this.deps.self.serverId, { state: r.ok ? "updating" : "error", detail: r.ok ? "restarting" : r.error });
      // On success the hub restarts; the record on disk carries the rest. Mark finished so a poll before
      // the process dies reflects that the hub was reached last.
    } catch (e) {
      this.setMember(this.deps.self.serverId, { state: "error", detail: e instanceof Error ? e.message : String(e) });
    }
    if (this.state) this.state.finishedAt = this.now();
    if (this.state) this.state.active = false;
  }

  /** Drive one member to a terminal state (healthy / rolled-back / error / pending-offline / legacy). */
  private async rollMember(m: RolloutTarget, targetSha: string): Promise<void> {
    const probe: ProbeInfo = await this.deps.client.probe(m.url).catch(() => ({ reachable: false }));
    if (!probe.reachable) {
      this.setMember(m.serverId, { state: "pending-offline", detail: "unreachable at fan-out — will reconcile on reconnect" });
      return;
    }
    if (probe.currentSha && (probe.currentSha.startsWith(targetSha) || targetSha.startsWith(probe.currentSha))) {
      this.setMember(m.serverId, { fromSha: probe.currentSha, state: "healthy", detail: "already at target" });
      return;
    }
    if (probe.updateApiVersion === undefined) {
      // Legacy member (spec §4.3): no frozen API → drive the old path, best-effort, no pinned SHA.
      const r = await this.deps.client.legacyUpdate(m.url).catch((e) => ({ ok: false, error: String(e) }));
      this.setMember(m.serverId, { fromSha: probe.currentSha, state: r.ok ? "legacy" : "error", detail: r.ok ? "driven via legacy daemon.update" : r.error });
      return;
    }
    this.setMember(m.serverId, { fromSha: probe.currentSha, state: "updating" });
    const applied = await this.deps.client.apply(m.url, targetSha).catch((e) => ({ ok: false, error: String(e) }));
    if (!applied.ok) {
      this.setMember(m.serverId, { state: "error", detail: applied.error ?? "apply rejected" });
      return;
    }
    await this.awaitMemberSettled(m, targetSha);
  }

  /** Poll a member's status until it reaches healthy/rolled-back, or the gate times out. */
  private async awaitMemberSettled(m: RolloutTarget, targetSha: string): Promise<void> {
    const deadline = this.now() + this.timeoutMs;
    while (this.now() < deadline) {
      await this.sleep(this.pollMs);
      const st = await this.deps.client.status(m.url).catch(() => null);
      if (!st) continue; // mid-restart the member is briefly unreachable — keep waiting
      if (st.phase === "healthy" && (st.currentSha.startsWith(targetSha) || targetSha.startsWith(st.currentSha))) {
        this.setMember(m.serverId, { state: "healthy", fromSha: st.prePullSha, toSha: st.currentSha });
        return;
      }
      if (st.phase === "rolled-back") {
        this.setMember(m.serverId, { state: "rolled-back", detail: st.reason ?? "failed its health gate — reverted" });
        return;
      }
      if (st.phase === "error") {
        this.setMember(m.serverId, { state: "error", detail: st.reason ?? "update error" });
        return;
      }
    }
    this.setMember(m.serverId, { state: "error", detail: `timed out after ${Math.round(this.timeoutMs / 1000)}s waiting for the member to become healthy` });
  }

  /**
   * Reconcile a member that (re)appeared: if it's behind the pinned desired target, nudge it to converge
   * (spec D19). No-op when there's no desired target, the member is already there, or it's legacy.
   * Fire-and-forget from the members/discovery path.
   */
  async reconcile(m: RolloutTarget): Promise<void> {
    const target = this.deps.desired.get();
    if (!target) return;
    const probe: ProbeInfo = await this.deps.client.probe(m.url).catch(() => ({ reachable: false }));
    if (!probe.reachable || probe.updateApiVersion === undefined) return;
    if (probe.currentSha && (probe.currentSha.startsWith(target) || target.startsWith(probe.currentSha))) return;
    this.log(`[fleet-rollout] reconciling ${m.serverName} → ${target}`);
    await this.deps.client.apply(m.url, target).catch(() => {});
  }

  status(): rest.FleetUpdateStatusResponse {
    if (!this.state) return { ok: true, active: false, targetSha: this.deps.desired.get(), members: [] };
    return {
      ok: true,
      active: this.state.active,
      targetSha: this.state.targetSha,
      startedAt: this.state.startedAt,
      ...(this.state.finishedAt ? { finishedAt: this.state.finishedAt } : {}),
      members: this.snapshotMembers(),
    };
  }

  private setMember(serverId: string, patch: Partial<rest.FleetRolloutMember>): void {
    const cur = this.state?.members.get(serverId);
    if (!cur) return;
    this.state!.members.set(serverId, { ...cur, ...patch });
  }
  private snapshotMembers(): rest.FleetRolloutMember[] {
    if (!this.state) return [];
    // Hub last in the rendered order too.
    return [...this.state.members.values()].sort((a, b) => Number(a.isHub) - Number(b.isHub));
  }
}

/** Persists the last pinned target so a lagging member is reconciled on reconnect (spec D19). Tiny +
 *  node:fs-only, like the other daemon stores. */
export class DesiredTargetStore {
  private readonly file: string;
  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, "fleet-target.json");
  }
  get(): string {
    if (!existsSync(this.file)) return "";
    try {
      return (JSON.parse(readFileSync(this.file, "utf8")).targetSha as string) ?? "";
    } catch {
      return "";
    }
  }
  set(targetSha: string): void {
    writeFileAtomic(this.file, JSON.stringify({ targetSha }, null, 2));
  }
}

/** The real HTTP transport to a member's frozen update API. Base URLs come from the fleet store
 *  (already healed to a working http/https transport). Short timeouts so a dead member fails the probe
 *  fast rather than stalling the rollout. */
export function httpMemberUpdateClient(fetchImpl: typeof fetch = fetch): MemberUpdateClient {
  const trim = (base: string) => base.replace(/\/+$/, "");
  const timeout = (ms: number) => AbortSignal.timeout(ms);
  return {
    async probe(base) {
      try {
        const r = await fetchImpl(`${trim(base)}/api/health`, { signal: timeout(5_000) });
        if (!r.ok) return { reachable: false };
        const h = (await r.json()) as rest.HealthResponse;
        return { reachable: true, updateApiVersion: h.updateApiVersion, currentSha: shaOf(h.version) };
      } catch {
        return { reachable: false };
      }
    },
    async apply(base, targetSha) {
      try {
        const r = await fetchImpl(`${trim(base)}/api/update/v1/apply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetSha } satisfies rest.update.ApplyRequest),
          signal: timeout(30_000),
        });
        const j = (await r.json().catch(() => ({}))) as rest.update.ApplyResponse;
        return { ok: !!j.ok, error: j.error };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    async status(base) {
      try {
        const r = await fetchImpl(`${trim(base)}/api/update/v1/status`, { signal: timeout(5_000) });
        if (!r.ok) return null;
        return (await r.json()) as rest.update.StatusResponse;
      } catch {
        return null;
      }
    },
    async legacyUpdate(base) {
      try {
        const r = await fetchImpl(`${trim(base)}/api/daemon/update`, { method: "POST", signal: timeout(30_000) });
        const j = (await r.json().catch(() => ({}))) as rest.DaemonUpdateResponse;
        return { ok: !!j.ok, error: j.ok ? undefined : j.output };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/** The short SHA embedded in a VERSION string ("0.2.1+abc1234" → "abc1234"). */
function shaOf(version: string): string {
  const i = version.indexOf("+");
  return i >= 0 ? version.slice(i + 1) : "";
}
