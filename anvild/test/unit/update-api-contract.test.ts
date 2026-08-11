/**
 * [stable-update-service Phase 0 / D12 / D20] The frozen-update-API CONTRACT test. update-api.openapi.json
 * is the source of truth; this test enforces it two ways (spec's "both"):
 *   • STATIC shape gate — every response the code produces must carry every `required` field from the
 *     schema with the declared type. A removed/renamed/retyped field ⇒ a required key goes missing or
 *     mistypes ⇒ FAIL. New (additive) fields are allowed. This is what makes the surface "frozen".
 *   • LIVE runtime — boot a real daemon and assert the actual /api/health + /api/update/v1/status
 *     responses satisfy the same schemas end-to-end (routing + serialization included).
 *
 * A failure here means a BREAKING change to a stable surface — do not "fix" it by editing the JSON to
 * match; bump to /v2 + updateApiVersion instead (see the schema's description).
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPDATE_API_VERSION } from "@protocol";
import { createServer, type ServerHandle } from "../../src/server/http";
import { UpdateStateStore } from "../../src/daemon/update-state";
import { updateApply, updateCheck, updateStatus, type UpdateApiDeps } from "../../src/daemon/update-api";
import type { CommandRunner } from "../../src/daemon/selfupdate";
import { FleetRolloutCoordinator, DesiredTargetStore } from "../../src/server/fleet-rollout";
import spec from "../../update-api.openapi.json";

type Schema = { required?: string[]; properties?: Record<string, { type: string }> };
const schemas = (spec as { components: { schemas: Record<string, Schema> } }).components.schemas;

/** Assert `obj` satisfies a frozen component schema: every required prop present with the declared type
 *  (additive extras allowed). */
function assertShape(obj: Record<string, unknown>, schemaName: string): void {
  const schema = schemas[schemaName]!;
  for (const key of schema.required ?? []) {
    expect(obj, `${schemaName}.${key} is a FROZEN required field — its absence is a breaking change`).toHaveProperty(key);
    const want = schema.properties![key]!.type;
    const got = obj[key];
    const ok =
      (want === "string" && typeof got === "string") ||
      (want === "boolean" && typeof got === "boolean") ||
      (want === "integer" && typeof got === "number") ||
      (want === "array" && Array.isArray(got));
    expect(ok, `${schemaName}.${key} must be ${want}, got ${Array.isArray(got) ? "array" : typeof got}`).toBe(true);
  }
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "anvil-contract-"));
}
function webDirOk(): string {
  const d = tmp();
  Bun.write(join(d, "index.html"), "<html></html>");
  return d;
}
function fakeRunner(overrides: Record<string, { code: number; out: string }>): CommandRunner {
  return async (cmd) => {
    const key = cmd.join(" ");
    for (const [pat, res] of Object.entries(overrides)) if (key.includes(pat)) return res;
    return { code: 0, out: "ok" };
  };
}
const HAPPY = {
  "symbolic-full-name @{u}": { code: 0, out: "origin/main" },
  "rev-parse --short origin/main": { code: 0, out: "newsha" },
  "rev-parse --short HEAD": { code: 0, out: "oldsha" },
  "status --porcelain": { code: 0, out: "" },
  "rev-list --count": { code: 0, out: "1" },
};

test("the schema doc's updateApiVersion matches the code constant", () => {
  expect((spec as { "x-updateApiVersion": number })["x-updateApiVersion"]).toBe(UPDATE_API_VERSION);
});

test("[static] CheckResponse conforms to the frozen schema", async () => {
  const deps: UpdateApiDeps = { state: new UpdateStateStore(tmp()), webDir: webDirOk(), run: fakeRunner(HAPPY) };
  assertShape((await updateCheck(deps)) as unknown as Record<string, unknown>, "CheckResponse");
});

test("[static] ApplyResponse conforms to the frozen schema", async () => {
  const deps: UpdateApiDeps = { state: new UpdateStateStore(tmp()), webDir: webDirOk(), run: fakeRunner(HAPPY), isManaged: () => true, scheduleRestart: () => {} };
  assertShape((await updateApply({}, deps)) as unknown as Record<string, unknown>, "ApplyResponse");
});

test("[static] StatusResponse conforms to the frozen schema", () => {
  const deps: UpdateApiDeps = { state: new UpdateStateStore(tmp()), webDir: webDirOk() };
  assertShape(updateStatus(deps) as unknown as Record<string, unknown>, "StatusResponse");
});

test("[static] FleetUpdate + FleetRolloutMember conform to the frozen schema", async () => {
  const c = new FleetRolloutCoordinator({
    self: { serverId: "hub", serverName: "hub" },
    members: () => [{ serverId: "m", serverName: "m", url: "u" }],
    resolveTargetSha: async () => "target1",
    applySelf: async () => ({ ok: true }),
    client: {
      probe: async () => ({ reachable: false }),
      apply: async () => ({ ok: true }),
      status: async () => null,
      legacyUpdate: async () => ({ ok: true }),
    },
    desired: new DesiredTargetStore(tmp()),
  });
  const snap = await c.start({ targetSha: "target1" });
  assertShape(snap as unknown as Record<string, unknown>, "FleetUpdateResponse");
  for (const m of snap.members) assertShape(m as unknown as Record<string, unknown>, "FleetRolloutMember");
  assertShape(c.status() as unknown as Record<string, unknown>, "FleetUpdateStatusResponse");
});

// ── Live runtime: boot a real daemon and validate the wire responses end-to-end ──────────────────────
let srv: ServerHandle;
let stateDir: string;
beforeAll(() => {
  stateDir = tmp();
  srv = createServer({ port: 0, stateDir });
});
afterAll(async () => {
  await srv.shutdown();
  rmSync(stateDir, { recursive: true, force: true });
});

test("[live] GET /api/health carries the frozen update fields", async () => {
  const r = await fetch(`http://localhost:${srv.port}/api/health`);
  expect(r.status).toBe(200);
  assertShape((await r.json()) as Record<string, unknown>, "HealthResponse");
});

test("[live] GET /api/update/v1/status conforms end-to-end", async () => {
  const r = await fetch(`http://localhost:${srv.port}/api/update/v1/status`);
  expect(r.status).toBe(200);
  assertShape((await r.json()) as Record<string, unknown>, "StatusResponse");
});

test("[live] GET /api/fleet/update/status conforms end-to-end", async () => {
  const r = await fetch(`http://localhost:${srv.port}/api/fleet/update/status`);
  expect(r.status).toBe(200);
  assertShape((await r.json()) as Record<string, unknown>, "FleetUpdateStatusResponse");
});
