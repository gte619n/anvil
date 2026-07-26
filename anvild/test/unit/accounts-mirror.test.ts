import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../../src/auth/accounts";
import { mirrorDefault } from "../../src/auth/account-mirror";
import { CLAUDE_TOKEN_KEY } from "../../src/auth/store";

const ORIGINAL = process.env[CLAUDE_TOKEN_KEY];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[CLAUDE_TOKEN_KEY];
  else process.env[CLAUDE_TOKEN_KEY] = ORIGINAL;
});

function tmp(): { store: AccountStore; envFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "anvil-mirror-"));
  return { store: new AccountStore(dir), envFile: join(dir, "env") };
}

test("mirrors the default account's token into the env file and process.env", () => {
  const { store, envFile } = tmp();
  store.add("work", "sk-ant-oat01-workworkwork-1111");
  mirrorDefault(store, envFile);
  expect(readFileSync(envFile, "utf8")).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-workworkwork-1111");
  expect(process.env[CLAUDE_TOKEN_KEY]).toBe("sk-ant-oat01-workworkwork-1111");
});

test("follows the default when it moves", () => {
  const { store, envFile } = tmp();
  store.add("work", "sk-ant-oat01-workworkwork-1111");
  const b = store.add("personal", "sk-ant-oat01-personalpers-2222");
  mirrorDefault(store, envFile);
  store.setDefault(b.id);
  mirrorDefault(store, envFile);
  expect(process.env[CLAUDE_TOKEN_KEY]).toBe("sk-ant-oat01-personalpers-2222");
  expect(readFileSync(envFile, "utf8")).not.toContain("workworkwork");
});

test("an empty roster clears the mirrored token rather than leaving a stale one", () => {
  const { store, envFile } = tmp();
  store.add("work", "sk-ant-oat01-workworkwork-1111");
  mirrorDefault(store, envFile);
  store.adoptReplica({ rev: 1, defaultId: "", entries: [] });
  mirrorDefault(store, envFile);
  expect(process.env[CLAUDE_TOKEN_KEY]).toBeUndefined();
});

test("an unwritable env file is reported, not thrown", () => {
  const { store } = tmp();
  store.add("work", "sk-ant-oat01-workworkwork-1111");
  const result = mirrorDefault(store, "/proc/definitely/not/writable/env");
  expect(result.persisted).toBe(false);
  expect(result.error).toBeTruthy();
  expect(process.env[CLAUDE_TOKEN_KEY]).toBe("sk-ant-oat01-workworkwork-1111"); // live value still applied
});
