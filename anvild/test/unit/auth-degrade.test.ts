import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAuth, assertSubscriptionAuth } from "../../src/auth/guard";
import {
  AuthDegradeTracker,
  applyDegradeMarkerAtBoot,
  clearDegradeMarker,
  degradeMarkerPath,
  isAuthClassFailure,
  readDegradeMarker,
  writeDegradeMarker,
} from "../../src/auth/degrade";

/**
 * anvil-headless-join.md §4.1/§4.2/§4.6 — the guard split and auto-degrade.
 *
 * The regression that matters most in this file is the FATAL path: §3 exists to stop a stray
 * ANTHROPIC_API_KEY from silently switching every turn to metered per-token billing, and headless-join
 * only relaxes the *other* axis (an absent token). If "API key set → exit 1" ever stops holding, the
 * daemon starts costing real money without saying so.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anvil-degrade-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── §4.1 the four combinations ──────────────────────────────────────────────────────────────────

test("guard: no token → degraded, NOT fatal (this is what lets a headless box boot to be paired)", () => {
  const s = checkAuth({});
  expect(s.fatal).toBe(false);
  expect(s.subscriptionAuthOk).toBe(false);
  expect(s.reason).toMatch(/pair|Settings/i);
});

test("guard: a plausible OAuth token alone → ok, not fatal", () => {
  expect(checkAuth({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc" })).toEqual({ subscriptionAuthOk: true, fatal: false });
});

test("guard: ANTHROPIC_API_KEY is FATAL — even with a valid OAuth token (regression-critical §3)", () => {
  const s = checkAuth({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-good", ANTHROPIC_API_KEY: "sk-ant-api03-x" });
  expect(s.fatal).toBe(true);
  expect(s.subscriptionAuthOk).toBe(false); // reported (not left undefined) so /api/health stays total
  expect(s.reason).toContain("ANTHROPIC_API_KEY");
});

test("guard: ANTHROPIC_AUTH_TOKEN is FATAL too (it also outranks the OAuth token)", () => {
  const s = checkAuth({ CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_AUTH_TOKEN: "x" });
  expect(s.fatal).toBe(true);
});

test("guard: a metered sk-ant-api… value in the OAuth slot is degraded, not ok (§4.2)", () => {
  const s = checkAuth({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-api03-not-a-subscription-token" });
  expect(s.subscriptionAuthOk).toBe(false);
  expect(s.fatal).toBe(false); // it's not in ANTHROPIC_API_KEY, so it can't outrank anything
});

test("guard: whitespace-only token counts as absent", () => {
  expect(checkAuth({ CLAUDE_CODE_OAUTH_TOKEN: "   " }).subscriptionAuthOk).toBe(false);
});

test("assertSubscriptionAuth: warns and RETURNS when there's no token (never exits)", () => {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
  try {
    assertSubscriptionAuth({}); // would have process.exit(1)'d before headless-join
  } finally {
    console.warn = orig;
  }
  expect(warnings.join("\n")).toMatch(/DEGRADED/);
});

// ── §4.6 / HJ-28 failure classification ─────────────────────────────────────────────────────────

test("classification: explicit 401/403-class errors count as auth failures", () => {
  for (const msg of [
    "HTTP 401 Unauthorized",
    "403 Forbidden",
    "authentication_error: invalid bearer token",
    "OAuth token has expired",
    "credential revoked",
  ]) {
    expect(isAuthClassFailure(new Error(msg))).toBe(true);
  }
});

test("classification: network / timeout / rate-limit NEVER count (a flaky link must not log the box out)", () => {
  for (const msg of [
    "429 rate_limit_exceeded",
    "request timed out",
    "fetch failed: ECONNREFUSED",
    "socket hang up",
    "overloaded_error",
    "network unreachable",
  ]) {
    expect(isAuthClassFailure(new Error(msg))).toBe(false);
  }
});

test("classification: a 429 wrapped in auth-ish prose still does not count", () => {
  expect(isAuthClassFailure(new Error("authentication service returned 429 rate limit"))).toBe(false);
});

// ── §4.6 the tracker ────────────────────────────────────────────────────────────────────────────

function tracker(env: NodeJS.ProcessEnv, onDegrade: () => void = () => {}) {
  return new AuthDegradeTracker(dir, onDegrade, env);
}

test("tracker: ONE auth failure changes nothing; the SECOND consecutive one degrades", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-livetoken-9f21" } as NodeJS.ProcessEnv;
  let degraded = 0;
  const t = tracker(env, () => degraded++);

  expect(t.recordTurnFailure(new Error("401 Unauthorized"))).toBeNull();
  expect(t.degraded()).toBe(false);
  expect(existsSync(degradeMarkerPath(dir))).toBe(false);

  const marker = t.recordTurnFailure(new Error("401 Unauthorized"));
  expect(marker).not.toBeNull();
  expect(degraded).toBe(1);
  expect(t.degraded()).toBe(true);
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); // live token dropped so no spawn picks it up
});

test("tracker: a non-auth failure between two 401s resets the streak", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "tok" } as NodeJS.ProcessEnv;
  const t = tracker(env);
  t.recordTurnFailure(new Error("401"));
  t.recordTurnFailure(new Error("timed out"));
  expect(t.recordTurnFailure(new Error("401"))).toBeNull(); // count restarted at 1
  expect(t.degraded()).toBe(false);
});

test("tracker: a successful turn resets the streak", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "tok" } as NodeJS.ProcessEnv;
  const t = tracker(env);
  t.recordTurnFailure(new Error("401"));
  t.recordTurnSuccess();
  expect(t.recordTurnFailure(new Error("401"))).toBeNull();
});

test("tracker: network failures alone never degrade, however many", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "tok" } as NodeJS.ProcessEnv;
  const t = tracker(env);
  for (let i = 0; i < 10; i++) expect(t.recordTurnFailure(new Error("fetch failed"))).toBeNull();
  expect(t.degraded()).toBe(false);
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
});

test("tracker: an ANTHROPIC_API_KEY environment is FATAL, not degraded — the two are different states", () => {
  const t = tracker({ ANTHROPIC_API_KEY: "sk-ant-api03-x" } as NodeJS.ProcessEnv);
  expect(t.degraded()).toBe(false); // fatal ⇒ the process wouldn't be running; never report it degraded
});

test("tracker: exactly one episode alert (HJ-12 suppression), reset by recovery", () => {
  const env = {} as NodeJS.ProcessEnv;
  const t = tracker(env);
  expect(t.claimEpisodeAlert()).toBe(true);
  expect(t.claimEpisodeAlert()).toBe(false);
  expect(t.claimEpisodeAlert()).toBe(false);
  t.recover();
  expect(t.claimEpisodeAlert()).toBe(true); // a NEW episode alerts again
});

// ── §4.6 / HJ-35 the marker ─────────────────────────────────────────────────────────────────────

test("marker: written mode 600 and carries only a MASKED token, never the raw secret (§8.5)", () => {
  const raw = "sk-ant-oat01-SUPERSECRETVALUE-9f21";
  const m = writeDegradeMarker(dir, "2 consecutive auth failures (401)", raw);
  const text = readFileSync(degradeMarkerPath(dir), "utf8");
  expect(text).not.toContain(raw);
  expect(text).not.toContain("SUPERSECRET");
  expect(m.masked).toBeTruthy();
  expect(m.masked).not.toBe(raw);
  expect(statSync(degradeMarkerPath(dir)).mode & 0o777).toBe(0o600);
});

test("marker: PRESENT ⇒ degraded at boot even though the env file still carries a token (HJ-35)", () => {
  // The restart case the whole marker exists for: the launcher re-sources ~/.config/anvil/env on every
  // start and loadPersistedClaudeToken() reloads that key, so an in-memory flag would evaporate and the
  // box would come back looking authed — re-degrading only after burning two MORE turns, every reboot.
  writeDegradeMarker(dir, "2 consecutive auth failures (401)", "sk-ant-oat01-stale");
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-stale-but-reloaded" } as NodeJS.ProcessEnv;

  const marker = applyDegradeMarkerAtBoot(dir, env);

  expect(marker).not.toBeNull();
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(checkAuth(env as Record<string, string | undefined>).subscriptionAuthOk).toBe(false);
});

test("marker: ABSENT ⇒ boot is untouched (an empty env file is already self-evidently degraded)", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-good" } as NodeJS.ProcessEnv;
  expect(applyDegradeMarkerAtBoot(dir, env)).toBeNull();
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-good");
});

test("marker: recover() clears it AND the failure counter", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "tok" } as NodeJS.ProcessEnv;
  const t = tracker(env);
  t.recordTurnFailure(new Error("401"));
  t.recordTurnFailure(new Error("401"));
  expect(existsSync(degradeMarkerPath(dir))).toBe(true);

  env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-fresh"; // as a pair / paste / rotation would
  t.recover();

  expect(existsSync(degradeMarkerPath(dir))).toBe(false);
  expect(t.degraded()).toBe(false);
  // counter reset: a single later 401 must not immediately re-degrade
  expect(t.recordTurnFailure(new Error("401"))).toBeNull();
});

test("marker: a corrupt file still reads as degraded — its EXISTENCE is the signal", () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(degradeMarkerPath(dir), "{not json");
  expect(readDegradeMarker(dir)).not.toBeNull();
});

test("marker: clearDegradeMarker reports whether one was actually there (idempotent)", () => {
  expect(clearDegradeMarker(dir)).toBe(false);
  writeDegradeMarker(dir, "x");
  expect(clearDegradeMarker(dir)).toBe(true);
  expect(clearDegradeMarker(dir)).toBe(false);
});
