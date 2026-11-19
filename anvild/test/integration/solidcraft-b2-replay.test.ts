/**
 * Phase B2 functional scenarios (agent-cad-and-browser spec §5 "Phase B2", §8.2): one test per
 * Acceptance bullet, driven through REAL daemons, as in solidcraft-b1-pin.test.ts.
 *
 * Every machine is a real `createServer` daemon with its own state dir and its own environments;
 * the hub reaches the members over real HTTP. The designs live in real git repositories with a real
 * bare `origin`. The SolidCraft builds are the fake binary, installed through the real installer
 * from release zips, with a per-version behaviour table baked in — so the pinned build and the
 * candidate are two different executables that can genuinely compute different numbers (§7: "replay
 * gate compares a build with itself"). Faked: the GitHub release list and download, Apple's
 * codesign / spctl, the push registries (captured), and the clock.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { rest } from "@protocol";
import { resolveSolidcraftCli, setManagedSolidcraftCli } from "../../src/solidcraft/binary";
import { installedSolidcraft, solidcraftCliPath, solidcraftRoot } from "../../src/solidcraft/install";
import type { GithubRelease } from "../../src/solidcraft/release";
import type { ReplayWorktree } from "../../src/solidcraft/replay";
import type { SolidcraftTestHooks } from "../../src/server/fleet-solidcraft";
import type { PeerTrust } from "../../src/server/pairing";
import { fakeReleaseZip, fakeVerifier, memoryDownloader } from "../helpers/solidcraft-release";
import { asDesignSteps, box, commitFiles, designJson, fakeReleaseWithTable, fixtureRepo, git, githubRelease, plate, pushFromElsewhere, rawScript, writeTable, type FakeEvalTable, type FixtureRepo } from "../helpers/solidcraft-replay";

process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "sk-ant-oat-test-placeholder";
const { createServer } = await import("../../src/server/http");

const HOUR = 60 * 60_000;
const VERSIONS = ["0.44.1", "0.45.0", "0.46.0", "0.47.0"] as const;
const PLATE_80 = 23335.166952407875;

const cleanups: (() => void)[] = [];
afterAll(() => {
  cleanups.forEach((c) => c());
  setManagedSolidcraftCli(undefined);
});
function tmp(prefix = "anvil-sc-b2-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** One scenario's world: a behaviour table, the release zips that read it, a clock and a release list. */
interface World {
  tableFile: string;
  setTable: (t: FakeEvalTable) => void;
  zips: Record<string, Buffer>;
  shas: Record<string, string>;
  clock: { t: number };
  /** What "GitHub" lists. Mutable. */
  releases: GithubRelease[];
  /** A release entry `ageHours` old right now. */
  rel: (version: string, ageHours: number) => GithubRelease;
  github: { down: boolean; lists: number };
  notes: { title: string; body: string; tag: string }[];
}
function world(table: FakeEvalTable = {}): World {
  const dir = tmp("anvil-sc-b2-world-");
  const tableFile = writeTable(join(dir, "table.json"), table);
  const zips: Record<string, Buffer> = {};
  const shas: Record<string, string> = {};
  for (const v of VERSIONS) {
    const z = fakeReleaseWithTable(v, tableFile);
    zips[v] = z.zip;
    shas[v] = z.sha256;
  }
  const w: World = {
    tableFile,
    setTable: (t) => void writeTable(tableFile, t),
    zips,
    shas,
    clock: { t: Date.parse("2026-11-19T12:00:00.000Z") },
    releases: [],
    rel: (version, ageHours) => githubRelease(version, w.clock.t - ageHours * HOUR, shas[version]!),
    github: { down: false, lists: 0 },
    notes: [],
  };
  return w;
}

interface Daemon {
  base: string;
  dir: string;
  serverId: string;
  serverName: string;
  download: ReturnType<typeof memoryDownloader>;
  stop: () => void;
}
interface BootOptions {
  dir?: string;
  features?: string[];
  members?: Daemon[];
  /** Repositories this machine hosts as environments (default branch `main`). */
  repos?: FixtureRepo[];
  worktrees?: ReplayWorktree[];
  /** The zips THIS machine's downloads return (default: the world's good ones). */
  zips?: Record<string, Buffer>;
  identity?: PeerTrust;
  hooks?: Partial<SolidcraftTestHooks>;
}
async function boot(w: World, o: BootOptions = {}): Promise<Daemon> {
  const dir = o.dir ?? tmp();
  if (o.members) writeFileSync(join(dir, "fleet.json"), JSON.stringify({ members: o.members.map((m) => ({ serverId: m.serverId, serverName: m.serverName, host: "127.0.0.1", url: `${m.base}/` })) }));
  // Environments go through the daemon's real store, exactly as a person's would.
  if (o.repos) writeFileSync(join(dir, "environments.json"), JSON.stringify({ environments: o.repos.map((r, i) => ({ id: `env_${i}`, name: `fixtures-${i}`, repoRoot: r.repoRoot, isRepo: true, defaultBase: "main" })) }));
  const download = memoryDownloader(o.zips ?? w.zips);
  const srv = createServer({
    host: "127.0.0.1",
    port: 0,
    stateDir: dir,
    envFile: join(dir, "env"),
    features: o.features ?? ["solidcraft-pin"],
    resolveIdentity: async () => ({ trust: o.identity ?? "sameUser" }),
    solidcraft: {
      install: { download, run: fakeVerifier(), notarizeAttempts: 2, notarizeRetryMs: 1, log: () => {} },
      resolveRef: async (version) => {
        if (!w.shas[version]) throw new Error(`SolidCraft has no release v${version}`);
        return { version, sha256: w.shas[version]! };
      },
      env: {},
      exists: () => false,
      primeResolver: false,
      reconcileMs: 0,
      checkEveryMs: 0, // tests press "Check now"; the 4-hour timer is covered in the unit tests
      now: () => w.clock.t,
      listReleases: async () => {
        w.github.lists++;
        if (w.github.down) throw new Error("getaddrinfo ENOTFOUND api.github.com");
        return w.releases;
      },
      releaseSha: async (_release, version) => w.shas[version]!,
      notify: (title, body, tag) => void w.notes.push({ title, body, tag }),
      worktrees: () => o.worktrees ?? [],
      ...o.hooks,
    },
  });
  const base = `http://127.0.0.1:${srv.port}`;
  const health = (await (await fetch(`${base}/api/health`)).json()) as rest.HealthResponse;
  const d: Daemon = { base, dir, serverId: health.serverId, serverName: health.serverName, download, stop: () => srv.stop() };
  cleanups.push(() => srv.stop());
  return d;
}

const post = (d: Daemon, path: string, body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }): Promise<Response> =>
  fetch(`${d.base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
const get = async <T>(d: Daemon, path: string): Promise<T> => (await (await fetch(`${d.base}${path}`)).json()) as T;
const localStatus = (d: Daemon) => get<rest.solidcraft.StatusResponse>(d, "/api/solidcraft/status");
const gateStatus = (d: Daemon) => get<rest.solidcraft.CandidateStatusResponse>(d, "/api/fleet/solidcraft/candidate");
const checkNow = async (d: Daemon) => (await (await post(d, "/api/fleet/solidcraft/candidate/check", {})).json()) as rest.solidcraft.CandidateCheckResponse;
const versionFolders = (d: Daemon): string[] => (existsSync(solidcraftRoot(d.dir)) ? readdirSync(solidcraftRoot(d.dir)).filter((n) => /^\d/.test(n)).sort() : []);

async function settled(hub: Daemon): Promise<rest.solidcraft.FleetStatusResponse> {
  for (let i = 0; i < 600; i++) {
    const st = await get<rest.solidcraft.FleetStatusResponse>(hub, "/api/fleet/solidcraft/status");
    if (!st.active) return st;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("the pin fan-out did not settle");
}
/** Set the fleet's starting pin by hand, as the owner does, and wait for every machine. */
async function pinTo(hub: Daemon, version: string): Promise<void> {
  const res = await post(hub, "/api/fleet/solidcraft/pin", { version });
  expect(res.status).toBe(200);
  await settled(hub);
}
const machine = (st: rest.solidcraft.CandidateStatusResponse, d: Daemon) => st.lastEvaluation!.machines.find((m) => m.serverId === d.serverId)!;
const repoWith = (files: Record<string, string>): FixtureRepo => fixtureRepo(tmp("anvil-sc-b2-repo-"), files);
const PLATE_REPO = () => repoWith({ "cad/plate/design.json": designJson("plate", plate()) });

describe("Phase B2 acceptance", () => {
  test("[B2] with releases 10, 30 and 50 hours old the 50-hour one is chosen; with only 10 and 30, none is", async () => {
    const w = world();
    const hub = await boot(w, { repos: [PLATE_REPO()] });
    await pinTo(hub, "0.44.1");
    w.releases = [w.rel("0.47.0", 10), w.rel("0.46.0", 30), w.rel("0.45.0", 50)];
    const r = await checkNow(hub);
    expect(r.check).toMatchObject({ outcome: "advanced", version: "0.45.0" });
    expect(r.lastEvaluation!.candidate).toEqual({ version: "0.45.0", sha256: w.shas["0.45.0"]! });
    await settled(hub);
    expect((await localStatus(hub)).pin).toMatchObject({ version: "0.45.0", sha256: w.shas["0.45.0"]!, previous: { version: "0.44.1" } });
    expect(hub.download.calls).toEqual(["0.44.1", "0.45.0"]); // the younger releases were never even downloaded

    // Only the 10- and 30-hour releases: nothing is old enough, nothing happens.
    const w2 = world();
    const hub2 = await boot(w2, { repos: [PLATE_REPO()] });
    await pinTo(hub2, "0.44.1");
    w2.releases = [w2.rel("0.47.0", 10), w2.rel("0.46.0", 30)];
    const none = await checkNow(hub2);
    expect(none.check!.outcome).toBe("none");
    expect(none.lastEvaluation).toBeUndefined();
    expect((await localStatus(hub2)).pin!.version).toBe("0.44.1");
    expect(hub2.download.calls).toEqual(["0.44.1"]);
    // 20 hours later the 30-hour release is 50 hours old, and is chosen over the (now 30-hour) newer one.
    w2.clock.t += 20 * HOUR;
    expect((await checkNow(hub2)).check).toMatchObject({ outcome: "advanced", version: "0.46.0" });
  });

  test("[B2] part.json.measured deliberately stale: the candidate still passes, because the comparison is pinned build against candidate", async () => {
    const w = world({ "0.45.0": { edgesDelta: 8 } }); // a newer kernel: other edge counts, same solid
    // The committed part.json records numbers no build would produce today.
    const stale = { schema: 1, name: "plate", measured: { volume_mm3: 1, faces: 3, body_count: 9, bbox: [1, 1, 1], solidcraft: "0.1.0", scriptSha: "0".repeat(64) } };
    const repo = repoWith({ "cad/plate/design.json": designJson("plate", plate()), "cad/plate/part.json": JSON.stringify(stale, null, 2) });
    const hub = await boot(w, { repos: [repo] });
    await pinTo(hub, "0.44.1");
    w.releases = [w.rel("0.45.0", 50)];
    const r = await checkNow(hub);
    expect(r.check).toMatchObject({ outcome: "advanced", version: "0.45.0" });
    const p = machine(r, hub).report!.parts[0]!;
    expect(p).toMatchObject({ part: "plate", outcome: "same", ref: "origin/main" });
    // The numbers compared are the two builds' own, and neither is what part.json claims.
    expect(p.old!.volume_mm3).toBeCloseTo(PLATE_80, 6);
    expect(p.new!.volume_mm3).toBeCloseTo(PLATE_80, 6);
    expect(p.old!.volume_mm3).not.toBe(stale.measured.volume_mm3);
    expect(p.old!.faces).toBe(22);
    expect(machine(r, hub).report!.baseline).toBe("0.44.1");
    expect((await localStatus(hub)).pin!.version).toBe("0.45.0");
    expect(r.rejected).toEqual([]);
  });

  test("[B2] the local checkout is on a feature branch with a different design: the replay reads origin/<defaultBase>", async () => {
    // The candidate computes the FEATURE branch's design differently. If the replay read the
    // checkout, the candidate would be rejected.
    const w = world({ "0.45.0": { parts: { "plate-on-feature": { volumeScale: 1.5 } } } });
    const root = tmp("anvil-sc-b2-repo-");
    const repo = fixtureRepo(root, { "cad/plate/design.json": designJson("plate", plate(80)) });
    pushFromElsewhere(root, repo.origin!, { "cad/plate/design.json": designJson("plate", plate(100)) }); // origin/main moved on
    git(repo.repoRoot, "checkout", "-q", "-b", "feature");
    commitFiles(repo.repoRoot, { "cad/plate/design.json": designJson("plate-on-feature", plate(120)) }, "feature work");
    writeFileSync(join(repo.repoRoot, "cad/plate/design.json"), designJson("plate-on-feature", plate(140))); // and an uncommitted edit

    const hub = await boot(w, { repos: [repo] });
    await pinTo(hub, "0.44.1");
    w.releases = [w.rel("0.45.0", 50)];
    const r = await checkNow(hub);
    expect(r.check).toMatchObject({ outcome: "advanced", version: "0.45.0" });
    const parts = machine(r, hub).report!.parts;
    expect(parts.map((p) => [p.part, p.ref, p.outcome])).toEqual([["plate", "origin/main", "same"]]);
    // origin/main's plate is the L = 100 one — fetched, not the stale local main (80), the branch (120) or the file on disk (140).
    expect(parts[0]!.old!.volume_mm3).toBeCloseTo(PLATE_80 + 20 * 50 * 6, 4);
    expect(git(repo.repoRoot, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature"); // the checkout was left alone
    expect(git(repo.repoRoot, "status", "--porcelain")).toContain("cad/plate/design.json");

    // Control: the same world, with that design ON origin/main, is rejected — so the pass above was not luck.
    const w2 = world({ "0.45.0": { parts: { "plate-on-feature": { volumeScale: 1.5 } } } });
    const hub2 = await boot(w2, { repos: [repoWith({ "cad/plate/design.json": designJson("plate-on-feature", plate(120)) })] });
    await pinTo(hub2, "0.44.1");
    w2.releases = [w2.rel("0.45.0", 50)];
    expect((await checkNow(hub2)).check!.outcome).toBe("rejected");
  });

  test("[B2] all parts identical: the pin advances once, and not again within 24 h", async () => {
    const w = world({ "0.45.0": { edgesDelta: 8, areaScale: 1.0001 }, "0.46.0": { edgesDelta: 8 } });
    const files = { "cad/plate/design.json": designJson("plate", plate()), "cad/block/design.json": designJson("block", box()) };
    const m1 = await boot(w, { repos: [repoWith(files)] });
    const m2 = await boot(w, { repos: [repoWith({ "cad/lid/design.json": designJson("lid", box(40, 40, 3)) })] });
    const hub = await boot(w, { members: [m1, m2], repos: [repoWith(files)] });
    await pinTo(hub, "0.44.1");

    w.releases = [w.rel("0.45.0", 50)];
    const first = await checkNow(hub);
    expect(first.check).toMatchObject({ outcome: "advanced", version: "0.45.0" });
    expect(first.lastEvaluation!.machines.map((m) => [m.serverId, m.state, m.report!.parts.map((p) => `${p.part}:${p.outcome}`)])).toEqual(
      // Hub first, then members by name and id (in this simulator every machine has the same host name).
      [hub, ...[m1, m2].sort((a, b) => a.serverName.localeCompare(b.serverName) || a.serverId.localeCompare(b.serverId))].map((d) => [d.serverId, "pass", d === m2 ? ["lid:same"] : ["block:same", "plate:same"]]),
    );
    const st = await settled(hub);
    expect(st.pin).toMatchObject({ version: "0.45.0", previous: { version: "0.44.1" } });
    for (const d of [hub, m1, m2]) {
      expect((await localStatus(d)).local).toEqual({ state: "ready", version: "0.45.0", source: "managed", pinned: "0.45.0", available: true });
      expect(versionFolders(d)).toEqual(["0.44.1", "0.45.0"]); // pruned to pinned + previous
    }
    const pinnedAt = st.pin!.pinnedAt;

    // Five hours later a newer release has aged in. The pin moved today, so nothing is evaluated.
    w.clock.t += 5 * HOUR;
    w.releases = [w.rel("0.46.0", 49), w.rel("0.45.0", 55)];
    const lists = w.github.lists;
    const second = await checkNow(hub);
    expect(second.check!.outcome).toBe("rate-limited");
    expect(second.nextAdvanceAllowedAt).toBeDefined();
    expect(w.github.lists).toBe(lists);
    expect((await localStatus(hub)).pin).toMatchObject({ version: "0.45.0", pinnedAt });
    expect(hub.download.calls).toEqual(["0.44.1", "0.45.0"]);
    w.clock.t += 18 * HOUR; // 23 h after the advance: still not
    expect((await checkNow(hub)).check!.outcome).toBe("rate-limited");
    expect((await localStatus(hub)).pin!.version).toBe("0.45.0");

    // 25 hours after the advance it may move again.
    w.clock.t += 2 * HOUR;
    w.releases = [w.rel("0.46.0", 69)];
    expect((await checkNow(hub)).check).toMatchObject({ outcome: "advanced", version: "0.46.0" });
    expect((await settled(hub)).pin).toMatchObject({ version: "0.46.0", previous: { version: "0.45.0" } });
    expect(versionFolders(m1)).toEqual(["0.45.0", "0.46.0"]);
    expect(w.notes).toEqual([]);
  });

  test("[B2] one part's volume differs by more than its tolerance: the pin holds, the candidate is rejected with that part's old and new numbers, one notification is sent, and the next check does not retry it", async () => {
    // Under 0.45.0 the bracket's volume is 0.1 % larger (the tolerance is 0.0001 %). Nothing else changes.
    const w = world({ "0.45.0": { parts: { bracket: { volumeScale: 1.001 } } } });
    const m1 = await boot(w, { repos: [repoWith({ "cad/plate/design.json": designJson("plate", plate()), "cad/bracket/design.json": designJson("bracket", box(30, 20, 10)) })] });
    const hub = await boot(w, { members: [m1], repos: [PLATE_REPO()] });
    await pinTo(hub, "0.44.1");

    // The two builds are two executables that really disagree about this script (not one build twice).
    const script = join(tmp(), "bracket.json");
    writeFileSync(script, designJson("bracket", box(30, 20, 10)));
    const volume = (d: Daemon, v: string): number => JSON.parse(Bun.spawnSync([solidcraftCliPath(d.dir, v), "eval", script]).stdout.toString()).total.volume_mm3;

    w.releases = [w.rel("0.45.0", 50)];
    const r = await checkNow(hub);
    expect(r.check).toMatchObject({ outcome: "rejected", version: "0.45.0" });
    expect(volume(m1, "0.44.1")).toBe(6000);
    expect(volume(m1, "0.45.0")).toBeCloseTo(6006, 6);

    // The pin holds, everywhere.
    await settled(hub);
    for (const d of [hub, m1]) expect((await localStatus(d)).local).toMatchObject({ state: "ready", version: "0.44.1", pinned: "0.44.1", available: true });
    expect((await localStatus(hub)).pin).toMatchObject({ version: "0.44.1" });
    expect((await localStatus(hub)).pin!.previous).toBeUndefined();

    // Recorded as rejected, with that part's old and new numbers.
    expect(r.rejected.length).toBe(1);
    const rej = r.rejected[0]!;
    expect(rej).toMatchObject({ version: "0.45.0", sha256: w.shas["0.45.0"]! });
    expect(rej.failures.length).toBe(1);
    expect(rej.failures[0]).toMatchObject({ part: "bracket", outcome: "differs", serverName: m1.serverName, ref: "origin/main", old: { volume_mm3: 6000, faces: 6, body_count: 1 } });
    expect(rej.failures[0]!.differences).toEqual([{ field: "volume_mm3", body: "Body1", old: 6000, new: expect.closeTo(6006, 6) }]);
    expect(rej.failures[0]!.new!.volume_mm3).toBeCloseTo(6006, 6);
    expect(machine(r, m1)).toMatchObject({ state: "fail", holds: true });
    expect(machine(r, m1).report!.parts.find((p) => p.part === "plate")!.outcome).toBe("same");
    expect(machine(r, hub)).toMatchObject({ state: "pass", holds: false });

    // One notification, naming the part.
    expect(w.notes.length).toBe(1);
    expect(w.notes[0]!.title).toContain("0.45.0");
    expect(w.notes[0]!.body).toContain("bracket");
    expect(w.notes[0]!.body).toContain("6000 → 6006");

    // The next check does not retry it: nothing is replayed, nothing is notified.
    w.clock.t += 4 * HOUR;
    const downloads = [...m1.download.calls];
    const again = await checkNow(hub);
    expect(again.check!.outcome).toBe("none");
    expect(again.lastEvaluation!.finishedAt).toBe(r.lastEvaluation!.finishedAt); // still the same evaluation
    expect(m1.download.calls).toEqual(downloads);
    expect(w.notes.length).toBe(1);
    expect((await localStatus(hub)).pin!.version).toBe("0.44.1");
    // Even if the build would now pass, it stays rejected.
    w.setTable({});
    w.clock.t += 4 * HOUR;
    expect((await checkNow(hub)).check!.outcome).toBe("none");
    // The rejected build is not kept on the hub's disk.
    expect(versionFolders(hub)).toEqual(["0.44.1"]);
  });

  test("[B2] a member hosting designs is unreachable: the pin holds and the card names the member", async () => {
    const w = world();
    const m1 = await boot(w, { repos: [PLATE_REPO()] });
    const hub = await boot(w, { members: [m1], repos: [PLATE_REPO()] });
    await pinTo(hub, "0.44.1");
    // A first evaluation with the member up: it reports that it hosts designs, and the pin advances.
    w.releases = [w.rel("0.45.0", 50)];
    const first = await checkNow(hub);
    expect(first.check!.outcome).toBe("advanced");
    expect(machine(first, m1)).toMatchObject({ state: "pass", report: { hostsDesigns: true } });
    await settled(hub);

    // Next day the member is off when a new candidate comes up.
    w.clock.t += 25 * HOUR;
    w.releases = [w.rel("0.46.0", 50)];
    m1.stop();
    const r = await checkNow(hub);
    expect(r.check).toMatchObject({ outcome: "held", version: "0.46.0" });
    expect(r.check!.detail).toContain(m1.serverName);
    expect(machine(r, m1)).toMatchObject({ serverName: m1.serverName, state: "unreachable", holds: true });
    expect(machine(r, hub)).toMatchObject({ state: "pass", holds: false });
    expect((await localStatus(hub)).pin!.version).toBe("0.45.0"); // held
    expect(r.rejected).toEqual([]); // not a rejection: it is tried again
    expect(w.notes).toEqual([]);

    // The Settings card, rendered from exactly what the hub returned, names the member.
    const { cadCardHtml } = await import("../../web/src/settings-cad");
    const html = cadCardHtml({ status: await get<rest.solidcraft.FleetStatusResponse>(hub, "/api/fleet/solidcraft/status"), gate: await gateStatus(hub) });
    const rowAt = html.indexOf(`data-server-id="${m1.serverId}" data-state="unreachable" data-holds="1"`);
    expect(rowAt).toBeGreaterThan(-1);
    expect(html.slice(rowAt, rowAt + 400)).toContain(m1.serverName);
    expect(html).toContain("holds the pin");
    expect(html).toContain("held — not decided");

    // The candidate stays beside the pin on the hub for the retry, and is evaluated again next time.
    expect(versionFolders(hub)).toEqual(["0.44.1", "0.45.0", "0.46.0"]); // previous, pinned, candidate
    expect(installedSolidcraft(hub.dir, "0.46.0", w.shas["0.46.0"])).toBeDefined();
    w.clock.t += 4 * HOUR;
    expect((await checkNow(hub)).check).toMatchObject({ outcome: "held", version: "0.46.0" });
  });

  test("[B2] during evaluation the pinned build keeps serving sessions (the candidate is installed beside it)", async () => {
    setManagedSolidcraftCli(undefined);
    const w = world({ "0.45.0": { delayMs: 900 } }); // the candidate is slow, so the evaluation takes a while
    const repo = PLATE_REPO();
    const m1 = await boot(w, { repos: [PLATE_REPO()] });
    const hub = await boot(w, { members: [m1], repos: [repo], hooks: { primeResolver: true } }); // this daemon primes the process-wide resolver
    await pinTo(hub, "0.44.1");
    const pinnedPath = solidcraftCliPath(hub.dir, "0.44.1");
    expect(resolveSolidcraftCli({}, () => false)).toEqual({ path: pinnedPath, source: "managed", version: "0.44.1" });

    w.releases = [w.rel("0.45.0", 50)];
    const pending = checkNow(hub);
    // Wait until the evaluation is under way and the candidate is on disk on both machines.
    let seen: rest.solidcraft.CandidateStatusResponse | undefined;
    for (let i = 0; i < 600; i++) {
      const st = await gateStatus(hub);
      if (st.evaluating && installedSolidcraft(hub.dir, "0.45.0") && installedSolidcraft(m1.dir, "0.45.0")) {
        seen = st;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(seen?.evaluating?.version).toBe("0.45.0");
    // MID-EVALUATION: the candidate sits beside the pinned build…
    expect(versionFolders(hub)).toEqual(["0.44.1", "0.45.0"]);
    expect(versionFolders(m1)).toEqual(["0.44.1", "0.45.0"]);
    // …and every machine is still on the pin, available for CAD, running the pinned binary.
    for (const d of [hub, m1]) {
      const own = await localStatus(d);
      expect(own.local).toEqual({ state: "ready", version: "0.44.1", source: "managed", pinned: "0.44.1", available: true });
      expect(own.pin!.version).toBe("0.44.1");
    }
    expect(resolveSolidcraftCli({}, () => false)).toEqual({ path: pinnedPath, source: "managed", version: "0.44.1" }); // what the CAD manager would start
    expect(Bun.spawnSync([pinnedPath, "--version"]).stdout.toString().trim()).toBe("solidcraft-cli 0.44.1");
    const script = join(tmp(), "plate.json");
    writeFileSync(script, designJson("plate", plate()));
    expect(Bun.spawnSync([pinnedPath, "eval", script]).exitCode).toBe(0); // and it does serve
    expect((await gateStatus(hub)).evaluating?.version).toBe("0.45.0"); // all of that happened during the evaluation

    // Only when every machine has reported does the pin move.
    const done = await pending;
    expect(done.check).toMatchObject({ outcome: "advanced", version: "0.45.0" });
    expect(done.evaluating).toBeUndefined();
    await settled(hub);
    expect(resolveSolidcraftCli({}, () => false)).toEqual({ path: solidcraftCliPath(hub.dir, "0.45.0"), source: "managed", version: "0.45.0" });
    expect((await localStatus(m1)).local).toMatchObject({ state: "ready", version: "0.45.0" });
    setManagedSolidcraftCli(undefined);
  }, 60_000);
});

describe("Phase B2 surface", () => {
  test("[B2] 'Advance anyway' through the hub route pins a rejected candidate across the fleet", async () => {
    const w = world({ "0.45.0": { parts: { plate: { facesDelta: 2 } } } });
    const m1 = await boot(w, { repos: [PLATE_REPO()] });
    const hub = await boot(w, { members: [m1] }); // the hub hosts nothing
    await pinTo(hub, "0.44.1");
    w.releases = [w.rel("0.45.0", 50)];
    const r = await checkNow(hub);
    expect(r.check!.outcome).toBe("rejected");
    expect(machine(r, hub).state).toBe("no-designs");
    expect(r.rejected[0]!.failures[0]!.differences).toEqual([{ field: "faces", body: "Body1", old: 22, new: 24 }]);

    // A version that was never a candidate is refused; so is a missing content type.
    expect((await post(hub, "/api/fleet/solidcraft/candidate/advance", { version: "0.47.0" })).status).toBe(409);
    expect((await post(hub, "/api/fleet/solidcraft/candidate/advance", { version: "0.45.0" }, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await localStatus(hub)).pin!.version).toBe("0.44.1");

    const res = await post(hub, "/api/fleet/solidcraft/candidate/advance", { version: "0.45.0" });
    expect(res.status).toBe(200);
    const done = (await res.json()) as rest.solidcraft.AdvanceAnywayResponse;
    expect(done.pin).toMatchObject({ version: "0.45.0", sha256: w.shas["0.45.0"]!, previous: { version: "0.44.1" } });
    expect(done.lastEvaluation!.advancedAnyway).toBeDefined();
    const st = await settled(hub);
    expect(st.members.find((m) => m.serverId === m1.serverId)).toMatchObject({ state: "ready", version: "0.45.0" });
    // "Pin back" (B1) undoes it.
    const back = (await (await post(hub, "/api/fleet/solidcraft/pin/back", {})).json()) as rest.solidcraft.PinBackResponse;
    expect(back.pin!.version).toBe("0.44.1");
  });

  test("[B2] designs in an open session worktree are listed as advisory and do not hold the pin", async () => {
    const w = world({ "0.45.0": { parts: { wip: { volumeScale: 2 } } } });
    const wt = tmp("anvil-sc-b2-wt-");
    mkdirSync(join(wt, "cad/wip"), { recursive: true });
    writeFileSync(join(wt, "cad/wip/design.json"), designJson("wip", box()));
    const hub = await boot(w, { repos: [PLATE_REPO()], worktrees: [{ path: wt, label: "new lid", environment: "fixtures-0" }] });
    await pinTo(hub, "0.44.1");
    w.releases = [w.rel("0.45.0", 50)];
    const r = await checkNow(hub);
    expect(r.check!.outcome).toBe("advanced");
    expect(machine(r, hub).report!.advisory).toEqual([expect.objectContaining({ part: "wip", worktree: "new lid", outcome: "differs" })]);
    expect(machine(r, hub).report!.advisory[0]!.differences![0]).toMatchObject({ field: "volume_mm3", old: 6000, new: 12000 });
    expect(r.rejected).toEqual([]);
  });

  test("[B2] GitHub unreachable: the check is skipped and the pin is unchanged", async () => {
    const w = world();
    const hub = await boot(w, { repos: [PLATE_REPO()] });
    await pinTo(hub, "0.44.1");
    w.releases = [w.rel("0.45.0", 50)];
    w.github.down = true;
    const r = await checkNow(hub);
    expect(r.check).toMatchObject({ outcome: "skipped", detail: expect.stringContaining("ENOTFOUND") });
    expect(r.lastEvaluation).toBeUndefined();
    expect((await localStatus(hub)).pin!.version).toBe("0.44.1");
    expect(hub.download.calls).toEqual(["0.44.1"]);
    w.github.down = false; // and it recovers by itself on the next check
    expect((await checkNow(hub)).check!.outcome).toBe("advanced");
  });

  test("[B2] the member replay route installs the candidate beside the pin, reports, and leaves the pin alone", async () => {
    const w = world({ "0.45.0": { parts: { block: { failFeature: "Block" } } } });
    const m = await boot(w, { repos: [repoWith({ "cad/plate/design.json": designJson("plate", plate()), "cad/block/design.json": designJson("block", box()) })] });
    await pinTo(m, "0.44.1");
    const res = await post(m, "/api/solidcraft/replay", { candidate: { version: "0.45.0", sha256: w.shas["0.45.0"] }, pin: { version: "0.44.1", sha256: w.shas["0.44.1"] } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as rest.solidcraft.ReplayResponse;
    expect(body.ok).toBe(true);
    expect(body.report).toMatchObject({ candidate: "0.45.0", baseline: "0.44.1", hostsDesigns: true, pass: false });
    expect(body.report!.parts.map((p) => [p.part, p.outcome])).toEqual([["block", "candidate-error"], ["plate", "same"]]);
    expect(versionFolders(m)).toEqual(["0.44.1", "0.45.0"]);
    expect((await localStatus(m)).local).toEqual({ state: "ready", version: "0.44.1", source: "managed", pinned: "0.44.1", available: true });
    // A candidate whose zip is not the recorded one is not installed and not replayed.
    const bad = await post(m, "/api/solidcraft/replay", { candidate: { version: "0.46.0", sha256: "0".repeat(64) } });
    expect(bad.status).toBe(500);
    expect(((await bad.json()) as rest.solidcraft.ReplayResponse).error).toContain("sha256");
    expect(versionFolders(m)).toEqual(["0.44.1"]); // and the earlier candidate was pruned when the new one came in
    expect((await post(m, "/api/solidcraft/replay", { candidate: { version: "../x", sha256: "nope" } })).status).toBe(400);
  });

  test("[B2] a member that hosts designs but is not on the pin cannot pass by default: the pin holds until it has compared against the pinned build", async () => {
    // The candidate makes the plate 50 % larger. The member's copy of the PINNED release is not the
    // file the hub recorded, so its install of the pin failed and it has no pinned build.
    const table: FakeEvalTable = { "0.45.0": { parts: { plate: { volumeScale: 1.5 } } } };
    const w = world(table);
    const wrongPinned = fakeReleaseZip("0.44.1", { extra: [{ name: "solidcraft-cli-0.44.1-macos-universal/NOTICE", data: "a different file" }] });
    const offPin = await boot(w, { repos: [PLATE_REPO()], zips: { ...w.zips, "0.44.1": wrongPinned.zip } });
    const hub = await boot(w, { members: [offPin] }); // the hub hosts nothing: only the member can tell
    await pinTo(hub, "0.44.1");
    expect((await localStatus(offPin)).local).toMatchObject({ state: "error", available: false, failure: "sha-mismatch" });
    expect(versionFolders(offPin)).toEqual([]);

    w.releases = [w.rel("0.45.0", 50)];
    const r = await checkNow(hub);
    expect(r.check).toMatchObject({ outcome: "held", version: "0.45.0" }); // NOT advanced
    expect(r.check!.detail).toContain(offPin.serverName);
    const row = machine(r, offPin);
    expect(row).toMatchObject({ state: "error", holds: true });
    expect(row.detail).toContain("the pinned SolidCraft 0.44.1 is not installed here and could not be");
    expect(row.detail).toContain("nothing to compare 0.45.0 against");
    expect((await localStatus(hub)).pin!.version).toBe("0.44.1");
    expect(r.rejected).toEqual([]);

    // Control: the same world with the member able to install the pin. Now the comparison happens,
    // sees the 50 %, and the candidate is rejected — which is what the first run could not know.
    const w2 = world(table);
    const onPin = await boot(w2, { repos: [PLATE_REPO()] });
    const hub2 = await boot(w2, { members: [onPin] });
    await pinTo(hub2, "0.44.1");
    w2.releases = [w2.rel("0.45.0", 50)];
    const c = await checkNow(hub2);
    expect(c.check!.outcome).toBe("rejected");
    expect(machine(c, onPin).report).toMatchObject({ baseline: "0.44.1" });
    expect(c.rejected[0]!.failures[0]!.differences![0]).toMatchObject({ field: "volume_mm3", old: expect.closeTo(PLATE_80, 6), new: expect.closeTo(PLATE_80 * 1.5, 6) });
  });

  test("[B2] a committed design that carries a file-writing command is refused on the machine that hosts it, holds the pin by name, and writes nothing", async () => {
    const w = world();
    const outside = tmp("anvil-sc-b2-victim-");
    const victim = join(outside, "authorized_keys");
    writeFileSync(victim, "the real key\n");
    const evil = rawScript("bracket", [...asDesignSteps(box()), { command: "timeline.export_script", params: { path: victim } }, { command: "file.save", params: { path: join(outside, "saved.sc") } }]);
    const m1 = await boot(w, { repos: [repoWith({ "cad/plate/design.json": designJson("plate", plate()), "cad/bracket/design.json": evil })] });
    const hub = await boot(w, { members: [m1], repos: [PLATE_REPO()] });
    await pinTo(hub, "0.44.1");
    w.releases = [w.rel("0.45.0", 50)];
    const r = await checkNow(hub);
    expect(r.check!.outcome).toBe("held");
    expect(r.check!.detail).toContain("bracket was refused and not replayed");
    expect(r.check!.detail).toContain("timeline.export_script");
    const row = machine(r, m1);
    expect(row).toMatchObject({ state: "held", holds: true });
    expect(row.report!.parts.map((p) => [p.part, p.outcome])).toEqual([["bracket", "refused"], ["plate", "same"]]);
    expect((await localStatus(hub)).pin!.version).toBe("0.44.1");
    expect(r.rejected).toEqual([]); // the design is at fault, not the candidate
    expect(w.notes).toEqual([]);
    expect(readFileSync(victim, "utf8")).toBe("the real key\n");
    expect(readdirSync(outside)).toEqual(["authorized_keys"]);
  });

  test("[B2] a candidate the hub cannot download is retried with a growing wait; one it refuses on verification is rejected once", async () => {
    // Four checks, four hours apart, with the download failing every time.
    const w = world();
    const { "0.45.0": _missing, ...withoutCandidate } = w.zips;
    const hub = await boot(w, { repos: [PLATE_REPO()], zips: withoutCandidate });
    await pinTo(hub, "0.44.1");
    w.releases = [w.rel("0.45.0", 50)];
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await checkNow(hub);
      outcomes.push(r.check!.outcome);
      if (i === 0) expect(r.retry).toMatchObject({ version: "0.45.0", attempts: 1, reason: expect.stringContaining("404") });
      w.clock.t += 4 * HOUR;
    }
    expect(outcomes).toEqual(["error", "error", "backoff", "error"]); // tried at 0 h, 4 h and 12 h; not at 8 h
    expect(hub.download.calls.filter((v) => v === "0.45.0").length).toBe(3);
    const st = await gateStatus(hub);
    expect(st.retry).toMatchObject({ version: "0.45.0", attempts: 3 });
    expect(st.rejected).toEqual([]);
    expect(w.notes).toEqual([]);
    expect((await localStatus(hub)).pin!.version).toBe("0.44.1");

    // A zip that is not the one the release records: a verification refusal. Rejected at once.
    const w2 = world();
    const tampered = fakeReleaseZip("0.45.0", { extra: [{ name: "solidcraft-cli-0.45.0-macos-universal/NOTICE", data: "tampered" }] });
    const hub2 = await boot(w2, { repos: [PLATE_REPO()], zips: { ...w2.zips, "0.45.0": tampered.zip } });
    await pinTo(hub2, "0.44.1");
    w2.releases = [w2.rel("0.45.0", 50)];
    const first = await checkNow(hub2);
    expect(first.check!.outcome).toBe("rejected");
    expect(first.rejected[0]).toMatchObject({ version: "0.45.0", failures: [] });
    expect(first.rejected[0]!.reason).toContain("sha256");
    for (let i = 0; i < 4; i++) {
      w2.clock.t += 4 * HOUR;
      expect((await checkNow(hub2)).check!.outcome).toBe("none");
    }
    expect(hub2.download.calls.filter((v) => v === "0.45.0").length).toBe(1); // downloaded once, ever
    expect(w2.notes.length).toBe(1);
    expect(w2.notes[0]!.body).toContain("the hub refused to install it");
    expect(versionFolders(hub2)).toEqual(["0.44.1"]);
  });

  test("[B2] the new routes follow the managed-CLI posture, and are 404 without the solidcraft-pin feature", async () => {
    const w = world();
    const h = await boot(w);
    const posts: [string, unknown][] = [
      ["/api/fleet/solidcraft/candidate/check", {}],
      ["/api/fleet/solidcraft/candidate/advance", { version: "0.45.0" }],
      ["/api/solidcraft/replay", { candidate: { version: "0.45.0", sha256: w.shas["0.45.0"] } }],
    ];
    for (const [path, body] of posts) expect((await post(h, path, body, { "Content-Type": "text/plain" })).status).toBe(415);
    const other = await boot(w, { identity: "otherUser" });
    w.releases = [w.rel("0.45.0", 50)];
    for (const [path, body] of posts) {
      // A caller presenting a tailnet identity that resolves to another user is rejected on all three.
      const res = await post(other, path, body, { "Content-Type": "application/json", "Tailscale-User-Login": "mallory@example" });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    }
    // The hub routes reject a proven other user even from the local machine with no identity header.
    for (const [path, body] of posts.slice(0, 2)) expect((await post(other, path, body)).status).toBe(403);
    expect(w.github.lists).toBe(0);
    expect(other.download.calls).toEqual([]);
    expect((await gateStatus(other)).lastCheck).toBeUndefined();

    const off = await boot(w, { features: [] });
    expect((await fetch(`${off.base}/api/fleet/solidcraft/candidate`)).status).toBe(404);
    for (const [path, body] of posts) expect((await post(off, path, body)).status).toBe(404);
    expect(off.download.calls).toEqual([]);
  });
});
