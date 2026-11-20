/**
 * Logged-in sites for the agent browser (agent-cad-and-browser §4.12, §4.14 items 28, 29 and 44).
 *
 * A site is LOGGED IN when the owner listed it, or when the agent profile gained cookies for it while
 * the owner had "Open agent browser" open. Cookies gained in agent sessions do not count (most sites
 * set one on the first visit). Each logged-in site is LOCKED until the owner unlocks it; the unlock is
 * persistent and fleet-wide (item 44).
 *
 * Three parts:
 *  - `LoggedInSitesStore` / `LoggedInSitesService`: the list on disk and its hub sync. Same shape as
 *    the allowed-sites list (`sites.ts`, `sites-sync.ts`): the hub is the authority, a member applies
 *    its own change at once, queues it, and forwards it.
 *
 *      hub → member   POST /api/browser/loggedin/sync   { hubServerId, hubUrl?, sites, confirmed? }
 *      member → hub   POST /api/browser/loggedin/op     { from, ops }
 *
 *  - the cookie snapshot: which sites the profile holds cookies for, read from Chrome's cookie
 *    database opened read-only (the debugging port is never opened; decision 22).
 *  - "Open agent browser": the command line for the owner's own Chrome window on the agent profile
 *    (pure), and the run that snapshots cookies before and after it.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROTOCOL_VERSION, type BrowserLoggedInEvent, type BrowserLoggedInSite, type ServerEvent } from "@protocol";
import { memberBases } from "../server/fleet";
import { now } from "../util/envelope";
import { PROFILE_UNKNOWN_SITE } from "./gate";
import { browserProfileDir } from "./preset";
import { normalizeSite, registrableDomain } from "./sites";
import type { BrowserFleetLink } from "./sites-sync";

// ── The list on disk ────────────────────────────────────────────────────────────────────────────

export type LoggedInSource = BrowserLoggedInSite["source"];

/** One change. `at` is when it was made (ms). On the authority the LATER change wins, per site, for
 *  being listed (add / remove) and for the switch (unlock / lock) — so an "unlock" queued on a member
 *  cannot undo a "lock" the owner set on the hub afterwards, and a queued add cannot bring back a site
 *  that was removed afterwards. */
export type LoggedInOp =
  /** List the site (locked). A site already listed keeps its source and its unlock switch. */
  | { op: "add"; site: string; source: LoggedInSource; at?: number }
  | { op: "remove"; site: string; at?: number }
  /** Flip the unlock switch of a listed site. Ignored for a site that is not listed. */
  | { op: "unlock"; site: string; at?: number }
  | { op: "lock"; site: string; at?: number };

/** How long the authority remembers a removal. */
export const LOGGEDIN_TOMBSTONE_MS = 30 * 24 * 60 * 60_000;

export const BROWSER_LOGGEDIN_FILE = "browser-loggedin.json";
const MAX_SITES = 2000;

/** A row as stored: the wire fields plus when its switch was last set. */
type Row = BrowserLoggedInSite & { switchAt?: number };

interface Persisted {
  sites: Row[];
  pending: LoggedInOp[];
  removed?: { site: string; at: number }[];
  hub?: { serverId: string; url?: string };
  /** The list on disk was damaged (C3 review, item 5): until the owner starts a new list (or the hub
   *  sends a good one) every site the headed profile has cookies for counts as logged in and locked. */
  corrupt?: { at: number; reason: string; keptAs?: string };
}

const isSource = (v: unknown): v is LoggedInSource => v === "owner" || v === "login-session";
const opKey = (o: LoggedInOp): string => `${o.op} ${o.site}${o.op === "add" ? ` ${o.source}` : ""}`;
/** Two families of change per site: being listed (add/remove) and the switch (unlock/lock). */
const family = (o: LoggedInOp): "list" | "switch" => (o.op === "add" || o.op === "remove" ? "list" : "switch");

export function cleanLoggedInOps(raw: unknown): LoggedInOp[] {
  if (!Array.isArray(raw)) return [];
  const out: LoggedInOp[] = [];
  for (const o of raw.slice(0, 500)) {
    const site = normalizeSite((o as LoggedInOp | undefined)?.site);
    const op = (o as LoggedInOp | undefined)?.op;
    if (!site) continue;
    const rawAt = (o as { at?: unknown }).at;
    const at = typeof rawAt === "number" && Number.isFinite(rawAt) ? { at: rawAt } : {};
    if (op === "add") out.push({ op, site, source: isSource((o as { source?: unknown }).source) ? (o as { source: LoggedInSource }).source : "owner", ...at });
    else if (op === "remove" || op === "unlock" || op === "lock") out.push({ op, site, ...at });
  }
  return out;
}

function cleanRows(raw: unknown, clock: () => number): Row[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const r of raw as Partial<Row>[]) {
    // Each row is re-normalized, so a hand-edited entry cannot widen to something a site is not.
    const site = normalizeSite(r?.site);
    if (!site || site !== r.site || seen.has(site) || out.length >= MAX_SITES) continue;
    seen.add(site);
    // Only the literal `true` unlocks: anything else (missing, a string, 1) stays locked.
    out.push({ site, source: isSource(r.source) ? r.source : "owner", unlocked: r.unlocked === true, addedAt: Number(r.addedAt) || clock(), ...(typeof r.switchAt === "number" ? { switchAt: r.switchAt } : {}) });
  }
  return out;
}

/** This daemon's copy of the fleet's logged-in sites (`<stateDir>/browser-loggedin.json`). */
export class LoggedInSitesStore {
  private readonly file: string;
  private state: Persisted = { sites: [], pending: [] };

  constructor(
    stateDir: string,
    private readonly clock: () => number = Date.now,
  ) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, BROWSER_LOGGEDIN_FILE);
    this.load();
  }

  list(): BrowserLoggedInSite[] {
    return [...this.state.sites].sort((a, b) => a.site.localeCompare(b.site)).map(wire);
  }
  get(site: string): BrowserLoggedInSite | undefined {
    const s = this.state.sites.find((x) => x.site === site);
    return s ? wire(s) : undefined;
  }
  pending(): LoggedInOp[] {
    return this.state.pending.map((p) => ({ ...p }));
  }
  hub(): { serverId: string; url?: string } | undefined {
    return this.state.hub ? { ...this.state.hub } : undefined;
  }
  /** Set while the list is known to be damaged (fail closed; see `Persisted.corrupt`). */
  corrupt(): { at: number; reason: string; keptAs?: string } | undefined {
    return this.state.corrupt ? { ...this.state.corrupt } : undefined;
  }
  /** The owner starts a new, empty list: the damaged one is no longer in force. */
  clearCorrupt(): boolean {
    if (!this.state.corrupt) return false;
    this.state.corrupt = undefined;
    this.save();
    return true;
  }

  /** Apply one change to the authority's list, in time order. Returns whether the list changed. */
  apply(op: LoggedInOp): boolean {
    const changed = this.applyTo(this.state.sites, op, true);
    this.save(); // a removal or a switch time is remembered even when nothing visible changed
    return changed;
  }

  /** Member: apply locally AND remember it for the hub, stamped with when it was made. */
  applyAndQueue(op: LoggedInOp): boolean {
    const stamped: LoggedInOp = { ...op, at: op.at ?? this.clock() };
    const changed = this.applyTo(this.state.sites, stamped, false);
    // The latest word of a family replaces the earlier one; removing a site drops everything queued for it.
    this.state.pending = [...this.state.pending.filter((p) => p.site !== op.site || (op.op !== "remove" && family(p) !== family(op))), stamped];
    this.save();
    return changed;
  }

  /** Member: the hub confirmed these queued changes. */
  confirm(ops: readonly LoggedInOp[]): void {
    const done = new Set(ops.map(opKey));
    const before = this.state.pending.length;
    this.state.pending = this.state.pending.filter((p) => !done.has(opKey(p)));
    if (this.state.pending.length !== before) this.save();
  }

  /** Member: take the hub's list as the truth, then put this machine's unconfirmed changes back on
   *  top. Returns whether the visible list changed. */
  replaceFromHub(sites: readonly BrowserLoggedInSite[], hub: { serverId: string; url?: string }): boolean {
    const before = JSON.stringify(this.list());
    const next = cleanRows(sites, this.clock);
    for (const p of this.state.pending) this.applyTo(next, p, false);
    this.state.sites = next;
    this.state.corrupt = undefined; // the hub's list is the authority, and it is whole
    this.state.hub = { serverId: hub.serverId, ...(hub.url ? { url: hub.url } : this.state.hub?.url ? { url: this.state.hub.url } : {}) };
    this.save();
    return JSON.stringify(this.list()) !== before;
  }

  /**
   * Apply one change. With `ordered` (the authority's own list) the change's time is compared with
   * what the list already knows, and a change older than that is a stale message: it does nothing.
   */
  private applyTo(sites: Row[], op: LoggedInOp, ordered: boolean): boolean {
    const at = typeof op.at === "number" && Number.isFinite(op.at) ? op.at : this.clock();
    const i = sites.findIndex((s) => s.site === op.site);
    const tombs = (this.state.removed ??= []);
    const tomb = tombs.find((t) => t.site === op.site);
    switch (op.op) {
      case "add":
        if (ordered && tomb && tomb.at > at) return false; // removed after this add was made
        if (i >= 0 || sites.length >= MAX_SITES) return false;
        sites.push({ site: op.site, source: op.source, unlocked: false, addedAt: at });
        if (ordered && tomb) tombs.splice(tombs.indexOf(tomb), 1);
        return true;
      case "remove":
        if (ordered) {
          if (i >= 0 && sites[i]!.addedAt > at) return false; // listed again after this removal was made
          if (tomb) tomb.at = Math.max(tomb.at, at);
          else tombs.push({ site: op.site, at });
        }
        if (i < 0) return false;
        sites.splice(i, 1);
        return true;
      case "unlock":
      case "lock": {
        const want = op.op === "unlock";
        if (i < 0) return false;
        const row = sites[i]!;
        // The switch was set after this change was made: the newer setting stands. On a tie, locked wins.
        if (ordered && row.switchAt !== undefined && (row.switchAt > at || (row.switchAt === at && want))) return false;
        const changed = row.unlocked !== want;
        sites[i] = { ...row, unlocked: want, ...(ordered ? { switchAt: at } : {}) };
        return changed;
      }
    }
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Persisted>;
      if (!raw || typeof raw !== "object" || !Array.isArray(raw.sites)) throw new Error("expected { sites: [...] }");
      this.state.sites = cleanRows(raw.sites, () => 0);
      this.state.pending = cleanLoggedInOps(raw.pending);
      if (raw.hub && typeof raw.hub.serverId === "string") this.state.hub = { serverId: raw.hub.serverId, ...(typeof raw.hub.url === "string" ? { url: raw.hub.url } : {}) };
      for (const t of Array.isArray(raw.removed) ? raw.removed : []) {
        const site = normalizeSite(t?.site);
        if (site && typeof t.at === "number") (this.state.removed ??= []).push({ site, at: t.at });
      }
      const c = (raw as { corrupt?: { at?: unknown; reason?: unknown; keptAs?: unknown } }).corrupt;
      if (c && typeof c === "object") this.state.corrupt = { at: Number(c.at) || this.clock(), reason: String(c.reason ?? "damaged"), ...(typeof c.keptAs === "string" ? { keptAs: c.keptAs } : {}) };
    } catch (e) {
      // A corrupt list cannot be trusted to say what is logged in, nor what is unlocked. Keep the
      // evidence, and FAIL CLOSED (C3 review, item 5): until the owner starts a new list in Settings,
      // every site the headed profile holds cookies for is treated as logged in and locked. The state
      // is written down, so a restart does not forget it.
      const dest = `${this.file}.corrupt-${this.clock()}`;
      let keptAs: string | undefined;
      try {
        renameSync(this.file, dest);
        keptAs = dest;
      } catch {
        /* could not move it; the save below overwrites it */
      }
      const reason = e instanceof Error ? e.message : String(e);
      this.state = { sites: [], pending: [], corrupt: { at: this.clock(), reason, ...(keptAs ? { keptAs } : {}) } };
      try {
        this.save();
      } catch {
        /* the in-memory state still fails closed */
      }
      console.error(`[browser] ${this.file} is corrupt (${reason}); every site with cookies in the agent profile is treated as a locked logged-in site until the list is started again in Settings`);
    }
  }

  private save(): void {
    const cutoff = this.clock() - LOGGEDIN_TOMBSTONE_MS;
    if (this.state.removed) this.state.removed = this.state.removed.filter((t) => t.at >= cutoff);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }
}

/** The row as clients see it (without the store's own bookkeeping). */
function wire(r: Row): BrowserLoggedInSite {
  return { site: r.site, source: r.source, unlocked: r.unlocked, addedAt: r.addedAt };
}

// ── Hub sync ────────────────────────────────────────────────────────────────────────────────────

export interface LoggedInSyncBody {
  hubServerId: string;
  hubUrl?: string;
  sites: BrowserLoggedInSite[];
  confirmed?: LoggedInOp[];
}
export interface LoggedInSyncReply {
  ok: boolean;
  serverId?: string;
  pending?: LoggedInOp[];
  error?: string;
}
export interface LoggedInOpBody {
  from: string;
  ops: LoggedInOp[];
}
export interface LoggedInOpReply {
  ok: boolean;
  sites?: BrowserLoggedInSite[];
  error?: string;
}

const TIMEOUT_MS = 8_000;
export const LOGGEDIN_SYNC_INTERVAL_MS = 5 * 60_000;

async function postJson<T>(url: string, body: unknown, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export interface LoggedInSitesServiceDeps {
  stateDir: string;
  broadcast: (event: ServerEvent) => void;
  clock?: () => number;
  fetchImpl?: typeof fetch;
  /** Sync timer period; 0 = no timer (tests drive `syncNow()`). */
  intervalMs?: number;
}

export class LoggedInSitesService {
  readonly store: LoggedInSitesStore;
  private fleet: BrowserFleetLink | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private readonly toConfirm = new Map<string, LoggedInOp[]>();

  constructor(private readonly deps: LoggedInSitesServiceDeps) {
    this.store = new LoggedInSitesStore(deps.stateDir, deps.clock);
    const every = deps.intervalMs ?? LOGGEDIN_SYNC_INTERVAL_MS;
    if (every > 0) {
      this.timer = setInterval(() => void this.syncNow(), every);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  setFleet(link: BrowserFleetLink): void {
    this.fleet = link;
    void this.syncNow();
  }

  role(): "authority" | "member" {
    const f = this.fleet;
    return f && f.pairedHubId() && f.members().length === 0 ? "member" : "authority";
  }

  // ── read side ───────────────────────────────────────────────────────────────────────────────

  private cookieCache: { at: number; sites: Set<string> | undefined } | undefined;
  /** While the list is damaged: the sites the headed profile has cookies for (undefined: unreadable,
   *  so every site counts). Read at most every 30 s. */
  private profileSites(): Set<string> | undefined {
    const t = (this.deps.clock ?? Date.now)();
    if (!this.cookieCache || t - this.cookieCache.at > 30_000 || t < this.cookieCache.at) {
      let snap: CookieSnapshot | undefined;
      try {
        snap = readCookieSnapshot(browserProfileDir(this.deps.stateDir));
      } catch {
        snap = undefined;
      }
      this.cookieCache = { at: t, sites: snap ? new Set(snap.keys()) : undefined };
    }
    return this.cookieCache.sites;
  }
  /** Whether a damaged list makes `site` count as logged in and locked (fail closed). */
  private corruptCovers(site: string): boolean {
    if (!this.store.corrupt()) return false;
    const sites = this.profileSites();
    return !sites || sites.has(site);
  }

  /** Every logged-in site, locked or not. */
  sites(): string[] {
    return this.store.list().map((s) => s.site);
  }
  isLoggedIn(site: string): boolean {
    return this.store.get(site) !== undefined || this.corruptCovers(site);
  }
  isUnlocked(site: string): boolean {
    return !this.store.corrupt() && this.store.get(site)?.unlocked === true;
  }
  /** Every site that is locked right now: the list's locked sites, and while the list is damaged every
   *  site the agent profile has cookies for — or, when those cannot be read, `PROFILE_UNKNOWN_SITE`
   *  (every site counts). The headed browser counts these as contacted from every launch (gate.ts). */
  lockedSites(): string[] {
    const out = new Set(this.store.list().filter((s) => this.isLocked(s.site)).map((s) => s.site));
    if (this.store.corrupt()) {
      const sites = this.profileSites();
      if (!sites) out.add(PROFILE_UNKNOWN_SITE);
      else for (const s of sites) out.add(s);
    }
    return [...out];
  }
  /** Logged in and not unlocked: the state in which actions ask. */
  isLocked(site: string): boolean {
    if (this.corruptCovers(site)) return true;
    const s = this.store.get(site);
    return !!s && !s.unlocked;
  }

  event(): BrowserLoggedInEvent {
    const pending = this.store.pending().length;
    const corrupt = this.store.corrupt();
    return {
      v: PROTOCOL_VERSION,
      type: "browser.loggedin",
      ts: now(),
      sites: this.store.list(),
      ...(pending ? { pending } : {}),
      ...(corrupt ? { error: `The logged-in sites list on this machine was damaged (${corrupt.reason})${corrupt.keptAs ? `; it was kept as ${corrupt.keptAs}` : ""}. Until a new list is started, every site the agent profile has cookies for is treated as a locked logged-in site.` } : {}),
    };
  }

  /** The owner starts a new, empty list after a damaged one (Settings). */
  reset(): void {
    if (this.store.clearCorrupt()) {
      this.deps.broadcast(this.event());
      void this.syncNow();
    }
  }

  // ── changes made on this machine ────────────────────────────────────────────────────────────

  /** List a site (a hostname or URL). @throws on something that is not a site. */
  add(input: unknown, source: LoggedInSource = "owner"): string {
    const site = normalizeSite(input);
    if (!site) throw new Error("enter a site like example.com");
    this.change({ op: "add", site, source });
    return site;
  }

  remove(input: unknown): void {
    const site = normalizeSite(input) ?? (typeof input === "string" ? input.trim().toLowerCase() : "");
    if (!site) throw new Error("no such site");
    this.change({ op: "remove", site });
  }

  /** Flip a listed site's unlock switch. @throws when the site is not a logged-in site. */
  setUnlocked(input: unknown, unlocked: boolean): string {
    const site = normalizeSite(input);
    if (!site || !this.store.get(site)) throw new Error(`${typeof input === "string" && input ? input : "that"} is not a logged-in site`);
    this.change({ op: unlocked ? "unlock" : "lock", site });
    return site;
  }

  private change(op: LoggedInOp): void {
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
        // A damaged list is never pushed: members would take the empty list as the truth.
        else if (!this.store.corrupt()) await this.pushToMembers(0);
      } catch (e) {
        console.warn(`[browser] logged-in sites sync failed: ${e instanceof Error ? e.message : String(e)}`);
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
        const body: LoggedInSyncBody = { hubServerId: f.selfServerId, ...(hubUrl ? { hubUrl } : {}), sites: this.store.list(), ...(confirmed ? { confirmed } : {}) };
        for (const base of memberBases(m)) {
          try {
            const reply = await postJson<LoggedInSyncReply>(`${base}/api/browser/loggedin/sync`, body, fetchImpl);
            if (confirmed) this.toConfirm.delete(m.url);
            const queued = cleanLoggedInOps(reply.pending);
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
      if (round < 3) await this.pushToMembers(round + 1);
    }
  }

  private async forwardQueue(): Promise<void> {
    const f = this.fleet;
    const ops = this.store.pending();
    const hub = this.store.hub();
    if (!f || !ops.length || !hub?.url) return;
    const reply = await postJson<LoggedInOpReply>(`${hub.url.replace(/\/+$/, "")}/api/browser/loggedin/op`, { from: f.selfServerId, ops } satisfies LoggedInOpBody, this.deps.fetchImpl ?? fetch);
    this.store.confirm(ops);
    if (Array.isArray(reply.sites)) this.store.replaceFromHub(reply.sites, hub);
    this.deps.broadcast(this.event());
  }

  // ── what the REST routes call ───────────────────────────────────────────────────────────────

  /** Member side of `POST /api/browser/loggedin/sync` (the caller has been checked to be our hub). */
  receiveSync(body: LoggedInSyncBody): LoggedInSyncReply {
    this.store.confirm(cleanLoggedInOps(body.confirmed));
    const hubUrl = typeof body.hubUrl === "string" && /^https?:\/\//.test(body.hubUrl) ? body.hubUrl : undefined;
    this.store.replaceFromHub(Array.isArray(body.sites) ? body.sites : [], { serverId: body.hubServerId, ...(hubUrl ? { url: hubUrl } : {}) });
    this.deps.broadcast(this.event());
    return { ok: true, serverId: this.fleet?.selfServerId, pending: this.store.pending() };
  }

  /** Hub side of `POST /api/browser/loggedin/op` (the caller has been checked to be a member). */
  receiveOps(body: LoggedInOpBody): LoggedInOpReply {
    // A damaged list cannot answer with "the truth": the member keeps its queue and its copy.
    if (this.store.corrupt()) return { ok: false, error: "the hub's logged-in sites list is damaged; start a new one in Settings on the hub" };
    let changed = false;
    for (const op of cleanLoggedInOps(body.ops)) changed = this.store.apply(op) || changed;
    if (changed) {
      this.deps.broadcast(this.event());
      void this.syncNow();
    }
    return { ok: true, sites: this.store.list() };
  }
}

// ── The cookie snapshot ─────────────────────────────────────────────────────────────────────────

/** site → the identities of the cookies the profile holds for it. */
export type CookieSnapshot = Map<string, Set<string>>;

export function cookieDbPath(profileDir: string): string {
  return join(profileDir, "Default", "Cookies");
}

function readRows(file: string): { host: string; id: string }[] {
  const db = new Database(file, { readonly: true });
  try {
    try {
      const rows = db.query("select host_key, name, path, creation_utc from cookies").all() as { host_key: unknown; name: unknown; path: unknown; creation_utc: unknown }[];
      return rows.map((r) => ({ host: String(r.host_key ?? ""), id: `${String(r.host_key)}\t${String(r.name)}\t${String(r.path)}\t${String(r.creation_utc)}` }));
    } catch {
      // An older or newer schema: fall back to the host alone.
      const rows = db.query("select host_key from cookies").all() as { host_key: unknown }[];
      return rows.map((r) => ({ host: String(r.host_key ?? ""), id: String(r.host_key) }));
    }
  } finally {
    db.close();
  }
}

/**
 * Which sites the profile holds cookies for, read from Chrome's cookie database opened READ-ONLY.
 * A profile with no database yet has no cookies (an empty snapshot). A database that cannot be read
 * (locked, corrupt, not a database) is tried once more from a private copy; if that fails too the
 * result is `undefined` — "unknown", which the caller treats as "no cookies before".
 */
export function readCookieSnapshot(profileDir: string): CookieSnapshot | undefined {
  const file = cookieDbPath(profileDir);
  if (!existsSync(file)) return new Map();
  let rows: { host: string; id: string }[] | undefined;
  try {
    rows = readRows(file);
  } catch {
    let scratch: string | undefined;
    try {
      scratch = mkdtempSync(join(tmpdir(), "anvil-cookies-"));
      const copy = join(scratch, "Cookies");
      copyFileSync(file, copy);
      for (const ext of ["-wal", "-journal"]) if (existsSync(file + ext)) copyFileSync(file + ext, copy + ext);
      rows = readRows(copy);
    } catch {
      rows = undefined;
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (!rows) return undefined;
  const out: CookieSnapshot = new Map();
  for (const r of rows) {
    const host = r.host.replace(/^\./, "");
    const site = host ? normalizeSite(registrableDomain(host)) : undefined;
    if (!site) continue;
    let set = out.get(site);
    if (!set) out.set(site, (set = new Set()));
    set.add(r.id);
  }
  return out;
}

/**
 * The sites that have a cookie in `after` that was not in `before` (a new cookie, or one set again
 * with a new value — Chrome gives that a new creation time). With `before` unknown every site with
 * cookies counts: the safe direction, since a logged-in site starts locked (§4.12: "if that cannot be
 * done reliably, every site in the headed profile is treated as logged in").
 */
export function sitesThatGainedCookies(before: CookieSnapshot | undefined, after: CookieSnapshot | undefined): string[] {
  if (!after) return [];
  const out: string[] = [];
  for (const [site, ids] of after) {
    const had = before?.get(site);
    if (!had || [...ids].some((id) => !had.has(id))) out.push(site);
  }
  return out.sort();
}

// ── "Open agent browser" ────────────────────────────────────────────────────────────────────────

/** Every argument "Open agent browser" may pass, by name. Anything else fails `agentBrowserArgProblems`. */
export const AGENT_BROWSER_FLAG_ALLOW_LIST: readonly string[] = ["--user-data-dir", "--password-store", "--use-mock-keychain", "--no-first-run", "--no-default-browser-check"];

/**
 * The command line for the owner's own window on the agent profile (item 29). Pure. The same profile
 * folder and the same `--password-store=basic --use-mock-keychain` Playwright uses, so a login made
 * here is readable by the agent's browser. No proxy (the owner is browsing, not the agent), no
 * debugging port, no automation switch, and nothing that hides anything from a web page.
 */
export function buildAgentBrowserCommand(input: { chromePath: string; stateDir: string }): { command: string; args: string[]; profileDir: string } {
  const profileDir = browserProfileDir(input.stateDir);
  return {
    command: input.chromePath,
    args: [`--user-data-dir=${profileDir}`, "--password-store=basic", "--use-mock-keychain", "--no-first-run", "--no-default-browser-check"],
    profileDir,
  };
}

/** Why an "Open agent browser" argument list is not the one Anvil builds (empty = fine). */
export function agentBrowserArgProblems(args: readonly string[], stateDir: string): string[] {
  const problems: string[] = [];
  const names = args.map((a) => a.split("=")[0]!);
  for (const [i, a] of args.entries()) {
    if (!a.startsWith("--")) problems.push(`unexpected argument ${a}`);
    else if (!AGENT_BROWSER_FLAG_ALLOW_LIST.includes(names[i]!)) problems.push(`${names[i]} is not on the allow list`);
  }
  for (const need of ["--user-data-dir", "--password-store", "--use-mock-keychain"]) {
    if (names.filter((n) => n === need).length !== 1) problems.push(`${need} must be passed exactly once`);
  }
  if (!args.includes(`--user-data-dir=${browserProfileDir(stateDir)}`)) problems.push("the profile must be the agent browser's own folder");
  if (!args.includes("--password-store=basic")) problems.push("--password-store must be basic");
  return problems;
}

/** A started Chrome: `exited` settles when the process is gone. */
export interface AgentBrowserProcess {
  exited: Promise<unknown>;
  kill(): void;
}
export type AgentBrowserLauncher = (command: string, args: string[], env: Record<string, string>) => AgentBrowserProcess;

/** Start Chrome itself (not through `open`, so its exit can be awaited) with nothing inherited. */
export const defaultAgentBrowserLauncher: AgentBrowserLauncher = (command, args, env) => {
  const proc = Bun.spawn([command, ...args], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return { exited: proc.exited, kill: () => proc.kill() };
};

/**
 * Why the DEFAULT launcher must not start a Chrome window here, or undefined (test safety, C3 review
 * item 7): under a test runner (`NODE_ENV=test`, which `bun test` sets; `BUN_TEST`; `ANVIL_TEST=1`),
 * or when the daemon's state folder is inside the OS temp folder (a test daemon, a throwaway
 * daemon). A test that means to exercise "Open agent browser" passes its own launcher.
 */
export function defaultLauncherRefusal(stateDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.NODE_ENV === "test" || env.BUN_TEST || env.ANVIL_TEST === "1") return "this daemon is running under a test runner";
  const within = (dir: string, root: string): boolean => dir === root || dir.startsWith(`${root}/`);
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const roots = [...new Set([tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].map(real))];
  const dir = real(stateDir);
  if (roots.some((r) => within(dir, r))) return "this daemon's state folder is in the temporary folder (a test or throwaway daemon)";
  return undefined;
}

export interface OwnerBrowserRunDeps {
  stateDir: string;
  chromePath: string;
  env: Record<string, string>;
  launcher?: AgentBrowserLauncher;
  /** Called once Chrome has exited, with the sites that gained cookies while it was open. */
  onClosed: (gained: string[]) => void;
}

/**
 * Run one "Open agent browser" session: snapshot the profile's cookies, start Chrome, and when it
 * exits snapshot again and report the sites that gained cookies. @throws when the command line fails
 * its own check or Chrome cannot be started.
 */
export function runOwnerBrowser(deps: OwnerBrowserRunDeps): AgentBrowserProcess & { done: Promise<string[]> } {
  const cmd = buildAgentBrowserCommand({ chromePath: deps.chromePath, stateDir: deps.stateDir });
  const problems = agentBrowserArgProblems(cmd.args, deps.stateDir);
  if (problems.length) throw new Error(`the agent browser's command line failed its own check (${problems[0]})`);
  if (!deps.launcher) {
    const refusal = defaultLauncherRefusal(deps.stateDir);
    if (refusal) throw new Error(`Open agent browser would start a visible Chrome window, and ${refusal}; it is refused here`);
  }
  mkdirSync(cmd.profileDir, { recursive: true, mode: 0o700 });
  const before = readCookieSnapshot(cmd.profileDir);
  const proc = (deps.launcher ?? defaultAgentBrowserLauncher)(cmd.command, cmd.args, deps.env);
  const done = Promise.resolve(proc.exited)
    .catch(() => undefined)
    .then(() => {
      const gained = sitesThatGainedCookies(before, readCookieSnapshot(cmd.profileDir));
      deps.onClosed(gained);
      return gained;
    });
  return { exited: proc.exited, kill: () => proc.kill(), done };
}
