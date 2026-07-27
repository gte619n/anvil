import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { looksLikeMeteredKey, mask } from "./env-file";
import { checkAuth, type GuardStatus } from "./guard";

/**
 * The daemon's roster of Claude subscription accounts (2026-07-25 multi-account design §3).
 *
 * Source of truth for WHICH tokens exist and which is the default. The default's token is separately
 * mirrored into `~/.config/anvil/env` by the caller via `setClaudeToken()` (§3.2) — this module is
 * deliberately ignorant of the env file so it can be unit-tested without touching $HOME.
 *
 * Hub vs replica: a hub owns a writable roster. A member that has received a push holds a
 * `role: "replica"` copy and refuses local mutation, so there is exactly one writer per fleet.
 * The hub's identity is NOT stored here — `PairedHubStore` (server/pairing.ts) already persists it.
 */

export interface ClaudeAccount {
  id: string;
  label: string;
  token: string;
  createdAt: number;
}

/** What a client is allowed to see: never the raw token. */
export interface PublicAccount {
  id: string;
  label: string;
  masked: string;
  createdAt: number;
}

export interface RosterSnapshot {
  rev: number;
  defaultId?: string;
  role: "hub" | "replica";
}

/** The wire shape pushed hub → member, carried on FleetPairRequest / FleetTokenRequest (§7.3). */
export interface RosterPayload {
  rev: number;
  defaultId: string;
  entries: ClaudeAccount[];
}

interface RosterFile {
  rev: number;
  defaultId?: string;
  role: "hub" | "replica";
  accounts: ClaudeAccount[];
}

export function newAccountId(): string {
  return `acct_${randomBytes(8).toString("hex")}`;
}

export const MAX_LABEL_LENGTH = 32;

function cleanToken(token: string): string {
  const t = token.trim();
  if (!t) throw new Error("a Claude OAuth token is required");
  if (looksLikeMeteredKey(t)) {
    throw new Error(
      "that looks like a metered ANTHROPIC_API_KEY, not a subscription OAuth token — run `claude setup-token` and paste that token instead (arch §3)",
    );
  }
  // Validation used to be negative-only: it rejected metered keys but accepted literally any other
  // string, so "not-a-real-token" was persisted and replicated to every member, only failing much
  // later as an opaque SDK error mid-turn. This is deliberately a LOOSE prefix check, matching the
  // guard's "plausible" wording (auth/guard.ts) — it catches a pasted password or truncated copy
  // without pretending to know the exact format of a token Anthropic may change.
  if (!/^sk-ant-/.test(t)) {
    throw new Error("that doesn't look like a Claude OAuth token — it should start with `sk-ant-`; run `claude setup-token` and paste the whole value");
  }
  return t;
}

export class AccountStore {
  private readonly file: string;
  private data: RosterFile = { rev: 0, role: "hub", accounts: [] };

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, "accounts.json");
    this.load();
  }

  // ── reads ────────────────────────────────────────────────────────────────────
  list(): ClaudeAccount[] {
    return this.data.accounts.map((a) => ({ ...a }));
  }

  publicList(): PublicAccount[] {
    return this.data.accounts.map(({ id, label, token, createdAt }) => ({ id, label, masked: mask(token), createdAt }));
  }

  snapshot(): RosterSnapshot {
    return { rev: this.data.rev, ...(this.data.defaultId ? { defaultId: this.data.defaultId } : {}), role: this.data.role };
  }

  defaultId(): string | undefined {
    return this.data.defaultId;
  }

  isEmpty(): boolean {
    return this.data.accounts.length === 0;
  }

  has(id: string): boolean {
    return this.data.accounts.some((a) => a.id === id);
  }

  get(id: string): ClaudeAccount | undefined {
    const a = this.data.accounts.find((x) => x.id === id);
    return a ? { ...a } : undefined;
  }

  labelOf(id: string | undefined): string | undefined {
    return id ? this.data.accounts.find((a) => a.id === id)?.label : undefined;
  }

  /**
   * The token for `id`, or the default's when `id` is undefined. An id that is PRESENT but unknown
   * returns undefined rather than falling back — a silent swap to another subscription is precisely
   * what this feature exists to prevent (§5.4). The caller decides between fallback and refusal.
   */
  token(id: string | undefined): string | undefined {
    const target = id ?? this.data.defaultId;
    if (!target) return undefined;
    return this.data.accounts.find((a) => a.id === target)?.token;
  }

  /** The full roster in push shape. Returns undefined when there is nothing to replicate. */
  payload(): RosterPayload | undefined {
    if (!this.data.defaultId || this.data.accounts.length === 0) return undefined;
    return { rev: this.data.rev, defaultId: this.data.defaultId, entries: this.list() };
  }

  // ── writes (hub only) ────────────────────────────────────────────────────────
  add(label: string, token: string, id: string = newAccountId()): ClaudeAccount {
    this.assertWritable();
    const cleanTok = cleanToken(token);
    this.assertTokenUnused(cleanTok);
    const clean = { label: this.cleanLabel(label), token: cleanTok };
    const account: ClaudeAccount = { id, ...clean, createdAt: Date.now() };
    this.data.accounts.push(account);
    this.data.defaultId ??= id; // the first account is the default; later ones never steal it
    this.bump();
    return { ...account };
  }

  rename(id: string, label: string): void {
    this.assertWritable();
    const a = this.require(id);
    a.label = this.cleanLabel(label, id);
    this.bump();
  }

  replace(id: string, token: string): void {
    this.assertWritable();
    const a = this.require(id);
    const cleanTok = cleanToken(token);
    this.assertTokenUnused(cleanTok, id);
    a.token = cleanTok;
    this.bump();
  }

  setDefault(id: string): void {
    this.assertWritable();
    this.require(id);
    this.data.defaultId = id;
    this.bump();
  }

  remove(id: string): void {
    this.assertWritable();
    const target = this.require(id);
    if (this.data.accounts.length === 1) {
      throw new Error("this is the last account — add another before removing it");
    }
    // Design §10: removing the default requires choosing a new one FIRST. Silently repointing it at
    // accounts[0] — arbitrary insertion order, not a choice — would move every default-following
    // session onto a different subscription with no prompt and no badge. That matters more since the
    // removal fallback started clearing `accountId` (so those sessions genuinely track the default),
    // and it is the same "surprise about who paid" this feature exists to prevent.
    if (this.data.defaultId === id) {
      throw new Error(`"${target.label}" is the default account — make another account the default before removing it`);
    }
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    this.bump();
  }

  /**
   * Replace this roster with one pushed by the hub (§7.3). Flips the store to replica mode.
   *
   * Returns false and changes NOTHING for a stale push. Rotation is a fan-out of concurrent HTTP
   * requests with retries, so two pushes can land out of order; without this an older payload could
   * silently move a member BACKWARDS — resurrecting a removed account, or restoring a rotated token —
   * and the member would then sit at a rev the hub believes it has already passed.
   */
  adoptReplica(payload: RosterPayload): boolean {
    if (this.data.role === "replica" && payload.rev < this.data.rev) return false;
    const byId = new Map(payload.entries.map((e) => [e.id, { ...e }]));
    this.data = { rev: payload.rev, defaultId: payload.defaultId, role: "replica", accounts: [...byId.values()] };
    this.save();
    return true;
  }

  // ── internals ────────────────────────────────────────────────────────────────
  private assertWritable(): void {
    if (this.data.role === "replica") {
      throw new Error("this machine holds a replica of its hub's account roster — change accounts on the hub");
    }
  }

  /** F6: labels dedup, tokens didn't — so one subscription could be added twice under two names, with
   *  matching masked previews as the only cue. Every downstream count ("2 Claude accounts"), the
   *  session picker and the per-account billing story then all lie. */
  private assertTokenUnused(token: string, exceptId?: string): void {
    const clash = this.data.accounts.find((a) => a.id !== exceptId && a.token === token);
    if (clash) throw new Error(`that token is already on the roster as "${clash.label}"`);
  }

  private cleanLabel(label: string, exceptId?: string): string {
    const l = label.trim();
    if (!l) throw new Error("a label is required");
    if (l.length > MAX_LABEL_LENGTH) throw new Error(`labels are limited to ${MAX_LABEL_LENGTH} characters`);
    const clash = this.data.accounts.find((a) => a.id !== exceptId && a.label.toLowerCase() === l.toLowerCase());
    if (clash) throw new Error(`an account called "${clash.label}" already exists`);
    return l;
  }

  private require(id: string): ClaudeAccount {
    const a = this.data.accounts.find((x) => x.id === id);
    if (!a) throw new Error(`unknown account ${id}`);
    return a;
  }

  private bump(): void {
    this.data.rev += 1;
    this.save();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<RosterFile>;
      const accounts = Array.isArray(raw.accounts) ? raw.accounts.filter((a) => a && typeof a.id === "string" && typeof a.token === "string") : [];
      // Drop duplicate ids (reachable via a malformed push) — last write wins, as adoptReplica implies.
      const byId = new Map(accounts.map((a) => [a.id, a]));
      const deduped = [...byId.values()];
      // A defaultId pointing at nothing would make token(undefined) silently return undefined and every
      // spawn fail with "no Claude OAuth token". Fall back to the first surviving account instead.
      const defaultId = raw.defaultId && byId.has(raw.defaultId) ? raw.defaultId : deduped[0]?.id;
      this.data = {
        rev: typeof raw.rev === "number" ? raw.rev : 0,
        ...(defaultId ? { defaultId } : {}),
        role: raw.role === "replica" ? "replica" : "hub",
        accounts: deduped,
      };
    } catch (e) {
      // A truncated/corrupt roster must NOT be silently discarded: it holds every Claude token, and
      // resetting to an empty `role: "hub"` would ALSO promote a member's replica to a writable hub,
      // breaking the single-writer invariant. Preserve the bytes for recovery and say so loudly.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        renameSync(this.file, backup);
      } catch {
        /* best-effort — an unreadable file we also can't move still must not crash the daemon */
      }
      console.error(
        `[accounts] ${this.file} was unreadable (${e instanceof Error ? e.message : e}); moved to ${backup}. ` +
          `Starting with an EMPTY roster — if this machine is a fleet member, re-pair it or press Sync now on the hub.`,
      );
      this.data = { rev: 0, role: "hub", accounts: [] };
    }
  }

  /** Atomic write (tmp + rename) so a crash mid-write can never truncate the roster — the same rule
   *  SessionStore follows. A torn accounts.json loses every token AND silently reverts a replica to a
   *  writable hub, so this is the more important of the two. */
  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/**
 * `checkAuth()` widened by the roster (multi-account §4.2). A fatal §3 violation always wins. A
 * non-empty roster satisfies the positive condition even when the mirrored env line is missing, so a
 * read-only or hand-edited env file can't make a perfectly good roster look unauthenticated.
 */
export function resolveAuthStatus(opts: { env?: Record<string, string | undefined>; accounts: AccountStore }): GuardStatus {
  const base = checkAuth(opts.env ?? process.env);
  if (base.fatal || base.subscriptionAuthOk) return base;
  if (!opts.accounts.isEmpty()) return { subscriptionAuthOk: true, fatal: false };
  return base;
}
