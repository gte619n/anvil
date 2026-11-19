/**
 * Phase B2 real-tool suite (agent-cad-and-browser spec §8.3 "B": "replay the repo's fixture designs
 * under it"). Runs the REAL SolidCraft through src/solidcraft/replay.ts — screen, sandbox and
 * comparison — from a real git repository with a real `origin`. Nothing is faked.
 *
 * Skipped unless ANVIL_REAL_TOOLS is set (`phase-gate B2 --require-real` sets it and fails on a skip).
 *
 * It needs TWO real builds, the ones the B0 spike extracted: 0.43.0 as the pinned build and 0.44.1
 * as the candidate. Without both, every test here FAILS with the paths it wants: a real run that
 * compares a build with itself, or compares nothing, must not pass.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REAL } from "../helpers/real-tools";
import { REFERENCE_PLATE, startFake } from "../helpers/fake-solidcraft";
import { binaryEnv } from "../../src/solidcraft/install";
import { classify, replayInSandbox, replayMachine, type ReplayBuild } from "../../src/solidcraft/replay";
import { sandboxedReplay } from "../../src/solidcraft/replay-client";
import { screenScriptText } from "../../src/solidcraft/script-screen";
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

function versionOf(path: string): string {
  const r = Bun.spawnSync([path, "--version"], { env: binaryEnv() });
  const v = r.stdout.toString().trim().match(/^solidcraft-cli (\d+\.\d+\.\d+)$/)?.[1];
  if (r.exitCode !== 0 || !v) throw new Error(`[B2 real] ${path} --version did not answer (exit ${r.exitCode}: ${r.stderr.toString().trim() || r.stdout.toString().trim()})`);
  return v;
}

/** The pinned build and the candidate: two different real builds, or a thrown explanation. */
function realBuilds(): { pinned: ReplayBuild; candidate: ReplayBuild } {
  const missing = ["0.43.0", "0.44.1"].map(spikeBuild).filter((p) => !existsSync(p));
  if (missing.length) {
    throw new Error(
      `[B2 real] required SolidCraft builds are missing: ${missing.join(", ")}. ` +
        `This suite compares two real builds and does not fall back to one. To recreate them, for each of 0.43.0 and 0.44.1 run ` +
        `\`mkdir -p ${SPIKE}/x/<version> && unzip ${SPIKE}/dl/solidcraft-cli-<version>-macos-universal.zip -d ${SPIKE}/x/<version>\`; ` +
        `if the zips under ${SPIKE}/dl are gone too, download solidcraft-cli-<version>-macos-universal.zip from the v0.43.0 and v0.44.1 releases of github.com/tangency-labs/solidcraft first.`,
    );
  }
  const pinned = { path: spikeBuild("0.43.0"), version: versionOf(spikeBuild("0.43.0")) };
  const candidate = { path: spikeBuild("0.44.1"), version: versionOf(spikeBuild("0.44.1")) };
  expect(pinned.version).toBe("0.43.0");
  expect(candidate.version).toBe("0.44.1"); // two builds, not one twice
  return { pinned, candidate };
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

type Script = { about?: unknown; commands: { command: string; params: Record<string, any> }[] };

/** The plate script with its fillet radius made impossible (500 mm on an 80 × 50 plate). */
function withImpossibleFillet(script: string): string {
  if (existsSync(SPIKE_GEOMFAIL)) return readFileSync(SPIKE_GEOMFAIL, "utf8");
  const doc = JSON.parse(script) as Script;
  const fillet = doc.commands.find((c) => c.params?.feature?.type === "fillet");
  if (!fillet) throw new Error("[B2 real] the plate script has no fillet feature to break");
  fillet.params.feature.radius = "500 mm";
  return JSON.stringify(doc, null, 1);
}
const withStep = (script: string, step: Script["commands"][number]): string => {
  const doc = JSON.parse(script) as Script;
  return JSON.stringify({ ...doc, commands: [...doc.commands, step] }, null, 1);
};
const sandbox = (build: ReplayBuild, text: string) => replayInSandbox(build, text, (JSON.parse(text) as Script).commands, { timeoutMs: 180_000, tmpRoot: tmp("anvil-sc-real-b2-box-") });

test.skipIf(!REAL)(
  "[B2 real] a real exported plate script, read from origin/main of a real repository, replays to `same` under the pinned build and the candidate",
  async () => {
    const { pinned, candidate } = realBuilds();
    const script = await plateScript(pinned.path);
    expect(screenScriptText(script).ok).toBe(true); // a real export is a plain design script
    const root = tmp("anvil-sc-real-b2-");
    const repo = fixtureRepo(root, { "cad/plate/design.json": script, "cad/plate/part.json": JSON.stringify({ measured: { volume_mm3: 1, solidcraft: "0.1.0" } }) });
    // The checkout wanders off to a branch with a broken design; the replay must not care.
    git(repo.repoRoot, "checkout", "-q", "-b", "feature");
    commitFiles(repo.repoRoot, { "cad/plate/design.json": "not a design at all" }, "feature work");

    const report = await replayMachine({ candidate, baseline: pinned, environments: [{ name: "real-fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }], timeoutMs: 180_000 });
    console.log(`[B2 real] replayed under ${pinned.version} and ${candidate.version}: ${JSON.stringify(report.parts)}`);
    expect(report).toMatchObject({ candidate: "0.44.1", baseline: "0.43.0", hostsDesigns: true, pass: true, notes: [], errors: [] });
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
    // The comparison includes the centre of mass, which both real builds report.
    const raw = await sandboxedReplay(candidate, script, (JSON.parse(script) as Script).commands, { timeoutMs: 180_000, tmpRoot: tmp("anvil-sc-real-b2-box-") });
    expect(raw.status).toBe("replayed");
    if (raw.status === "replayed") expect((raw.doc.bodies[0] as { center_of_mass: number[] }).center_of_mass.length).toBe(3);
  },
  10 * 60_000,
);

test.skipIf(!REAL)(
  "[B2 real] a script whose fillet cannot be computed is a failed replay even though the real eval exits 0",
  async () => {
    const { pinned, candidate } = realBuilds();
    const good = await plateScript(pinned.path);
    const bad = withImpossibleFillet(good);
    const dir = tmp("anvil-sc-real-b2-bad-");
    const badFile = join(dir, "bad.json");
    writeFileSync(badFile, bad);

    // The raw fact first: the real `eval` exits 0 and puts the failure on the timeline.
    const raw = Bun.spawnSync([candidate.path, "eval", badFile, "--json-out", join(dir, "raw.json")], { env: binaryEnv(), cwd: dir });
    expect(raw.exitCode).toBe(0);
    const doc = JSON.parse(readFileSync(join(dir, "raw.json"), "utf8")) as { timeline: { name: string; error: string | null }[]; body_count: number };
    const failed = doc.timeline.filter((t) => t.error !== null);
    expect(failed.length).toBeGreaterThan(0);
    expect(doc.body_count).toBeGreaterThan(0); // it still reports (wrong) geometry
    console.log(`[B2 real] eval exited ${raw.exitCode} with timeline error: ${failed[0]!.name}: ${failed[0]!.error}`);

    // The sandboxed replay sees the same thing — the build answers "ok" and the timeline says otherwise —
    // and reads it as a conclusive failure, under each build…
    const badUnderCandidate = await sandbox(candidate, bad);
    const badUnderPinned = await sandbox(pinned, bad);
    expect(badUnderCandidate).toEqual({ ok: false, error: expect.stringContaining("failed"), conclusive: true });
    expect(badUnderPinned).toMatchObject({ ok: false, conclusive: true });
    // …so a design that replays under the pin and does this under the candidate rejects the candidate,
    const goodUnderPinned = await sandbox(pinned, good);
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

test.skipIf(!REAL)(
  "[B2 real] a design carrying file-writing commands is refused and writes nothing outside the sandbox; with the screen bypassed the sandbox alone still stops the write",
  async () => {
    const { pinned, candidate } = realBuilds();
    const good = await plateScript(pinned.path);
    const outside = tmp("anvil-sc-real-b2-victim-");
    const victim = join(outside, "authorized_keys");
    const VICTIM = "ssh-ed25519 AAAA the real key\n";
    const intact = (): void => {
      expect(readFileSync(victim, "utf8")).toBe(VICTIM); // byte for byte
      expect(readdirSync(outside)).toEqual(["authorized_keys"]); // and nothing new beside it
    };
    writeFileSync(victim, VICTIM);
    const steps: Script["commands"] = [
      { command: "parameters.export", params: { path: victim } },
      { command: "file.save", params: { path: victim } },
      { command: "file.export_step", params: { path: join(outside, "exported.step") } },
      { command: "timeline.export_script", params: { path: victim } },
      { command: "doc.open", params: { path: victim } },
    ];

    // 1. End to end through replayMachine: one design per command, plus the good plate.
    const files: Record<string, string> = { "cad/plate/design.json": good };
    steps.forEach((s, i) => (files[`cad/evil${i}/design.json`] = withStep(good, s)));
    files["cad/evilall/design.json"] = JSON.stringify({ ...(JSON.parse(good) as Script), commands: [...(JSON.parse(good) as Script).commands, ...steps] });
    const repo = fixtureRepo(tmp("anvil-sc-real-b2-evil-"), files);
    const report = await replayMachine({ candidate, baseline: pinned, environments: [{ name: "real-fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }], timeoutMs: 180_000 });
    expect(report.parts.map((p) => [p.part, p.outcome])).toEqual([["evil0", "refused"], ["evil1", "refused"], ["evil2", "refused"], ["evil3", "refused"], ["evil4", "refused"], ["evilall", "refused"], ["plate", "same"]]);
    steps.forEach((s, i) => expect(report.parts[i]!.error).toContain(`(${s.command})`)); // reported by name
    expect(report.pass).toBe(false); // a refused design holds the pin
    intact();

    // 2. The screen bypassed: each script handed straight to the sandboxed runner, under both real
    //    builds. The build is given the file-writing step and its own sandbox must refuse it.
    for (const build of [pinned, candidate]) {
      for (const s of steps.slice(0, 4)) {
        const text = withStep(good, s);
        const r = await sandboxedReplay(build, text, (JSON.parse(text) as Script).commands, { timeoutMs: 180_000, tmpRoot: tmp("anvil-sc-real-b2-box-") });
        console.log(`[B2 real] sandbox only, ${build.version}, ${s.command}: ${r.status}${r.status === "replayed" ? "" : ` — ${r.error.slice(0, 160)}`}`);
        intact();
        expect(r.status).toBe("refused-by-build");
        if (r.status === "refused-by-build") expect(r.error).toContain("outside the folders this agent may use");
      }
    }
    // 3. Nothing was left in the real HOME's SolidCraft folders by these runs either: the sandbox
    //    HOME is a throwaway, so the build never saw the real one.
    let sawHome = "";
    const probe = await sandboxedReplay(candidate, good, (JSON.parse(good) as Script).commands, { timeoutMs: 180_000, tmpRoot: tmp("anvil-sc-real-b2-box-"), onBox: (b) => (sawHome = b.home) });
    expect(probe.status).toBe("replayed");
    expect(sawHome).not.toBe(process.env.HOME);
    expect(existsSync(sawHome)).toBe(false); // deleted with the box
    intact();
  },
  10 * 60_000,
);
