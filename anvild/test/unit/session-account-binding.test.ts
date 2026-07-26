import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { Supervisor, BadCommand } from "../../src/session/supervisor";
import { ConnectionRegistry } from "../../src/server/registry";
import { AccountStore } from "../../src/auth/accounts";
import type { EnvironmentStore } from "../../src/env/store";

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "anvil-sup-acct-"));
}
const createCmd = (cwd: string, extra: Record<string, unknown> = {}) =>
  ({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd, ...extra }) as const;

test("a new session stamps the roster default's id and label", () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  const a = accounts.add("work", "sk-ant-oat01-workworkwork-1111");
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  const s = sup.create(createCmd(dir));
  expect(s.data.accountId).toBe(a.id);
  expect(s.data.accountLabel).toBe("work");
  rmSync(dir, { recursive: true, force: true });
});

test("an explicit accountId on the command wins over the default", () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  accounts.add("work", "sk-ant-oat01-workworkwork-1111");
  const b = accounts.add("personal", "sk-ant-oat01-personalpers-2222");
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  const s = sup.create(createCmd(dir, { accountId: b.id }));
  expect(s.data.accountId).toBe(b.id);
  expect(s.data.accountLabel).toBe("personal");
  rmSync(dir, { recursive: true, force: true });
});

test("an unresolvable accountId is rejected rather than silently defaulted", () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  accounts.add("work", "sk-ant-oat01-workworkwork-1111");
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  expect(() => sup.create(createCmd(dir, { accountId: "acct_gone" }))).toThrow(BadCommand);
  rmSync(dir, { recursive: true, force: true });
});

test("an empty roster leaves accountId/accountLabel unset (pre-migration/dev)", () => {
  const dir = tempState();
  const sup = new Supervisor({ stateDir: dir, accounts: new AccountStore(dir), envFile: join(dir, "env") }, new ConnectionRegistry());
  const s = sup.create(createCmd(dir));
  expect(s.data.accountId).toBeUndefined();
  expect(s.data.accountLabel).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});

test("a new session inherits the ENVIRONMENT's account over the roster default (§6)", () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  accounts.add("work", "sk-ant-oat01-workworkwork-1111"); // roster default
  const personal = accounts.add("personal", "sk-ant-oat01-personalpers-2222");
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());

  // addEnvironment insists on a real git repo and returns void, so go through the store the
  // supervisor already holds — this test is about accountId resolution, not env creation.
  const envStore = (sup as unknown as { envStore: EnvironmentStore }).envStore;
  mkdirSync(join(dir, ".git"), { recursive: true }); // EnvironmentStore.add requires a git repo
  const env = envStore.add("proj", dir);
  sup.updateEnvironment(env.id, { accountId: personal.id });

  const s = sup.create(createCmd(dir, { environmentId: env.id }));
  expect(s.data.accountId).toBe(personal.id);
  expect(s.data.accountLabel).toBe("personal");

  // ...and an explicit command accountId still wins over the environment's.
  const s2 = sup.create(createCmd(dir, { environmentId: env.id, accountId: accounts.defaultId() }));
  expect(s2.data.accountId).toBe(accounts.defaultId());

  // Clearing it falls back to the roster default again.
  sup.updateEnvironment(env.id, { accountId: null });
  const s3 = sup.create(createCmd(dir, { environmentId: env.id }));
  expect(s3.data.accountId).toBe(accounts.defaultId());
  rmSync(dir, { recursive: true, force: true });
});
