/**
 * Phase B2 real-tool suite (agent-cad-and-browser spec §8.3 "B": "replay the repo's fixture designs
 * under it"). Runs the REAL `solidcraft-cli eval` through src/solidcraft/replay.ts, from a real git
 * repository with a real `origin`. Nothing is faked.
 *
 * Skipped unless ANVIL_REAL_TOOLS is set (`phase-gate B2 --require-real` sets it and fails on a skip).
 *
 * Builds: the two the B0 spike extracted (0.43.0 as the pinned build, 0.44.1 as the candidate) when
 * they are still under /tmp/sc-b0/x. Otherwise the app bundle stands in for BOTH sides; that run
 * says so in its output and still checks the real eval, but it does not compare two builds.
 * With neither available the tests fail: a real run that proves nothing must not pass.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REAL } from "../helpers/real-tools";
import { REFERENCE_PLATE, startFake } from "../helpers/fake-solidcraft";
import { APP_BUNDLE_SOLIDCRAFT_CLI } from "../../src/solidcraft/binary";
import { binaryEnv } from "../../src/solidcraft/install";
import { classify, evalDesign, readEval, replayMachine, replayRun, type ReplayBuild } from "../../src/solidcraft/replay";
import { commitFiles, fixtureRepo, git } from "../helpers/solidcraft-replay";

const SPIKE = "/tmp/sc-b0";
const spikeBuild = (v: string): string => join(SPIKE, "x", v, `solidcraft-cli-${v}-macos-universal`, "solidcraft-cli");
const SPIKE_PLATE = join(SPIKE, "out", "0.43.0", "plate.script.json");
const SPIKE_GEOMFAIL = join(SPIKE, "cases", "geomfail.json");
/** The reference plate at L = 80, as the real kernel measures it (A0/B0 evidence). */
const PLATE_VOLUME = 23335.167;

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function versionOf(path: string): Promise<string> {
  const r = await replayRun([path, "--version"], { env: binaryEnv(), timeoutMs: 60_000 });
  const v = r.stdout.trim().match(/^solidcraft-cli (\d+\.\d+\.\d+)$/)?.[1];
  if (r.code !== 0 || !v) throw new Error(`[B2 real] ${path} --version did not answer (exit ${r.code}: ${r.stderr.trim() || r.stdout.trim()})`);
  return v;
}

/** The pinned build and the candidate to use, and whether they are really two builds. */
async function realBuilds(): Promise<{ pinned: ReplayBuild; candidate: ReplayBuild; twoBuilds: boolean }> {
  if (existsSync(spikeBuild("0.43.0")) && existsSync(spikeBuild("0.44.1"))) {
    const pinned = { path: spikeBuild("0.43.0"), version: await versionOf(spikeBuild("0.43.0")) };
    const candidate = { path: spikeBuild("0.44.1"), version: await versionOf(spikeBuild("0.44.1")) };
    return { pinned, candidate, twoBuilds: true };
  }
  if (!existsSync(APP_BUNDLE_SOLIDCRAFT_CLI)) {
    throw new Error(`[B2 real] no SolidCraft build to run: neither ${spikeBuild("0.43.0")} + ${spikeBuild("0.44.1")} nor ${APP_BUNDLE_SOLIDCRAFT_CLI} exists.`);
  }
  const version = await versionOf(APP_BUNDLE_SOLIDCRAFT_CLI);
  console.log(`[B2 real] NOTE: the extracted builds under ${SPIKE}/x are absent, so SolidCraft ${version} from the app bundle is used for BOTH sides. The two-build comparison was NOT exercised in this run.`);
  return { pinned: { path: APP_BUNDLE_SOLIDCRAFT_CLI, version }, candidate: { path: APP_BUNDLE_SOLIDCRAFT_CLI, version }, twoBuilds: false };
}

/** A real exported plate script: the spike's, or one built and exported now by the real binary over MCP. */
async function plateScript(cli: string): Promise<string> {
  if (existsSync(SPIKE_PLATE)) return readFileSync(SPIKE_PLATE, "utf8");
  const dir = tmp("anvil-sc-real-b2-gen-");
  const sc = await startFake({ cli: [cli], allow: [dir], env: { SOLIDCRAFT_GPU: "cpu" } });
  try {
    const built = await sc.call("batch", { commands: REFERENCE_PLATE });
    if (built.isError) throw new Error(`[B2 real] the real SolidCraft could not build the reference plate: ${built.text}`);
    const exported = await sc.call("execute", { command: "timeline.export_script", params: {} });
    if (exported.isError || !exported.json?.script?.commands) throw new Error(`[B2 real] the real SolidCraft did not export a script: ${exported.text.slice(0, 400)}`);
    return JSON.stringify(exported.json.script, null, 1);
  } finally {
    await sc.close();
  }
}

/** The plate script with its fillet radius made impossible (500 mm on an 80 × 50 plate). */
function withImpossibleFillet(script: string): string {
  if (existsSync(SPIKE_GEOMFAIL)) return readFileSync(SPIKE_GEOMFAIL, "utf8");
  const doc = JSON.parse(script) as { commands: { command: string; params: { feature?: { type?: string; radius?: unknown } } }[] };
  const fillet = doc.commands.find((c) => c.params?.feature?.type === "fillet");
  if (!fillet?.params.feature) throw new Error("[B2 real] the plate script has no fillet feature to break");
  fillet.params.feature.radius = "500 mm";
  return JSON.stringify(doc, null, 1);
}

test.skipIf(!REAL)(
  "[B2 real] a real exported plate script, read from origin/main of a real repository, replays to `same` under the pinned build and the candidate",
  async () => {
    const { pinned, candidate, twoBuilds } = await realBuilds();
    if (twoBuilds) expect(pinned.version).not.toBe(candidate.version); // two builds, not one twice
    const script = await plateScript(pinned.path);
    const root = tmp("anvil-sc-real-b2-");
    const repo = fixtureRepo(root, { "cad/plate/design.json": script, "cad/plate/part.json": JSON.stringify({ measured: { volume_mm3: 1, solidcraft: "0.1.0" } }) });
    // The checkout wanders off to a branch with a broken design; the replay must not care.
    git(repo.repoRoot, "checkout", "-q", "-b", "feature");
    commitFiles(repo.repoRoot, { "cad/plate/design.json": "not a design at all" }, "feature work");

    const report = await replayMachine({ candidate, baseline: pinned, environments: [{ name: "real-fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }], timeoutMs: 180_000 });
    console.log(`[B2 real] replayed under ${pinned.version} and ${candidate.version}: ${JSON.stringify(report.parts)}`);
    expect(report).toMatchObject({ candidate: candidate.version, baseline: pinned.version, hostsDesigns: true, pass: true, notes: [] });
    expect(report.parts.length).toBe(1);
    const p = report.parts[0]!;
    expect(p).toMatchObject({ part: "plate", path: "cad/plate/design.json", ref: "origin/main", outcome: "same" });
    expect(p.differences).toBeUndefined();
    // Both builds really computed the plate: 23,335.2 mm³, 22 faces, one body.
    for (const n of [p.old!, p.new!]) {
      expect(n.body_count).toBe(1);
      expect(n.faces).toBe(22);
      expect(Math.abs(n.volume_mm3 - PLATE_VOLUME)).toBeLessThan(0.01);
    }
    // And they agree to well inside the 1e-6 tolerance (adjacent releases differed by 5e-12).
    expect(Math.abs(p.old!.volume_mm3 - p.new!.volume_mm3) / p.old!.volume_mm3).toBeLessThan(1e-6);
  },
  10 * 60_000,
);

test.skipIf(!REAL)(
  "[B2 real] a script whose fillet cannot be computed is a failed replay even though the real eval exits 0",
  async () => {
    const { pinned, candidate } = await realBuilds();
    const good = await plateScript(pinned.path);
    const bad = withImpossibleFillet(good);
    const dir = tmp("anvil-sc-real-b2-bad-");
    const badFile = join(dir, "bad.json");
    const goodFile = join(dir, "good.json");
    writeFileSync(badFile, bad);
    writeFileSync(goodFile, good);

    // The raw fact first: the real tool exits 0 and puts the failure on the timeline.
    const raw = await replayRun([candidate.path, "eval", badFile, "--json-out", join(dir, "raw.json")], { env: binaryEnv(), timeoutMs: 180_000 });
    expect(raw.code).toBe(0);
    const doc = JSON.parse(readFileSync(join(dir, "raw.json"), "utf8")) as { timeline: { name: string; error: string | null }[]; body_count: number };
    const failed = doc.timeline.filter((t) => t.error !== null);
    expect(failed.length).toBeGreaterThan(0);
    expect(doc.body_count).toBeGreaterThan(0); // it still reports (wrong) geometry
    console.log(`[B2 real] eval exited ${raw.code} with timeline error: ${failed[0]!.name}: ${failed[0]!.error}`);

    // replay.ts reads that as a failure, under each build…
    expect(readEval(raw.code, readFileSync(join(dir, "raw.json"), "utf8"), raw.stderr).ok).toBe(false);
    const badUnderCandidate = await evalDesign(candidate, badFile, join(dir, "c.json"), replayRun, 180_000, binaryEnv());
    const badUnderPinned = await evalDesign(pinned, badFile, join(dir, "p.json"), replayRun, 180_000, binaryEnv());
    expect(badUnderCandidate).toEqual({ ok: false, error: expect.stringContaining("failed") });
    expect(badUnderPinned.ok).toBe(false);
    // …so a design that replays under the pin and does this under the candidate holds the pin,
    const goodUnderPinned = await evalDesign(pinned, goodFile, join(dir, "g.json"), replayRun, 180_000, binaryEnv());
    expect(goodUnderPinned.ok).toBe(true);
    expect(classify(goodUnderPinned, badUnderCandidate)).toMatchObject({ outcome: "candidate-error", error: expect.stringContaining("failed") });
    // …and through the whole machine replay, a design broken under both builds is `baseline-broken`
    // (reported, not held against the candidate) while the good plate beside it is `same`.
    const repo = fixtureRepo(tmp("anvil-sc-real-b2-repo-"), { "cad/plate/design.json": good, "cad/overfilleted/design.json": bad });
    const report = await replayMachine({ candidate, baseline: pinned, environments: [{ name: "real-fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }], timeoutMs: 180_000 });
    expect(report.parts.map((p) => [p.part, p.outcome])).toEqual([["overfilleted", "baseline-broken"], ["plate", "same"]]);
    expect(report.parts[0]!.error).toContain("failed");
    expect(report.pass).toBe(true);
  },
  10 * 60_000,
);
