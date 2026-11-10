/**
 * Hub-orchestrated Claude CLI rollout (managed-claude-cli-updates spec D3). The hub resolves ONE
 * target CLI version and installs it on every reachable member in parallel; the hub installs ITSELF
 * LAST. Unreachable members are marked `pending-offline` and left for a later manual run.
 *
 * Unlike the daemon-SHA rollout (fleet-rollout.ts) there's no restart/health-gate dance: a member
 * hot-swaps the managed CLI in-process, so its install response carries the resulting version and the
 * member reaches a terminal state in one call. Everything the coordinator touches the network through
 * is injected (MemberCliClient, resolveLatest, installSelf), so the orchestration is unit-testable.
 */
import type { rest } from "@protocol";

/** The subset of a fleet member the coordinator needs. */
export interface CliRolloutTarget {
  serverId: string;
  serverName: string;
  url: string; // base, e.g. "https://host:7701/"
}

/** Transport to a single member's Claude-CLI REST surface. Injected so tests use in-memory fakes. */
export interface MemberCliClient {
  /** Reachability + whether the member advertises the "claude-cli-update" capability. */
  probe(base: string): Promise<{ reachable: boolean; supported: boolean }>;
  /** POST /api/claude-cli/install {version}. */
  install(base: string, version: string): Promise<{ ok: boolean; version?: string; error?: string }>;
}

export interface FleetCliRolloutDeps {
  self: { serverId: string; serverName: string };
  members: () => CliRolloutTarget[];
  /** Resolve the newest published CLI version once → the version to pin (when the request omits one). */
  resolveLatest: () => Promise<string>;
  /** Install the target CLI on the hub itself, last. */
  installSelf: (version: string) => Promise<{ ok: boolean; version?: string; error?: string }>;
  client: MemberCliClient;
  now?: () => number;
  log?: (m: string) => void;
}

interface RolloutState {
  active: boolean;
  version: string;
  startedAt: number;
  finishedAt?: number;
  members: Map<string, rest.claudecli.Member>;
}

export class FleetCliRolloutCoordinator {
  private state: RolloutState | null = null;
  private running: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(private readonly deps: FleetCliRolloutDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? (() => {});
  }

  /** Kick off a rollout; returns the initial snapshot. The fan-out runs in the background (hub last). */
  async start(req: rest.claudecli.FleetUpdateRequest): Promise<rest.claudecli.FleetUpdateResponse> {
    if (this.state?.active) {
      return { ok: false, version: this.state.version, members: this.snapshotMembers(), error: "a Claude CLI rollout is already in progress" };
    }
    let version: string;
    try {
      version = (req.version?.trim() || (await this.deps.resolveLatest())).trim();
    } catch (e) {
      return { ok: false, version: "", members: [], error: e instanceof Error ? e.message : String(e) };
    }
    if (!version) return { ok: false, version: "", members: [], error: "could not resolve a target version" };

    const members = new Map<string, rest.claudecli.Member>();
    for (const m of this.deps.members()) {
      members.set(m.serverId, { serverId: m.serverId, serverName: m.serverName, isHub: false, state: "pending" });
    }
    members.set(this.deps.self.serverId, { serverId: this.deps.self.serverId, serverName: this.deps.self.serverName, isHub: true, state: "pending" });
    this.state = { active: true, version, startedAt: this.now(), members };

    this.running = this.run(version).catch(() => {}); // fire-and-forget; observers poll status()
    return { ok: true, version, members: this.snapshotMembers() };
  }

  /** Await the in-flight rollout body (tests + a caller that wants to block until the fleet settles). */
  async settled(): Promise<void> {
    await this.running;
  }

  /** The rollout body (awaitable for tests): install on reachable members in PARALLEL, then the hub. */
  async run(version: string): Promise<void> {
    try {
      await Promise.all(this.deps.members().map((m) => this.installMember(m, version)));
      // Hub last: only after every reachable member has settled.
      this.setMember(this.deps.self.serverId, { state: "installing" });
      try {
        const r = await this.deps.installSelf(version);
        this.setMember(this.deps.self.serverId, r.ok ? { state: "healthy", version: r.version ?? version } : { state: "error", detail: r.error });
      } catch (e) {
        this.setMember(this.deps.self.serverId, { state: "error", detail: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      // ALWAYS release the in-flight lock, even if members()/installMember throws, or a future rollout
      // is wedged "already in progress" until a daemon restart (mirrors fleet-rollout BE2-11).
      if (this.state) {
        this.state.finishedAt = this.now();
        this.state.active = false;
      }
    }
  }

  /** Drive one member to a terminal state (healthy / error / pending-offline). */
  private async installMember(m: CliRolloutTarget, version: string): Promise<void> {
    const probe = await this.deps.client.probe(m.url).catch(() => ({ reachable: false, supported: false }));
    if (!probe.reachable) {
      this.setMember(m.serverId, { state: "pending-offline", detail: "unreachable at fan-out — run again when it's back" });
      return;
    }
    if (!probe.supported) {
      this.setMember(m.serverId, { state: "error", detail: "member is too old to manage the Claude CLI — update Anvil there first" });
      return;
    }
    this.setMember(m.serverId, { state: "installing" });
    const r = await this.deps.client
      .install(m.url, version)
      .catch((e): { ok: boolean; version?: string; error?: string } => ({ ok: false, error: String(e) }));
    this.setMember(m.serverId, r.ok ? { state: "healthy", version: r.version ?? version } : { state: "error", detail: r.error ?? "install rejected" });
  }

  status(): rest.claudecli.FleetUpdateStatusResponse {
    if (!this.state) return { ok: true, active: false, version: "", members: [] };
    return {
      ok: true,
      active: this.state.active,
      version: this.state.version,
      startedAt: this.state.startedAt,
      ...(this.state.finishedAt ? { finishedAt: this.state.finishedAt } : {}),
      members: this.snapshotMembers(),
    };
  }

  private setMember(serverId: string, patch: Partial<rest.claudecli.Member>): void {
    const cur = this.state?.members.get(serverId);
    if (!cur) return;
    this.state!.members.set(serverId, { ...cur, ...patch });
  }
  private snapshotMembers(): rest.claudecli.Member[] {
    if (!this.state) return [];
    return [...this.state.members.values()].sort((a, b) => Number(a.isHub) - Number(b.isHub)); // hub last
  }
}

/** The real HTTP transport to a member's Claude-CLI REST surface. Short probe timeout, generous
 *  install timeout (the member downloads a ~300MB native binary). */
export function httpMemberCliClient(fetchImpl: typeof fetch = fetch): MemberCliClient {
  const trim = (base: string) => base.replace(/\/+$/, "");
  const timeout = (ms: number) => AbortSignal.timeout(ms);
  return {
    async probe(base) {
      try {
        const r = await fetchImpl(`${trim(base)}/api/health`, { signal: timeout(5_000) });
        if (!r.ok) return { reachable: false, supported: false };
        const h = (await r.json()) as rest.HealthResponse;
        return { reachable: true, supported: !!h.capabilities?.includes("claude-cli-update") };
      } catch {
        return { reachable: false, supported: false };
      }
    },
    async install(base, version) {
      try {
        const r = await fetchImpl(`${trim(base)}/api/claude-cli/install`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version } satisfies rest.claudecli.InstallRequest),
          signal: timeout(180_000),
        });
        const j = (await r.json().catch(() => ({}))) as rest.claudecli.InstallResponse;
        return { ok: !!j.ok, version: j.info?.active, error: j.error };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
