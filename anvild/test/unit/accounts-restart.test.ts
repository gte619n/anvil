import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { Supervisor } from "../../src/session/supervisor";
import { ConnectionRegistry } from "../../src/server/registry";
import { AccountStore } from "../../src/auth/accounts";

// These exercise the changed-token PREDICATE (Task 21) directly rather than driving a real agent
// turn through a mocked SDK: the behaviour under test is purely "does restartIdleSessionsForNewToken
// drop the right drivers given a before/after token snapshot", which doesn't need a live query() —
// only that a driver-shaped stub is present in the private `drivers` map and gets stop()ped or not.
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
  return mkdtempSync(join(tmpdir(), "anvil-sup-restart-"));
}
const createCmd = (cwd: string, accountId?: string) =>
  ({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd, ...(accountId ? { accountId } : {}) }) as const;

test("adding a NON-default account restarts no drivers", () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  const a = accounts.add("work", "sk-ant-oat01-workworkwork-1111"); // default
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  const s = sup.create(createCmd(dir, a.id));
  driversOf(sup).set(s.data.id, fakeDriver());

  sup.accountAdd("personal", "sk-ant-oat01-personalpers-2222"); // does not steal default

  expect(driversOf(sup).get(s.data.id)?.stopped).toBeFalsy();
  rmSync(dir, { recursive: true, force: true });
});

test("changing the default's token restarts idle sessions on the default", async () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  const a = accounts.add("work", "sk-ant-oat01-workworkwork-1111"); // default
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  const s = sup.create(createCmd(dir)); // no explicit accountId -> resolves to the default
  expect(s.data.accountId).toBe(a.id);
  const driver = fakeDriver();
  driversOf(sup).set(s.data.id, driver);

  sup.accountReplace(a.id, "sk-ant-oat01-rotatedtoken-3333");
  await Bun.sleep(10); // restart is fire-and-forget

  expect(driver.stopped).toBe(true);
  expect(driversOf(sup).has(s.data.id)).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("a session pinned to an untouched account is not restarted", async () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  accounts.add("work", "sk-ant-oat01-workworkwork-1111"); // default
  const b = accounts.add("personal", "sk-ant-oat01-personalpers-2222");
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  const s = sup.create(createCmd(dir, b.id)); // pinned to "personal"
  const driver = fakeDriver();
  driversOf(sup).set(s.data.id, driver);

  // Replacing "work" (the default)'s token doesn't touch "personal"'s resolved token.
  sup.accountReplace(accounts.defaultId()!, "sk-ant-oat01-newworktoken-9999");
  await Bun.sleep(10);

  expect(driver.stopped).toBe(false);
  expect(driversOf(sup).has(s.data.id)).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("a mid-turn session is left running and gets the existing message", async () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  const a = accounts.add("work", "sk-ant-oat01-workworkwork-1111");
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  const s = sup.create(createCmd(dir));
  expect(s.data.accountId).toBe(a.id);
  s.setStatus("thinking"); // mid-turn
  const driver = fakeDriver();
  driversOf(sup).set(s.data.id, driver);
  let errored: string | undefined;
  s.emitError = (message: string) => {
    errored = message;
  };

  sup.accountReplace(a.id, "sk-ant-oat01-rotatedtoken-3333");
  await Bun.sleep(10);

  expect(driver.stopped).toBe(false); // left running, not torn down mid-turn
  expect(driversOf(sup).has(s.data.id)).toBe(true);
  expect(errored).toMatch(/mid-turn/i);
  rmSync(dir, { recursive: true, force: true });
});
