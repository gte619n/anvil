/**
 * [A3] Real-tool suite for Phase A3 (agent-cad-and-browser spec §8.3, §6): the preview the REAL
 * `solidcraft-cli` writes, served by a real daemon on the route the viewer uses, and the owner's
 * parameter change end to end. Skipped unless `ANVIL_REAL_TOOLS=1` (`bun test/tools/phase-gate.ts A3
 * --require-real` sets it and fails on any skip).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { cadTools } from "../../src/agent/cad-tools";
import { AccountStore } from "../../src/auth/accounts";
import { partRef } from "../../src/cadwork/partfolder";
import { createServer, type ServerHandle } from "../../src/server/http";
import { PLATE_VOLUME, RULES, buildPlate, callable, cleanupTemp, modelPlate, stopServices, tempRepo, until, writeRules } from "../helpers/cad-work";
import { evalExpr } from "../../src/cadwork/expr";
import { MOVED_WITHOUT_APPROVAL } from "../../src/cadwork/gate";
import { repoIdentity } from "../../src/cadwork/locks";
import { REAL, SOLIDCRAFT_CLI, hasSolidcraft } from "../helpers/real-tools";
import { readGlb } from "../golden/live-glb";

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ["ANVIL_SOLIDCRAFT_CLI", "CLAUDE_CODE_OAUTH_TOKEN"]) saved[k] = process.env[k];
  process.env.ANVIL_SOLIDCRAFT_CLI = SOLIDCRAFT_CLI; // the daemon resolves the real binary exactly as production does
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "sk-ant-oat-test-placeholder"; // a server will not boot without a credential; no turn is run
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const servers: ServerHandle[] = [];
const sockets: WebSocket[] = [];
const states: string[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  await stopServices();
  for (const s of servers.splice(0)) await s.shutdown().catch(() => undefined);
  for (const d of states.splice(0)) rmSync(d, { recursive: true, force: true });
  cleanupTemp();
});

const round = (v: number, places = 6) => Math.round(v * 10 ** places) / 10 ** places;
/** A GLB's overall size as CAD millimetres [x, y, z] (the file is metres, Y up: gl x, y, z = cad x, z, -y). */
const sizeMm = (glb: ReturnType<typeof readGlb>): [number, number, number] => [round((glb.max[0]! - glb.min[0]!) * 1000, 3), round((glb.max[2]! - glb.min[2]!) * 1000, 3), round((glb.max[1]! - glb.min[1]!) * 1000, 3)];
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** A real daemon with cad-work on, one socket, one session on a fresh repo, and the plate built and passing. */
async function plateOnDaemon() {
  expect(hasSolidcraft()).toBe(true); // a missing binary is a FAILURE in a real run, never a skip
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "anvil-cad-a3-real-")));
  states.push(stateDir);
  const accounts = new AccountStore(stateDir);
  accounts.add("test", "sk-ant-oat01-testtesttest-0000");
  const handle = createServer({ host: "127.0.0.1", port: 0, stateDir, envFile: join(stateDir, "env"), accounts, features: ["cad-work"], resolveIdentity: async () => ({ trust: "sameUser" as const }) });
  servers.push(handle);
  const url = `http://127.0.0.1:${handle.port}`;
  const frames: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
  sockets.push(ws);
  ws.onmessage = (m) => void frames.push(JSON.parse(String(m.data)));
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws error"));
  });
  const send = (cmd: Record<string, unknown>) => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: "t", ...cmd }));
  const sup = handle.supervisor;
  const repo = tempRepo("anvil-cad-real-");
  writeRules(repo, RULES);
  const session = await sup.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd: repo } as any);
  const tools = callable(cadTools(sup.cadwork.toolDeps(session.id, repo)) as any);
  await modelPlate(tools);
  await tools.check_part!({ part: "plate" });
  await until(() => frames.some((e) => e.type === "cad.expectations.request"), "the adopt card", 20_000);
  for (const c of frames.filter((e) => e.type === "cad.expectations.request")) sup.respondCadExpectations(c.requestId, true);
  const gate = (await tools.check_part!({ part: "plate" })).json;
  expect(gate.failing).toEqual([]);
  expect(gate.state).toBe("pass");
  const ref = partRef(repo, "plate");
  const designs = () => frames.filter((e) => e.type === "cad.design" && e.part === "plate");
  const settled = async () => {
    await until(() => !sup.cadwork.manager.status(ref)!.busy, "the queue to drain", 30_000);
    await until(() => designs().at(-1)?.rev === sup.cadwork.snapshot(ref)!.rev, "the socket to catch up", 10_000);
    return designs().at(-1);
  };
  const fetchPreview = (path: string) => fetch(`${url}/api/cad/preview?cwd=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`);
  const setParam = async (name: string, expression: string, cid: string) => {
    send({ type: "cad.param.set", cid, cwd: repo, part: "plate", name, expression });
    await until(() => frames.some((e) => e.cid === cid), `the reply to ${cid}`, 60_000);
    return frames.find((e) => e.cid === cid);
  };
  return { sup, repo, ref, tools, frames, designs, settled, fetchPreview, setParam, cache: join(repo, "cad", "plate", ".cache") };
}

describe("real SolidCraft: live preview and the owner's parameter change", () => {
  test.skipIf(!REAL)("[A3] real: after the plate batch a preview-<rev>.glb exists, is a valid GLB with a mesh, and is served by the daemon route the viewer uses", async () => {
    const x = await plateOnDaemon();
    const ev = await x.settled();
    expect(ev.preview).toBe(`cad/plate/.cache/preview-${ev.rev}.glb`);
    const onDisk = readFileSync(join(x.repo, ev.preview));
    const glb = readGlb(onDisk); // throws unless: magic, version 2, length, a JSON chunk first
    expect(glb.json.asset.version).toBe("2.0");
    expect(glb.meshes).toBeGreaterThanOrEqual(1);
    expect(glb.json.meshes[0].primitives.length).toBeGreaterThanOrEqual(1);
    expect(sizeMm(glb)).toEqual([80, 50, 6]); // metres and Y up in the file: 0.08 × 0.006 × 0.05

    const res = await x.fetchPreview(ev.preview);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("model/gltf-binary");
    const served = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(served).equals(onDisk)).toBe(true);
    // Nothing but previews is served from there.
    expect((await x.fetchPreview("cad/plate/design.json")).status).toBe(404);
    // The preview is not something git would commit.
    expect(Bun.spawnSync(["git", "-C", x.repo, "status", "--porcelain", "--untracked-files=all"]).stdout.toString()).not.toContain(".cache");
  }, 180_000);

  test.skipIf(!REAL)("[A3] real: an owner cad.param.set L=120 yields a new preview whose bounding box is 120 mm long, the documented volume, and a passing gate", async () => {
    const x = await plateOnDaemon();
    const before = await x.settled();
    const reply = await x.setParam("L", "120", "set-l");
    expect(reply).toMatchObject({ type: "cad.param.set.result", ok: true, name: "L" });
    const after = await x.settled();
    expect(after.rev).toBe(before.rev + 1);
    expect(after.by).toBe("panel");
    expect(after.preview).not.toBe(before.preview);
    expect(sizeMm(readGlb(new Uint8Array(await (await x.fetchPreview(after.preview)).arrayBuffer())))).toEqual([120, 50, 6]);
    const volume = after.gate.checks.find((c: any) => c.id === "volume");
    expect(Math.abs(volume.measured - 35335.2)).toBeLessThan(0.05);
    expect(after.gate.state).toBe("pass");
    expect(after.params.find((p: any) => p.name === "L").value).toBe(120);
    expect(readFileSync(join(x.repo, "cad", "plate", "design.json"), "utf8")).toContain("120");

    // A bad expression: the real SolidCraft's error, and neither file changes.
    const files = ["design.json", "part.json"].map((f) => readFileSync(join(x.repo, "cad", "plate", f), "utf8"));
    const bad = await x.setParam("L", "80 +* mm(", "bad");
    expect(bad).toMatchObject({ type: "cad.param.set.result", ok: false });
    expect(typeof bad.error).toBe("string");
    expect(bad.error.length).toBeGreaterThan(5);
    console.log(`[A3 real] SolidCraft's answer to a bad expression: ${bad.error}`);
    await x.settled();
    expect(["design.json", "part.json"].map((f) => readFileSync(join(x.repo, "cad", "plate", f), "utf8"))).toEqual(files);
    expect(x.sup.cadwork.manager.status(x.ref)!.params.find((p) => p.name === "L")!.value).toBe(120);
  }, 180_000);

  test.skipIf(!REAL)("[A3] real: old previews are pruned to three, and script write + refresh time for the plate is recorded", async () => {
    const x = await plateOnDaemon();
    await x.settled();
    const total: number[] = [];
    const refresh: number[] = [];
    for (const [i, L] of [90, 100, 110, 120, 80].entries()) {
      const t0 = performance.now();
      const reply = await x.setParam("L", String(L), `t${i}`); // the change, its script write and its refresh, in one queue slot
      total.push(performance.now() - t0);
      expect(reply.ok).toBe(true);
      const ev = await x.settled();
      refresh.push(x.sup.cadwork.snapshot(x.ref)!.outcome.ms);
      expect(existsSync(join(x.repo, ev.preview))).toBe(true);
    }
    const kept = readdirSync(x.cache).filter((n) => /^preview-\d+\.glb$/.test(n));
    expect(kept).toHaveLength(3);
    const newest = x.designs().at(-1).rev;
    expect(kept.sort()).toEqual([newest - 2, newest - 1, newest].map((r) => `preview-${r}.glb`).sort());
    // Spec §6: script write plus refresh for the reference plate under 1 s on the M4 — recorded, not asserted.
    const [mTotal, mRefresh] = [median(total), median(refresh)];
    console.log(`[A3 real] plate: parameter change + script write + refresh (measure, holes, gate, preview) median ${mTotal.toFixed(0)} ms over ${total.length} runs (max ${Math.max(...total).toFixed(0)} ms); refresh alone median ${mRefresh.toFixed(0)} ms — target < 1000 ms: ${mTotal < 1000 ? "MET" : "NOT MET"}`);
    expect(Number.isFinite(mTotal)).toBe(true);
    expect(mRefresh).toBeGreaterThan(0);
  }, 300_000);

  test.skipIf(!REAL)("[A3] real: review — the agent sets L=120, the owner edits T=6.5 in the panel: the gate still fails on L (80 → 120) and the accepted numbers move for T only", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI });
    expect(x.gate.state).toBe("pass");
    const ref = partRef(repo, "plate");
    expect((await x.tools.set_parameter!({ name: "L", expression: "120" })).isError).toBe(false);
    expect((await x.check()).state).toBe("fail");
    expect((await x.service.setParamAsOwner(ref, "T", "6.5")).ok).toBe(true);
    const g = await x.check();
    expect(g.state).toBe("fail");
    const moved = g.failing.find((l: string) => l.startsWith("accepted:"))!;
    expect(moved).toContain(MOVED_WITHOUT_APPROVAL);
    expect(moved).toContain("L 80 → 120");
    const lock = x.service.locks.findPart(repoIdentity(repo), "plate")!;
    expect(lock.values!.bbox.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([6.5, 50, 80]);
    expect(lock.values!.volume).toBeCloseTo(evalExpr(PLATE_VOLUME, { L: 80, W: 50, T: 6.5 }), 3);
    expect(lock.declared).toEqual({ L: 80, W: 50, T: 6.5 });
  }, 180_000);
});
