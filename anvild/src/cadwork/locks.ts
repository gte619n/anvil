/**
 * The lock store (agent-cad-and-browser spec §4.1, §4.14 #42): what the OWNER approved, kept outside
 * every repo so the agent's edits to `part.json` or `cad/rules.json` can never count as approval.
 *
 * Per (repo, part): the sha256 of the approved block (see `lockedBlockSha`), who approved it, the
 * EVALUATED numbers that were accepted, and the approved `ownerParams`. Per repo: the sha256 (and
 * text, so an adopt card can show a diff) of the approved `cad/rules.json`. The gate trusts a repo
 * file only when its hash matches.
 *
 * The repo key is the remote URL when there is one, else the repo's real path — so every worktree
 * and every clone of one repo shares its approvals.
 *
 * FILE: `<stateDir>/cadwork/locks.json`. A file that does not parse is moved aside
 * (`locks.json.corrupt-<time>`) and the store starts empty: every part then needs adopting again,
 * which is the safe direction.
 *
 * HUB SYNC (`LockSync`). The store is hub-authoritative and fleet-wide:
 *   - standalone: the local file is everything.
 *   - hub:    an approval is stored and pushed to every member (`POST /api/fleet/cad-locks`).
 *   - member: an approval is applied locally at once, queued, and sent to the hub
 *             (`POST /api/fleet/cad-locks/approve`). The hub's reply is its merged store, which
 *             replaces the member's copy. While the hub cannot be reached the member keeps working
 *             from its copy and the approval stays queued (persisted) until a later flush.
 *   - conflicts: per (repo, part) — and per repo for rules — the approval with the LATEST `at`
 *             wins. An equal time keeps the copy already held (on the hub: the hub's).
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../util/atomic";
import type { EvaluatedExpectations, LockedBy, PartStatusKind } from "./partfile";

export interface PartLock {
  repo: string;
  part: string;
  /** `lockedBlockSha` of the approved process + status + expectations. */
  sha: string;
  approvedBy: LockedBy;
  status: PartStatusKind;
  /** The evaluated numbers the owner last accepted (absent for a concept part with no expectations). */
  values?: EvaluatedExpectations;
  ownerParams?: Record<string, number>;
  /** ISO time of the approval — the conflict rule's clock. */
  at: string;
  /** serverId of the machine the approval was made on. */
  machine?: string;
}

export interface RulesLock {
  repo: string;
  sha: string;
  /** The approved file's text, kept so the next adopt card can show what changed. */
  text: string;
  at: string;
  machine?: string;
}

export interface LockSnapshot {
  parts: PartLock[];
  rules: RulesLock[];
}

export type PendingApproval = { id: string; kind: "part"; lock: PartLock } | { id: string; kind: "rules"; lock: RulesLock };

interface LockFile {
  schema: 1;
  parts: PartLock[];
  rules: RulesLock[];
  pending: PendingApproval[];
  hub?: { serverId: string; url?: string };
}

const partKey = (repo: string, part: string): string => `${repo}\n${part}`;
const time = (iso: string | undefined): number => {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? 0 : t;
};
/** Whether `a` replaces `b` under the conflict rule (strictly later wins; a tie keeps `b`). */
export const isNewer = (a: { at: string }, b: { at: string } | undefined): boolean => !b || time(a.at) > time(b.at);

function git(cwd: string, args: string[]): string | undefined {
  try {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    return r.exitCode === 0 ? r.stdout.toString().trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The key approvals are stored under for the repo containing `worktree`: its remote URL (`origin`,
 * else the first remote) with a trailing `.git` or `/` removed; with no remote, the real path of the
 * MAIN checkout (so a session's linked worktree shares the repo's approvals).
 */
export function repoKey(worktree: string): string {
  const remote = git(worktree, ["config", "--get", "remote.origin.url"]) ?? (() => {
    const first = git(worktree, ["remote"])?.split("\n")[0]?.trim();
    return first ? git(worktree, ["config", "--get", `remote.${first}.url`]) : undefined;
  })();
  if (remote) return remote.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const common = git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  try {
    if (common) {
      const real = realpathSync(common);
      return real.endsWith("/.git") ? dirname(real) : real;
    }
    return realpathSync(worktree);
  } catch {
    return worktree;
  }
}

let quarantineSeq = 0;

export class LockStore {
  readonly file: string;
  private parts = new Map<string, PartLock>();
  private rules = new Map<string, RulesLock>();
  private queue: PendingApproval[] = [];
  private hubInfo: { serverId: string; url?: string } | undefined;
  private readonly listeners = new Set<() => void>();
  /** Set when the file on disk could not be read and was moved aside. */
  quarantined: string | undefined;

  constructor(stateDir: string) {
    const dir = join(stateDir, "cadwork");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "locks.json");
    this.load();
  }

  getPart(repo: string, part: string): PartLock | undefined {
    return this.parts.get(partKey(repo, part));
  }
  getRules(repo: string): RulesLock | undefined {
    return this.rules.get(repo);
  }
  snapshot(): LockSnapshot {
    return { parts: [...this.parts.values()], rules: [...this.rules.values()] };
  }
  pending(): PendingApproval[] {
    return [...this.queue];
  }
  hub(): { serverId: string; url?: string } | undefined {
    return this.hubInfo ? { ...this.hubInfo } : undefined;
  }
  /** Called after every change to what is approved (not for queue bookkeeping). Returns unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Record an approval made on this machine. Always applied: the owner just made it. */
  putPart(lock: PartLock): void {
    this.parts.set(partKey(lock.repo, lock.part), lock);
    this.changed();
  }
  putRules(lock: RulesLock): void {
    this.rules.set(lock.repo, lock);
    this.changed();
  }

  /** Fold approvals in under the conflict rule (latest `at` wins). Returns how many were taken. */
  merge(incoming: Partial<LockSnapshot>): number {
    let taken = 0;
    for (const p of validParts(incoming.parts)) {
      if (isNewer(p, this.parts.get(partKey(p.repo, p.part)))) {
        this.parts.set(partKey(p.repo, p.part), p);
        taken++;
      }
    }
    for (const r of validRules(incoming.rules)) {
      if (isNewer(r, this.rules.get(r.repo))) {
        this.rules.set(r.repo, r);
        taken++;
      }
    }
    if (taken) this.changed();
    return taken;
  }

  /** Take the hub's store as the truth, then lay this machine's undelivered approvals back on top
   *  (each only where it is newer than what the hub holds). */
  replaceFromHub(snapshot: Partial<LockSnapshot>): boolean {
    const before = JSON.stringify(this.snapshot());
    this.parts = new Map(validParts(snapshot.parts).map((p) => [partKey(p.repo, p.part), p]));
    this.rules = new Map(validRules(snapshot.rules).map((r) => [r.repo, r]));
    for (const q of this.queue) {
      if (q.kind === "part" && isNewer(q.lock, this.parts.get(partKey(q.lock.repo, q.lock.part)))) this.parts.set(partKey(q.lock.repo, q.lock.part), q.lock);
      if (q.kind === "rules" && isNewer(q.lock, this.rules.get(q.lock.repo))) this.rules.set(q.lock.repo, q.lock);
    }
    const changed = JSON.stringify(this.snapshot()) !== before;
    if (changed) this.changed();
    else this.save();
    return changed;
  }

  enqueue(item: PendingApproval): void {
    this.queue.push(item);
    this.save();
  }
  dequeue(ids: string[]): void {
    if (ids.length === 0) return;
    this.queue = this.queue.filter((q) => !ids.includes(q.id));
    this.save();
  }
  setHub(hub: { serverId: string; url?: string } | undefined): void {
    if (JSON.stringify(hub) === JSON.stringify(this.hubInfo)) return;
    this.hubInfo = hub;
    this.save();
  }

  private changed(): void {
    this.save();
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* a listener must never break an approval */
      }
    }
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<LockFile>;
      if (!raw || typeof raw !== "object" || raw.schema !== 1) throw new Error("not a schema-1 lock store");
      this.parts = new Map(validParts(raw.parts).map((p) => [partKey(p.repo, p.part), p]));
      this.rules = new Map(validRules(raw.rules).map((r) => [r.repo, r]));
      this.queue = Array.isArray(raw.pending) ? raw.pending.filter((q) => q && typeof q.id === "string" && (q.kind === "part" || q.kind === "rules") && q.lock) : [];
      this.hubInfo = raw.hub && typeof raw.hub.serverId === "string" ? { serverId: raw.hub.serverId, ...(typeof raw.hub.url === "string" ? { url: raw.hub.url } : {}) } : undefined;
    } catch (e) {
      // Quarantine, never guess: an unreadable store means nothing is approved on this machine.
      const aside = `${this.file}.corrupt-${Date.now()}-${++quarantineSeq}`;
      try {
        renameSync(this.file, aside);
        this.quarantined = aside;
      } catch {
        /* could not move it — the next save overwrites it */
      }
      console.error(`[cad] lock store ${this.file} could not be read (${e instanceof Error ? e.message : String(e)}); moved aside to ${aside}. Every part needs adopting again.`);
      this.parts = new Map();
      this.rules = new Map();
      this.queue = [];
      this.hubInfo = undefined;
    }
  }

  private save(): void {
    const doc: LockFile = { schema: 1, parts: [...this.parts.values()], rules: [...this.rules.values()], pending: this.queue, ...(this.hubInfo ? { hub: this.hubInfo } : {}) };
    writeFileAtomic(this.file, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  }
}

function validParts(list: unknown): PartLock[] {
  if (!Array.isArray(list)) return [];
  return list.filter((p): p is PartLock => !!p && typeof p.repo === "string" && typeof p.part === "string" && typeof p.sha === "string" && typeof p.at === "string");
}
function validRules(list: unknown): RulesLock[] {
  if (!Array.isArray(list)) return [];
  return list.filter((r): r is RulesLock => !!r && typeof r.repo === "string" && typeof r.sha === "string" && typeof r.at === "string" && typeof r.text === "string");
}

// ── hub sync ──────────────────────────────────────────────────────────────────────────────────────

export const LOCKS_PUSH_PATH = "/api/fleet/cad-locks";
export const LOCKS_APPROVE_PATH = "/api/fleet/cad-locks/approve";

/** Hub → member: the hub's whole store. */
export interface LocksPushBody extends LockSnapshot {
  hubServerId: string;
  /** Where members send their approvals. Absent when the hub cannot tell its own address. */
  hubUrl?: string;
}
/** Member → hub: approvals made on that member. */
export interface LocksApproveBody extends LockSnapshot {
  serverId: string;
}
/** The hub's answer: its store after merging. */
export interface LocksApproveReply extends LockSnapshot {
  ok: boolean;
  hubServerId?: string;
  error?: string;
}

export type FleetRole =
  | { kind: "standalone"; serverId?: string }
  | { kind: "hub"; serverId: string; selfUrl: () => Promise<string | undefined>; members: () => { serverId: string; url: string; host?: string }[] }
  | { kind: "member"; serverId: string; hubServerId: string };

/** https and http forms of a daemon base URL, the given one first (a transport can change after pairing). */
function bothSchemes(url: string): string[] {
  const base = url.replace(/\/+$/, "");
  const other = base.startsWith("https://") ? base.replace(/^https:/, "http:") : base.startsWith("http://") ? base.replace(/^http:/, "https:") : undefined;
  return other ? [base, other] : [base];
}

export interface LockSyncOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  newId?: () => string;
  /** Approvals arrived from another machine (through the hub): re-check open parts. */
  onRemoteChange?: () => void;
}

export class LockSync {
  private role: () => FleetRole = () => ({ kind: "standalone" });
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly newId: () => string;
  private seq = 0;
  private readonly onRemoteChange: () => void;
  private inFlight: Promise<unknown> = Promise.resolve();
  /** Members the last push did not reach (hub only). */
  readonly unreached = new Set<string>();

  constructor(
    readonly store: LockStore,
    opts: LockSyncOptions = {},
  ) {
    this.doFetch = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.onRemoteChange = () => {
      try {
        opts.onRemoteChange?.();
      } catch {
        /* a listener must never break the sync */
      }
    };
    this.newId = opts.newId ?? (() => `appr_${Date.now().toString(36)}_${(++this.seq).toString(36)}`);
  }

  /** Tell the sync what this daemon is in the fleet. Read on every use, so pairing takes effect live. */
  setRole(role: () => FleetRole): void {
    this.role = role;
  }
  currentRole(): FleetRole {
    try {
      return this.role();
    } catch {
      return { kind: "standalone" };
    }
  }

  /** Everything this sync has started in the background has finished (tests; shutdown). */
  settled(): Promise<void> {
    return this.inFlight.then(
      () => undefined,
      () => undefined,
    );
  }
  private background(p: Promise<unknown>): void {
    const prev = this.inFlight;
    this.inFlight = Promise.allSettled([prev, p]);
  }

  /** An approval or adoption made on THIS machine. Applied locally first, then synced by role. */
  approvePart(lock: PartLock): void {
    const role = this.currentRole();
    const stamped = { ...lock, ...(role.serverId ? { machine: role.serverId } : {}) };
    this.store.putPart(stamped);
    this.afterLocal(role, { id: this.newId(), kind: "part", lock: stamped });
  }
  approveRules(lock: RulesLock): void {
    const role = this.currentRole();
    const stamped = { ...lock, ...(role.serverId ? { machine: role.serverId } : {}) };
    this.store.putRules(stamped);
    this.afterLocal(role, { id: this.newId(), kind: "rules", lock: stamped });
  }
  private afterLocal(role: FleetRole, item: PendingApproval): void {
    if (role.kind === "member") {
      this.store.enqueue(item); // persisted before any network call: a crash cannot lose it
      this.background(this.flush());
    } else if (role.kind === "hub") {
      this.background(this.broadcast());
    }
  }

  /** MEMBER: deliver queued approvals to the hub. Whatever cannot be delivered stays queued. */
  async flush(): Promise<{ delivered: number; queued: number }> {
    const role = this.currentRole();
    const queued = this.store.pending();
    if (role.kind !== "member" || queued.length === 0) return { delivered: 0, queued: queued.length };
    const hub = this.store.hub();
    if (!hub?.url || hub.serverId !== role.hubServerId) return { delivered: 0, queued: queued.length };
    const body: LocksApproveBody = {
      serverId: role.serverId,
      parts: queued.filter((q) => q.kind === "part").map((q) => q.lock as PartLock),
      rules: queued.filter((q) => q.kind === "rules").map((q) => q.lock as RulesLock),
    };
    for (const base of bothSchemes(hub.url)) {
      try {
        const res = await this.doFetch(`${base}${LOCKS_APPROVE_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const data = (await res.json().catch(() => ({}))) as Partial<LocksApproveReply>;
        if (!res.ok || data.ok !== true) continue;
        this.store.dequeue(queued.map((q) => q.id));
        // The hub's merged store is the truth (it may have kept a later approval than ours).
        if (this.store.replaceFromHub(data)) this.onRemoteChange();
        return { delivered: queued.length, queued: this.store.pending().length };
      } catch {
        /* unreachable on this scheme — try the other, else stay queued */
      }
    }
    return { delivered: 0, queued: queued.length };
  }

  /** HUB: approvals arriving from a member. Merged under the conflict rule, then pushed to the fleet. */
  acceptFromMember(body: Partial<LocksApproveBody>): LocksApproveReply {
    const role = this.currentRole();
    if (this.store.merge(body) > 0) this.onRemoteChange();
    if (role.kind === "hub") this.background(this.broadcast());
    return { ok: true, ...(role.serverId ? { hubServerId: role.serverId } : {}), ...this.store.snapshot() };
  }

  /** MEMBER: the hub's store arrived. It replaces the local copy; anything queued is then sent. */
  acceptFromHub(body: Partial<LocksPushBody>): void {
    if (typeof body.hubServerId === "string") this.store.setHub({ serverId: body.hubServerId, ...(typeof body.hubUrl === "string" && body.hubUrl ? { url: body.hubUrl } : this.store.hub()?.url ? { url: this.store.hub()!.url } : {}) });
    if (this.store.replaceFromHub(body)) this.onRemoteChange();
    if (this.store.pending().length) this.background(this.flush());
  }

  /** HUB: push the whole store to members (all, or the given serverIds). Best-effort per member. */
  async broadcast(targets?: string[]): Promise<{ serverId: string; ok: boolean; error?: string }[]> {
    const role = this.currentRole();
    if (role.kind !== "hub") return [];
    const hubUrl = await role.selfUrl().catch(() => undefined);
    const body: LocksPushBody = { hubServerId: role.serverId, ...(hubUrl ? { hubUrl } : {}), ...this.store.snapshot() };
    const members = role.members().filter((m) => !targets || targets.includes(m.serverId));
    return Promise.all(
      members.map(async (m) => {
        let error = "no reachable transport";
        for (const base of bothSchemes(m.url)) {
          try {
            const res = await this.doFetch(`${base}${LOCKS_PUSH_PATH}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(this.timeoutMs),
            });
            const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
            if (res.ok && data.ok !== false) {
              this.unreached.delete(m.serverId);
              return { serverId: m.serverId, ok: true };
            }
            error = data.error ?? `HTTP ${res.status}`;
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
        }
        this.unreached.add(m.serverId);
        return { serverId: m.serverId, ok: false, error };
      }),
    );
  }

  /** HUB: try again for members the last push missed. MEMBER: try the queue again. */
  async retry(): Promise<void> {
    const role = this.currentRole();
    if (role.kind === "hub" && this.unreached.size) await this.broadcast([...this.unreached]);
    if (role.kind === "member") await this.flush();
  }
}
