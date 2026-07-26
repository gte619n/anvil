/**
 * Multi-account §7.3: a hub pushes its whole roster alongside the credential on /api/fleet/pair and
 * /api/fleet/token. These exercise `AccountStore.adoptReplica` + the read-only GET, which is the part
 * of the replication path that doesn't need two live daemons and a tailnet. The transport gating
 * (sameUser + hubServerId) is unchanged by this feature and already covered by the pairing tests.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../../src/auth/accounts";
import type { rest } from "@protocol";

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "anvil-repl-"));
}
const PUSH: rest.RosterPush = {
  rev: 7,
  defaultId: "acct_personal",
  entries: [
    { id: "acct_work", label: "work", token: "sk-ant-oat01-hubwork-1111", createdAt: 1 },
    { id: "acct_personal", label: "personal", token: "sk-ant-oat01-hubpersonal-2222", createdAt: 2 },
  ],
};

test("a push carrying accounts persists a replica and sets the default", () => {
  const dir = tempState();
  const store = new AccountStore(dir);
  store.adoptReplica(PUSH);

  expect(store.snapshot().role).toBe("replica");
  expect(store.snapshot().rev).toBe(7);
  expect(store.defaultId()).toBe("acct_personal");
  expect(store.token(undefined)).toBe("sk-ant-oat01-hubpersonal-2222");
  expect(store.token("acct_work")).toBe("sk-ant-oat01-hubwork-1111");

  // Survives a restart as a replica — a member must not silently revert to hub-writable on reboot.
  const reloaded = new AccountStore(dir);
  expect(reloaded.snapshot().role).toBe("replica");
  expect(reloaded.snapshot().rev).toBe(7);
  expect(reloaded.token("acct_work")).toBe("sk-ant-oat01-hubwork-1111");
  expect(() => reloaded.add("local", "sk-ant-oat01-local-9999")).toThrow(/hub/i);
  rmSync(dir, { recursive: true, force: true });
});

test("a push WITHOUT accounts leaves the roster untouched (an older hub)", () => {
  const dir = tempState();
  const store = new AccountStore(dir);
  const a = store.add("default", "sk-ant-oat01-preexisting-1111");
  const revBefore = store.snapshot().rev;

  // adoptCredentials only calls adoptReplica when body.accounts is present; nothing else touches the
  // roster, so a legacy token-only push is bit-for-bit the old behaviour.
  expect(store.snapshot().role).toBe("hub");
  expect(store.snapshot().rev).toBe(revBefore);
  expect(store.token(a.id)).toBe("sk-ant-oat01-preexisting-1111");
  rmSync(dir, { recursive: true, force: true });
});

test("a later push replaces the whole replica rather than merging", () => {
  const dir = tempState();
  const store = new AccountStore(dir);
  store.adoptReplica(PUSH);
  store.adoptReplica({
    rev: 9,
    defaultId: "acct_only",
    entries: [{ id: "acct_only", label: "only", token: "sk-ant-oat01-newer-3333", createdAt: 3 }],
  });
  // The hub is the single writer: its latest payload IS the roster. No merge, so an account removed
  // on the hub actually disappears here instead of lingering forever.
  expect(store.list().map((a) => a.id)).toEqual(["acct_only"]);
  expect(store.snapshot().rev).toBe(9);
  rmSync(dir, { recursive: true, force: true });
});

test("payload() round-trips a hub's roster into the push shape", () => {
  const dir = tempState();
  const hub = new AccountStore(dir);
  const work = hub.add("work", "sk-ant-oat01-workworkwork-1111");
  const personal = hub.add("personal", "sk-ant-oat01-personalpers-2222");
  hub.setDefault(personal.id);

  const payload = hub.payload()!;
  expect(payload.defaultId).toBe(personal.id);
  expect(payload.entries.map((e) => e.id).sort()).toEqual([work.id, personal.id].sort());

  const member = new AccountStore(tempState());
  member.adoptReplica(payload);
  expect(member.token(work.id)).toBe("sk-ant-oat01-workworkwork-1111");
  expect(member.token(undefined)).toBe("sk-ant-oat01-personalpers-2222");
  rmSync(dir, { recursive: true, force: true });
});

test("an empty roster has nothing to push", () => {
  const dir = tempState();
  expect(new AccountStore(dir).payload()).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});

test("publicList never leaks a pushed token (what GET /api/fleet/accounts returns)", () => {
  const dir = tempState();
  const store = new AccountStore(dir);
  store.adoptReplica(PUSH);
  const pub = store.publicList();
  expect(JSON.stringify(pub)).not.toContain("hubwork");
  expect(JSON.stringify(pub)).not.toContain("hubpersonal");
  expect(pub.map((a) => a.label)).toEqual(["work", "personal"]);
  for (const a of pub) expect(a).not.toHaveProperty("token");
  rmSync(dir, { recursive: true, force: true });
});
