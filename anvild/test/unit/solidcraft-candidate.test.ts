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
  MAX_REJECTED,
  MAX_REJECTED_FAILURES,
  MIN_RELEASE_AGE_MS,
  VERIFICATION_REFUSALS,
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
  errors: [],
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
  /** The hub's own replay: a report, or an install error (with `hubFailure` as its typed reason). */
  hub?: SolidcraftReplayReport | string;
  hubFailure?: string;
}
function rig(o: { dir?: string; members?: string[]; plan?: Record<string, MemberPlan>; releases?: GithubRelease[]; hub?: SolidcraftReplayReport | string; hubFailure?: string; pinned?: string | null; overrides?: Partial<CandidateGateDeps>; clock?: { t: number } } = {}): Rig {
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
    hub: o.hub,
    hubFailure: o.hubFailure,
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
        // By default a member compares against exactly the pin it was handed.
        return { ok: true, report: p.report ?? report([part("plate")], { candidate: req.candidate.version, baseline: req.pin?.version }) };
      },
    },
    listReleases: async () => {
      r.lists++;
      return r.releases;
    },
    releaseSha: async (_release, version) => sha(version),
    pin: () => r.pin.current,
    localVersion: async () => "0.40.1",
    replayLocal: async (candidate, pin) => {
      r.replays.push(`hub:${candidate.version}`);
      if (typeof r.hub === "string") return { ok: false, error: r.hub, ...(r.hubFailure ? { failure: r.hubFailure } : {}) };
      return { ok: true, report: r.hub ?? report([part("plate")], { candidate: candidate.version, baseline: pin?.version }) };
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
    // A crash gives no verdict on the design (`inconclusive`): the pin holds and the candidate is
    // tried again, rather than being rejected for good on what may be a passing fault.
    const r = rig({ hub: report([part("plate", { outcome: "inconclusive", error: "the candidate gave no result: SolidCraft 0.45.0 stopped (exit 139)" })]) });
    const check = await r.gate.check();
    expect(check.outcome).toBe("held");
    expect(check.detail).toContain("plate could not be replayed");
    expect(r.advances).toEqual([]);
    expect(r.pin.current?.version).toBe("0.44.1");
    expect(r.gate.status().lastEvaluation!.machines[0]).toMatchObject({ isHub: true, state: "held", holds: true });
    expect(r.gate.status().rejected).toEqual([]);
    expect(r.notes).toEqual([]);
    // A feature error the candidate REPORTED is a verdict: that one rejects.
    const ran = rig({ hub: report([part("plate", { outcome: "candidate-error", error: "feature Corners failed: too large" })]) });
    expect((await ran.gate.check()).outcome).toBe("rejected");
    expect(ran.notes[0]!.body).toContain("plate replays under the pinned build but fails under the candidate");
  });

  test("[B2] a member whose only trouble is a timed-out or refused design holds the pin by name and is not a rejection", async () => {
    const r = rig({
      plan: {
        m1: { report: report([part("plate"), part("slow", { outcome: "inconclusive", error: "the candidate gave no result: SolidCraft 0.45.0 did not finish within 120 s and was stopped" })]) },
        m2: { report: report([part("trap", { outcome: "refused", error: "step 3 (file.save): this command is not one SolidCraft writes into a design script, so it is not replayed" })]) },
      },
    });
    const check = await r.gate.check();
    expect(check.outcome).toBe("held");
    expect(check.detail).toContain("slow could not be replayed");
    expect(check.detail).toContain("trap was refused and not replayed");
    expect(check.detail).toContain("file.save");
    const machines = r.gate.status().lastEvaluation!.machines;
    expect(machines.map((m) => [m.serverName, m.state, m.holds])).toEqual([["HUB", "pass", false], ["M1", "held", true], ["M2", "held", true]]);
    expect(r.gate.status().rejected).toEqual([]); // not a permanent rejection
    // The candidate is not reported as turned down; the refused DESIGN is reported, once.
    expect(r.notes.map((n) => n.title)).toEqual(["Design trap is not replayed"]);
    expect(r.advances).toEqual([]);
    // Next check the slow design replays: only the refused one still holds.
    r.plan.m1 = {};
    r.clock.t += 4 * HOUR;
    const again = await r.gate.check();
    expect(again.outcome).toBe("held");
    expect(again.detail).not.toContain("M1");
    // A real difference elsewhere still rejects, whatever else is merely held.
    r.plan.m1 = { report: report([DIFFERS]) };
    r.clock.t += 4 * HOUR;
    expect((await r.gate.check()).outcome).toBe("rejected");
  });

  test("[B2] a member that hosts designs but did not compare against the pinned build holds the pin", async () => {
    // The reviewer's case: the member's install of the pinned 0.44.1 failed, so it replayed with no
    // baseline (or with whatever build it had). Every part reads `same`, because nothing was compared.
    const noBaseline = report([part("plate")], { baseline: undefined });
    delete (noBaseline as { baseline?: string }).baseline;
    const r = rig({ plan: { m1: { report: noBaseline } } });
    const check = await r.gate.check();
    expect(check.outcome).toBe("held");
    expect(check.detail).toContain("M1");
    expect(check.detail).toContain("it compared against no build, not the pinned 0.44.1");
    expect(r.advances).toEqual([]);
    expect(r.gate.status().lastEvaluation!.machines.find((m) => m.serverName === "M1")).toMatchObject({ state: "held", holds: true });
    // Another version as the baseline (an app bundle, an env override) is no better.
    const other = rig({ plan: { m2: { report: report([part("plate")], { baseline: "0.43.0" }) } } });
    const c2 = await other.gate.check();
    expect(c2.outcome).toBe("held");
    expect(c2.detail).toContain("it compared against SolidCraft 0.43.0, not the pinned 0.44.1");
    // The hub's own report is held to the same rule.
    expect((await rig({ hub: report([part("plate")], { baseline: "0.44.0" }) }).gate.check()).outcome).toBe("held");
    // Control: the same reports with the pinned baseline advance.
    expect((await rig({ plan: { m1: { report: report([part("plate")], { baseline: "0.44.1" }) } } }).gate.check()).outcome).toBe("advanced");
    // A machine that hosts NO designs has nothing to compare, so its baseline does not matter.
    expect((await rig({ plan: { m1: { report: report([], { baseline: "0.43.0" }) } } }).gate.check()).outcome).toBe("advanced");
  });

  test("[B2] a report made against the wrong baseline is never a rejection, even when it says a part differs", async () => {
    // The member compared the candidate against 0.43.0 (it is off the pin) and saw a difference.
    // That is no verdict on the candidate against the PINNED build: held, not rejected for good.
    const wrong = report([part("plate"), DIFFERS], { baseline: "0.43.0" });
    const r = rig({ plan: { m1: { report: wrong } } });
    const check = await r.gate.check();
    expect(check.outcome).toBe("held");
    expect(check.detail).toContain("it compared against SolidCraft 0.43.0, not the pinned 0.44.1");
    const st = r.gate.status();
    expect(st.rejected).toEqual([]);
    expect(st.lastEvaluation!.machines.find((m) => m.serverName === "M1")).toMatchObject({ state: "held", holds: true });
    expect(r.notes).toEqual([]);
    expect(r.advances).toEqual([]);
    // No baseline at all, with a candidate-error: the same.
    const none = report([part("plate", { outcome: "candidate-error", error: "feature Corners failed" })]);
    delete (none as { baseline?: string }).baseline;
    expect((await rig({ plan: { m2: { report: none } } }).gate.check()).outcome).toBe("held");
    // Control: the same difference against the pinned build does reject.
    expect((await rig({ plan: { m1: { report: report([part("plate"), DIFFERS], { baseline: "0.44.1" }) } } }).gate.check()).outcome).toBe("rejected");
  });

  test("[B2] a committed design that is refused is notified once per version of the file, naming the design and the command", async () => {
    const reason = "step 3 (occurrence.pattern): this command is not on Anvil's list of commands allowed in a design script (extend ALLOWED_COMMANDS in script-screen.ts if it is legitimate)";
    const refusedPart = (sha: string) => part("gearbox", { environment: "lapo", outcome: "refused", error: reason, sha });
    const r = rig({ plan: { m1: { report: report([part("plate"), refusedPart("a".repeat(64))]) } } });
    expect((await r.gate.check()).outcome).toBe("held");
    expect(r.notes.length).toBe(1);
    expect(r.notes[0]!.title).toBe("Design gearbox is not replayed");
    expect(r.notes[0]!.body).toContain("gearbox (lapo, on M1)");
    expect(r.notes[0]!.body).toContain("occurrence.pattern");
    expect(r.notes[0]!.body).toContain("extend ALLOWED_COMMANDS");
    expect(r.notes[0]!.body).toContain("held until it is fixed");
    // Every four hours the same file is refused again: no more notifications…
    for (let i = 0; i < 6; i++) {
      r.clock.t += 4 * HOUR;
      expect((await r.gate.check()).outcome).toBe("held");
    }
    expect(r.notes.length).toBe(1);
    // …nor after a restart, nor when a second machine hosts the same file.
    const again = rig({ dir: r.deps.stateDir, clock: r.clock, plan: { m1: { report: report([refusedPart("a".repeat(64))]) }, m2: { report: report([refusedPart("a".repeat(64))]) } } });
    await again.gate.check();
    expect(again.notes).toEqual([]);
    // The file changes and is still refused: that is news.
    again.plan.m1 = { report: report([refusedPart("b".repeat(64))]) };
    again.plan.m2 = {};
    again.clock.t += 4 * HOUR;
    await again.gate.check();
    expect(again.notes.length).toBe(1);
    // An ADVISORY (worktree) refusal is listed on the card and never notified.
    const adv = rig({ plan: { m1: { report: report([part("plate")], { advisory: [part("wip", { worktree: "session", outcome: "refused", error: reason, sha: "c".repeat(64) })] }) } } });
    expect((await adv.gate.check()).outcome).toBe("advanced");
    expect(adv.notes).toEqual([]);
    // The memory of what was notified is bounded.
    const many = rig({ plan: { m1: { report: report(Array.from({ length: 700 }, (_, i) => part(`p${i}`, { outcome: "refused", error: reason, sha: String(i).padStart(64, "0") }))) } } });
    await many.gate.check();
    expect(many.notes.length).toBe(700);
    expect(JSON.parse(readFileSync(join(many.deps.stateDir, CANDIDATE_FILE), "utf8")).refusedNotified.length).toBe(500);
  });

  test("[B2] a member that could not read its designs holds the pin, and is not remembered as hosting none", async () => {
    const unread = report([], { errors: ["fixtures: could not list origin/main (fatal: unable to read tree)"] });
    const r = rig({ plan: { m2: { report: unread } } });
    const check = await r.gate.check();
    expect(check.outcome).toBe("held");
    expect(check.detail).toContain("could not list origin/main");
    expect(r.gate.status().lastEvaluation!.machines.find((m) => m.serverName === "M2")).toMatchObject({ state: "held", holds: true });
    expect(r.advances).toEqual([]);
    // It reported `hostsDesigns: false` only because the read failed. Unreachable next time, it
    // must still hold: "hosts nothing" was never established.
    r.plan.m2 = { reachable: false };
    r.clock.t += 4 * HOUR;
    const next = await r.gate.check();
    expect(next.outcome).toBe("held");
    expect(r.gate.status().lastEvaluation!.machines.find((m) => m.serverName === "M2")).toMatchObject({ state: "unreachable", holds: true });
    expect(JSON.parse(readFileSync(join(r.deps.stateDir, CANDIDATE_FILE), "utf8")).hosts.m2).toBeUndefined();
    // A report that ran out of time (partial results) is held the same way.
    const partial = rig({ plan: { m1: { report: report([part("a")], { errors: ["this machine's replay ran out of time with 3 of 4 designs not replayed"] }) } } });
    expect(await partial.gate.check()).toMatchObject({ outcome: "held", detail: expect.stringContaining("ran out of time") });
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
    const r = rig({ hub: "SolidCraft 0.45.0 could not be installed here: GitHub answered 503", hubFailure: "download-failed" });
    const check = await r.gate.check();
    expect(check.outcome).toBe("error");
    expect(check.detail).toContain("503");
    expect(r.replays).toEqual(["hub:0.45.0"]);
    expect(r.advances).toEqual([]);
    expect(r.gate.status().rejected).toEqual([]);
    expect(r.notes).toEqual([]);
  });

  test("[B2] a hub install that fails for a passing reason is retried with a growing wait, at most once in 24 hours, and the attempts are counted", async () => {
    const r = rig({ hub: "SolidCraft 0.45.0 could not be installed here: GitHub answered 503", hubFailure: "download-failed" });
    const attemptsAt: number[] = [];
    // A check every 4 hours for a week, as the timer would run them.
    for (let h = 0; h <= 7 * 24; h += 4) {
      r.clock.t = T0 + h * HOUR;
      r.releases = [rel("0.45.0", 50 + h, {}, r.clock.t)];
      const before = r.replays.length;
      const check = await r.gate.check();
      if (r.replays.length > before) {
        attemptsAt.push(h);
        expect(check.outcome).toBe("error");
      } else {
        expect(check.outcome).toBe("backoff");
        expect(check.detail).toContain("tried again after");
      }
    }
    // Waits of 4, 8, 16, then 24 hours each: 9 downloads in a week instead of 43.
    expect(attemptsAt).toEqual([0, 4, 12, 28, 52, 76, 100, 124, 148]);
    const st = r.gate.status();
    expect(st.retry).toMatchObject({ version: "0.45.0", attempts: 9, reason: expect.stringContaining("503") });
    expect(Date.parse(st.retry!.nextAt) - (T0 + 148 * HOUR)).toBe(24 * HOUR); // capped
    expect(st.rejected).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(r.gate.candidateVersion()).toBe("0.45.0");
    // The count survives a restart…
    const again = rig({ dir: r.deps.stateDir, clock: r.clock, releases: r.releases, hub: "still down", hubFailure: "download-failed" });
    expect(again.gate.status().retry?.attempts).toBe(9);
    expect((await again.gate.check()).outcome).toBe("backoff");
    expect(again.replays).toEqual([]);
    // …and once the install works the evaluation goes ahead and the counter is gone.
    r.hub = undefined;
    r.clock.t = T0 + 172 * HOUR;
    r.releases = [rel("0.45.0", 250, {}, r.clock.t)];
    expect((await r.gate.check()).outcome).toBe("advanced");
    expect(r.gate.status().retry).toBeUndefined();
    // "Gatekeeper unavailable" and a disk error are passing reasons too.
    for (const failure of ["cannot-verify", "install-failed", undefined]) {
      const t = rig({ hub: "could not be installed", hubFailure: failure });
      expect((await t.gate.check()).outcome).toBe("error");
      expect(t.gate.status().retry?.attempts).toBe(1);
    }
  });

  test("[B2] a candidate the hub refuses on verification is rejected with one notification and never downloaded again", async () => {
    expect(VERIFICATION_REFUSALS).toEqual(["sha-mismatch", "bad-zip", "unsafe-zip", "missing-binary", "signature-invalid", "wrong-team", "not-notarized", "version-mismatch"]);
    for (const failure of ["sha-mismatch", "signature-invalid", "wrong-team", "not-notarized", "version-mismatch"]) {
      const r = rig({ hub: `SolidCraft 0.45.0 could not be installed here: refused (${failure})`, hubFailure: failure });
      const check = await r.gate.check();
      expect(check.outcome).toBe("rejected");
      expect(check.detail).toContain("the hub refused to install it");
      expect(r.replays).toEqual(["hub:0.45.0"]); // no member was asked
      expect(r.advances).toEqual([]);
      const st = r.gate.status();
      expect(st.rejected.map((x) => [x.version, x.failures.length])).toEqual([["0.45.0", 0]]);
      expect(st.rejected[0]!.reason).toContain(failure);
      expect(st.retry).toBeUndefined();
      expect(r.notes.length).toBe(1);
      expect(r.notes[0]!.body).toContain("the hub refused to install it");
      // Four more checks: no further download, no further notification.
      for (let i = 1; i <= 4; i++) {
        r.clock.t += 4 * HOUR;
        expect((await r.gate.check()).outcome).toBe("none");
      }
      expect(r.replays).toEqual(["hub:0.45.0"]);
      expect(r.notes.length).toBe(1);
    }
  });

  test("[B2] the rejected list is bounded: the newest 50 versions, each with at most 50 failures and a truncated flag", async () => {
    expect([MAX_REJECTED, MAX_REJECTED_FAILURES]).toEqual([50, 50]);
    const many = Array.from({ length: 120 }, (_, i) => part(`p${i}`, { outcome: "differs", differences: [{ field: "faces", body: "Body1", old: 6, new: 7 }] }));
    const r = rig({ plan: { m1: { report: report(many) } } });
    for (let i = 0; i < 55; i++) {
      r.clock.t = T0 + i * 4 * HOUR;
      r.releases = [rel(`0.${45 + i}.0`, 50, {}, r.clock.t)];
      expect((await r.gate.check()).outcome).toBe("rejected");
    }
    const st = r.gate.status();
    expect(st.rejected.length).toBe(50);
    expect(st.rejected[0]!.version).toBe("0.50.0"); // the five oldest were dropped
    expect(st.rejected.at(-1)!.version).toBe("0.99.0");
    for (const rej of st.rejected) {
      expect(rej.failures.length).toBe(50);
      expect(rej.failuresTruncated).toBe(true);
    }
    expect(r.notes.length).toBe(55); // one per rejected version, none repeated
    // A short list is not flagged.
    const few = rig({ plan: { m1: { report: report([DIFFERS]) } } });
    await few.gate.check();
    expect(few.gate.status().rejected[0]!.failuresTruncated).toBeUndefined();
    // The file on disk is bounded too.
    expect(JSON.parse(readFileSync(join(r.deps.stateDir, CANDIDATE_FILE), "utf8")).rejected.length).toBe(50);
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
    // The marker stays until a check completes, so the build already downloaded for the cut-short
    // evaluation is kept on disk rather than pruned and fetched again.
    expect(JSON.parse(readFileSync(join(dir, CANDIDATE_FILE), "utf8")).inFlight.version).toBe("0.45.0");
    expect(second.gate.candidateVersion()).toBe("0.45.0");

    // The next check evaluates the whole fleet again and only then advances.
    expect(await second.gate.check()).toMatchObject({ outcome: "advanced", version: "0.45.0" });
    expect(second.replays.sort()).toEqual(["hub:0.45.0", "m1:0.45.0:0.44.1", "m2:0.45.0:0.44.1"]);
    expect(second.advances.length).toBe(1);
    expect(second.gate.status().interrupted).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, CANDIDATE_FILE), "utf8")).inFlight).toBeUndefined();
    expect(second.gate.candidateVersion()).toBeUndefined();
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

  test("[B2] a daemon that keeps restarting mid-evaluation starts a check at most once an hour, not two minutes after every start", async () => {
    const dir = stateDir();
    const clock = { t: T0 };
    const first = rig({ dir, clock, plan: { m1: { hang: true } } });
    void first.gate.check(); // starts, and the daemon goes down before it finishes
    for (let i = 0; i < 200 && !first.replays.includes("m1:0.45.0:0.44.1"); i++) await new Promise((r) => setTimeout(r, 5));
    expect(JSON.parse(readFileSync(join(dir, CANDIDATE_FILE), "utf8")).lastCheckStartedAt).toBe(new Date(T0).toISOString());

    // Restarts 5, 20 and 50 minutes later: each waits out the rest of the hour.
    for (const minutes of [5, 20, 50]) {
      clock.t = T0 + minutes * 60_000;
      const g = rig({ dir, clock });
      expect(g.gate.firstCheckDelay()).toBe((60 - minutes) * 60_000);
      const once: number[] = [];
      g.gate.start(undefined, (() => 0) as never, ((_: () => void, ms: number) => (once.push(ms), 0)) as never);
      expect(once).toEqual([(60 - minutes) * 60_000]);
      g.gate.stop();
    }
    // 59 minutes on, the floor of two minutes applies; after the hour it is two minutes again.
    clock.t = T0 + 59 * 60_000;
    expect(rig({ dir, clock }).gate.firstCheckDelay()).toBe(2 * 60_000);
    clock.t = T0 + 3 * HOUR;
    const late = rig({ dir, clock });
    expect(late.gate.firstCheckDelay()).toBe(2 * 60_000);
    // Once a check does finish, the ordinary rule is back: four hours after it.
    await late.gate.check();
    clock.t += 30 * 60_000;
    expect(rig({ dir, clock, pinned: "0.45.0" }).gate.firstCheckDelay()).toBe(3.5 * HOUR);
    first.release();
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
