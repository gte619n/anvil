import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    const clean = { label: this.cleanLabel(label), token: cleanToken(token) };
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
    a.token = cleanToken(token);
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
    this.require(id);
    if (this.data.accounts.length === 1) {
      throw new Error("this is the last account — add another before removing it");
    }
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (this.data.defaultId === id) this.data.defaultId = this.data.accounts[0]?.id;
    this.bump();
  }

  /** Replace this roster with one pushed by the hub (§7.3). Flips the store to replica mode. */
  adoptReplica(payload: RosterPayload): void {
    this.data = { rev: payload.rev, defaultId: payload.defaultId, role: "replica", accounts: payload.entries.map((e) => ({ ...e })) };
    this.save();
  }

  // ── internals ────────────────────────────────────────────────────────────────
  private assertWritable(): void {
    if (this.data.role === "replica") {
      throw new Error("this machine holds a replica of its hub's account roster — change accounts on the hub");
    }
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
      this.data = {
        rev: typeof raw.rev === "number" ? raw.rev : 0,
        ...(raw.defaultId ? { defaultId: raw.defaultId } : {}),
        role: raw.role === "replica" ? "replica" : "hub",
        accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
      };
    } catch {
      this.data = { rev: 0, role: "hub", accounts: [] }; // corrupt — behave as empty (FleetStore's rule)
    }
  }

  private save(): void {
    writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
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
