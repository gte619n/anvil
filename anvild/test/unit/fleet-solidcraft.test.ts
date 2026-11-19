/**
 * Phase B1 unit tests for the hub's SolidCraft pin fan-out (server/fleet-solidcraft.ts), with an
 * in-memory member transport and an in-memory hub machine. The real HTTP path between real daemons
 * is exercised in test/integration/solidcraft-b1-pin.test.ts.
 */
import { describe, expect, test } from "bun:test";
import type { SolidcraftMachineStatus, SolidcraftPin } from "@protocol";
import { FleetSolidcraftCoordinator, type LocalSolidcraft, type MemberSolidcraftClient, type SolidcraftTarget } from "../../src/server/fleet-solidcraft";
import type { SolidcraftRef } from "../../src/solidcraft/install";
import type { SetPinResult } from "../../src/solidcraft/pin";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const self = { serverId: "hub", serverName: "Hub" };
const member = (id: string): SolidcraftTarget => ({ serverId: id, serverName: id.toUpperCase(), url: `https://${id}/` });

/** The hub's own machine, in memory: records the order of calls so "hub first" can be asserted. */
function fakeLocal(log: string[], opts: { fail?: string } = {}): LocalSolidcraft & { current?: SolidcraftPin } {
  const l: LocalSolidcraft & { current?: SolidcraftPin } = {
    current: undefined,
    pin: () => l.current,
    async setPin(ref: SolidcraftRef): Promise<SetPinResult> {
      log.push(`hub:${ref.version}`);
      if (opts.fail) return { ok: false, error: opts.fail, failure: "sha-mismatch" };
      const prev = l.current;
      l.current = { ...ref, pinnedAt: `t-${ref.version}`, ...(prev ? { previous: { version: prev.version, sha256: prev.sha256 } } : {}) };
      return { ok: true, pin: l.current };
    },
    async pinBack(): Promise<SetPinResult> {
      const prev = l.current?.previous;
      if (!prev) return { ok: false, error: "there is no previous pin to go back to" };
      return l.setPin({ version: prev.version, sha256: prev.sha256 });
    },
    async status(): Promise<SolidcraftMachineStatus> {
      return l.current ? { state: "ready", version: l.current.version, source: "managed", pinned: l.current.version, available: true } : { state: "unpinned", available: true };
    },
  };
  return l;
}

interface MemberPlan {
  reachable?: boolean;
  supported?: boolean;
  /** The install fails with this message; the member stays on `version`. */
  fail?: string;
  version?: string;
}
/** In-memory member transport. Each member remembers the pin it was handed. */
function fakeClient(plan: Record<string, MemberPlan>, log: string[]): MemberSolidcraftClient & { applied: Record<string, SolidcraftPin[]>; keeps: string[][] } {
  const applied: Record<string, SolidcraftPin[]> = {};
  const keeps: string[][] = [];
  const state: Record<string, SolidcraftMachineStatus> = {};
  return {
    applied,
    keeps,
    async probe(base) {
      const p = plan[base] ?? {};
      return { reachable: p.reachable ?? true, supported: p.supported ?? true };
    },
    async apply(base, pin, keep) {
      const p = plan[base] ?? {};
      log.push(`apply:${base}:${pin.version}`);
      (applied[base] ??= []).push(pin);
      keeps.push(keep);
      const local: SolidcraftMachineStatus = p.fail
        ? { state: "error", version: p.version ?? "0.40.1", source: "managed", pinned: pin.version, available: false, error: p.fail, failure: "not-notarized", reason: `off the pin (${p.fail})` }
        : { state: "ready", version: pin.version, source: "managed", pinned: pin.version, available: true };
      state[base] = local;
      return { ok: !p.fail, local, error: p.fail };
    },
    async status(base) {
      return { ok: true, local: state[base] ?? { state: "unpinned", available: true } };
    },
  };
}

function coordinator(plan: Record<string, MemberPlan> = {}, opts: { members?: SolidcraftTarget[]; localFail?: string; resolveRef?: (v: string) => Promise<SolidcraftRef>; rewritten?: { part: string; version: string }[] } = {}) {
  const log: string[] = [];
  const local = fakeLocal(log, { fail: opts.localFail });
  const client = fakeClient(plan, log);
  const coord = new FleetSolidcraftCoordinator({
    self,
    members: () => opts.members ?? [member("m1"), member("m2")],
    local,
    client,
    resolveRef: opts.resolveRef ?? (async (version) => ({ version, sha256: SHA_B })),
    rewrittenDesigns: () => opts.rewritten ?? [],
    keepVersions: () => ["0.45.0"],
    now: () => 1,
  });
  return { coord, local, client, log };
}

describe("FleetSolidcraftCoordinator", () => {
  test("[B1] the hub resolves ONE { version, sha256 } and every member is sent that exact pair", async () => {
    let lookups = 0;
    const { coord, client, local } = coordinator({}, { resolveRef: async (version) => (lookups++, { version, sha256: SHA_B }) });
    const r = await coord.setPin({ version: "0.44.1" });
    expect(r.ok).toBe(true);
    expect(r.pin).toMatchObject({ version: "0.44.1", sha256: SHA_B });
    await coord.settled();
    expect(lookups).toBe(1);
    for (const base of ["https://m1/", "https://m2/"]) {
      expect(client.applied[base]).toEqual([local.current!]); // the whole pin, byte for byte the hub's
    }
    expect(client.keeps).toEqual([["0.45.0"], ["0.45.0"]]); // the candidate is kept beside the pin
    const st = coord.status();
    expect(st.active).toBe(false);
    expect(st.pin).toEqual(local.current);
    expect(st.members.map((m) => [m.serverName, m.state, m.version])).toEqual([
      ["Hub", "ready", "0.44.1"],
      ["M1", "ready", "0.44.1"],
      ["M2", "ready", "0.44.1"],
    ]);
    expect(st.members[0]!.isHub).toBe(true);
  });

  test("[B1] an explicit sha256 is used as given, without a lookup", async () => {
    const { coord, local } = coordinator({}, { resolveRef: async () => Promise.reject(new Error("must not be called")) });
    const r = await coord.setPin({ version: "v0.44.1", sha256: SHA_A.toUpperCase() });
    expect(r.ok).toBe(true);
    expect(local.current).toMatchObject({ version: "0.44.1", sha256: SHA_A });
  });

  test("[B1] the hub proves the build first: if its own install fails, no pin is recorded and no member is contacted", async () => {
    const { coord, log, local } = coordinator({}, { localFail: "zip sha256 is x, the pin records y" });
    const r = await coord.setPin({ version: "0.44.1", sha256: SHA_A });
    expect(r).toMatchObject({ ok: false, failure: "sha-mismatch", error: expect.stringContaining("sha256") });
    expect(r.pin).toBeUndefined();
    expect(local.current).toBeUndefined();
    expect(log).toEqual(["hub:0.44.1"]);
    expect(coord.status().active).toBe(false); // not wedged
  });

  test("[B1] the hub installs before the members are sent the pin", async () => {
    const { coord, log } = coordinator();
    await coord.setPin({ version: "0.44.1", sha256: SHA_A });
    await coord.settled();
    expect(log[0]).toBe("hub:0.44.1");
    expect(log.slice(1).sort()).toEqual(["apply:https://m1/:0.44.1", "apply:https://m2/:0.44.1"]);
  });

  test("[B1] a member that fails to install is reported as an error with its reason and old version", async () => {
    const { coord } = coordinator({ "https://m2/": { fail: "spctl did not accept it", version: "0.43.0" } });
    await coord.setPin({ version: "0.44.1", sha256: SHA_A });
    await coord.settled();
    const m2 = coord.status().members.find((m) => m.serverId === "m2")!;
    expect(m2).toMatchObject({ state: "error", version: "0.43.0", pinned: "0.44.1", available: false, detail: "spctl did not accept it" });
    expect(coord.status().members.find((m) => m.serverId === "m1")!.state).toBe("ready");
  });

  test("[B1] an unreachable member is pending-offline and is brought to the pin by reconcile when it is back", async () => {
    const plan: Record<string, MemberPlan> = { "https://m2/": { reachable: false } };
    const { coord, client } = coordinator(plan);
    await coord.setPin({ version: "0.44.1", sha256: SHA_A });
    await coord.settled();
    expect(coord.status().members.find((m) => m.serverId === "m2")!.state).toBe("pending-offline");
    expect(client.applied["https://m2/"]).toBeUndefined();

    expect(await coord.reconcile()).toEqual([]); // still offline: nothing to do, nobody else disturbed
    expect(client.applied["https://m1/"]!.length).toBe(1);

    plan["https://m2/"] = {};
    expect(await coord.reconcile()).toEqual(["m2"]);
    expect(coord.status().members.find((m) => m.serverId === "m2")).toMatchObject({ state: "ready", version: "0.44.1" });
    expect(client.applied["https://m1/"]!.length).toBe(1); // a member already on the pin is left alone
    expect(await coord.reconcile()).toEqual([]);
  });

  test("[B1] a member without the capability is reported unsupported and never sent a pin", async () => {
    const { coord, client } = coordinator({ "https://m1/": { supported: false } });
    await coord.setPin({ version: "0.44.1", sha256: SHA_A });
    await coord.settled();
    expect(coord.status().members.find((m) => m.serverId === "m1")).toMatchObject({ state: "unsupported" });
    expect(client.applied["https://m1/"]).toBeUndefined();
    expect(await coord.reconcile()).toEqual([]);
  });

  test("[B1] a second pin change while one is in progress is refused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { coord } = coordinator({}, { resolveRef: async (version) => (await gate, { version, sha256: SHA_B }) });
    const first = coord.setPin({ version: "0.44.1" });
    const second = await coord.setPin({ version: "0.45.0", sha256: SHA_A });
    expect(second).toMatchObject({ ok: false, error: expect.stringContaining("already in progress") });
    release();
    expect((await first).ok).toBe(true);
    await coord.settled();
    expect(coord.status().pin?.version).toBe("0.44.1");
  });

  test("[B1] bad input and a failed lookup change nothing", async () => {
    const { coord, log } = coordinator({}, { resolveRef: async () => Promise.reject(new Error("GitHub answered 503")) });
    expect((await coord.setPin({ version: "latest" })).ok).toBe(false);
    expect((await coord.setPin({ version: "0.44.1", sha256: "xyz" })).ok).toBe(false);
    expect(await coord.setPin({ version: "0.44.1" })).toMatchObject({ ok: false, error: expect.stringContaining("GitHub answered 503") });
    expect(log).toEqual([]);
    expect(coord.status().active).toBe(false);
  });

  test("[B1] pin back fans the previous build out and returns the designs the newer build rewrote", async () => {
    const rewritten = [
      { part: "bracket", version: "0.44.1" },
      { part: "plate", version: "0.43.0" },
    ];
    const { coord, client, local } = coordinator({}, { rewritten });
    expect(await coord.pinBackPreview()).toMatchObject({ ok: false, rewritten: [] }); // nothing pinned yet
    await coord.setPin({ version: "0.43.0", sha256: SHA_A });
    await coord.settled();
    expect((await coord.pinBack()).ok).toBe(false); // no previous yet
    await coord.setPin({ version: "0.44.1", sha256: SHA_B });
    await coord.settled();

    const preview = await coord.pinBackPreview();
    expect(preview).toMatchObject({ ok: true, current: { version: "0.44.1" }, previous: { version: "0.43.0" } });
    expect(preview.rewritten).toEqual([{ part: "bracket", version: "0.44.1" }]);
    expect(local.current?.version).toBe("0.44.1"); // the preview changed nothing

    const back = await coord.pinBack();
    expect(back.ok).toBe(true);
    expect(back.pin).toMatchObject({ version: "0.43.0", sha256: SHA_A, previous: { version: "0.44.1" } });
    expect(back.rewritten).toEqual([{ part: "bracket", version: "0.44.1" }]);
    await coord.settled();
    expect(client.applied["https://m1/"]!.map((p) => p.version)).toEqual(["0.43.0", "0.44.1", "0.43.0"]);
    expect(coord.status().members.every((m) => m.version === "0.43.0" && m.state === "ready")).toBe(true);
  });

  test("[B1] with no rewritten-designs provider the pin-back list is reported unavailable; a provider that returns none is reported as none", async () => {
    const log: string[] = [];
    const make = (rewrittenDesigns?: () => { part: string; version: string }[]) => {
      const local = fakeLocal(log);
      const coord = new FleetSolidcraftCoordinator({ self, members: () => [], local, client: fakeClient({}, log), resolveRef: async (v) => ({ version: v, sha256: v === "0.43.0" ? SHA_A : SHA_B }), ...(rewrittenDesigns ? { rewrittenDesigns } : {}) });
      return coord;
    };
    const without = make();
    await without.setPin({ version: "0.43.0" });
    await without.settled();
    await without.setPin({ version: "0.44.1" });
    await without.settled();
    expect(await without.pinBackPreview()).toMatchObject({ ok: true, rewritten: [], listUnavailable: true });
    expect(await without.pinBack()).toMatchObject({ ok: true, rewritten: [], listUnavailable: true });

    const withEmpty = make(() => []);
    await withEmpty.setPin({ version: "0.43.0" });
    await withEmpty.settled();
    await withEmpty.setPin({ version: "0.44.1" });
    await withEmpty.settled();
    const preview = await withEmpty.pinBackPreview();
    expect(preview).toMatchObject({ ok: true, rewritten: [] });
    expect(preview.listUnavailable).toBeUndefined();
  });

  test("[B1] refresh re-reads every machine without changing anything", async () => {
    const { coord, client } = coordinator();
    await coord.refresh();
    expect(coord.status().members.map((m) => m.state)).toEqual(["unpinned", "unpinned", "unpinned"]);
    expect(client.applied).toEqual({});
  });
});
