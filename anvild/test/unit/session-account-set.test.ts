import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { Supervisor, BadCommand } from "../../src/session/supervisor";
import { ConnectionRegistry } from "../../src/server/registry";
import { AccountStore } from "../../src/auth/accounts";

interface FakeDriver {
  stop: () => Promise<void>;
  stopped: boolean;
}
function fakeDriver(): FakeDriver {
  const d: FakeDriver = { stopped: false, stop: async () => {} };
  d.stop = async () => {
    d.stopped = true;
  };
  return d;
}
function driversOf(sup: Supervisor): Map<string, FakeDriver> {
  return (sup as unknown as { drivers: Map<string, FakeDriver> }).drivers;
}

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "anvil-sup-set-"));
}
const createCmd = (cwd: string, accountId?: string) =>
  ({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd, ...(accountId ? { accountId } : {}) }) as const;

test("switching an idle session's account updates its record and drops the live driver", async () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  const a = accounts.add("work", "sk-ant-oat01-workworkwork-1111");
  const b = accounts.add("personal", "sk-ant-oat01-personalpers-2222");
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  const s = sup.create(createCmd(dir, a.id));
  const driver = fakeDriver();
  driversOf(sup).set(s.data.id, driver);

  await sup.setSessionAccount(s.data.id, b.id);

  expect(s.data.accountId).toBe(b.id);
  expect(s.data.accountLabel).toBe("personal");
  expect(s.data.accountMissing).toBeUndefined();
  expect(driver.stopped).toBe(true);
  expect(driversOf(sup).has(s.data.id)).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("refuses to switch a mid-turn session", async () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  const a = accounts.add("work", "sk-ant-oat01-workworkwork-1111");
  const b = accounts.add("personal", "sk-ant-oat01-personalpers-2222");
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  const s = sup.create(createCmd(dir, a.id));
  s.setStatus("thinking");

  await expect(sup.setSessionAccount(s.data.id, b.id)).rejects.toThrow(/mid-turn/i);
  expect(s.data.accountId).toBe(a.id); // unchanged
  rmSync(dir, { recursive: true, force: true });
});

test("refuses an unknown accountId", async () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  const a = accounts.add("work", "sk-ant-oat01-workworkwork-1111");
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  const s = sup.create(createCmd(dir, a.id));

  await expect(sup.setSessionAccount(s.data.id, "acct_gone")).rejects.toThrow(BadCommand);
  rmSync(dir, { recursive: true, force: true });
});

test("clears a stale accountMissing flag on a successful switch", async () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  const a = accounts.add("work", "sk-ant-oat01-workworkwork-1111");
  const b = accounts.add("personal", "sk-ant-oat01-personalpers-2222");
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  const s = sup.create(createCmd(dir, a.id));
  s.data.accountMissing = true; // simulate a prior removal fallback

  await sup.setSessionAccount(s.data.id, b.id);

  expect(s.data.accountMissing).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});
