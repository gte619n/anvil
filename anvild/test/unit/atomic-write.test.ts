/**
 * [BE-9] Several stores (push registries, budget, schedule) wrote their JSON in place with a bare
 * writeFileSync — a crash mid-write truncates the file, and the load path then silently resets to
 * defaults (e.g. schedule reverts to disabled, killing the user's nightly autopilot). The shared
 * atomic writer does tmp+rename so the target is always either the old or the new content, never
 * partial. These pin the observable guarantees.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../src/util/atomic";

test("writes the content and leaves no .tmp behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-atomic-"));
  const f = join(dir, "state.json");
  writeFileAtomic(f, '{"a":1}');
  expect(readFileSync(f, "utf8")).toBe('{"a":1}');
  expect(readdirSync(dir)).toEqual(["state.json"]); // no leftover temp file
});

test("fully replaces an existing file (no partial overlay)", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-atomic-"));
  const f = join(dir, "state.json");
  writeFileSync(f, '{"old":"much longer content than the new one"}');
  writeFileAtomic(f, '{"new":1}');
  expect(readFileSync(f, "utf8")).toBe('{"new":1}');
});

test("applies the requested mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-atomic-"));
  const f = join(dir, "secret.json");
  writeFileAtomic(f, "{}", { mode: 0o600 });
  expect(statSync(f).mode & 0o777).toBe(0o600);
});

test("a failed write does not destroy the existing target", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-atomic-"));
  const f = join(dir, "state.json");
  writeFileAtomic(f, '{"good":true}');
  // Passing a non-serializable value type simulates a caller/encoding failure before rename.
  expect(() => writeFileAtomic(f, undefined as unknown as string)).toThrow();
  expect(existsSync(f)).toBe(true);
  expect(readFileSync(f, "utf8")).toBe('{"good":true}'); // untouched
});

// ── [BE2-14] the two sites this program moved onto the atomic writer ───────────────────────────────
import { FleetStore } from "../../src/fleet/store";
import { upsertEnvLine, readEnvKey } from "../../src/auth/env-file";

test("[BE2-14] FleetStore.save is atomic — no stray fleet.json.tmp, round-trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-atomic-fleet-"));
  const f = new FleetStore(dir);
  f.upsert({ serverId: "a", serverName: "a", host: "a.ts.net", url: "https://a.ts.net:7701/" });
  expect(existsSync(join(dir, "fleet.json.tmp"))).toBe(false);
  expect(new FleetStore(dir).list().map((m) => m.serverId)).toEqual(["a"]); // survives reload
});

test("[BE2-14] upsertEnvLine writes the token atomically, preserves 0600 + other keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-atomic-env-"));
  const file = join(dir, "env");
  upsertEnvLine(file, "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat-xyz");
  upsertEnvLine(file, "OTHER", "keep");
  expect(readEnvKey(file, "CLAUDE_CODE_OAUTH_TOKEN")).toBe("sk-ant-oat-xyz");
  expect(readEnvKey(file, "OTHER")).toBe("keep"); // other keys survive a rewrite
  expect(existsSync(`${file}.tmp`)).toBe(false);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});
