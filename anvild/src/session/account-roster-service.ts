/**
 * Claude multi-account roster domain (Settings → Models; multi-account §7/§9), extracted from Supervisor
 * as the second slice of the P7 god-file decomposition. Owns the roster snapshot + the mutators
 * (add/rename/replace/set-default/remove) with their side effects: mirror the default account to the
 * launcher env file, replicate to fleet members, restart only the idle sessions whose resolved token
 * actually changed, and reconcile sessions + environments bound to a removed account.
 *
 * Behaviour-preserving: methods moved verbatim from Supervisor with every Supervisor internal they touch
 * INJECTED (the roster is genuinely woven into session/env/driver state, so the deps surface is wide but
 * EXPLICIT — that documentation of the coupling is part of the value). The Supervisor delegates its
 * public roster commands here. Covered by the existing account test suite (session-account-*,
 * accounts-restart, accounts-supervisor, accounts-replication) exercised through those delegations.
 */
import { PROTOCOL_VERSION, type AccountInfo, type AuthAccountsEvent, type EnvironmentsEvent, type Session as SessionData } from "@protocol";
import { now } from "../util/envelope";
import { AccountStore } from "../auth/accounts";
import { mirrorDefault, defaultPersisted } from "../auth/account-mirror";
import type { ConnectionRegistry } from "../server/registry";
import type { EnvironmentStore } from "../env/store";
import type { PairedHubStore } from "../server/pairing";
import type { Session } from "./session";
import { BadCommand } from "./errors";

export interface AccountRosterDeps {
  accounts: AccountStore;
  registry: ConnectionRegistry;
  /** Launcher env file the default account is mirrored to (undefined in some tests). */
  envFile: string | undefined;
  envStore: EnvironmentStore;
  /** The hub this member is paired to (for the roster event's hubServerId on a replica). */
  pairedHub: PairedHubStore | undefined;
  /** Live view of the session registry (roster reconciles sessions bound to an account). */
  sessions: () => Iterable<Session>;
  /** Snapshot of each session's resolved token BEFORE a mutation — narrows the restart. */
  tokensBySession: () => Map<string, string | undefined>;
  /** Restart idle sessions whose resolved token changed after a mutation. */
  restartIdleSessionsForNewToken: (before: Map<string, string | undefined>) => Promise<void>;
  /** Replicate a roster change to fleet members (§7.3); no-op on a leaf. */
  onRosterChanged?: (reason: string) => void;
  /** Broadcast a single session's updated data (roster rename/remove touch bound sessions). */
  broadcastUpdated: (data: SessionData) => void;
  /** The environments event, broadcast when a removed account leaves a dangling env binding. */
  environmentsEvent: () => EnvironmentsEvent;
  /** Persist the session registry after a mutation touches session data. */
  persist: () => void;
}

export class AccountRosterService {
  constructor(private readonly deps: AccountRosterDeps) {}

  private get accounts(): AccountStore {
    return this.deps.accounts;
  }
  private get registry(): ConnectionRegistry {
    return this.deps.registry;
  }

  /** Active (non-terminal) sessions currently bound to `accountId` — drives the removal confirm
   *  (§9.1/§10) without a second round trip. */
  sessionsUsingAccount(accountId: string): { sessionId: string; title: string }[] {
    return [...this.deps.sessions()]
      .filter((s) => !s.data.archived && s.data.accountId === accountId)
      .map((s) => ({ sessionId: s.data.id, title: s.data.title }));
  }

  private accountsInUse(): Record<string, { sessionId: string; title: string }[]> {
    const out: Record<string, { sessionId: string; title: string }[]> = {};
    for (const s of this.deps.sessions()) {
      if (s.data.archived || !s.data.accountId) continue;
      (out[s.data.accountId] ??= []).push({ sessionId: s.data.id, title: s.data.title });
    }
    return out;
  }

  /** Roster snapshot for clients — masked previews only (§11). */
  accountsEvent(cid?: string): AuthAccountsEvent {
    const snap = this.accounts.snapshot();
    const accounts: AccountInfo[] = this.accounts.publicList();
    const inUse = this.accountsInUse();
    return {
      v: PROTOCOL_VERSION,
      type: "auth.accounts",
      ts: now(),
      ...(cid ? { cid } : {}),
      rev: snap.rev,
      ...(snap.defaultId ? { defaultId: snap.defaultId } : {}),
      role: snap.role,
      ...(snap.role === "replica" && this.deps.pairedHub?.get()?.hubServerId ? { hubServerId: this.deps.pairedHub.get()!.hubServerId } : {}),
      accounts,
      persisted: defaultPersisted(this.accounts, this.deps.envFile),
      ...(Object.keys(inUse).length ? { inUse } : {}),
    };
  }

  /** Broadcast the roster to every connected client, like `broadcastAuthState()`. */
  broadcastAccounts(): void {
    this.registry.toAll(this.accountsEvent());
  }

  /** Every mutator: apply → mirror the default → broadcast → return the same event to the caller. A
   *  mutation on a replica throws `AccountStore`'s "change accounts on the hub" message unchanged
   *  (BadCommand via the caller's catch). `before` — a snapshot from {@link AccountRosterDeps.tokensBySession}
   *  taken BEFORE the mutation — narrows the restart to sessions whose OWN resolved token actually changed
   *  (adding a non-default account, or replacing a token no live session is pinned to, restarts no
   *  one). Fire-and-forget, like every other credential-change call site (http.ts's pair/rotate handlers). */
  private afterAccountMutation(cid: string | undefined, before: Map<string, string | undefined>, reason: string): AuthAccountsEvent {
    mirrorDefault(this.accounts, this.deps.envFile); // the ONLY place a roster change is written to the launcher env file
    this.deps.onRosterChanged?.(reason); // replicate to fleet members (§7.3); fire-and-forget, no-op on a leaf
    void this.deps.restartIdleSessionsForNewToken(before);
    const event = this.accountsEvent(cid);
    this.registry.toAll(cid ? { ...event, cid: undefined } : event);
    return event;
  }

  accountAdd(label: string, token: string, cid?: string): AuthAccountsEvent {
    const before = this.deps.tokensBySession();
    try {
      this.accounts.add(label, token);
    } catch (e) {
      throw new BadCommand(e instanceof Error ? e.message : String(e));
    }
    return this.afterAccountMutation(cid, before, "add");
  }

  accountRename(accountId: string, label: string, cid?: string): AuthAccountsEvent {
    const before = this.deps.tokensBySession();
    try {
      this.accounts.rename(accountId, label);
    } catch (e) {
      throw new BadCommand(e instanceof Error ? e.message : String(e));
    }
    // accountLabel is denormalised for display; refresh every session bound to this account.
    for (const s of this.deps.sessions()) {
      if (s.data.accountId === accountId) {
        s.data.accountLabel = label;
        this.deps.broadcastUpdated(s.data);
      }
    }
    this.deps.persist();
    return this.afterAccountMutation(cid, before, "rename");
  }

  accountReplace(accountId: string, token: string, cid?: string): AuthAccountsEvent {
    const before = this.deps.tokensBySession();
    try {
      this.accounts.replace(accountId, token);
    } catch (e) {
      throw new BadCommand(e instanceof Error ? e.message : String(e));
    }
    return this.afterAccountMutation(cid, before, "replace");
  }

  accountSetDefault(accountId: string, cid?: string): AuthAccountsEvent {
    const before = this.deps.tokensBySession();
    try {
      this.accounts.setDefault(accountId);
    } catch (e) {
      throw new BadCommand(e instanceof Error ? e.message : String(e));
    }
    return this.afterAccountMutation(cid, before, "set-default");
  }

  accountRemove(accountId: string, cid?: string): AuthAccountsEvent {
    const before = this.deps.tokensBySession();
    try {
      this.accounts.remove(accountId);
    } catch (e) {
      throw new BadCommand(e instanceof Error ? e.message : String(e));
    }
    // §5.4 removal fallback: fall every session bound to the removed account back to the default,
    // flagged so the client can render the "⚠ was <label>" badge (Task 24/20).
    //
    // `accountId` is CLEARED rather than set to a snapshot of `defaultId()`. Both resolve to the
    // default today, but a snapshot silently stops tracking it: move the default afterwards and the
    // session keeps spawning on the OLD one while the header chip — which renders the CURRENT
    // default's label — names the new one. The chip then advertises a subscription that isn't paying,
    // which is precisely the confusion this feature exists to prevent. `undefined` genuinely follows
    // the default, because that is what `AccountStore.token(undefined)` resolves.
    //
    // `accountLabel` IS deliberately left holding the removed account's old name — it's the only
    // place that survives the removal, and the badge needs it.
    for (const s of this.deps.sessions()) {
      if (s.data.accountId !== accountId) continue;
      delete s.data.accountId;
      s.data.accountMissing = true;
      this.deps.broadcastUpdated(s.data);
    }
    // Environments bind to accounts too (§6), and were NOT being reconciled — a removed account left a
    // dangling `env.accountId` that only surfaced later, unattended, as a failed autopilot spawn.
    // Clearing it falls the environment back to the roster default, same as a session.
    let envsCleared = 0;
    for (const env of this.deps.envStore.list()) {
      if (env.accountId !== accountId) continue;
      this.deps.envStore.update(env.id, { accountId: null });
      envsCleared++;
    }
    if (envsCleared) this.registry.toAll(this.deps.environmentsEvent());
    this.deps.persist();
    return this.afterAccountMutation(cid, before, "remove");
  }
}
