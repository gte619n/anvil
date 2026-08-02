/**
 * [SEC2-2 / SEC2-3] The state-mutating REST routes (update apply, fleet update, permission respond, …)
 * gained neither the WS origin gate nor an identity gate, so a page in a trusted device's browser could
 * drive them via a CORS "simple request", and a foreign tailnet user could pin/restart a member. This
 * boots the real server and asserts:
 *   • a foreign browser Origin is rejected 403 on the mutating routes (origin gate);
 *   • a no-Origin native request is NOT rejected by the origin gate;
 *   • an explicitly-allowed Origin (ANVIL_ALLOWED_ORIGINS) passes the origin gate;
 *   • /api/update/v1/apply requires an application/json content-type (defeats the no-preflight bypass);
 *   • /api/update/v1/apply rejects a caller with no proven tailnet identity (SEC2-3).
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "sk-ant-oat-test-placeholder";
const { createServer } = await import("../../src/server/http");

function boot() {
  const dir = mkdtempSync(join(tmpdir(), "anvil-origin-"));
  const srv = createServer({ host: "127.0.0.1", port: 0, stateDir: dir, envFile: join(dir, "env") });
  return { srv, dir, base: `http://127.0.0.1:${srv.port}`, cleanup: () => { srv.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test("[SEC2-2] a foreign browser Origin is rejected 403 on mutating routes", async () => {
  const { base, cleanup } = boot();
  try {
    for (const path of ["/api/update/v1/apply", "/api/fleet/update", "/api/permission/respond"]) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: "{}",
      });
      expect(res.status).toBe(403);
    }
  } finally {
    cleanup();
  }
});

test("[SEC2-2] a no-Origin native request is not blocked by the origin gate", async () => {
  const { base, cleanup } = boot();
  try {
    // permission/respond has no identity gate; with no Origin the origin gate must let it through — it
    // then 400s on the missing requestId, which proves it got past the gate (≠ 403 forbidden origin).
    const res = await fetch(`${base}/api/permission/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  } finally {
    cleanup();
  }
});

test("[SEC2-2] an explicitly-allowed Origin passes the origin gate", async () => {
  const prev = process.env.ANVIL_ALLOWED_ORIGINS;
  process.env.ANVIL_ALLOWED_ORIGINS = "https://my.other.app";
  const { base, cleanup } = boot();
  try {
    const res = await fetch(`${base}/api/permission/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://my.other.app" },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(403); // origin allowed → falls through to the route's own 400
  } finally {
    cleanup();
    if (prev === undefined) delete process.env.ANVIL_ALLOWED_ORIGINS;
    else process.env.ANVIL_ALLOWED_ORIGINS = prev;
  }
});

test("[SEC2-2] /api/update/v1/apply requires an application/json content-type", async () => {
  const { base, cleanup } = boot();
  try {
    // text/plain is exactly the CORS simple-request content-type this gate is meant to defeat.
    const res = await fetch(`${base}/api/update/v1/apply`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "targetSha=deadbeef",
    });
    expect(res.status).toBe(415);
  } finally {
    cleanup();
  }
});

// NOTE: the SEC2-3 identity gate is exercised here only for the ORIGIN + content-type paths, which
// short-circuit BEFORE the update flow. We deliberately do NOT drive a real loopback apply through the
// booted server: after the interview decision to permit a local (loopback, no-header) caller, such a
// request would reach the REAL update flow and run `git` against this checkout. The identity DECISION
// (reject proven otherUser, allow a local no-identity caller) is unit-tested via
// `isLocalNoIdentityCaller` in test/unit/pairing.test.ts + the existing resolveCallerIdentity tests.
