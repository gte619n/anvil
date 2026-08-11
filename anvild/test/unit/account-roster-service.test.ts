/**
 * [P7] AccountRosterService — the multi-account roster domain extracted from Supervisor. The roster
 * BEHAVIOUR is covered end-to-end by accounts-supervisor / session-account-* through the Supervisor's
 * delegations; this isolates the INJECTION CONTRACT the extraction introduced: mutators fire
 * onRosterChanged(reason) + restartIdleSessionsForNewToken(before) + broadcast, and a removal reconciles
 * bound sessions (accountId cleared, accountMissing set, broadcastUpdated) and bound environments.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent, Session as SessionData } from "@protocol";
import { AccountStore } from "../../src/auth/accounts";
import { AccountRosterService, type AccountRosterDeps } from "../../src/session/account-roster-service";
import type { Session } from "../../src/session/session";

function harness(sessionData: Partial<SessionData>[] = [], envs: { id: string; accountId?: string | null }[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "anvil-roster-"));
  const accounts = new AccountStore(dir);
  const broadcasts: ServerEvent[] = [];
  const updated: SessionData[] = [];
  const rosterReasons: string[] = [];
  let restartCalls = 0;
  const sessions = sessionData.map((d) => ({ data: d as SessionData }) as Session);
  const envStore = {
    list: () => envs,
    update: (id: string, patch: { accountId: string | null }) => {
      const e = envs.find((x) => x.id === id);
      if (e) e.accountId = patch.accountId;
    },
  };
  const deps: AccountRosterDeps = {
    accounts,
    registry: { toAll: (e: ServerEvent) => broadcasts.push(e) } as never,
    envFile: join(dir, "env"),
    envStore: envStore as never,
    pairedHub: undefined,
    sessions: () => sessions,
    tokensBySession: () => new Map(),
    restartIdleSessionsForNewToken: async () => {
      restartCalls++;
    },
    onRosterChanged: (reason) => rosterReasons.push(reason),
    broadcastUpdated: (d) => updated.push(d),
    environmentsEvent: () => ({ v: 4, ts: "t", type: "environments", environments: [] }) as never,
    persist: () => {},
  };
  return { svc: new AccountRosterService(deps), accounts, broadcasts, updated, rosterReasons, envs, sessions, get restartCalls() { return restartCalls; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("[P7] accountAdd fires the injected side effects (roster-changed + restart + broadcast)", () => {
  const h = harness();
  try {
    const ev = h.svc.accountAdd("work", "sk-ant-oat01-workworkwork-1111");
    expect(ev.type).toBe("auth.accounts");
    expect(ev.accounts).toHaveLength(1);
    expect(h.rosterReasons).toEqual(["add"]); // onRosterChanged called with the reason (fleet replication)
    expect(h.restartCalls).toBe(1); // restartIdleSessionsForNewToken called with the before-snapshot
    expect(h.broadcasts.at(-1)?.type).toBe("auth.accounts"); // roster re-broadcast to all clients
  } finally {
    h.cleanup();
  }
});

test("[P7] accountRemove reconciles a bound session AND a bound environment back to the default", () => {
  const h = harness(
    [{ id: "s1", title: "t", accountId: "acc_x", archived: false } as Partial<SessionData>],
    [{ id: "env1", accountId: "acc_x" }],
  );
  try {
    // Seed two accounts so we can remove one (the last account can't be removed), with a known id.
    h.accounts.add("keep", "sk-ant-oat01-keepkeepkeep-0000");
    h.accounts.add("gone", "sk-ant-oat01-gonegonegone-9999", "acc_x");

    h.svc.accountRemove("acc_x");

    // Session bound to the removed account falls back to the default, flagged for the "⚠ was …" badge.
    expect(h.sessions[0]!.data.accountId).toBeUndefined();
    expect(h.sessions[0]!.data.accountMissing).toBe(true);
    expect(h.updated.some((d) => d.id === "s1")).toBe(true); // broadcastUpdated fired for the bound session
    // Environment binding reconciled too (was the dangling-env bug).
    expect(h.envs.find((e) => e.id === "env1")?.accountId).toBeNull();
    expect(h.rosterReasons.at(-1)).toBe("remove");
  } finally {
    h.cleanup();
  }
});

test("[P7] sessionsUsingAccount lists only active sessions bound to the account", () => {
  const h = harness([
    { id: "s1", title: "a", accountId: "acc_x", archived: false } as Partial<SessionData>,
    { id: "s2", title: "b", accountId: "acc_x", archived: true } as Partial<SessionData>, // archived → excluded
    { id: "s3", title: "c", accountId: "acc_y", archived: false } as Partial<SessionData>, // other account
  ]);
  try {
    expect(h.svc.sessionsUsingAccount("acc_x")).toEqual([{ sessionId: "s1", title: "a" }]);
  } finally {
    h.cleanup();
  }
});
