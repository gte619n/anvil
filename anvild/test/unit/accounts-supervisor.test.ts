import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { Supervisor, BadCommand } from "../../src/session/supervisor";
import { ConnectionRegistry } from "../../src/server/registry";
import { AccountStore } from "../../src/auth/accounts";

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "anvil-sup-acct2-"));
}
const createCmd = (cwd: string, accountId?: string) =>
  ({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd, ...(accountId ? { accountId } : {}) }) as const;

test("accountAdd/rename/replace/setDefault/remove all return a fresh roster snapshot", () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  const sup = new Supervisor({ stateDir: dir, accounts }, new ConnectionRegistry());
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
  const sup = new Supervisor({ stateDir: dir, accounts }, new ConnectionRegistry());
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

  // Falls back to the (now sole remaining) default account...
  expect(s.data.accountId).toBe(personal.id);
  expect(s.data.accountMissing).toBe(true);
  // ...but the label field DELIBERATELY still names the removed account, not the fallback — the client
  // renders "<current default> ⚠ was <this>" and has no other way to recover the old name.
  expect(s.data.accountLabel).toBe("work");

  rmSync(dir, { recursive: true, force: true });
});

test("accountsEvent's inUse map only lists ACTIVE (non-archived) sessions", () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  const sup = new Supervisor({ stateDir: dir, accounts }, new ConnectionRegistry());
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
  const sup = new Supervisor({ stateDir: dir, accounts }, new ConnectionRegistry());
  expect(() => sup.accountAdd("local", "sk-ant-oat01-nope-0000")).toThrow(/replica/i);
  expect(() => sup.accountAdd("local", "sk-ant-oat01-nope-0000")).toThrow(BadCommand);
  rmSync(dir, { recursive: true, force: true });
});
