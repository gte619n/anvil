/**
 * Fleet sync for the agent browser's allowed-sites list (agent-cad-and-browser §4.14 item 43).
 *
 * The HUB's list is the authority. It follows the environments/Todoist replication pattern: a daemon
 * store, a protocol event to each daemon's own clients (`browser.sites`), and daemon-to-daemon REST
 * on the ordinary daemon API (tailnet-gated like the rest of it):
 *
 *   hub → member   POST /api/browser/sites/sync   { hubServerId, hubUrl?, sites, confirmed? }
 *                                          reply  { ok, serverId, pending }
 *   member → hub   POST /api/browser/sites/op     { from, ops }
 *                                          reply  { ok, sites }
 *
 * A member applies its own change locally at once and queues it (so it works offline), then forwards
 * the queue to the hub at the URL the hub's last push gave. If that fails the queue waits: every
 * hub push is answered with the member's queue, so the hub collects it on its next push (on any
 * change, on a client connecting to the hub, and every few minutes) and confirms it.
 *
 * A daemon is a MEMBER when it has been paired by a hub and has no members of its own; otherwise it
 * is the authority for its list (a hub, or a standalone machine).
 */
import { PROTOCOL_VERSION, type BrowserSite, type BrowserSitesEvent, type ServerEvent } from "@protocol";
import { now } from "../util/envelope";
import { memberBases } from "../server/fleet";
import { AllowedSitesStore, normalizeSite, type SiteOp } from "./sites";

export interface SitesSyncBody {
  hubServerId: string;
  /** Where this hub's daemon API answers, so the member can forward its own approvals. */
  hubUrl?: string;
  sites: BrowserSite[];
  /** Queued member changes the hub has now applied. */
  confirmed?: SiteOp[];
}
export interface SitesSyncReply {
  ok: boolean;
  serverId?: string;
  pending?: SiteOp[];
  error?: string;
}
export interface SitesOpBody {
  from: string;
  ops: SiteOp[];
}
export interface SitesOpReply {
  ok: boolean;
  sites?: BrowserSite[];
  error?: string;
}

export interface FleetMemberRef {
  url: string;
  host?: string;
  serverId: string;
}

/** What the sync needs to know about the fleet. Supplied by http.ts, which owns the fleet stores. */
export interface BrowserFleetLink {
  selfServerId: string;
  members: () => FleetMemberRef[];
  /** The hub this machine was paired by, or null. */
  pairedHubId: () => string | null;
  /** This daemon's base URL as other machines reach it. */
  selfUrl: () => Promise<string | undefined>;
}

export const SITES_SYNC_INTERVAL_MS = 5 * 60_000;
const TIMEOUT_MS = 8_000;

function cleanOps(raw: unknown): SiteOp[] {
  if (!Array.isArray(raw)) return [];
  const out: SiteOp[] = [];
  for (const o of raw.slice(0, 500)) {
    const site = normalizeSite((o as SiteOp | undefined)?.site);
    const op = (o as SiteOp | undefined)?.op;
    if (site && (op === "add" || op === "remove")) out.push({ op, site });
  }
  return out;
}

async function postJson<T>(url: string, body: unknown, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export interface AllowedSitesServiceDeps {
  stateDir: string;
  /** Send an event to this daemon's own clients. */
  broadcast: (event: ServerEvent) => void;
  clock?: () => number;
  fetchImpl?: typeof fetch;
  /** Sync timer period; 0 = no timer (tests drive `syncNow()`). */
  intervalMs?: number;
}

export class AllowedSitesService {
  readonly store: AllowedSitesStore;
  private fleet: BrowserFleetLink | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private chain: Promise<void> = Promise.resolve();
  /** Member queues the hub applied and must confirm on its next push (keyed by member url). */
  private readonly toConfirm = new Map<string, SiteOp[]>();

  constructor(private readonly deps: AllowedSitesServiceDeps) {
    this.store = new AllowedSitesStore(deps.stateDir, deps.clock);
    const every = deps.intervalMs ?? SITES_SYNC_INTERVAL_MS;
    if (every > 0) {
      this.timer = setInterval(() => void this.syncNow(), every);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** http.ts hands over the fleet once its stores exist. Triggers a first sync. */
  setFleet(link: BrowserFleetLink): void {
    this.fleet = link;
    void this.syncNow();
  }

  role(): "authority" | "member" {
    const f = this.fleet;
    return f && f.pairedHubId() && f.members().length === 0 ? "member" : "authority";
  }

  // ── read side ───────────────────────────────────────────────────────────────────────────────

  isAllowed(site: string): boolean {
    return this.store.has(site);
  }

  event(): BrowserSitesEvent {
    const pending = this.store.pending().length;
    return { v: PROTOCOL_VERSION, type: "browser.sites", ts: now(), sites: this.store.list(), ...(pending ? { pending } : {}) };
  }

  /** Hostnames of the other machines in the fleet, for the proxy's block list. */
  fleetHosts(): string[] {
    const out = new Set<string>();
    const add = (url: string | undefined): void => {
      try {
        if (url) out.add(new URL(url).hostname);
      } catch {
        /* not a URL */
      }
    };
    for (const m of this.fleet?.members() ?? []) {
      add(m.url);
      if (m.host) out.add(m.host);
    }
    add(this.store.hub()?.url);
    return [...out].filter(Boolean);
  }

  // ── changes made on this machine ────────────────────────────────────────────────────────────

  /** Add a site (a hostname or URL; stored as its registrable domain). @throws on something that is not a site. */
  add(input: unknown): string {
    const site = normalizeSite(input);
    if (!site) throw new Error("enter a site like example.com");
    this.change({ op: "add", site });
    return site;
  }

  remove(input: unknown): void {
    const site = normalizeSite(input) ?? (typeof input === "string" ? input.trim().toLowerCase() : "");
    if (!site) throw new Error("no such site");
    this.change({ op: "remove", site });
  }

  private change(op: SiteOp): void {
    if (this.role() === "member") {
      this.store.applyAndQueue(op);
      this.deps.broadcast(this.event());
      void this.syncNow();
      return;
    }
    if (this.store.apply(op)) this.deps.broadcast(this.event());
    void this.syncNow();
  }

  // ── sync ────────────────────────────────────────────────────────────────────────────────────

  /** Push (authority) or forward the queue (member). Runs are serialized; never rejects. */
  syncNow(): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        if (this.role() === "member") await this.forwardQueue();
        else await this.pushToMembers(0);
      } catch (e) {
        console.warn(`[browser] allowed-sites sync failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  private async pushToMembers(round: number): Promise<void> {
    const f = this.fleet;
    const members = f?.members() ?? [];
    if (!f || !members.length) return;
    const hubUrl = await f.selfUrl().catch(() => undefined);
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    let collected = false;
    await Promise.all(
      members.map(async (m) => {
        const confirmed = this.toConfirm.get(m.url);
        const body: SitesSyncBody = { hubServerId: f.selfServerId, ...(hubUrl ? { hubUrl } : {}), sites: this.store.list(), ...(confirmed ? { confirmed } : {}) };
        for (const base of memberBases(m)) {
          try {
            const reply = await postJson<SitesSyncReply>(`${base}/api/browser/sites/sync`, body, fetchImpl);
            if (confirmed) this.toConfirm.delete(m.url);
            const queued = cleanOps(reply.pending);
            if (queued.length) {
              for (const op of queued) this.store.apply(op);
              this.toConfirm.set(m.url, queued);
              collected = true;
            }
            return;
          } catch {
            /* next transport; an unreachable member heals on a later push */
          }
        }
      }),
    );
    if (collected) {
      this.deps.broadcast(this.event());
      if (round < 3) await this.pushToMembers(round + 1); // send the merged list, and the confirmations
    }
  }

  private async forwardQueue(): Promise<void> {
    const f = this.fleet;
    const ops = this.store.pending();
    const hub = this.store.hub();
    if (!f || !ops.length || !hub?.url) return;
    const reply = await postJson<SitesOpReply>(`${hub.url.replace(/\/+$/, "")}/api/browser/sites/op`, { from: f.selfServerId, ops } satisfies SitesOpBody, this.deps.fetchImpl ?? fetch);
    this.store.confirm(ops);
    if (Array.isArray(reply.sites)) this.store.replaceFromHub(reply.sites, hub);
    this.deps.broadcast(this.event());
  }

  // ── what the REST routes call ───────────────────────────────────────────────────────────────

  /** Member side of `POST /api/browser/sites/sync`. The caller has already been checked against the
   *  hub this machine is paired to. */
  receiveSync(body: SitesSyncBody): SitesSyncReply {
    const sites = Array.isArray(body.sites) ? body.sites.flatMap((s) => (normalizeSite(s?.site) === s?.site ? [{ site: s.site, addedAt: Number(s.addedAt) || 0 }] : [])) : [];
    this.store.confirm(cleanOps(body.confirmed));
    const hubUrl = typeof body.hubUrl === "string" && /^https?:\/\//.test(body.hubUrl) ? body.hubUrl : undefined;
    this.store.replaceFromHub(sites, { serverId: body.hubServerId, ...(hubUrl ? { url: hubUrl } : {}) });
    this.deps.broadcast(this.event());
    return { ok: true, serverId: this.fleet?.selfServerId, pending: this.store.pending() };
  }

  /** Hub side of `POST /api/browser/sites/op`. The caller has already been checked to be a member. */
  receiveOps(body: SitesOpBody): SitesOpReply {
    let changed = false;
    for (const op of cleanOps(body.ops)) changed = this.store.apply(op) || changed;
    if (changed) {
      this.deps.broadcast(this.event());
      void this.syncNow();
    }
    return { ok: true, sites: this.store.list() };
  }
}
