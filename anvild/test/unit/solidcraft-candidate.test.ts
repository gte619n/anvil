/**
 * Phase B2 unit tests for candidate selection and the hub's replay gate (src/solidcraft/candidate.ts):
 * which release is picked, the sha256 cross-check, the 24-hour limit, the memory of rejected
 * versions, and every decision the hub makes from the machines' reports — with an in-memory fleet
 * and a fake clock. The real replay between real daemons is in
 * test/integration/solidcraft-b2-replay.test.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { rest, SolidcraftPin, SolidcraftReplayPart, SolidcraftReplayReport } from "@protocol";
import {
  ADVANCE_LIMIT_MS,
  CANDIDATE_FILE,
  CHECK_EVERY_MS,
  CandidateGate,
  MIN_RELEASE_AGE_MS,
  advanceAllowed,
  compareVersions,
  fetchReleases,
  pickCandidate,
  type CandidateGateDeps,
  type GateTarget,
} from "../../src/solidcraft/candidate";
import type { SolidcraftRef } from "../../src/solidcraft/install";
import { verifiedReleaseSha, type GithubRelease } from "../../src/solidcraft/release";
import { githubRelease } from "../helpers/solidcraft-replay";

const dirs: string[] = [];
function stateDir(): string {
  const d = mkdtempSync(join(tmpdir(), "anvil-sc-candidate-"));
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const HOUR = 60 * 60_000;
const T0 = Date.parse("2026-11-19T12:00:00.000Z");
const sha = (version: string): string => version.replace(/\D/g, "").padEnd(64, "a");
const rel = (version: string, ageHours: number, over: Partial<GithubRelease> = {}, now = T0): GithubRelease => githubRelease(version, now - ageHours * HOUR, sha(version), over);

describe("candidate selection", () => {
  test("[B2] with releases 10, 30 and 50 hours old the 50-hour one is chosen; with only 10 and 30, none is", () => {
    const all = [rel("0.47.0", 10), rel("0.46.0", 30), rel("0.45.0", 50)];
    expect(pickCandidate(all, { now: T0, newerThan: "0.44.1" })?.version).toBe("0.45.0");
    expect(pickCandidate(all.slice(0, 2), { now: T0, newerThan: "0.44.1" })).toBeUndefined();
    // The boundary is 48 hours exactly.
    expect(MIN_RELEASE_AGE_MS).toBe(48 * HOUR);
    expect(pickCandidate([rel("0.45.0", 48)], { now: T0, newerThan: "0.44.1" })?.version).toBe("0.45.0");
    expect(pickCandidate([rel("0.45.0", 47.99)], { now: T0, newerThan: "0.44.1" })).toBeUndefined();
  });

  test("[B2] the NEWEST qualifying release is taken, not the first old-enough one", () => {
    const all = [rel("0.48.0", 10), rel("0.47.0", 50), rel("0.46.0", 74), rel("0.45.0", 98)];
    expect(pickCandidate(all, { now: T0, newerThan: "0.44.1" })?.version).toBe("0.47.0");
  });

  test("[B2] a plain-looking tag that is a prerelease, a draft, a nightly or an rc is never a candidate", () => {
    const all = [
      rel("0.49.0", 60, { prerelease: true }), // the v0.40.0 trap: plain tag, prerelease flag
      rel("0.48.0", 70, { draft: true }),
      rel("0.47.0", 80, { tag_name: "v0.47.0-rc.1" }),
      rel("0.46.5", 90, { tag_name: "nightly-2026-11-15" }),
      rel("0.46.0", 100, { tag_name: "0.46.0" }), // no leading v
      rel("0.45.9", 105, { prerelease: undefined as unknown as boolean }), // flag missing: not proven a full release
      rel("0.45.0", 110),
    ];
    expect(pickCandidate(all, { now: T0, newerThan: "0.44.1" })?.version).toBe("0.45.0");
  });

  test("[B2] releases are sorted by published_at, whatever order the API returns them in", () => {
    const shuffled = [rel("0.45.0", 200), rel("0.47.0", 60), rel("0.44.9", 300), rel("0.46.0", 120)];
    expect(pickCandidate(shuffled, { now: T0, newerThan: "0.44.1" })?.version).toBe("0.47.0");
    expect(pickCandidate([...shuffled].reverse(), { now: T0, newerThan: "0.44.1" })?.version).toBe("0.47.0");
    // A release with no publication date cannot be aged, so it cannot qualify.
    expect(pickCandidate([rel("0.50.0", 60, { published_at: null })], { now: T0 })).toBeUndefined();
  });

  test("[B2] the candidate must be newer than the pin by version number, and not previously rejected", () => {
    const all = [rel("0.44.1", 60), rel("0.44.0", 70), rel("0.9.0", 80), rel("0.10.0", 90)];
    expect(pickCandidate(all, { now: T0, newerThan: "0.44.1" })).toBeUndefined(); // the pin itself and older ones
    expect(pickCandidate(all, { now: T0, newerThan: "0.9.5" })?.version).toBe("0.44.1");
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0); // numeric, not text
    expect(compareVersions("0.44.1", "0.44.1")).toBe(0);
    expect(compareVersions("0.43.9", "0.44.0")).toBeLessThan(0);
    const three = [rel("0.47.0", 60), rel("0.46.0", 70), rel("0.45.0", 80)];
    expect(pickCandidate(three, { now: T0, newerThan: "0.44.1", rejected: ["0.47.0"] })?.version).toBe("0.46.0");
    expect(pickCandidate(three, { now: T0, newerThan: "0.44.1", rejected: ["0.47.0", "0.46.0", "0.45.0"] })).toBeUndefined();
    // A release with no CLI zip for this platform cannot be installed, so it is passed over.
    expect(pickCandidate([rel("0.47.0", 60, { assets: [] }), rel("0.46.0", 70)], { now: T0, newerThan: "0.44.1" })?.version).toBe("0.46.0");
  });

  test("[B2] the release list is read page by page until a short page", async () => {
    const pages: GithubRelease[][] = [[rel("0.47.0", 10), rel("0.46.0", 30)], [rel("0.44.0", 400), rel("0.45.0", 50)], [rel("0.43.0", 500)]];
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get("page"));
      return Response.json(pages[page - 1] ?? []);
    }) as unknown as typeof fetch;
    const all = await fetchReleases(fake, { perPage: 2 });
    expect(all.map((r) => r.tag_name)).toEqual(["v0.47.0", "v0.46.0", "v0.44.0", "v0.45.0", "v0.43.0"]);
    expect(urls.map((u) => new URL(u).search)).toEqual(["?per_page=2&page=1", "?per_page=2&page=2", "?per_page=2&page=3"]);
    expect(urls[0]).toStartWith("https://api.github.com/repos/tangency-labs/solidcraft/releases?");
    // The candidate sits on page two: without paging it would be missed.
    expect(pickCandidate(all, { now: T0, newerThan: "0.44.1" })?.version).toBe("0.45.0");
    expect(pickCandidate(pages[0]!, { now: T0, newerThan: "0.44.1" })).toBeUndefined();
    // A failing page is an error, never a short list.
    const broken = (async (url: string) => (url.includes("page=2") ? new Response("rate limited", { status: 403 }) : Response.json(pages[0]))) as unknown as typeof fetch;
    await expect(fetchReleases(broken, { perPage: 2 })).rejects.toThrow("403");
  });

  test("[B2] at most one advance per 24 hours", () => {
    expect(ADVANCE_LIMIT_MS).toBe(24 * HOUR);
    expect(advanceAllowed(undefined, T0)).toBe(true);
    const at = new Date(T0).toISOString();
    expect(advanceAllowed(at, T0 + 23.9 * HOUR)).toBe(false);
    expect(advanceAllowed(at, T0 + 24 * HOUR)).toBe(true);
  });
});

// ── The hub's gate, with an in-memory fleet ─────────────────────────────────────────────────────

const part = (name: string, over: Partial<SolidcraftReplayPart> = {}): SolidcraftReplayPart => ({ part: name, environment: "fixtures", path: `cad/${name}/design.json`, ref: "origin/main", outcome: "same", old: { body_count: 1, faces: 6, volume_mm3: 6000 }, new: { body_count: 1, faces: 6, volume_mm3: 6000 }, ...over });
const report = (parts: SolidcraftReplayPart[], over: Partial<SolidcraftReplayReport> = {}): SolidcraftReplayReport => ({
  candidate: "0.45.0",
  baseline: "0.44.1",
  hostsDesigns: parts.length > 0,
  pass: !parts.some((p) => p.outcome === "differs" || p.outcome === "candidate-error"),
  parts,
  advisory: [],
  notes: [],
  ...over,
});
const DIFFERS = part("bracket", { outcome: "differs", differences: [{ field: "volume_mm3", body: "Body1", old: 6000, new: 6060 }], new: { body_count: 1, faces: 6, volume_mm3: 6060 } });

interface MemberPlan {
  reachable?: boolean;
  supported?: boolean;
  report?: SolidcraftReplayReport;
  error?: string;
  /** Never answers (until `release` is called). */
  hang?: boolean;
}
interface Rig {
  gate: CandidateGate;
  clock: { t: number };
  pin: { current: SolidcraftPin | undefined };
  advances: SolidcraftRef[];
  notes: { title: string; body: string; tag: string }[];
  replays: string[];
  lists: number;
  plan: Record<string, MemberPlan>;
  releases: GithubRelease[];
  release: () => void;
  deps: CandidateGateDeps;
}
function rig(o: { dir?: string; members?: string[]; plan?: Record<string, MemberPlan>; releases?: GithubRelease[]; hub?: SolidcraftReplayReport | string; pinned?: string | null; overrides?: Partial<CandidateGateDeps>; clock?: { t: number } } = {}): Rig {
  const clock = o.clock ?? { t: T0 };
  const members: GateTarget[] = (o.members ?? ["m1", "m2"]).map((id) => ({ serverId: id, serverName: id.toUpperCase(), url: id }));
  let unhang: () => void = () => {};
  const hung = new Promise<void>((r) => (unhang = r));
  const r = {
    clock,
    pin: { current: o.pinned === null ? undefined : ({ version: o.pinned ?? "0.44.1", sha256: sha(o.pinned ?? "0.44.1"), pinnedAt: "2026-11-01T00:00:00.000Z" } as SolidcraftPin) },
    advances: [] as SolidcraftRef[],
    notes: [] as { title: string; body: string; tag: string }[],
    replays: [] as string[],
    lists: 0,
    plan: o.plan ?? {},
    releases: o.releases ?? [rel("0.45.0", 50)],
    release: () => unhang(),
  } as Rig;
  r.deps = {
    stateDir: o.dir ?? stateDir(),
    self: { serverId: "hub", serverName: "HUB" },
    members: () => members,
    client: {
      async probe(base) {
        const p = r.plan[base] ?? {};
        return { reachable: p.reachable ?? true, supported: p.supported ?? true };
      },
      async replay(base, req): Promise<rest.solidcraft.ReplayResponse> {
        r.replays.push(`${base}:${req.candidate.version}:${req.pin?.version ?? "-"}`);
        const p = r.plan[base] ?? {};
        if (p.hang) await hung;
        if (p.error) return { ok: false, error: p.error };
        return { ok: true, report: p.report ?? report([part("plate")], { candidate: req.candidate.version }) };
      },
    },
    listReleases: async () => {
      r.lists++;
      return r.releases;
    },
    releaseSha: async (_release, version) => sha(version),
    pin: () => r.pin.current,
    localVersion: async () => "0.40.1",
    replayLocal: async (candidate) => {
      r.replays.push(`hub:${candidate.version}`);
      if (typeof o.hub === "string") return { ok: false, error: o.hub };
      return { ok: true, report: o.hub ?? report([part("plate")], { candidate: candidate.version }) };
    },
    advance: async (ref) => {
      r.advances.push(ref);
      const prev = r.pin.current;
      r.pin.current = { ...ref, pinnedAt: new Date(clock.t).toISOString(), ...(prev ? { previous: { version: prev.version, sha256: prev.sha256 } } : {}) };
      return { ok: true, pin: r.pin.current };
    },
    notify: (title, body, tag) => void r.notes.push({ title, body, tag }),
    now: () => clock.t,
    ...o.overrides,
  };
  r.gate = new CandidateGate(r.deps);
  return r;
}

describe("the hub's replay gate", () => {
  test("[B2] all machines pass: the pin advances once, through the coordinator, with the release's sha256", async () => {
    const r = rig();
    const check = await r.gate.check();
    expect(check).toMatchObject({ outcome: "advanced", version: "0.45.0" });
    expect(r.advances).toEqual([{ version: "0.45.0", sha256: sha("0.45.0") }]);
    expect(r.replays.sort()).toEqual(["hub:0.45.0", "m1:0.45.0:0.44.1", "m2:0.45.0:0.44.1"]); // every machine was asked, with the pin to compare against
    const st = r.gate.status();
    expect(st.lastEvaluation).toMatchObject({ candidate: { version: "0.45.0", sha256: sha("0.45.0") }, baseline: "0.44.1", result: "advanced" });
    expect(st.lastEvaluation!.machines.map((m) => [m.serverName, m.state, m.holds])).toEqual([["HUB", "pass", false], ["M1", "pass", false], ["M2", "pass", false]]);
    expect(st.rejected).toEqual([]);
    expect(r.notes).toEqual([]);
  });

  test("[B2] the pin does not advance again within 24 hours, and does after", async () => {
    const r = rig();
    await r.gate.check();
    expect(r.pin.current?.version).toBe("0.45.0");
    // Five hours on, a newer release is old enough — but the pin moved today.
    r.clock.t += 5 * HOUR;
    r.releases = [rel("0.46.0", 60, {}, r.clock.t), rel("0.45.0", 55, {}, r.clock.t)];
    const lists = r.lists;
    const limited = await r.gate.check();
    expect(limited.outcome).toBe("rate-limited");
    expect(r.advances.length).toBe(1);
    expect(r.lists).toBe(lists); // nothing was even listed or replayed
    expect(r.gate.status().nextAdvanceAllowedAt).toBe(new Date(T0 + 24 * HOUR).toISOString());
    r.clock.t = T0 + 23.99 * HOUR;
    expect((await r.gate.check()).outcome).toBe("rate-limited");
    // A restart does not forget when the pin last moved.
    const again = rig({ dir: r.deps.stateDir, clock: r.clock, releases: r.releases, pinned: "0.45.0" });
    expect((await again.gate.check()).outcome).toBe("rate-limited");
    r.clock.t = T0 + 24 * HOUR;
    r.releases = [rel("0.46.0", 80, {}, r.clock.t)];
    expect(await r.gate.check()).toMatchObject({ outcome: "advanced", version: "0.46.0" });
    expect(r.advances.map((a) => a.version)).toEqual(["0.45.0", "0.46.0"]);
    expect(r.gate.status().nextAdvanceAllowedAt).toBeDefined();
  });

  test("[B2] a part that differs on one member rejects the candidate, with its old and new numbers, and sends one notification naming it", async () => {
    const r = rig({ plan: { m2: { report: report([part("plate"), DIFFERS, part("lid", { outcome: "candidate-error", error: "eval exited 139" })]) } } });
    const check = await r.gate.check();
    expect(check.outcome).toBe("rejected");
    expect(r.advances).toEqual([]);
    expect(r.pin.current?.version).toBe("0.44.1");
    const st = r.gate.status();
    expect(st.rejected.length).toBe(1);
    expect(st.rejected[0]).toMatchObject({ version: "0.45.0", sha256: sha("0.45.0") });
    expect(st.rejected[0]!.failures.map((f) => [f.part, f.outcome, f.serverName])).toEqual([["bracket", "differs", "M2"], ["lid", "candidate-error", "M2"]]);
    expect(st.rejected[0]!.failures[0]!.differences).toEqual([{ field: "volume_mm3", body: "Body1", old: 6000, new: 6060 }]);
    expect(st.lastEvaluation!.machines.find((m) => m.serverName === "M2")).toMatchObject({ state: "fail", holds: true });
    // ONE notification, naming the first failing part.
    expect(r.notes.length).toBe(1);
    expect(r.notes[0]!.title).toBe("SolidCraft 0.45.0 was not adopted");
    expect(r.notes[0]!.body).toContain("bracket");
    expect(r.notes[0]!.body).toContain("6000 → 6060");
    expect(r.notes[0]!.body).toContain("M2");
    expect(r.notes[0]!.body).not.toContain("lid");
  });

  test("[B2] a rejected version is never retried, across checks and across a restart", async () => {
    const r = rig({ plan: { m1: { report: report([DIFFERS]) } } });
    await r.gate.check();
    const replays = r.replays.length;
    r.plan.m1 = {}; // the member would pass now — it must not be asked
    r.clock.t += 4 * HOUR;
    expect(await r.gate.check()).toMatchObject({ outcome: "none" });
    expect(r.replays.length).toBe(replays);
    expect(r.notes.length).toBe(1);
    // After a restart the list is read back from disk.
    const again = rig({ dir: r.deps.stateDir, clock: r.clock });
    expect(again.gate.status().rejected.map((x) => x.version)).toEqual(["0.45.0"]);
    expect((await again.gate.check()).outcome).toBe("none");
    expect(again.replays).toEqual([]);
    expect(JSON.parse(readFileSync(join(r.deps.stateDir, CANDIDATE_FILE), "utf8")).rejected[0].version).toBe("0.45.0");
    // A newer release is a new candidate; the rejected one stays rejected.
    again.clock.t += 60 * HOUR;
    again.releases = [rel("0.46.0", 50, {}, again.clock.t), rel("0.45.0", 110, {}, again.clock.t)];
    expect(await again.gate.check()).toMatchObject({ outcome: "advanced", version: "0.46.0" });
  });

  test("[B2] a candidate that crashes on replay on the hub holds the pin", async () => {
    const r = rig({ hub: report([part("plate", { outcome: "candidate-error", error: "eval exited 139: simulated crash" })]) });
    expect((await r.gate.check()).outcome).toBe("rejected");
    expect(r.advances).toEqual([]);
    expect(r.notes[0]!.body).toContain("plate replays under the pinned build but fails under the candidate");
    expect(r.gate.status().lastEvaluation!.machines[0]).toMatchObject({ isHub: true, state: "fail", holds: true });
  });

  test("[B2] a design already broken under the pinned build is reported and ignored for the decision", async () => {
    const r = rig({ plan: { m1: { report: report([part("plate"), part("old", { outcome: "baseline-broken", error: "feature Corners failed" })]) } } });
    expect((await r.gate.check()).outcome).toBe("advanced");
    const m1 = r.gate.status().lastEvaluation!.machines.find((m) => m.serverName === "M1")!;
    expect(m1.state).toBe("pass");
    expect(m1.report!.parts.find((p) => p.part === "old")!.outcome).toBe("baseline-broken");
  });

  test("[B2] a member that hosts designs and is unreachable holds the pin and is named; it is not a rejection", async () => {
    const r = rig({ plan: { m2: { reachable: false } } });
    const check = await r.gate.check();
    expect(check.outcome).toBe("held");
    expect(check.detail).toContain("M2");
    expect(check.detail).toContain("unreachable");
    expect(r.advances).toEqual([]);
    const st = r.gate.status();
    expect(st.rejected).toEqual([]);
    expect(st.lastEvaluation!.machines.find((m) => m.serverName === "M2")).toMatchObject({ state: "unreachable", holds: true });
    expect(r.notes).toEqual([]);
    expect(r.gate.candidateVersion()).toBe("0.45.0"); // kept on disk: it is evaluated again
    // Back online at the next check: the same version is evaluated again and passes.
    r.plan.m2 = {};
    r.clock.t += 4 * HOUR;
    expect(await r.gate.check()).toMatchObject({ outcome: "advanced", version: "0.45.0" });
    expect(r.gate.candidateVersion()).toBeUndefined();
  });

  test("[B2] an unreachable member known to host no designs does not hold the pin; one that never reported does", async () => {
    const r = rig({ plan: { m2: { report: report([]) } } });
    expect((await r.gate.check()).outcome).toBe("advanced");
    expect(r.gate.status().lastEvaluation!.machines.find((m) => m.serverName === "M2")!.state).toBe("no-designs");
    // Next day M2 (no designs when last asked) is off: the pin still advances.
    r.clock.t += 25 * HOUR;
    r.releases = [rel("0.46.0", 50, {}, r.clock.t)];
    r.plan.m2 = { reachable: false };
    expect(await r.gate.check()).toMatchObject({ outcome: "advanced", version: "0.46.0" });
    expect(r.gate.status().lastEvaluation!.machines.find((m) => m.serverName === "M2")).toMatchObject({ state: "unreachable", holds: false });
    // M1 hosted designs when last asked: off, it holds.
    r.clock.t += 25 * HOUR;
    r.releases = [rel("0.47.0", 50, {}, r.clock.t)];
    r.plan.m1 = { reachable: false };
    expect((await r.gate.check()).outcome).toBe("held");
  });

  test("[B2] a member that cannot install or replay the candidate holds the pin; one without the feature takes no part", async () => {
    const r = rig({ plan: { m1: { error: "SolidCraft 0.45.0 could not be installed here: zip sha256 is aa" }, m2: { supported: false } } });
    const check = await r.gate.check();
    expect(check.outcome).toBe("held");
    expect(check.detail).toContain("M1");
    const machines = r.gate.status().lastEvaluation!.machines;
    expect(machines.find((m) => m.serverName === "M1")).toMatchObject({ state: "error", holds: true, detail: expect.stringContaining("sha256") });
    expect(machines.find((m) => m.serverName === "M2")).toMatchObject({ state: "unsupported", holds: false });
    expect(r.replays.some((x) => x.startsWith("m2:"))).toBe(false);
    const alone = rig({ plan: { m1: { supported: false }, m2: { supported: false } } });
    expect((await alone.gate.check()).outcome).toBe("advanced");
  });

  test("[B2] if the hub cannot install the candidate nothing is asked of the members and nothing is rejected", async () => {
    const r = rig({ hub: "SolidCraft 0.45.0 could not be installed here: the build is signed by another team" });
    const check = await r.gate.check();
    expect(check.outcome).toBe("error");
    expect(check.detail).toContain("another team");
    expect(r.replays).toEqual(["hub:0.45.0"]);
    expect(r.advances).toEqual([]);
    expect(r.gate.status().rejected).toEqual([]);
  });

  test("[B2] GitHub unreachable: the check is skipped and the pin is unchanged", async () => {
    const r = rig({ overrides: { listReleases: async () => { throw new Error("getaddrinfo ENOTFOUND api.github.com"); } } });
    const check = await r.gate.check();
    expect(check.outcome).toBe("skipped");
    expect(check.detail).toContain("ENOTFOUND");
    expect(r.pin.current?.version).toBe("0.44.1");
    expect(r.advances).toEqual([]);
    expect(r.replays).toEqual([]);
    const st = r.gate.status();
    expect(st.lastCheck).toMatchObject({ outcome: "skipped" });
    expect(st.lastEvaluation).toBeUndefined();
    expect(st.rejected).toEqual([]);
    // Through the real lister with a network that fails:
    const viaFetch = rig({ overrides: { listReleases: () => fetchReleases((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch) } });
    expect(await viaFetch.gate.check()).toMatchObject({ outcome: "skipped", detail: expect.stringContaining("fetch failed") });
    expect(viaFetch.advances).toEqual([]);
  });

  test("[B2] an asset digest that disagrees with SHA256SUMS.txt is never evaluated", async () => {
    const sums = (line: string) => (async () => new Response(line)) as unknown as typeof fetch;
    const release = rel("0.45.0", 50);
    const name = "solidcraft-cli-0.45.0-macos-universal.zip";
    // Agreeing: the digest is the sha256 used.
    expect(await verifiedReleaseSha(release, "0.45.0", sums(`${sha("0.45.0")}  ${name}\n`))).toBe(sha("0.45.0"));
    const run = async (text: string) => {
      const r = rig({ releases: [release], overrides: { releaseSha: (rl, v) => verifiedReleaseSha(rl, v, sums(text)) } });
      const check = await r.gate.check();
      expect(r.replays).toEqual([]); // not even installed
      expect(r.advances).toEqual([]);
      expect(r.gate.status().rejected).toEqual([]);
      return check;
    };
    const disagree = await run(`${"f".repeat(64)}  ${name}\n`);
    expect(disagree).toMatchObject({ outcome: "error", version: "0.45.0", detail: expect.stringContaining("disagree") });
    expect((await run(`${sha("0.45.0")}  some-other-file.zip\n`)).outcome).toBe("error"); // no line for the zip
    // And a release whose asset carries no digest at all:
    const noDigest = rig({ releases: [rel("0.45.0", 50, { assets: [{ name, browser_download_url: "x", digest: null }] })], overrides: { releaseSha: (rl, v) => verifiedReleaseSha(rl, v, sums("")) } });
    expect((await noDigest.gate.check()).outcome).toBe("error");
    expect(noDigest.advances).toEqual([]);
  });

  test("[B2] a hub restart mid-evaluation leaves the pin and the rejected list untouched, and the next check starts from scratch", async () => {
    const dir = stateDir();
    const first = rig({ dir, plan: { m1: { hang: true } } });
    void first.gate.check(); // never finishes: m1 does not answer before the "restart"
    for (let i = 0; i < 200 && !first.replays.includes("m1:0.45.0:0.44.1"); i++) await new Promise((r) => setTimeout(r, 5));
    expect(first.gate.status().evaluating).toEqual({ version: "0.45.0", startedAt: new Date(T0).toISOString() });
    expect(JSON.parse(readFileSync(join(dir, CANDIDATE_FILE), "utf8")).inFlight.version).toBe("0.45.0");
    expect(first.advances).toEqual([]);

    // The process dies here. A new one starts on the same state folder.
    const second = rig({ dir, clock: { t: T0 + 10 * 60_000 } });
    const st = second.gate.status();
    expect(st.evaluating).toBeUndefined();
    expect(st.lastEvaluation).toBeUndefined(); // no half result was kept
    expect(st.rejected).toEqual([]);
    expect(st.lastAdvanceAt).toBeUndefined();
    expect(st.interrupted).toContain("0.45.0");
    expect(st.interrupted).toContain("starts again from scratch");
    expect(second.pin.current?.version).toBe("0.44.1");
    expect(second.advances).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, CANDIDATE_FILE), "utf8")).inFlight).toBeUndefined();

    // The next check evaluates the whole fleet again and only then advances.
    expect(await second.gate.check()).toMatchObject({ outcome: "advanced", version: "0.45.0" });
    expect(second.replays.sort()).toEqual(["hub:0.45.0", "m1:0.45.0:0.44.1", "m2:0.45.0:0.44.1"]);
    expect(second.advances.length).toBe(1);
    expect(second.gate.status().interrupted).toBeUndefined();
    first.release();
  });

  test("[B2] the pin is not advanced if it changed while the candidate was being evaluated", async () => {
    const r = rig({ plan: { m1: { hang: true } } });
    const pending = r.gate.check();
    for (let i = 0; i < 200 && !r.replays.includes("m1:0.45.0:0.44.1"); i++) await new Promise((x) => setTimeout(x, 5));
    r.pin.current = { version: "0.44.2", sha256: sha("0.44.2"), pinnedAt: "2026-11-19T12:30:00.000Z" }; // the owner pins by hand meanwhile
    r.release();
    const check = await pending;
    expect(check.outcome).toBe("held");
    expect(check.detail).toContain("pin changed");
    expect(r.advances).toEqual([]);
  });

  test("[B2] two checks at once run one evaluation", async () => {
    const r = rig();
    const [a, b] = await Promise.all([r.gate.check(), r.gate.check()]);
    expect(a).toEqual(b);
    expect(r.advances.length).toBe(1);
    expect(r.lists).toBe(1);
  });

  test("[B2] with no pin recorded the candidate must be newer than the hub's local build, and the first pin is set by a passing evaluation", async () => {
    const r = rig({ pinned: null, releases: [rel("0.45.0", 50), rel("0.40.1", 400), rel("0.40.0", 500)] });
    expect(await r.gate.check()).toMatchObject({ outcome: "advanced", version: "0.45.0" });
    expect(r.replays.sort()).toEqual(["hub:0.45.0", "m1:0.45.0:-", "m2:0.45.0:-"]); // no pin to hand the members
    expect(r.gate.status().lastEvaluation!.baseline).toBeUndefined();
    const none = rig({ pinned: null, releases: [rel("0.40.1", 400), rel("0.40.0", 500)] }); // local build is 0.40.1
    expect((await none.gate.check()).outcome).toBe("none");
  });

  test("[B2] 'Advance anyway' pins a rejected candidate, only that one, and only a newer one", async () => {
    const r = rig({ plan: { m1: { report: report([DIFFERS]) } } });
    await r.gate.check();
    expect(r.advances).toEqual([]);
    expect(await r.gate.advanceAnyway("0.46.0")).toMatchObject({ ok: false, error: expect.stringContaining("not a held or rejected candidate") });
    expect(await r.gate.advanceAnyway("")).toMatchObject({ ok: false });
    const done = await r.gate.advanceAnyway("v0.45.0");
    expect(done.ok).toBe(true);
    expect(done.pin).toMatchObject({ version: "0.45.0", sha256: sha("0.45.0") }); // the sha256 the gate recorded, not one from the request
    expect(r.advances).toEqual([{ version: "0.45.0", sha256: sha("0.45.0") }]);
    expect(done.lastEvaluation).toMatchObject({ result: "rejected", advancedAnyway: new Date(T0).toISOString() });
    expect(done.rejected.map((x) => x.version)).toEqual(["0.45.0"]); // the record of why it was rejected stays
    expect(r.notes.length).toBe(1);
    // It is the pin now, so it cannot be "advanced" to again, and the 24 hours start over.
    expect(await r.gate.advanceAnyway("0.45.0")).toMatchObject({ ok: false, error: expect.stringContaining("not newer than the pin") });
    r.clock.t += HOUR;
    expect((await r.gate.check()).outcome).toBe("rate-limited");
  });

  test("[B2] 'Advance anyway' also takes a held candidate, reports a failed pin change, and waits for a running check", async () => {
    const held = rig({ plan: { m2: { reachable: false } } });
    await held.gate.check();
    expect((await held.gate.advanceAnyway("0.45.0")).ok).toBe(true);
    expect(held.pin.current?.version).toBe("0.45.0");

    const failing = rig({ plan: { m2: { reachable: false } }, overrides: { advance: async () => ({ ok: false, error: "a SolidCraft pin change is already in progress" }) } });
    await failing.gate.check();
    expect(await failing.gate.advanceAnyway("0.45.0")).toMatchObject({ ok: false, error: "a SolidCraft pin change is already in progress" });
    expect(failing.gate.status().lastAdvanceAt).toBeUndefined();

    const busy = rig({ plan: { m1: { hang: true } } });
    const pending = busy.gate.check();
    expect(await busy.gate.advanceAnyway("0.45.0")).toMatchObject({ ok: false, error: expect.stringContaining("check is running") });
    busy.release();
    await pending;
  });

  test("[B2] the hub checks every 4 hours, and once soon after a start", async () => {
    expect(CHECK_EVERY_MS).toBe(4 * HOUR);
    const r = rig();
    const every: { fn: () => void; ms: number }[] = [];
    const once: { fn: () => void; ms: number }[] = [];
    const set = ((fn: () => void, ms: number) => (every.push({ fn, ms }), 0)) as never;
    const setOnce = ((fn: () => void, ms: number) => (once.push({ fn, ms }), 0)) as never;
    r.gate.start(undefined, set, setOnce);
    expect(every.map((t) => t.ms)).toEqual([4 * HOUR]);
    expect(once.map((t) => t.ms)).toEqual([2 * 60_000]); // never checked: two minutes after the start
    expect(r.lists).toBe(0); // nothing runs until a timer fires
    every[0]!.fn();
    for (let i = 0; i < 200 && r.advances.length === 0; i++) await new Promise((x) => setTimeout(x, 5));
    expect(r.advances.map((a) => a.version)).toEqual(["0.45.0"]);
    expect(r.gate.status().lastCheck).toMatchObject({ outcome: "advanced" });
    r.gate.stop();
    // A restart one hour after that check waits the remaining three hours, not four more and not zero.
    r.clock.t += HOUR;
    const again = rig({ dir: r.deps.stateDir, clock: r.clock, pinned: "0.45.0" });
    expect(again.gate.firstCheckDelay()).toBe(3 * HOUR);
    r.clock.t += 10 * HOUR; // long overdue: soon, but not instantly
    expect(again.gate.firstCheckDelay()).toBe(2 * 60_000);
    // A member's timers fire but do nothing: only the hub looks for candidates by itself.
    const member = rig({ overrides: { timerEnabled: () => false } });
    const fired: (() => void)[] = [];
    member.gate.start(undefined, ((fn: () => void) => (fired.push(fn), 0)) as never, ((fn: () => void) => (fired.push(fn), 0)) as never);
    fired.forEach((fn) => fn());
    await new Promise((x) => setTimeout(x, 20));
    expect(member.lists).toBe(0);
    expect(member.advances).toEqual([]);
    expect((await member.gate.check()).outcome).toBe("advanced"); // asked directly ("Check now"), it still works
  });
});
