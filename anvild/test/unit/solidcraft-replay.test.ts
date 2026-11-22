/**
 * Phase B2 unit tests for one machine's replay (src/solidcraft/replay.ts, replay-client.ts): reading
 * a replay result, the comparison rule (spec §4.14 item 17), the outcomes, the screen and the
 * sandbox every script goes through, where designs are read from, and the bounds on a run. Also
 * the fake binary's `eval` subcommand, its replay server and its per-version table.
 *
 * The "builds" are real executables (the fake SolidCraft with a behaviour table) and the
 * repositories are real git repositories in temp folders.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COM_FLOOR_MM,
  REPLAY_TOLERANCE,
  classify,
  compareEval,
  describeFailure,
  holdsPin,
  readEnvironmentDesigns,
  readEval,
  readResult,
  rejectsCandidate,
  replayInSandbox,
  replayMachine,
  spawnGit,
  withinTolerance,
  type EvalOutcome,
  type EvalSummary,
  type Git,
  type ReplayOne,
} from "../../src/solidcraft/replay";
import { sandboxedReplay } from "../../src/solidcraft/replay-client";
import { asDesignSteps, blockWithHole, box, commitFiles, designJson, fakeBuild, fixtureRepo, git, plate, plateWithImpossibleFillet, pushFromElsewhere, rawScript, writeTable, type Command, type FakeEvalTable } from "../helpers/solidcraft-replay";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "anvil-sc-replay-test-"));
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const PLATE_VOLUME = 23335.166952407875;

/** A real eval result, as text, from the real shape (B0 evidence), with overrides per body. */
function evalJson(over: { bodies?: Record<string, unknown>[]; timeline?: Record<string, unknown>[]; params?: Record<string, unknown>[]; body_count?: number } = {}): string {
  const body = { area_mm2: 9777.8, bbox: { max: [40, 25, 6], min: [-40, -25, 0] }, closed: true, edges: 48, faces: 22, kernel: { name: "smlib", build: 7 }, name: "Body1", vertices: 32, volume_mm3: PLATE_VOLUME };
  const bodies = (over.bodies ?? [{}]).map((b) => ({ ...body, ...b }));
  return JSON.stringify({
    bodies,
    body_count: over.body_count ?? bodies.length,
    params: over.params ?? [{ name: "L", expression: "80 mm", value: 80, unit: "mm", error: null }],
    sketches: [],
    timeline: over.timeline ?? [{ error: null, id: 1, ms: 6.9, name: "Plate", suppressed: false, type: "ExtrudeFeature", warning: null }],
    total: {},
  });
}
const ok = (json: string): EvalSummary => {
  const r = readEval(0, json);
  if (!r.ok) throw new Error(`expected a good eval: ${r.error}`);
  return r.summary;
};

describe("reading an eval result", () => {
  test("[B2] a feature error with exit code 0 counts as a failed replay", () => {
    const r = readEval(0, evalJson({ timeline: [{ error: null, id: 1, name: "Plate" }, { error: "not supported yet: the fillet is larger than the faces allow", id: 3, name: "Corners" }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Corners");
      expect(r.error).toContain("fillet is larger");
    }
    // The same document with no error is a success: only the error field made the difference.
    expect(readEval(0, evalJson()).ok).toBe(true);
  });

  test("[B2] a parameter error with exit code 0 counts as a failed replay", () => {
    const r = readEval(0, evalJson({ params: [{ name: "L", expression: "80 mm", error: null }, { name: "W", expression: "Q/2", error: "unknown parameter Q" }] }));
    expect(r).toEqual({ ok: false, error: expect.stringContaining("parameter W failed"), conclusive: true });
  });

  test("[B2] a non-zero exit, a crash with no output and unreadable JSON are all failures", () => {
    expect(readEval(1, undefined, "error: step 7 (timeline.add): invalid parameters\n")).toEqual({ ok: false, error: "eval exited 1: error: step 7 (timeline.add): invalid parameters", conclusive: true });
    expect(readEval(139, "", "segmentation fault").ok).toBe(false);
    expect(readEval(1, evalJson()).ok).toBe(false); // a good-looking document does not excuse the exit code
    expect(readEval(0, "").ok).toBe(false);
    expect(readEval(0, "{not json").ok).toBe(false);
    expect(readEval(0, "[]").ok).toBe(false);
    expect(readEval(0, JSON.stringify({ timeline: [], params: [] }))).toEqual({ ok: false, error: "the result has no `bodies`", conclusive: false });
    // The same reading of a document handed over directly (what the sandboxed replay returns).
    expect(readResult(JSON.parse(evalJson())).ok).toBe(true);
    expect(readResult(JSON.parse(evalJson({ timeline: [{ error: "boom", id: 1, name: "Plate" }] })))).toEqual({ ok: false, error: "feature Plate failed: boom", conclusive: true });
    expect(readResult(null)).toMatchObject({ ok: false, conclusive: false });
  });

  test("[B2] older builds lack some keys: a result without params or timeline is read leniently", () => {
    const r = readEval(0, JSON.stringify({ bodies: [{ name: "B", faces: 6, volume_mm3: 6000, bbox: { min: [0, 0, 0], max: [30, 20, 10] } }] }));
    expect(r).toEqual({ ok: true, summary: { bodyCount: 1, bodies: [{ name: "B", faces: 6, volume: 6000, extents: [10, 20, 30] }] } });
  });
});

describe("the comparison rule", () => {
  test("[B2] edges, kernel, area, vertices and timings are ignored", () => {
    const a = ok(evalJson());
    const b = ok(evalJson({ bodies: [{ edges: 40, kernel: { name: "other", build: 9 }, area_mm2: 1, vertices: 99, center_of_mass: [1, 2, 3] }], timeline: [{ error: null, id: 1, ms: 9999, name: "Plate" }] }));
    expect(compareEval(a, b)).toEqual([]);
  });

  test("[B2] the volume tolerance is 1e-6 relative: at the boundary it is the same, just past it differs", () => {
    expect(REPLAY_TOLERANCE).toBe(1e-6);
    const at = (v: number) => ok(evalJson({ bodies: [{ volume_mm3: v }] }));
    expect(compareEval(at(1_000_000), at(1_000_001))).toEqual([]); // 1e-6 of the larger: inside
    expect(compareEval(at(1_000_000), at(1_000_002))).toEqual([{ field: "volume_mm3", body: "Body1", old: 1_000_000, new: 1_000_002 }]);
    // The real adjacent-release drift (5e-12) and the real kernel-change drift (7.8e-7) both pass.
    expect(compareEval(at(23335.166952297608), at(23335.166952407864))).toEqual([]);
    expect(compareEval(at(23335.185042797417), at(23335.166952297608))).toEqual([]);
    expect(withinTolerance(100, 100.0002)).toBe(false);
    expect(withinTolerance(0, 0)).toBe(true);
    expect(withinTolerance(-5, 5)).toBe(false);
    expect(withinTolerance(NaN, 5)).toBe(false);
  });

  test("[B2] face count and body count are compared exactly, per body", () => {
    const a = ok(evalJson({ bodies: [{}, { name: "Lid", faces: 6, volume_mm3: 100 }] }));
    expect(compareEval(a, ok(evalJson({ bodies: [{}, { name: "Lid", faces: 7, volume_mm3: 100 }] })))).toEqual([{ field: "faces", body: "Lid", old: 6, new: 7 }]);
    expect(compareEval(a, ok(evalJson()))).toEqual([{ field: "body_count", old: 2, new: 1 }]);
  });

  test("[B2] the bounding box is compared sorted, so the same solid facing another way is the same", () => {
    const a = ok(evalJson());
    const turned = ok(evalJson({ bodies: [{ bbox: { min: [0, 0, 0], max: [6, 80, 50] } }] }));
    expect(compareEval(a, turned)).toEqual([]);
    const grown = ok(evalJson({ bodies: [{ bbox: { min: [-40, -25, 0], max: [40, 25, 6.5] } }] }));
    expect(compareEval(a, grown)).toEqual([{ field: "bbox", body: "Body1", old: [6, 50, 80], new: [6.5, 50, 80] }]);
    const drift = ok(evalJson({ bodies: [{ bbox: { min: [-40, -25, 0], max: [40, 25, 6.000000000000001] } }] }));
    expect(compareEval(a, drift)).toEqual([]);
  });

  test("[B2] the four outcomes: same, differs with old and new numbers, candidate-error, baseline-broken", () => {
    const good: EvalOutcome = { ok: true, summary: ok(evalJson()) };
    const bigger: EvalOutcome = { ok: true, summary: ok(evalJson({ bodies: [{ volume_mm3: PLATE_VOLUME * 1.01 }] })) };
    const broke: EvalOutcome = { ok: false, error: "feature Corners failed: too large", conclusive: true };
    expect(classify(good, good)).toMatchObject({ outcome: "same", old: { volume_mm3: PLATE_VOLUME, faces: 22, body_count: 1 } });
    const d = classify(good, bigger);
    expect(d.outcome).toBe("differs");
    expect(d.differences).toEqual([{ field: "volume_mm3", body: "Body1", old: PLATE_VOLUME, new: PLATE_VOLUME * 1.01 }]);
    expect(d.old?.volume_mm3).toBe(PLATE_VOLUME);
    expect(d.new?.volume_mm3).toBe(PLATE_VOLUME * 1.01);
    expect(classify(good, broke)).toMatchObject({ outcome: "candidate-error", error: "feature Corners failed: too large" });
    // Broken under the pinned build already: not the candidate's fault, whether or not it replays now.
    expect(classify(broke, good).outcome).toBe("baseline-broken");
    expect(classify(broke, broke).outcome).toBe("baseline-broken");
    // No baseline build at all: replayed for errors only.
    expect(classify(undefined, good).outcome).toBe("same");
    expect(classify(undefined, broke).outcome).toBe("candidate-error");
    expect(describeFailure({ part: "bracket", environment: "e", path: "p", ...d })).toContain("bracket: volume (mm³)");
  });

  test("[B2] a build that gave no verdict is inconclusive, whichever build it was: it holds the pin and rejects nothing", () => {
    const good: EvalOutcome = { ok: true, summary: ok(evalJson()) };
    const bigger: EvalOutcome = { ok: true, summary: ok(evalJson({ bodies: [{ volume_mm3: PLATE_VOLUME * 1.5 }] })) };
    const ranAndFailed: EvalOutcome = { ok: false, error: "feature Corners failed", conclusive: true };
    const noVerdict: EvalOutcome = { ok: false, error: "SolidCraft 0.44.1 did not finish within 120 s and was stopped", conclusive: false };
    // The pinned build timed out and the candidate is 50 % larger: NOT "broken under the pin".
    const a = classify(noVerdict, bigger);
    expect(a.outcome).toBe("inconclusive");
    expect(a.error).toContain("the pinned build gave no result");
    expect(holdsPin(a)).toBe(true);
    expect(rejectsCandidate(a)).toBe(false);
    expect(classify(noVerdict, ranAndFailed).outcome).toBe("inconclusive");
    // The candidate crashed or timed out: held and retried, never a permanent rejection.
    const b = classify(good, noVerdict);
    expect(b).toMatchObject({ outcome: "inconclusive", old: { volume_mm3: PLATE_VOLUME } });
    expect(holdsPin(b)).toBe(true);
    expect(rejectsCandidate(b)).toBe(false);
    expect(classify(undefined, noVerdict).outcome).toBe("inconclusive");
    // Only a pinned build that RAN and reported errors is baseline-broken.
    expect(classify(ranAndFailed, bigger).outcome).toBe("baseline-broken");
    expect(holdsPin({ outcome: "baseline-broken" })).toBe(false);
    // What rejects: ran and differed, ran and failed. What only holds: refused, inconclusive.
    expect((["same", "differs", "candidate-error", "baseline-broken", "refused", "inconclusive"] as const).map((o) => [holdsPin({ outcome: o }), rejectsCandidate({ outcome: o })])).toEqual([[false, false], [true, true], [true, true], [false, false], [true, false], [true, false]]);
  });

  test("[B2] the centre of mass is compared, so a hole that moved without changing volume, faces or extents is seen", () => {
    expect(COM_FLOOR_MM).toBe(1e-6);
    const at = (c: unknown) => ok(evalJson({ bodies: [{ center_of_mass: c }] }));
    const a = at([0, 0, 2.9815929769105227]);
    expect(compareEval(a, at([0.02, 0, 2.9815929769105227]))).toEqual([{ field: "center_of_mass", body: "Body1", old: [0, 0, 2.9815929769105227], new: [0.02, 0, 2.9815929769105227] }]);
    // Real float dust between builds (1e-15 against 6e-11, and 9e-12 in z) is the same.
    expect(compareEval(at([-2.7516248135069477e-15, 6.772312735587028e-16, 2.9815929769105227]), at([3.677230119013482e-12, -6.451927852145488e-11, 2.9815929769017604]))).toEqual([]);
    // The allowance is 1e-6 of the largest box side (80 mm here → 8e-5 mm), never under 1e-6 mm.
    expect(compareEval(a, at([7e-5, 0, 2.9815929769105227]))).toEqual([]);
    expect(compareEval(a, at([9e-5, 0, 2.9815929769105227])).map((d) => d.field)).toEqual(["center_of_mass"]);
    const tiny = (c: unknown) => ok(evalJson({ bodies: [{ center_of_mass: c, bbox: { min: [0, 0, 0], max: [0.1, 0.1, 0.1] } }] }));
    expect(compareEval(tiny([0, 0, 0]), tiny([9e-7, 0, 0]))).toEqual([]); // the floor
    expect(compareEval(tiny([0, 0, 0]), tiny([2e-6, 0, 0])).map((d) => d.field)).toEqual(["center_of_mass"]);
    // A build that reports none (older ones lack the key) is not held against the other.
    expect(compareEval(a, ok(evalJson()))).toEqual([]);
    expect(compareEval(a, at("nonsense"))).toEqual([]);
  });
});

// ── With real (fake) binaries and real git repositories ─────────────────────────────────────────

/** Two builds that share one behaviour table. */
function builds(table: FakeEvalTable) {
  const dir = tmp();
  const tableFile = writeTable(join(dir, "table.json"), table);
  return { dir, tableFile, pinned: fakeBuild(dir, "0.44.1", tableFile), candidate: fakeBuild(dir, "0.45.0", tableFile) };
}
const DESIGNS = { "cad/plate/design.json": designJson("plate", plate()), "cad/block/design.json": designJson("block", box()) };
const ENV = (repoRoot: string, name = "fixtures") => [{ name, repoRoot, defaultBase: "main" }];
const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { env: { PATH: process.env.PATH ?? "" } });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};
/** Replay one script text under one build through the sandbox. */
const inSandbox = (build: { path: string; version: string }, text: string, timeoutMs = 30_000) => replayInSandbox(build, text, JSON.parse(text).commands, { timeoutMs, tmpRoot: tmp(), pathEnv: process.env.PATH });
/** Every file under `dir`, relative, sorted. */
function filesUnder(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesUnder(dir, join(rel, e.name)) : [join(rel, e.name)]))
    .sort();
}
/** The file-touching steps the review used, each aimed at `target`. */
const fileSteps = (target: string): Command[] => [
  { command: "parameters.export", params: { path: target } },
  { command: "file.save", params: { path: target } },
  { command: "file.export_step", params: { path: target } },
  { command: "timeline.export_script", params: { path: target } },
  { command: "doc.open", params: { path: target } },
];

describe("the fake binary's eval subcommand", () => {
  test("[B2] the fake eval prints the real JSON shape and follows the real exit codes", async () => {
    const b = builds({});
    const dir = tmp();
    const write = (name: string, text: string) => (writeFileSync(join(dir, name), text), join(dir, name));
    const ev = (file: string, out?: string) => run([b.pinned.path, "eval", file, ...(out ? ["--json-out", out] : [])]);

    const good = ev(write("plate.json", designJson("plate", plate())), join(dir, "out.json"));
    expect(good.code).toBe(0);
    expect(good.stderr).toBe("");
    const doc = JSON.parse(readFileSync(join(dir, "out.json"), "utf8"));
    expect(JSON.parse(good.stdout)).toEqual(doc); // stdout and --json-out carry the same document
    expect(Object.keys(doc).sort()).toEqual(["bodies", "body_count", "params", "sketches", "timeline", "total"]);
    expect(doc.body_count).toBe(1);
    expect(doc.bodies[0]).toMatchObject({ name: "Body1", faces: 22, closed: true, bbox: { min: [-40, -25, 0], max: [40, 25, 6] } });
    expect(doc.bodies[0].volume_mm3).toBeCloseTo(23335.167, 2);
    expect(doc.bodies[0].center_of_mass.length).toBe(3);
    expect(doc.timeline.every((t: { error: unknown }) => t.error === null)).toBe(true);
    expect(doc.params.map((p: { name: string }) => p.name)).toEqual(["L", "W", "T", "inset"]);

    // A feature that cannot be computed: exit 0, empty stderr, the error on the timeline, later features still run.
    const geom = ev(write("bad.json", designJson("bad", plateWithImpossibleFillet())));
    expect(geom.code).toBe(0);
    expect(geom.stderr).toBe("");
    const g = JSON.parse(geom.stdout);
    const failed = g.timeline.filter((t: { error: unknown }) => t.error !== null);
    expect(failed.length).toBe(1);
    expect(failed[0]).toMatchObject({ name: "Corners", error: expect.stringContaining("fillet") });
    expect(g.timeline.some((t: { name: string; error: unknown }) => t.name === "Holes" && t.error === null)).toBe(true);
    expect(g.bodies[0].volume_mm3).not.toBeCloseTo(23335.167, 0); // partial geometry

    // Malformed step, unknown feature, unknown command, missing file, garbage: exit 1 with the real stderr forms.
    const step = ev(write("step.json", designJson("x", [{ command: "solid.box", params: { length: "nope +", width: 1, height: 1 } }])));
    expect(step.code).toBe(1);
    expect(step.stderr).toMatch(/^error: step 1 \(timeline\.add\): /);
    const unknown = ev(write("unknown.json", rawScript("x", [...asDesignSteps(box()), { command: "timeline.add", params: { feature: { type: "warp_drive" } } }])));
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/^error: step 2 \(timeline\.add\): invalid parameters for `timeline.add`: invalid feature/);
    const nope = ev(write("nope.json", rawScript("x", [{ command: "nope.nothing", params: {} }])));
    expect(nope.stderr).toMatch(/^error: step 1 \(nope\.nothing\): unknown command/);
    const missing = ev(join(dir, "absent.json"));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toStartWith(`error: ${join(dir, "absent.json")}: `);
    expect(ev(write("garbage.json", "this is not json")).code).toBe(1);
  });

  test("[B2] the per-version table makes two fake builds genuinely differ, one part at a time", async () => {
    const b = builds({ "0.45.0": { edgesDelta: 8, parts: { block: { volumeScale: 1.01 }, lid: { failFeature: "Block" }, hinge: { crash: true } } } });
    const [pBlock, cBlock] = [await inSandbox(b.pinned, designJson("block", box())), await inSandbox(b.candidate, designJson("block", box()))];
    expect(pBlock).toMatchObject({ ok: true, summary: { bodies: [{ volume: 6000 }] } });
    expect(cBlock).toMatchObject({ ok: true, summary: { bodies: [{ volume: 6060 }] } }); // the candidate really computes another number
    // Another part is untouched by that row, though the candidate's edge counts differ everywhere.
    expect(await inSandbox(b.candidate, designJson("plate", plate()))).toEqual(await inSandbox(b.pinned, designJson("plate", plate())));
    // failFeature: the build answers, with a timeline error (conclusive). crash: no answer at all.
    expect(await inSandbox(b.candidate, designJson("lid", box()))).toEqual({ ok: false, error: expect.stringContaining("feature Block failed"), conclusive: true });
    expect((await inSandbox(b.pinned, designJson("lid", box()))).ok).toBe(true);
    expect(await inSandbox(b.candidate, designJson("hinge", box()))).toEqual({ ok: false, error: expect.stringContaining("exit 139"), conclusive: false });
    // The same through `eval`, which the table also drives.
    const dir = tmp();
    writeFileSync(join(dir, "block.json"), designJson("block", box()));
    expect(JSON.parse(run([b.pinned.path, "eval", join(dir, "block.json")]).stdout).total.volume_mm3).toBe(6000);
    expect(JSON.parse(run([b.candidate.path, "eval", join(dir, "block.json")]).stdout).total.volume_mm3).toBe(6060);
  });
});

describe("the screen and the sandbox", () => {
  test("[B2] a design that carries a file-writing command is refused before any build sees it, and nothing outside is touched", async () => {
    const b = builds({});
    const outside = tmp();
    const victim = join(outside, "authorized_keys");
    writeFileSync(victim, "ssh-ed25519 AAAA the real key\n");
    const files: Record<string, string> = { "cad/plate/design.json": designJson("plate", plate()) };
    const steps = fileSteps(victim);
    steps.forEach((step, i) => (files[`cad/evil${i}/design.json`] = rawScript(`evil${i}`, [...asDesignSteps(box()), step])));
    files["cad/sneaky/design.json"] = rawScript("sneaky", [{ command: "timeline.add", params: { feature: { type: "fake", id: "solid.box", params: { length: 1, width: 1, height: 1 } }, path: join(outside, "via-key.txt") } }]);
    const repo = fixtureRepo(tmp(), files);
    let replays = 0;
    const counting: ReplayOne = (...args) => (replays++, replayInSandbox(...args));
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot), replayOne: counting });
    expect(r.parts.map((p) => [p.part, p.outcome])).toEqual([["evil0", "refused"], ["evil1", "refused"], ["evil2", "refused"], ["evil3", "refused"], ["evil4", "refused"], ["plate", "same"], ["sneaky", "refused"]]);
    steps.forEach((step, i) => {
      expect(r.parts[i]!.error).toContain(`(${step.command})`); // reported by name
      expect(r.parts[i]!.error).toContain("step 2");
    });
    expect(r.parts[6]!.error).toContain("names a file or a place");
    expect(r.pass).toBe(false); // a refused design holds the pin
    expect(replays).toBe(2); // only the plate reached a build (once per build)
    expect(readFileSync(victim, "utf8")).toBe("ssh-ed25519 AAAA the real key\n");
    expect(readdirSync(outside)).toEqual(["authorized_keys"]);
  });

  test("[B2] with the screen bypassed, the sandbox alone stops a write outside its folder", async () => {
    const b = builds({});
    const outside = tmp();
    const victim = join(outside, "victim.txt");
    for (const step of fileSteps(victim).slice(0, 4)) {
      writeFileSync(victim, "VICTIM");
      const text = rawScript("evil", [...asDesignSteps(box()), step]);
      // Straight to the sandboxed runner: no screening.
      const r = await sandboxedReplay(b.candidate, text, JSON.parse(text).commands, { tmpRoot: tmp(), pathEnv: process.env.PATH });
      expect(r.status).toBe("refused-by-build");
      if (r.status === "refused-by-build") {
        expect(r.error).toContain(`step 2 (${step.command})`);
        expect(r.error).toContain("outside the folders this agent may use");
      }
      expect(readFileSync(victim, "utf8")).toBe("VICTIM");
      expect(readdirSync(outside)).toEqual(["victim.txt"]);
    }
    // The fake is not simply refusing those commands: with no sandbox (`eval`, as the gate used to
    // run it) the very same script DOES overwrite the file. That is the hole the sandbox closes.
    const evil = join(tmp(), "evil.json");
    writeFileSync(evil, rawScript("evil", [...asDesignSteps(box()), { command: "parameters.export", params: { path: victim } }]));
    expect(run([b.candidate.path, "eval", evil]).code).toBe(0);
    expect(readFileSync(victim, "utf8")).not.toBe("VICTIM");
    // And inside the sandbox folder a write is allowed, so a refusal is about the place, not the command.
    const boxRoot = tmp();
    const inside = rawScript("ok", [...asDesignSteps(box()), { command: "parameters.export", params: { path: "params.csv" } }]);
    const allowed = await sandboxedReplay(b.candidate, inside, JSON.parse(inside).commands, { tmpRoot: boxRoot, pathEnv: process.env.PATH });
    expect(allowed.status).toBe("replayed");
    expect(readdirSync(boxRoot)).toEqual([]); // the box, with whatever was written in it, is gone afterwards
  });

  test("[B2] the sandboxed build runs in a fresh folder holding only the script, with a throwaway HOME and exactly four environment variables", async () => {
    const dir = tmp();
    const seen = join(dir, "seen.txt");
    const spy = join(dir, "spy-cli");
    // A stand-in binary that records how it was started, then leaves.
    writeFileSync(spy, `#!/bin/sh\n{ echo "ARGS $*"; echo "PWD $(pwd -P)"; echo "LS $(ls)"; env | sort; } > '${seen}'\nexit 3\n`);
    chmodSync(spy, 0o755);
    const tmpRoot = tmp();
    let box: { root: string; work: string; home: string; tmp: string } | undefined;
    const r = await sandboxedReplay({ path: spy, version: "9.9.9" }, '{"commands":[]}', [], { tmpRoot, onBox: (b) => (box = b) });
    expect(r).toEqual({ status: "could-not-run", error: expect.stringContaining("exit 3") });
    const lines = readFileSync(seen, "utf8").trim().split("\n");
    expect(lines[0]).toBe(`ARGS mcp --headless --compact --allow-path ${box!.work} --require-allow-path`); // no --in, no eval
    expect(lines[1]).toBe(`PWD ${box!.work}`);
    expect(lines[2]).toBe("LS design.json"); // the only file there
    const env = Object.fromEntries(lines.slice(3).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    delete env.PWD; // set by the shell itself
    delete env.SHLVL;
    delete env._;
    delete env.OLDPWD;
    expect(env).toEqual({ HOME: box!.home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SOLIDCRAFT_GPU: "cpu", TMPDIR: box!.tmp });
    expect(box!.home.startsWith(`${box!.root}/`)).toBe(true);
    expect(box!.home).not.toBe(process.env.HOME);
    expect(box!.root.includes("sc-box-")).toBe(true);
    expect(readdirSync(tmpRoot)).toEqual([]); // removed afterwards
  });

  test("[B2] a build that cannot be started, hangs, or answers nonsense gives no verdict", async () => {
    const dir = tmp();
    const missing = await sandboxedReplay({ path: join(dir, "no-such-binary"), version: "1.0.0" }, "{}", [], { tmpRoot: tmp() });
    expect(missing.status).toBe("could-not-run");
    const chatty = join(dir, "chatty");
    writeFileSync(chatty, "#!/bin/sh\necho 'this is not json-rpc'\nsleep 30\n");
    chmodSync(chatty, 0o755);
    const started = Date.now();
    const hung = await sandboxedReplay({ path: chatty, version: "1.0.0" }, "{}", [], { tmpRoot: tmp(), timeoutMs: 700 });
    expect(hung).toEqual({ status: "could-not-run", error: expect.stringContaining("did not finish within") });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await replayInSandbox({ path: chatty, version: "1.0.0" }, "{}", [], { timeoutMs: 500, tmpRoot: tmp() })).toMatchObject({ ok: false, conclusive: false });
  }, 30_000);
  test("[B2] a timed-out build is killed together with everything it started", async () => {
    const dir = tmp();
    const pidFile = join(dir, "grandchild.pid");
    const spawner = join(dir, "spawner-cli");
    // A stand-in build that starts a long-lived child of its own, then hangs.
    writeFileSync(spawner, `#!/bin/sh\nsleep 300 &\necho $! > '${pidFile}'\nwait\n`);
    chmodSync(spawner, 0o755);
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const r = await sandboxedReplay({ path: spawner, version: "1.0.0" }, "{}", [], { tmpRoot: tmp(), timeoutMs: 800 });
    expect(r).toEqual({ status: "could-not-run", error: expect.stringContaining("did not finish within") });
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(grandchild).toBeGreaterThan(1);
    for (let i = 0; i < 100 && alive(grandchild); i++) await new Promise((x) => setTimeout(x, 20));
    expect(alive(grandchild)).toBe(false); // the `sleep 300` did not outlive the replay
    // The same for a build that EXITS by itself but leaves a child behind in its group.
    const leaver = join(dir, "leaver-cli");
    const pidFile2 = join(dir, "left.pid");
    writeFileSync(leaver, `#!/bin/sh\nsleep 300 &\necho $! > '${pidFile2}'\nexit 3\n`);
    chmodSync(leaver, 0o755);
    expect((await sandboxedReplay({ path: leaver, version: "1.0.0" }, "{}", [], { tmpRoot: tmp(), timeoutMs: 5_000 })).status).toBe("could-not-run");
    const left = Number(readFileSync(pidFile2, "utf8").trim());
    for (let i = 0; i < 100 && alive(left); i++) await new Promise((x) => setTimeout(x, 20));
    expect(alive(left)).toBe(false);
  }, 30_000);
});

describe("replaying a machine's designs", () => {
  test("[B2] identical builds give `same` for every part, with the numbers both produced", async () => {
    const b = builds({ "0.45.0": { edgesDelta: 8, areaScale: 1.2 } }); // differences the rule ignores
    const repo = fixtureRepo(tmp(), DESIGNS);
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot) });
    expect(r).toMatchObject({ candidate: "0.45.0", baseline: "0.44.1", hostsDesigns: true, pass: true, advisory: [], notes: [], errors: [] });
    expect(r.parts.map((p) => [p.part, p.outcome, p.ref, p.path])).toEqual([
      ["block", "same", "origin/main", "cad/block/design.json"],
      ["plate", "same", "origin/main", "cad/plate/design.json"],
    ]);
    expect(r.parts[0]!.old).toEqual({ body_count: 1, faces: 6, volume_mm3: 6000 });
    expect(r.parts[0]!.new).toEqual(r.parts[0]!.old!);
  });

  test("[B2] a part whose volume differs is `differs` with the old and new numbers; the others stay `same`", async () => {
    const b = builds({ "0.45.0": { parts: { block: { volumeScale: 1.001 } } } });
    const repo = fixtureRepo(tmp(), DESIGNS);
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot) });
    expect(r.pass).toBe(false);
    const block = r.parts.find((p) => p.part === "block")!;
    expect(block.outcome).toBe("differs");
    expect(block.differences).toEqual([{ field: "volume_mm3", body: "Body1", old: 6000, new: 6000 * 1.001 }]);
    expect(r.parts.find((p) => p.part === "plate")!.outcome).toBe("same");
    // A difference inside the tolerance is not one.
    writeTable(b.tableFile, { "0.45.0": { parts: { block: { volumeScale: 1 + 5e-7 } } } });
    const within = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot) });
    expect(within.pass).toBe(true);
    // Face count, body count and bounding box are caught too.
    for (const [behaviour, field] of [[{ facesDelta: 1 }, "faces"], [{ extraBody: true }, "body_count"], [{ bboxGrow: 0.5 }, "bbox"]] as const) {
      writeTable(b.tableFile, { "0.45.0": { parts: { block: behaviour } } });
      const rr = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot) });
      expect(rr.parts.find((p) => p.part === "block")!.differences!.map((d) => d.field)).toEqual([field]);
    }
  });

  test("[B2] two builds that differ only in where a hole is are told apart by the centre of mass", async () => {
    // Under 0.45.0 the bore of this one part sits 5 mm further along x. Volume, faces, body count
    // and bounding box are identical; before the centre of mass was compared this was `same`.
    const b = builds({ "0.45.0": { parts: { bored: { holeShift: [5, 0] } } } });
    const repo = fixtureRepo(tmp(), { "cad/bored/design.json": designJson("bored", blockWithHole()), "cad/plate/design.json": designJson("plate", plate()) });
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot) });
    const bored = r.parts.find((p) => p.part === "bored")!;
    expect(bored.outcome).toBe("differs");
    expect(bored.differences!.map((d) => d.field)).toEqual(["center_of_mass"]);
    expect(bored.old).toEqual(bored.new!); // volume, faces and body count really are the same
    const [from, to] = [bored.differences![0]!.old as number[], bored.differences![0]!.new as number[]];
    expect(to[0]! - from[0]!).toBeGreaterThan(0.01);
    expect(to[1]).toBeCloseTo(from[1]!, 9);
    expect(r.parts.find((p) => p.part === "plate")!.outcome).toBe("same");
    expect(r.pass).toBe(false);
    expect(describeFailure(bored)).toContain("centre of mass");
  });

  test("[B2] a candidate build that crashes on replay counts as a failure for that part", async () => {
    const b = builds({ "0.45.0": { parts: { block: { crash: true } } } });
    const repo = fixtureRepo(tmp(), DESIGNS);
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot) });
    expect(r.pass).toBe(false); // the pin holds
    const block = r.parts.find((p) => p.part === "block")!;
    // A crash is no verdict on the design: it holds the pin and is tried again, rather than
    // condemning the build for good on what may be a passing fault.
    expect(block.outcome).toBe("inconclusive");
    expect(holdsPin(block)).toBe(true);
    expect(block.error).toContain("the candidate gave no result");
    expect(block.error).toContain("exit 139");
    expect(block.old).toEqual({ body_count: 1, faces: 6, volume_mm3: 6000 }); // it did replay under the pin
    expect(r.parts.find((p) => p.part === "plate")!.outcome).toBe("same");
  });

  test("[B2] a feature that fails only under the candidate, with exit code 0, is a candidate-error", async () => {
    const b = builds({ "0.45.0": { parts: { plate: { failFeature: "Corners" } } } });
    const repo = fixtureRepo(tmp(), DESIGNS);
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot) });
    const p = r.parts.find((x) => x.part === "plate")!;
    expect(p.outcome).toBe("candidate-error");
    expect(rejectsCandidate(p)).toBe(true);
    expect(p.error).toContain("feature Corners failed");
    expect(r.pass).toBe(false);
    // A step the candidate refuses outright (a feature kind it does not know) is the same class.
    const unknown = fixtureRepo(tmp(), { "cad/odd/design.json": rawScript("odd", [{ command: "timeline.add", params: { feature: { type: "fake", id: "solid.sphere", params: { radius: 3 } } } }]) });
    const u = await replayMachine({ candidate: b.candidate, environments: ENV(unknown.repoRoot) });
    expect(u.parts[0]).toMatchObject({ outcome: "candidate-error", error: expect.stringContaining("refused the script") });
  });

  test("[B2] a design that already fails under the pinned build is reported as baseline-broken and does not hold the pin", async () => {
    const b = builds({ "0.45.0": { parts: { broken: { volumeScale: 1.5 } } } });
    const repo = fixtureRepo(tmp(), { ...DESIGNS, "cad/broken/design.json": designJson("broken", plateWithImpossibleFillet()) });
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot) });
    expect(r.parts.map((p) => [p.part, p.outcome])).toEqual([["block", "same"], ["broken", "baseline-broken"], ["plate", "same"]]);
    expect(r.parts[1]!.error).toContain("feature Corners failed"); // the pinned build RAN it and said so
    expect(r.pass).toBe(true);
    expect(r.hostsDesigns).toBe(true);
    // A file that is not a script at all is not "broken under the pin": it is refused, and holds.
    const junk = fixtureRepo(tmp(), { ...DESIGNS, "cad/garbage/design.json": "not a script" });
    const j = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(junk.repoRoot) });
    expect(j.parts.find((p) => p.part === "garbage")).toMatchObject({ outcome: "refused", error: "the design script is not valid JSON" });
    expect(j.pass).toBe(false);
  });

  test("[B2] a pinned build that times out on a part holds the pin; it is not written off as broken under the pin", async () => {
    // The pinned build hangs on this one part, and the candidate makes it 50 % larger. Treating the
    // timeout as "already broken" would ignore the part and let the candidate through.
    const b = builds({ "0.44.1": { parts: { block: { delayMs: 30_000 } } }, "0.45.0": { parts: { block: { volumeScale: 1.5 } } } });
    const repo = fixtureRepo(tmp(), DESIGNS);
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot), timeoutMs: 1_500 });
    const block = r.parts.find((p) => p.part === "block")!;
    expect(block.outcome).toBe("inconclusive");
    expect(block.error).toContain("the pinned build gave no result");
    expect(block.error).toContain("did not finish within");
    expect(r.pass).toBe(false);
    expect(r.parts.find((p) => p.part === "plate")!.outcome).toBe("same");
    // A pinned binary that cannot be run at all is the same: no verdict, the pin holds.
    const gone = await replayMachine({ candidate: b.candidate, baseline: { path: join(b.dir, "missing-cli"), version: "0.44.1" }, environments: ENV(repo.repoRoot) });
    expect(gone.parts.map((p) => p.outcome)).toEqual(["inconclusive", "inconclusive"]);
    expect(gone.pass).toBe(false);
  }, 30_000);

  test("[B2] designs are read from origin/<defaultBase> after a fetch, never from the working checkout", async () => {
    const b = builds({ "0.45.0": { parts: { "plate-on-feature": { volumeScale: 2 } } } });
    const root = tmp();
    const repo = fixtureRepo(root, { "cad/plate/design.json": designJson("plate", plate(80)) });
    // Another machine pushes a change to main that this checkout has not fetched…
    pushFromElsewhere(root, repo.origin!, { "cad/plate/design.json": designJson("plate", plate(100)) });
    // …while this checkout sits on a feature branch with a different design (one the candidate
    // WOULD compute differently), an extra part, and uncommitted edits on top.
    git(repo.repoRoot, "checkout", "-q", "-b", "feature");
    commitFiles(repo.repoRoot, { "cad/plate/design.json": designJson("plate-on-feature", plate(120)), "cad/extra/design.json": designJson("plate-on-feature", box()) }, "feature work");
    writeFileSync(join(repo.repoRoot, "cad/plate/design.json"), "uncommitted garbage");
    const head = git(repo.repoRoot, "rev-parse", "HEAD");

    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot) });
    expect(r.parts.map((p) => [p.part, p.outcome, p.ref])).toEqual([["plate", "same", "origin/main"]]);
    // The L = 100 plate from origin, not the stale local main (L = 80) or the checkout (L = 120).
    expect(r.parts[0]!.old!.volume_mm3).toBeCloseTo(23335.167 + 20 * 50 * 6, 1);
    expect(r.pass).toBe(true);
    // The checkout itself was not touched: same branch, same commit, same uncommitted file.
    expect(git(repo.repoRoot, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
    expect(git(repo.repoRoot, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(repo.repoRoot, "cad/plate/design.json"), "utf8")).toBe("uncommitted garbage");
  });

  test("[B2] with no remote the local <defaultBase> branch is read, still not the checkout", async () => {
    const b = builds({});
    const repo = fixtureRepo(tmp(), { "cad/block/design.json": designJson("block", box(30, 20, 10)) }, { remote: false });
    git(repo.repoRoot, "checkout", "-q", "-b", "wip");
    commitFiles(repo.repoRoot, { "cad/block/design.json": designJson("block", box(99, 99, 99)) }, "wip");
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot, "local") });
    expect(r.parts.map((p) => [p.part, p.ref, p.old?.volume_mm3])).toEqual([["block", "main", 6000]]);
    // No defaultBase recorded: main is found; a branch or a repository that is not there is a note, not an error.
    const noBase = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: [{ name: "local", repoRoot: repo.repoRoot }] });
    expect(noBase.parts.map((p) => p.ref)).toEqual(["main"]);
    const gone = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: [{ name: "local", repoRoot: repo.repoRoot, defaultBase: "release" }, { name: "missing", repoRoot: join(repo.repoRoot, "nope") }] });
    expect(gone.hostsDesigns).toBe(false);
    expect(gone.notes).toEqual(["local: there is no local branch release; skipped", "missing: the repository folder is missing; skipped"]);
    expect(gone.errors).toEqual([]);
    expect(gone.pass).toBe(true);
  });

  test("[B2] a ref that exists but cannot be listed or read holds the pin: a git failure is an error, not an empty repository", async () => {
    const b = builds({});
    const repo = fixtureRepo(tmp(), DESIGNS);
    const failing = (fail: (args: string[]) => boolean): Git => (root, args, t) => (fail(args) ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: unable to read tree (object database is corrupt)\n" }) : spawnGit(root, args, t));
    // `git ls-tree` fails: nothing can be said about what this machine hosts.
    const noList = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot), git: failing((a) => a[0] === "ls-tree") });
    expect(noList.parts).toEqual([]);
    expect(noList.errors).toEqual(["fixtures: could not list origin/main (fatal: unable to read tree (object database is corrupt))"]);
    expect(noList.pass).toBe(false);
    // Reading one blob fails: the others are replayed, and the machine still does not pass.
    let shown = 0;
    const noShow = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot), git: failing((a) => a[0] === "cat-file" && shown++ === 0) });
    expect(noShow.parts.map((p) => [p.part, p.outcome])).toEqual([["plate", "same"]]);
    expect(noShow.errors).toEqual([expect.stringContaining("could not read cad/block/design.json from origin/main")]);
    expect(noShow.pass).toBe(false);
    const found = await readEnvironmentDesigns({ name: "fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }, tmp(), failing((a) => a[0] === "ls-tree"));
    expect(found).toMatchObject({ ref: "origin/main", designs: [], notes: [] });
    expect(found.errors.length).toBe(1);
  });

  test("[B2] only cad/<part>/design.json is read: part.json, nested folders and other files are never copied or replayed", async () => {
    const b = builds({});
    const repo = fixtureRepo(tmp(), {
      ...DESIGNS,
      "cad/plate/part.json": JSON.stringify({ measured: { volume_mm3: 1, solidcraft: "0.1.0" } }),
      "cad/plate/refs/bracket.step": "ISO-10303-21;",
      "cad/plate/old/design.json": designJson("nested", box()),
      "cad/design.json": designJson("loose", box()),
      "cad/rules.json": "{}",
      "docs/cad/x/design.json": designJson("elsewhere", box()),
    });
    const seen: string[][] = [];
    const tmpRoot = tmp();
    const watching: ReplayOne = (build, text, commands, opts) => {
      seen.push(filesUnder(tmpRoot)); // everything the replay has copied out of the repository so far
      return replayInSandbox(build, text, commands, opts);
    };
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot), replayOne: watching, tmpRoot, concurrency: 1 });
    expect(r.parts.map((p) => p.path)).toEqual(["cad/block/design.json", "cad/plate/design.json"]);
    expect(seen.length).toBe(4); // two parts × two builds, nothing else
    for (const files of seen) {
      expect(files.length).toBe(2);
      expect(files.every((f) => f.endsWith("/design.json"))).toBe(true); // no part.json, no refs, no rules
    }
    expect(readdirSync(tmpRoot)).toEqual([]); // the temporary folder is removed afterwards
    const found = await readEnvironmentDesigns({ name: "fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }, join(tmpRoot, "x"));
    expect(found.designs.map((d) => d.part)).toEqual(["block", "plate"]);
  });

  test("[B2] a design.json that is a symbolic link is skipped with a note, and one over 64 MB is refused without being read", async () => {
    const b = builds({});
    const root = tmp();
    const repo = fixtureRepo(root, DESIGNS);
    // A committed symlink pointing out of the repository, where a design file should be.
    mkdirSync(join(repo.repoRoot, "cad/linked"), { recursive: true });
    symlinkSync("/etc/passwd", join(repo.repoRoot, "cad/linked/design.json"));
    git(repo.repoRoot, "add", "-A");
    git(repo.repoRoot, "commit", "-q", "-m", "a symlink");
    git(repo.repoRoot, "push", "-q", "origin", "main");
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot) });
    expect(r.parts.map((p) => p.part)).toEqual(["block", "plate"]);
    expect(r.notes).toEqual(["fixtures: cad/linked/design.json on origin/main is a symbolic link, not a design file; skipped"]);
    expect(r.pass).toBe(true);
    // An oversized blob: `git ls-tree -l` reports the size, so it is refused before any read.
    const reads: string[][] = [];
    const big: Git = async (rootDir, args, t) => {
      const out = await spawnGit(rootDir, args, t);
      if (args[0] === "cat-file") reads.push(args);
      if (args[0] !== "ls-tree") return out;
      return { ...out, stdout: out.stdout.replace(/(\s)(\d+)(\tcad\/block\/design\.json)/, `$1${64 * 1024 * 1024 + 1}$3`) };
    };
    const o = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot), git: big });
    expect(o.parts.find((p) => p.part === "block")).toMatchObject({ outcome: "refused", error: expect.stringContaining("larger than the 64 MB limit") });
    expect(reads.length).toBe(1); // only the plate was read
    expect(o.pass).toBe(false);
  });

  test("[B2] designs in open session worktrees are replayed as advisory and never decide", async () => {
    const b = builds({ "0.45.0": { parts: { wip: { volumeScale: 3 } } } });
    const repo = fixtureRepo(tmp(), DESIGNS);
    const wt = tmp();
    const outside = tmp();
    mkdirSync(join(wt, "cad/wip"), { recursive: true });
    writeFileSync(join(wt, "cad/wip/design.json"), designJson("wip", box())); // uncommitted, as a session leaves it
    mkdirSync(join(wt, "cad/empty"), { recursive: true });
    // An agent-written file that tries to write outside: screened like any other, and only listed.
    mkdirSync(join(wt, "cad/trap"), { recursive: true });
    writeFileSync(join(wt, "cad/trap/design.json"), rawScript("trap", [{ command: "file.save", params: { path: join(outside, "pwned.sc") } }]));
    const r = await replayMachine({
      candidate: b.candidate,
      baseline: b.pinned,
      environments: ENV(repo.repoRoot),
      worktrees: () => [{ path: wt, label: "session: new lid", environment: "fixtures" }, { path: join(wt, "gone"), label: "removed" }],
    });
    expect(r.pass).toBe(true); // neither the differing nor the refused worktree design holds the pin
    expect(r.parts.map((p) => p.outcome)).toEqual(["same", "same"]);
    expect(r.advisory.map((p) => [p.part, p.outcome, p.worktree])).toEqual([["trap", "refused", "session: new lid"], ["wip", "differs", "session: new lid"]]);
    expect(r.advisory[0]!.error).toContain("(file.save)");
    expect(r.advisory[1]!.ref).toBeUndefined();
    expect(readdirSync(outside)).toEqual([]);
    // A provider that throws costs the advisory list, not the replay.
    const thrown = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot), worktrees: () => { throw new Error("session store offline"); } });
    expect(thrown.pass).toBe(true);
    expect(thrown.notes).toEqual(["open session worktrees could not be listed (session store offline)"]);
  });

  test("[B2] a worktree design that is a symbolic link is skipped, and no refusal ever quotes a file's content", async () => {
    const b = builds({});
    const repo = fixtureRepo(tmp(), DESIGNS);
    const secretDir = tmp();
    const SECRET = "hunter2-TOP-SECRET-0123456789";
    writeFileSync(join(secretDir, "id_rsa"), `-----BEGIN KEY-----\n${SECRET}\n`);
    mkdirSync(join(secretDir, "cad-elsewhere", "inner"), { recursive: true });
    writeFileSync(join(secretDir, "cad-elsewhere", "inner", "design.json"), SECRET);
    const wt = tmp();
    // 1. cad/leak/design.json is a link to a secret file.
    mkdirSync(join(wt, "cad/leak"), { recursive: true });
    symlinkSync(join(secretDir, "id_rsa"), join(wt, "cad/leak/design.json"));
    // 2. cad/linked is a link to a folder elsewhere that holds a design.json.
    symlinkSync(join(secretDir, "cad-elsewhere", "inner"), join(wt, "cad/linked"));
    // 3. A real file that is simply not JSON, with the same secret in it.
    mkdirSync(join(wt, "cad/junk"), { recursive: true });
    writeFileSync(join(wt, "cad/junk/design.json"), `{"commands": [${SECRET}]}`);
    // 4. And an honest one.
    mkdirSync(join(wt, "cad/wip"), { recursive: true });
    writeFileSync(join(wt, "cad/wip/design.json"), designJson("wip", box()));
    // A second worktree whose whole cad folder is a link.
    const wt2 = tmp();
    symlinkSync(join(secretDir, "cad-elsewhere"), join(wt2, "cad"));

    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot), worktrees: () => [{ path: wt, label: "agent session" }, { path: wt2, label: "other" }] });
    expect(r.advisory.map((p) => [p.part, p.outcome])).toEqual([["junk", "refused"], ["wip", "same"]]); // neither link was read
    expect(r.advisory[0]!.error).toBe("the design script is not valid JSON");
    expect(r.notes).toEqual([
      "cad/leak/design.json in a worktree is a symbolic link, not a design file; skipped",
      "cad/linked in a worktree is a symbolic link; skipped",
      "a worktree's cad folder is a symbolic link or not a folder; skipped",
    ]);
    expect(JSON.stringify(r)).not.toContain("SECRET"); // nothing of any of the three files is in the report
    expect(JSON.stringify(r)).not.toContain("hunter2");
    expect(r.pass).toBe(true);
    // The same for a committed file that is not JSON: refused, and its content stays out of the report.
    const junk = fixtureRepo(tmp(), { "cad/junk/design.json": `{"commands": [${SECRET}]}` });
    const j = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(junk.repoRoot) });
    expect(j.parts[0]).toMatchObject({ outcome: "refused", error: "the design script is not valid JSON", sha: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(j)).not.toContain("hunter2");
  });

  test("[B2] a large design made of text the screen must read does not stall the machine's replay", async () => {
    // 150 KB of letters in one comment took the old screen 14 s, with the event loop blocked.
    const b = builds({});
    const big = rawScript("big", [{ command: "parameters.add", params: { name: "L", expression: "80 mm", comment: "a".repeat(1024 * 1024) } }, ...asDesignSteps(box())]);
    const repo = fixtureRepo(tmp(), { "cad/big/design.json": big, "cad/plate/design.json": designJson("plate", plate()) });
    // Measure the longest gap between heartbeats: a blocked event loop shows up as one long gap,
    // however quickly the replay as a whole happens to finish on this machine.
    const started = Date.now();
    let last = started;
    let maxGap = 0;
    const heartbeat = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 20);
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot) });
    clearInterval(heartbeat);
    maxGap = Math.max(maxGap, Date.now() - last);
    expect(r.parts.map((p) => [p.part, p.outcome])).toEqual([["big", "same"], ["plate", "same"]]);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(maxGap).toBeLessThan(1_000); // the event loop kept turning throughout (the old screen blocked it for 14 s)
  }, 30_000);

  test("[B2] a replay that outlasts the per-design timeout is stopped and counts against the candidate", async () => {
    const b = builds({ "0.45.0": { parts: { block: { delayMs: 30_000 } } } });
    const repo = fixtureRepo(tmp(), DESIGNS);
    const started = Date.now();
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot), timeoutMs: 1_500 });
    expect(Date.now() - started).toBeLessThan(15_000);
    const block = r.parts.find((p) => p.part === "block")!;
    expect(block.outcome).toBe("inconclusive"); // holds the pin; retried, not a permanent rejection
    expect(block.error).toContain("did not finish within");
    expect(r.pass).toBe(false);
    expect(r.parts.find((p) => p.part === "plate")!.outcome).toBe("same");
  }, 30_000);

  test("[B2] a machine's whole replay is bounded: designs not reached in time are reported, and the machine does not pass", async () => {
    const b = builds({});
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`cad/p${i}/design.json`] = designJson(`p${i}`, box(10 + i, 10, 10));
    const repo = fixtureRepo(tmp(), files);
    // A clock that jumps past the bound after the second design has been replayed.
    let replayed = 0;
    const clock = { t: 1_000_000 };
    const slow: ReplayOne = async (...args) => {
      const r = await replayInSandbox(...args);
      if (++replayed === 4) clock.t += 31 * 60_000;
      return r;
    };
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot), replayOne: slow, concurrency: 1, now: () => clock.t });
    expect(r.parts.map((p) => p.outcome)).toEqual(["same", "same", "inconclusive", "inconclusive", "inconclusive"]);
    expect(r.parts[2]!.error).toContain("ran out of time");
    expect(r.errors).toEqual(["this machine's replay ran out of time with 3 of 5 designs not replayed"]);
    expect(r.pass).toBe(false);
    expect(replayed).toBe(4); // nothing more was started
  });

  test("[B2] at most `concurrency` designs are replayed at once", async () => {
    const b = builds({});
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`cad/p${i}/design.json`] = designJson(`p${i}`, box(10 + i, 10, 10));
    const repo = fixtureRepo(tmp(), files);
    let active = 0;
    let peak = 0;
    const counting: ReplayOne = async (...args) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      try {
        return await replayInSandbox(...args);
      } finally {
        active--;
      }
    };
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: ENV(repo.repoRoot), replayOne: counting, concurrency: 2 });
    expect(r.parts.length).toBe(6);
    expect(r.parts.every((p) => p.outcome === "same")).toBe(true);
    expect(peak).toBe(2);
  });

  test("[B2] with no baseline build the designs are replayed under the candidate for errors only", async () => {
    const b = builds({ "0.45.0": { parts: { block: { failFeature: "Block" }, plate: { volumeScale: 5 } } } });
    const repo = fixtureRepo(tmp(), DESIGNS);
    const r = await replayMachine({ candidate: b.candidate, environments: ENV(repo.repoRoot) });
    expect(r.baseline).toBeUndefined();
    expect(r.parts.map((p) => [p.part, p.outcome])).toEqual([["block", "candidate-error"], ["plate", "same"]]); // nothing to compare the volume with
    expect(r.parts[1]!.old).toBeUndefined();
    expect(r.pass).toBe(false);
    expect(r.notes.join(" ")).toContain("for errors only");
    expect(existsSync(b.pinned.path)).toBe(true);
  });
});
