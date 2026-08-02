/**
 * [P7] http.ts route-table guard. The 560-line if-ladder became a method+path route table with a
 * top-level try/catch→500; this pins the routing semantics the conversion must preserve: exact-match
 * dispatch, pattern routes (param decode), the attachments 405 (a matched pattern with a wrong method
 * answers 405, not 404), the strict-body 400 of the withJsonBody handlers, the CORS preflight, the
 * SEC2-2 origin gate running BEFORE any route, and the 404 fallback for unknown API paths.
 */
import { test, expect } from "bun:test";
import { bootServer } from "../helpers";

test("[P7] route table preserves the ladder's routing semantics", async () => {
  const srv = await bootServer();
  try {
    // exact route
    const health = await fetch(`${srv.base}/api/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

    // static GET route registered alongside POST on the same path
    expect((await fetch(`${srv.base}/api/update/v1/status`)).status).toBe(200);

    // unknown /api path falls through the table (and the web dir) to 404
    expect((await fetch(`${srv.base}/api/no/such/route`)).status).toBe(404);

    // pattern route with a param + decode (DELETE of a non-existent member is an idempotent ok)
    const del = await fetch(`${srv.base}/api/fleet/members/srv_nope%20x`, { method: "DELETE" });
    expect(del.status).toBe(200);

    // a matched pattern with an unhandled method answers 405 (not 404): the attachments route
    expect((await fetch(`${srv.base}/api/sessions/s1/attachments`, { method: "DELETE" })).status).toBe(405);

    // withJsonBody: a garbled body on the push handlers is a 400, not a crash/500
    const bad = await fetch(`${srv.base}/api/push/fcm/register`, { method: "POST", body: "{not json" });
    expect(bad.status).toBe(400);

    // CORS preflight short-circuits in fetch() before the table
    const opt = await fetch(`${srv.base}/api/push/fcm/register`, { method: "OPTIONS" });
    expect(opt.status).toBe(204);
    expect(opt.headers.get("access-control-allow-origin")).toBe("*");

    // [SEC2-2] the origin gate runs BEFORE any route: a foreign browser origin can't reach a
    // mutating handler even with a valid body
    const foreign = await fetch(`${srv.base}/api/push/fcm/register`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ token: "t" }),
    });
    expect(foreign.status).toBe(403);
  } finally {
    srv.cleanup();
  }
});
