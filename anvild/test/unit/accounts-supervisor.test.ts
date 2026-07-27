import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { Supervisor, BadCommand } from "../../src/session/supervisor";
import { ConnectionRegistry } from "../../src/server/registry";
import { AccountStore } from "../../src/auth/accounts";
import type { EnvironmentStore } from "../../src/env/store";

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "anvil-sup-acct2-"));
}
const createCmd = (cwd: string, accountId?: string) =>
  ({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd, ...(accountId ? { accountId } : {}) }) as const;

test("accountAdd/rename/replace/setDefault/remove all return a fresh roster snapshot", () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  const added = sup.accountAdd("work", "sk-ant-oat01-workworkwork-1111");
  expect(added.accounts).toHaveLength(1);
  expect(added.defaultId).toBe(added.accounts[0]!.id);

  const b = sup.accountAdd("personal", "sk-ant-oat01-personalpers-2222");
  expect(b.accounts).toHaveLength(2);
  expect(b.defaultId).toBe(added.defaultId); // second account does NOT steal default

  const renamed = sup.accountRename(added.accounts[0]!.id, "day job");
  expect(renamed.accounts.find((a) => a.id === added.accounts[0]!.id)?.label).toBe("day job");

  const replaced = sup.accountReplace(added.accounts[0]!.id, "sk-ant-oat01-rotatedtoken-3333");
  expect(replaced.accounts).toHaveLength(2);

  const bId = b.accounts.find((a) => a.label === "personal")!.id;
  const defaulted = sup.accountSetDefault(bId);
  expect(defaulted.defaultId).toBe(bId);

  rmSync(dir, { recursive: true, force: true });
});

test("removing an in-use account falls its sessions back to the default and PRESERVES the old label", () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  const work = accounts.add("work", "sk-ant-oat01-workworkwork-1111");
  const personal = accounts.add("personal", "sk-ant-oat01-personalpers-2222");
  accounts.setDefault(personal.id); // default is now "personal"; "work" is the one we'll remove

  const s = sup.create(createCmd(dir, work.id));
  expect(s.data.accountId).toBe(work.id);
  expect(s.data.accountLabel).toBe("work");

  const inUseBefore = sup.sessionsUsingAccount(work.id);
  expect(inUseBefore).toHaveLength(1);
  expect(inUseBefore[0]!.sessionId).toBe(s.data.id);

  sup.accountRemove(work.id);

  // Falls back to the default by CLEARING the binding, not by snapshotting the default's id — see
  // the F1 regression below for why the difference is load-bearing.
  expect(s.data.accountId).toBeUndefined();
  expect(s.data.accountMissing).toBe(true);
  // ...but the label field DELIBERATELY still names the removed account, not the fallback — the client
  // renders "<current default> ⚠ was <this>" and has no other way to recover the old name.
  expect(s.data.accountLabel).toBe("work");

  rmSync(dir, { recursive: true, force: true });
});

test("accountsEvent's inUse map only lists ACTIVE (non-archived) sessions", () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  const a = accounts.add("work", "sk-ant-oat01-workworkwork-1111");
  const s = sup.create(createCmd(dir, a.id));
  expect(sup.accountsEvent().inUse?.[a.id]).toHaveLength(1);
  s.data.archived = true;
  expect(sup.accountsEvent().inUse?.[a.id] ?? []).toHaveLength(0);
  rmSync(dir, { recursive: true, force: true });
});

test("a mutation on a replica throws BadCommand with AccountStore's message unchanged", () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  accounts.adoptReplica({ rev: 1, defaultId: "acct_x", entries: [{ id: "acct_x", label: "work", token: "sk-ant-oat01-pushed-9999", createdAt: 1 }] });
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  expect(() => sup.accountAdd("local", "sk-ant-oat01-nope-0000")).toThrow(/replica/i);
  expect(() => sup.accountAdd("local", "sk-ant-oat01-nope-0000")).toThrow(BadCommand);
  rmSync(dir, { recursive: true, force: true });
});

// ── §5.4 boot reconciliation + the replica "not yet replicated" refusal ──────────────────────

test("a session bound to an account removed while the daemon was DOWN is reconciled on restore", () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  const work = accounts.add("work", "sk-ant-oat01-workworkwork-1111");
  accounts.add("personal", "sk-ant-oat01-personalpers-2222");
  const sup1 = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  const s = sup1.create(createCmd(dir, work.id));
  const sessionId = s.data.id;

  // Simulate the account vanishing out-of-band (a hand-edited accounts.json, or a hub push that
  // replaced the roster) — no live accountRemove() call runs, so nothing falls back at the time.
  const accounts2 = new AccountStore(dir);
  accounts2.remove(work.id);

  const sup2 = new Supervisor({ stateDir: dir, accounts: accounts2 }, new ConnectionRegistry());
  const restored = sup2.get(sessionId)!;
  expect(restored.data.accountId).toBeUndefined(); // follows the default live
  expect(restored.data.accountMissing).toBe(true);
  expect(restored.data.accountLabel).toBe("work"); // the removed account's name still names itself
  rmSync(dir, { recursive: true, force: true });
});

test("a REPLICA never rewrites a session's binding on restore (the push may just be late)", () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  const work = accounts.add("work", "sk-ant-oat01-workworkwork-1111");
  const sup1 = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  const sessionId = sup1.create(createCmd(dir, work.id)).data.id;

  // This machine becomes a member and adopts a roster that doesn't (yet) carry `work`.
  const accounts2 = new AccountStore(dir);
  accounts2.adoptReplica({
    rev: 9,
    defaultId: "acct_hub",
    entries: [{ id: "acct_hub", label: "hub-account", token: "sk-ant-oat01-hubpushed-9999", createdAt: 1 }],
  });

  const sup2 = new Supervisor({ stateDir: dir, accounts: accounts2 }, new ConnectionRegistry());
  const restored = sup2.get(sessionId)!;
  expect(restored.data.accountId).toBe(work.id); // binding preserved, NOT silently repointed
  expect(restored.data.accountMissing).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});

// Regression: a roster mutation mirrors the default into the launcher env file unconditionally. With
// no `envFile` override that is the developer's REAL ~/.config/anvil/env, so `bun test` silently
// overwrote their working Claude credential with a fixture token. Caught by hand on 2026-07-26 after
// the suite clobbered a live machine. The override is now the only thing standing between the test
// suite and every contributor's daemon.
test("a roster mutation mirrors into the CONFIGURED env file, never the real one", () => {
  const dir = tempState();
  const envFile = join(dir, "env");
  const accounts = new AccountStore(dir);
  const sup = new Supervisor({ stateDir: dir, accounts, envFile }, new ConnectionRegistry());

  sup.accountAdd("work", "sk-ant-oat01-workworkwork-1111");

  expect(existsSync(envFile)).toBe(true);
  expect(readFileSync(envFile, "utf8")).toContain("sk-ant-oat01-workworkwork-1111");
  // ...and the event's `persisted` flag reads back from that same file, not the real one.
  expect(sup.accountsEvent().persisted).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});


// F1 (found by independent E2E, 2026-07-27): the removal fallback used to write a SNAPSHOT of
// defaultId() into the session. Both resolve to the default at that instant, so it looked right —
// but move the default afterwards and the session keeps spawning on the OLD account while the header
// chip, which renders the CURRENT default's label, names the NEW one. The UI then advertises a
// subscription that isn't being billed, which is the exact confusion this whole feature exists to
// prevent. Clearing the binding makes it track the default for real.
test("F1: a fallen-back session follows the default when the default LATER moves", () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  const work = accounts.add("work", "sk-ant-oat01-workworkwork-1111");
  const personal = accounts.add("personal", "sk-ant-oat01-personalpers-2222");
  const third = accounts.add("third", "sk-ant-oat01-thirdthird-3333");
  accounts.setDefault(personal.id);
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  const s = sup.create(createCmd(dir, work.id));

  sup.accountRemove(work.id); // falls back to the default, which is currently "personal"
  expect(s.data.accountMissing).toBe(true);
  expect(accounts.token(s.data.accountId)).toBe("sk-ant-oat01-personalpers-2222");

  // Now move the default. The session must FOLLOW it — a snapshot would still resolve "personal"
  // while the chip rendered "third".
  sup.accountSetDefault(third.id);
  expect(accounts.token(s.data.accountId)).toBe("sk-ant-oat01-thirdthird-3333");
  rmSync(dir, { recursive: true, force: true });
});

// C2 (found by independent E2E, 2026-07-27): environments bind to accounts too, but removal only
// reconciled SESSIONS. A removed account left a dangling env.accountId that surfaced later,
// unattended, as a failed autopilot spawn — and because the run loop had `finally` but no `catch`,
// that one environment aborted the whole nightly run including every environment after it.
test("C2: removing an account clears it from ENVIRONMENTS too", () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  accounts.add("work", "sk-ant-oat01-workworkwork-1111");
  const personal = accounts.add("personal", "sk-ant-oat01-personalpers-2222");
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());

  const envStore = (sup as unknown as { envStore: EnvironmentStore }).envStore;
  mkdirSync(join(dir, ".git"), { recursive: true });
  const env = envStore.add("proj", dir);
  sup.updateEnvironment(env.id, { accountId: personal.id });
  expect(envStore.get(env.id)?.accountId).toBe(personal.id);

  sup.accountRemove(personal.id);

  // Cleared, not left dangling — the environment falls back to the roster default like a session.
  expect(envStore.get(env.id)?.accountId).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});
