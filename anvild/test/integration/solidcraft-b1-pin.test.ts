/**
 * Phase B1 functional scenarios (agent-cad-and-browser spec §5 "Phase B1", §8.2): one test per
 * Acceptance bullet, driven through REAL daemons.
 *
 * The fleet simulator here is stricter than test/integration/fleet-sim.test.ts: instead of
 * hand-written member stubs, every machine is a real `createServer` daemon with its own state dir,
 * and the hub reaches the members over real HTTP through the real route table, identity gate and
 * coordinator. What is faked is only what cannot exist in CI: the GitHub download (served from
 * memory) and Apple's codesign / spctl (scripted). Hashing, extraction, the six-step order, the
 * rename into place, the pin store and the execution of the extracted binary are all real.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { rest, SolidcraftStatusEvent } from "@protocol";
import { resolveSolidcraftCli, setManagedSolidcraftCli } from "../../src/solidcraft/binary";
import { solidcraftCliPath, solidcraftRoot, solidcraftVersionDir } from "../../src/solidcraft/install";
import { pinAvailability } from "../../src/solidcraft/pin";
import type { SolidcraftTestHooks } from "../../src/server/fleet-solidcraft";
import type { PeerTrust } from "../../src/server/pairing";
import { fakeReleaseZip, fakeVerifier, memoryDownloader, type FakeVerifierOptions } from "../helpers/solidcraft-release";

process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "sk-ant-oat-test-placeholder";
const { createServer } = await import("../../src/server/http");

const OLD = fakeReleaseZip("0.43.0");
const NEW = fakeReleaseZip("0.44.1");
const WRONG = fakeReleaseZip("0.44.1", { reports: "0.44.1", extra: [{ name: "solidcraft-cli-0.44.1-macos-universal/NOTICE", data: "a different file" }] });
const SHAS: Record<string, string> = { "0.43.0": OLD.sha256, "0.44.1": NEW.sha256 };
const GOOD_ZIPS = { "0.43.0": OLD.zip, "0.44.1": NEW.zip };

interface Daemon {
  base: string;
  dir: string;
  serverId: string;
  serverName: string;
  download: ReturnType<typeof memoryDownloader>;
  stop: () => void;
}
const cleanups: (() => void)[] = [];
afterAll(() => {
  cleanups.forEach((c) => c());
  setManagedSolidcraftCli(undefined);
});

interface BootOptions {
  dir?: string;
  features?: string[];
  zips?: Record<string, Buffer>;
  verifier?: FakeVerifierOptions;
  members?: Daemon[];
  identity?: PeerTrust;
  hooks?: Partial<SolidcraftTestHooks>;
}
async function boot(o: BootOptions = {}): Promise<Daemon> {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "anvil-sc-b1-"));
  if (o.members) {
    const members = o.members.map((m) => ({ serverId: m.serverId, serverName: m.serverName, host: "127.0.0.1", url: `${m.base}/` }));
    writeFileSync(join(dir, "fleet.json"), JSON.stringify({ members }));
  }
  const download = memoryDownloader(o.zips ?? GOOD_ZIPS);
  const srv = createServer({
    host: "127.0.0.1",
    port: 0,
    stateDir: dir,
    envFile: join(dir, "env"),
    features: o.features ?? ["solidcraft-pin"],
    resolveIdentity: async () => ({ trust: o.identity ?? "sameUser" }),
    solidcraft: {
      install: { download, run: fakeVerifier(o.verifier), notarizeAttempts: 2, notarizeRetryMs: 1, log: () => {} },
      resolveRef: async (version) => {
        const sha256 = SHAS[version];
        if (!sha256) throw new Error(`SolidCraft has no release v${version}`);
        return { version, sha256 };
      },
      env: {}, // no ANVIL_SOLIDCRAFT_CLI override…
      exists: () => false, // …and no /Applications/SolidCraft.app, whatever this machine has
      primeResolver: false, // several daemons share this process; only the last test primes the global
      reconcileMs: 0,
      ...o.hooks,
    },
  });
  const base = `http://127.0.0.1:${srv.port}`;
  const health = (await (await fetch(`${base}/api/health`)).json()) as rest.HealthResponse;
  const d: Daemon = { base, dir, serverId: health.serverId, serverName: health.serverName, download, stop: () => srv.stop() };
  cleanups.push(() => {
    srv.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return d;
}

const post = (d: Daemon, path: string, body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }): Promise<Response> =>
  fetch(`${d.base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
const get = async <T>(d: Daemon, path: string): Promise<T> => (await (await fetch(`${d.base}${path}`)).json()) as T;
const localStatus = (d: Daemon) => get<rest.solidcraft.StatusResponse>(d, "/api/solidcraft/status");

/** Poll the hub until the fan-out has settled. */
async function settled(hub: Daemon): Promise<rest.solidcraft.FleetStatusResponse> {
  for (let i = 0; i < 400; i++) {
    const st = await get<rest.solidcraft.FleetStatusResponse>(hub, "/api/fleet/solidcraft/status");
    if (!st.active) return st;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("the pin fan-out did not settle");
}
const row = (st: rest.solidcraft.FleetStatusResponse, d: Daemon) => st.members.find((m) => m.serverId === d.serverId)!;
const versionFolders = (d: Daemon): string[] => (existsSync(solidcraftRoot(d.dir)) ? readdirSync(solidcraftRoot(d.dir)).sort() : []);

describe("Phase B1 acceptance", () => {
  let m1: Daemon;
  let m2: Daemon;
  let hub: Daemon;
  beforeAll(async () => {
    m1 = await boot();
    m2 = await boot();
    hub = await boot({ members: [m1, m2] });
  });

  test("[B1] in the fleet simulator, setting the pin on the hub brings two members to ready", async () => {
    // Before: no pin anywhere, nothing installed.
    expect((await localStatus(m1)).local).toEqual({ state: "unpinned", available: true });
    expect(versionFolders(m1)).toEqual([]);

    const res = await post(hub, "/api/fleet/solidcraft/pin", { version: "0.44.1" });
    expect(res.status).toBe(200);
    const set = (await res.json()) as rest.solidcraft.SetPinResponse;
    expect(set.ok).toBe(true);
    expect(set.pin).toMatchObject({ version: "0.44.1", sha256: NEW.sha256 }); // ONE pair, resolved by the hub

    const st = await settled(hub);
    expect(st.pin).toEqual(set.pin!);
    expect(st.members.length).toBe(3);
    for (const m of [m1, m2]) {
      expect(row(st, m)).toMatchObject({ isHub: false, state: "ready", version: "0.44.1", source: "managed", pinned: "0.44.1", available: true });
      // Asked directly, each member says the same, holds the hub's pin verbatim, and has the build on disk.
      const own = await localStatus(m);
      expect(own.local).toEqual({ state: "ready", version: "0.44.1", source: "managed", pinned: "0.44.1", available: true });
      expect(own.pin).toEqual(set.pin!);
      expect(m.download.calls).toEqual(["0.44.1"]); // each machine installed exactly that version, once
      expect(versionFolders(m)).toEqual(["0.44.1"]);
      const out = Bun.spawnSync([solidcraftCliPath(m.dir, "0.44.1"), "--version"]);
      expect(out.stdout.toString().trim()).toBe("solidcraft-cli 0.44.1");
    }
    expect(row(st, hub)).toMatchObject({ isHub: true, state: "ready", version: "0.44.1" });
  });

  test("[B1] a member on a different version reports CAD unavailable with the reason", async () => {
    // This machine was on the fleet's earlier pin, and its copy of the new release is not the file
    // the hub recorded (so its install is refused).
    const stale = await boot({ zips: { "0.43.0": OLD.zip, "0.44.1": WRONG.zip } });
    const applied = await post(stale, "/api/solidcraft/pin/apply", { pin: { version: "0.43.0", sha256: OLD.sha256, pinnedAt: "2026-11-18T10:00:00.000Z" } });
    expect(applied.status).toBe(200);
    expect((await localStatus(stale)).local).toMatchObject({ state: "ready", version: "0.43.0", available: true });

    const fleet = await boot({ members: [m1, stale] });
    expect((await post(fleet, "/api/fleet/solidcraft/pin", { version: "0.44.1" })).status).toBe(200);
    const st = await settled(fleet);

    // The hub's view: one member ready, the other off the pin with the reason.
    expect(row(st, m1).state).toBe("ready");
    const r = row(st, stale);
    expect(r).toMatchObject({ state: "error", version: "0.43.0", pinned: "0.44.1", available: false });
    expect(r.detail).toContain("sha256");

    // The member's own report — what Track A turns into `cad.status { available: false }` and the
    // reason its `anvil_cad` tools refuse with.
    const own = await localStatus(stale);
    expect(own.pin).toMatchObject({ version: "0.44.1", sha256: NEW.sha256 });
    expect(own.local.state).toBe("error");
    expect(own.local.available).toBe(false);
    expect(own.local.version).toBe("0.43.0");
    expect(own.local.failure).toBe("sha-mismatch");
    expect(own.local.reason).toContain("runs SolidCraft 0.43.0 but the fleet is pinned to 0.44.1");
    const avail = pinAvailability(own.local.version, own.pin);
    expect(avail).toEqual({ available: false, pinned: "0.44.1", reason: expect.stringContaining("runs SolidCraft 0.43.0 but the fleet is pinned to 0.44.1") });
    // The refused build is not on disk; the old one still is.
    expect(existsSync(solidcraftVersionDir(stale.dir, "0.44.1"))).toBe(false);
    expect(versionFolders(stale)).toEqual(["0.43.0"]);
    // A member that IS on the pin gets the opposite answer from the same rule.
    const ok = await localStatus(m1);
    expect(pinAvailability(ok.local.version, ok.pin)).toEqual({ available: true, pinned: "0.44.1" });
  });

  test("[B1] a zip whose sha differs is deleted and reported, and the pin does not move", async () => {
    const h = await boot();
    const res = await post(h, "/api/fleet/solidcraft/pin", { version: "0.44.1", sha256: "0".repeat(64) });
    expect(res.status).toBe(409);
    const body = (await res.json()) as rest.solidcraft.SetPinResponse;
    expect(body).toMatchObject({ ok: false, failure: "sha-mismatch" });
    expect(body.error).toContain(NEW.sha256);
    expect(body.pin).toBeUndefined();
    expect(versionFolders(h)).toEqual([]); // deleted: no version folder, no temp folder, no zip
    expect((await localStatus(h)).local.state).toBe("unpinned");
  });

  test("[B1] a zip with the wrong Team ID is deleted and reported, and the pin does not move", async () => {
    const h = await boot({ verifier: { teamOk: false } });
    const res = await post(h, "/api/fleet/solidcraft/pin", { version: "0.44.1" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as rest.solidcraft.SetPinResponse;
    expect(body).toMatchObject({ ok: false, failure: "wrong-team" });
    expect(body.error).toContain("G5QA5U5X2S");
    expect(versionFolders(h)).toEqual([]);
    expect((await get<rest.solidcraft.FleetStatusResponse>(h, "/api/fleet/solidcraft/status")).pin).toBeUndefined();
  });

  test("[B1] a build that is not notarized, or cannot be checked, is refused the same way", async () => {
    const unnotarized = await boot({ verifier: { notarized: [false] } });
    expect(((await (await post(unnotarized, "/api/fleet/solidcraft/pin", { version: "0.44.1" })).json()) as rest.solidcraft.SetPinResponse).failure).toBe("not-notarized");
    expect(versionFolders(unnotarized)).toEqual([]);
    const blind = await boot({ verifier: { assessments: false } });
    expect(((await (await post(blind, "/api/fleet/solidcraft/pin", { version: "0.44.1" })).json()) as rest.solidcraft.SetPinResponse).failure).toBe("cannot-verify");
    expect(versionFolders(blind)).toEqual([]);
  });

  test("[B1] pin back returns the fleet to the previous build and lists the designs the newer build rewrote", async () => {
    const member = await boot();
    const h = await boot({
      members: [member],
      hooks: {
        rewrittenDesigns: (newer) => [
          { part: "bracket", version: newer, environment: "fixtures", path: "cad/bracket/design.json" },
          { part: "plate", version: "0.43.0", environment: "fixtures" },
        ],
      },
    });
    await post(h, "/api/fleet/solidcraft/pin", { version: "0.43.0" });
    await settled(h);
    await post(h, "/api/fleet/solidcraft/pin", { version: "0.44.1" });
    await settled(h);
    expect(versionFolders(member)).toEqual(["0.43.0", "0.44.1"]); // previous is kept beside the pin

    const preview = await get<rest.solidcraft.PinBackPreviewResponse>(h, "/api/fleet/solidcraft/pin/back");
    expect(preview).toMatchObject({ ok: true, current: { version: "0.44.1" }, previous: { version: "0.43.0", sha256: OLD.sha256 } });
    expect(preview.rewritten).toEqual([{ part: "bracket", version: "0.44.1", environment: "fixtures", path: "cad/bracket/design.json" }]);
    expect((await localStatus(h)).pin?.version).toBe("0.44.1"); // reading the warning changed nothing

    const res = await post(h, "/api/fleet/solidcraft/pin/back", {});
    expect(res.status).toBe(200);
    const back = (await res.json()) as rest.solidcraft.PinBackResponse;
    expect(back.pin).toMatchObject({ version: "0.43.0", sha256: OLD.sha256, previous: { version: "0.44.1", sha256: NEW.sha256 } });
    expect(back.rewritten.map((d) => d.part)).toEqual(["bracket"]);
    const st = await settled(h);
    expect(row(st, member)).toMatchObject({ state: "ready", version: "0.43.0", pinned: "0.43.0" });
    expect(member.download.calls).toEqual(["0.43.0", "0.44.1"]); // no re-download to go back
  });
});

describe("Phase B1 surface", () => {
  test("[B1] the routes follow the managed-CLI posture: JSON content type, and a proven other tailnet user is rejected", async () => {
    const h = await boot();
    for (const path of ["/api/fleet/solidcraft/pin", "/api/fleet/solidcraft/pin/back", "/api/solidcraft/pin/apply"]) {
      const plain = await post(h, path, { version: "0.44.1" }, { "Content-Type": "text/plain" });
      expect(plain.status).toBe(415);
    }
    const other = await boot({ identity: "otherUser" });
    for (const [path, body] of [
      ["/api/fleet/solidcraft/pin", { version: "0.44.1" }],
      ["/api/fleet/solidcraft/pin/back", {}],
    ] as const) {
      const res = await post(other, path, body);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    }
    expect((await localStatus(other)).local.state).toBe("unpinned"); // nothing happened
    expect(versionFolders(other)).toEqual([]);
    // A malformed pin is a 400, not an install.
    const bad = await post(h, "/api/solidcraft/pin/apply", { pin: { version: "../../x", sha256: "nope", pinnedAt: "t" } });
    expect(bad.status).toBe(400);
    expect(h.download.calls).toEqual([]);
  });

  test("[B1] without the solidcraft-pin feature the capability is not advertised and every route is a 404", async () => {
    const off = await boot({ features: [] });
    const health = await get<rest.HealthResponse>(off, "/api/health");
    expect(health.capabilities).not.toContain("solidcraft-pin");
    expect((await fetch(`${off.base}/api/solidcraft/status`)).status).toBe(404);
    expect((await fetch(`${off.base}/api/fleet/solidcraft/status`)).status).toBe(404);
    expect((await post(off, "/api/fleet/solidcraft/pin", { version: "0.44.1" })).status).toBe(404);
    expect((await post(off, "/api/solidcraft/pin/apply", { pin: {} })).status).toBe(404);
    expect(off.download.calls).toEqual([]);
    // Over the socket: no status is pushed, and asking for it is an error, not silence.
    const ws = new WebSocket(`${off.base.replace("http", "ws")}/ws`);
    const got: { type: string; cid?: string; message?: string }[] = [];
    ws.onmessage = (ev) => void got.push(JSON.parse(String(ev.data)));
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ v: 1, type: "solidcraft.status.get", ts: new Date().toISOString(), cid: "c-off" }));
    for (let i = 0; i < 400 && !got.some((e) => e.cid === "c-off"); i++) await new Promise((r) => setTimeout(r, 10));
    ws.close();
    expect(got.find((e) => e.cid === "c-off")).toMatchObject({ type: "command.error", message: expect.stringContaining("not switched on") });
    expect(got.some((e) => e.type === "solidcraft.status")).toBe(false);

    const on = await boot();
    expect((await get<rest.HealthResponse>(on, "/api/health")).capabilities).toContain("solidcraft-pin");
  });

  test("[B1] a hub reports a member without the feature as unsupported and does not send it the pin", async () => {
    const plain = await boot({ features: [] });
    const h = await boot({ members: [plain] });
    await post(h, "/api/fleet/solidcraft/pin", { version: "0.44.1" });
    const st = await settled(h);
    expect(row(st, plain).state).toBe("unsupported");
    expect(plain.download.calls).toEqual([]);
    expect(row(st, h).state).toBe("ready");
  });

  test("[B1] solidcraft.status is sent on connect, on a pin change, and in reply to solidcraft.status.get", async () => {
    const h = await boot();
    const ws = new WebSocket(`${h.base.replace("http", "ws")}/ws`);
    const seen: SolidcraftStatusEvent[] = [];
    const other: { type: string; cid?: string }[] = [];
    ws.onmessage = (ev) => {
      const e = JSON.parse(String(ev.data)) as { type: string; cid?: string };
      if (e.type === "solidcraft.status") seen.push(e as unknown as SolidcraftStatusEvent);
      else other.push(e);
    };
    const until = async (cond: () => boolean): Promise<void> => {
      for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(cond()).toBe(true);
    };
    try {
      await until(() => seen.length >= 1);
      expect(seen[0]!.pin).toBeUndefined();
      expect(seen[0]!.local).toEqual({ state: "unpinned", available: true });

      await post(h, "/api/fleet/solidcraft/pin", { version: "0.44.1" });
      await until(() => seen.some((e) => e.pin?.version === "0.44.1" && e.local.state === "ready"));
      expect(seen.some((e) => e.local.state === "installing")).toBe(true); // progress was pushed too

      const before = seen.length;
      ws.send(JSON.stringify({ v: 1, type: "solidcraft.status.get", ts: new Date().toISOString(), cid: "c-sc-1" }));
      await until(() => other.some((e) => e.type === "ack" && e.cid === "c-sc-1"));
      expect(seen.length).toBeGreaterThan(before);
      expect(seen.at(-1)).toMatchObject({ pin: { version: "0.44.1", sha256: NEW.sha256 }, local: { state: "ready", version: "0.44.1", source: "managed", available: true } });
    } finally {
      ws.close();
    }
  });

  test("[B1] a good zip becomes the manager's binary, and still is after the daemon restarts", async () => {
    setManagedSolidcraftCli(undefined);
    const dir = mkdtempSync(join(tmpdir(), "anvil-sc-b1-restart-"));
    const first = await boot({ dir, hooks: { primeResolver: true } });
    expect(resolveSolidcraftCli({}, () => false)).toBeUndefined();
    expect((await post(first, "/api/fleet/solidcraft/pin", { version: "0.44.1" })).status).toBe(200);
    await settled(first);
    // What the CAD process manager will run:
    expect(resolveSolidcraftCli({}, () => false)).toEqual({ path: solidcraftCliPath(dir, "0.44.1"), source: "managed", version: "0.44.1" });

    // Restart: a new process has nothing primed until boot reads the pin and checks the folder.
    first.stop();
    setManagedSolidcraftCli(undefined);
    const second = await boot({ dir, hooks: { primeResolver: true } });
    expect(resolveSolidcraftCli({}, () => false)).toEqual({ path: solidcraftCliPath(dir, "0.44.1"), source: "managed", version: "0.44.1" });
    expect((await localStatus(second)).local).toEqual({ state: "ready", version: "0.44.1", source: "managed", pinned: "0.44.1", available: true });
    expect(second.download.calls).toEqual([]); // primed from disk, no download
  });
});
