import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { Supervisor } from "../../src/session/supervisor";
import { ConnectionRegistry } from "../../src/server/registry";
import { AccountStore } from "../../src/auth/accounts";

// The between-turns usage poll (arch §3): each account with a live session is re-read through one of
// its drivers, and the budget event carries one labelled gauge per account.

interface FakeDriver {
  started: boolean;
  reads: number;
  readUsage: () => Promise<{ rateLimits: unknown; subscriptionType: string | null } | null>;
  stop: () => Promise<void>;
}
function fakeDriver(sevenDay: number | null, started = true): FakeDriver {
  const d: FakeDriver = {
    started,
    reads: 0,
    readUsage: async () => {
      d.reads++;
      return sevenDay === null ? null : { rateLimits: { five_hour: { utilization: 1 }, seven_day: { utilization: sevenDay } }, subscriptionType: "max" };
    },
    stop: async () => {},
  };
  return d;
}
const driversOf = (sup: Supervisor) => (sup as unknown as { drivers: Map<string, FakeDriver> }).drivers;
const createCmd = (cwd: string, accountId: string) =>
  ({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd, accountId }) as const;

test("pollUsage reads each account once and reports a labelled gauge per account", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-bpoll-"));
  const accounts = new AccountStore(dir);
  const a = accounts.add("work", "sk-ant-oat01-workworkwork-1111");
  const b = accounts.add("personal", "sk-ant-oat01-personalpers-2222");
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env"), usagePollMs: 0 }, new ConnectionRegistry());
  const s1 = await sup.create(createCmd(dir, a.id));
  const s2 = await sup.create(createCmd(dir, a.id));
  const s3 = await sup.create(createCmd(dir, b.id));
  const d1 = fakeDriver(40);
  const d2 = fakeDriver(41);
  const d3 = fakeDriver(7);
  driversOf(sup).set(s1.data.id, d1);
  driversOf(sup).set(s2.data.id, d2);
  driversOf(sup).set(s3.data.id, d3);

  await sup.pollUsage();

  expect(d1.reads + d2.reads).toBe(1); // one read per ACCOUNT, not per session
  expect(d3.reads).toBe(1);
  const ev = sup.budgetEvent();
  const byLabel = Object.fromEntries((ev.budgets ?? []).map((g) => [g.accountLabel, g]));
  expect(byLabel.work?.week?.utilization).toBeGreaterThanOrEqual(40);
  expect(byLabel.work?.accountId).toBe(a.id);
  expect(byLabel.personal?.week?.utilization).toBe(7);

  // A renamed account is relabelled at send time; a removed one drops out of the event.
  accounts.rename(b.id, "side");
  expect(sup.budgetEvent().budgets?.some((g) => g.accountLabel === "side")).toBe(true);
  accounts.remove(b.id);
  expect(sup.budgetEvent().budgets?.map((g) => g.accountId)).toEqual([a.id]);
  rmSync(dir, { recursive: true, force: true });
});

test("pollUsage skips unstarted drivers and keeps the gauge when a read is unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-bpoll-"));
  const accounts = new AccountStore(dir);
  const a = accounts.add("work", "sk-ant-oat01-workworkwork-1111");
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env"), usagePollMs: 0 }, new ConnectionRegistry());
  const s1 = await sup.create(createCmd(dir, a.id));
  const cold = fakeDriver(50, false);
  driversOf(sup).set(s1.data.id, cold);
  await sup.pollUsage();
  expect(cold.reads).toBe(0);
  expect(sup.budgetEvent().budgets).toEqual([]);

  driversOf(sup).set(s1.data.id, fakeDriver(22));
  await sup.pollUsage();
  driversOf(sup).set(s1.data.id, fakeDriver(null)); // endpoint went away
  await sup.pollUsage();
  expect(sup.budgetEvent().budgets?.[0]?.week?.utilization).toBe(22);
  rmSync(dir, { recursive: true, force: true });
});
