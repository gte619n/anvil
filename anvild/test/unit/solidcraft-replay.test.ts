/**
 * Phase B2 unit tests for one machine's replay (src/solidcraft/replay.ts): reading an `eval`
 * result, the comparison rule (spec §4.14 item 17), the four outcomes, where designs are read from,
 * and the bounds on a run. Also the fake binary's `eval` subcommand and its per-version table.
 *
 * The "builds" are real executables (the fake SolidCraft with a behaviour table) and the
 * repositories are real git repositories in temp folders.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Run } from "../../src/solidcraft/install";
import {
  REPLAY_TOLERANCE,
  classify,
  compareEval,
  describeFailure,
  evalDesign,
  readEnvironmentDesigns,
  readEval,
  replayMachine,
  replayRun,
  withinTolerance,
  type EvalOutcome,
  type EvalSummary,
} from "../../src/solidcraft/replay";
import { box, commitFiles, designJson, fakeBuild, fixtureRepo, git, plate, plateWithImpossibleFillet, pushFromElsewhere, writeTable, type FakeEvalTable } from "../helpers/solidcraft-replay";

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
    expect(r).toEqual({ ok: false, error: expect.stringContaining("parameter W failed") });
  });

  test("[B2] a non-zero exit, a crash with no output and unreadable JSON are all failures", () => {
    expect(readEval(1, undefined, "error: step 7 (timeline.add): invalid parameters\n")).toEqual({ ok: false, error: "eval exited 1: error: step 7 (timeline.add): invalid parameters" });
    expect(readEval(139, "", "segmentation fault").ok).toBe(false);
    expect(readEval(1, evalJson()).ok).toBe(false); // a good-looking document does not excuse the exit code
    expect(readEval(0, "").ok).toBe(false);
    expect(readEval(0, "{not json").ok).toBe(false);
    expect(readEval(0, "[]").ok).toBe(false);
    expect(readEval(0, JSON.stringify({ timeline: [], params: [] }))).toEqual({ ok: false, error: "eval result has no `bodies`" });
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
    const broke: EvalOutcome = { ok: false, error: "eval exited 139" };
    expect(classify(good, good)).toMatchObject({ outcome: "same", old: { volume_mm3: PLATE_VOLUME, faces: 22, body_count: 1 } });
    const d = classify(good, bigger);
    expect(d.outcome).toBe("differs");
    expect(d.differences).toEqual([{ field: "volume_mm3", body: "Body1", old: PLATE_VOLUME, new: PLATE_VOLUME * 1.01 }]);
    expect(d.old?.volume_mm3).toBe(PLATE_VOLUME);
    expect(d.new?.volume_mm3).toBe(PLATE_VOLUME * 1.01);
    expect(classify(good, broke)).toMatchObject({ outcome: "candidate-error", error: "eval exited 139" });
    // Broken under the pinned build already: not the candidate's fault, whether or not it replays now.
    expect(classify(broke, good).outcome).toBe("baseline-broken");
    expect(classify(broke, broke).outcome).toBe("baseline-broken");
    // No baseline build at all: replayed for errors only.
    expect(classify(undefined, good).outcome).toBe("same");
    expect(classify(undefined, broke).outcome).toBe("candidate-error");
    expect(describeFailure({ part: "bracket", environment: "e", path: "p", ...d })).toContain("bracket: volume (mm³)");
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

describe("the fake binary's eval subcommand", () => {
  test("[B2] the fake eval prints the real JSON shape and follows the real exit codes", async () => {
    const b = builds({});
    const dir = tmp();
    const write = (name: string, text: string) => (writeFileSync(join(dir, name), text), join(dir, name));
    const run = (file: string, out?: string) => replayRun([b.pinned.path, "eval", file, ...(out ? ["--json-out", out] : [])], { env: { PATH: process.env.PATH ?? "" } });

    const good = await run(write("plate.json", designJson("plate", plate())), join(dir, "out.json"));
    expect(good.code).toBe(0);
    expect(good.stderr).toBe("");
    const doc = JSON.parse(readFileSync(join(dir, "out.json"), "utf8"));
    expect(JSON.parse(good.stdout)).toEqual(doc); // stdout and --json-out carry the same document
    expect(Object.keys(doc).sort()).toEqual(["bodies", "body_count", "params", "sketches", "timeline", "total"]);
    expect(doc.body_count).toBe(1);
    expect(doc.bodies[0]).toMatchObject({ name: "Body1", faces: 22, closed: true, bbox: { min: [-40, -25, 0], max: [40, 25, 6] } });
    expect(doc.bodies[0].volume_mm3).toBeCloseTo(23335.167, 2);
    expect(doc.timeline.every((t: { error: unknown }) => t.error === null)).toBe(true);
    expect(doc.params.map((p: { name: string }) => p.name)).toEqual(["L", "W", "T", "inset"]);

    // A feature that cannot be computed: exit 0, empty stderr, the error on the timeline, later features still run.
    const geom = await run(write("bad.json", designJson("bad", plateWithImpossibleFillet())));
    expect(geom.code).toBe(0);
    expect(geom.stderr).toBe("");
    const g = JSON.parse(geom.stdout);
    const failed = g.timeline.filter((t: { error: unknown }) => t.error !== null);
    expect(failed.length).toBe(1);
    expect(failed[0]).toMatchObject({ name: "Corners", error: expect.stringContaining("fillet") });
    expect(g.timeline.some((t: { name: string; error: unknown }) => t.name === "Holes" && t.error === null)).toBe(true);
    expect(g.bodies[0].volume_mm3).not.toBeCloseTo(23335.167, 0); // partial geometry

    // Malformed step, unknown command, missing file, garbage: exit 1 with the real stderr forms.
    const step = await run(write("step.json", designJson("x", [{ command: "solid.box", params: { length: "nope +", width: 1, height: 1 } }])));
    expect(step.code).toBe(1);
    expect(step.stderr).toMatch(/^error: step 1 \(solid\.box\): /);
    const unknown = await run(write("unknown.json", designJson("x", [...box(), { command: "solid.teleport", params: {} }])));
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/^error: step 2 \(solid\.teleport\): unknown command/);
    const missing = await run(join(dir, "absent.json"));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toStartWith(`error: ${join(dir, "absent.json")}: `);
    expect((await run(write("garbage.json", "this is not json"))).code).toBe(1);
  });

  test("[B2] the per-version table makes two fake builds genuinely differ, one part at a time", async () => {
    const b = builds({ "0.45.0": { edgesDelta: 8, parts: { block: { volumeScale: 1.01 }, lid: { failFeature: "Block" }, hinge: { crash: true } } } });
    const dir = tmp();
    const file = (part: string, cmds = box()) => {
      const f = join(dir, `${part}.json`);
      writeFileSync(f, designJson(part, cmds));
      return f;
    };
    const run: Run = (cmd, o) => replayRun(cmd, o);
    const env = { PATH: process.env.PATH ?? "" };
    const ev = (build: { path: string; version: string }, f: string) => evalDesign(build, f, join(dir, `out-${Math.random()}.json`), run, 30_000, env);

    const [pBlock, cBlock] = [await ev(b.pinned, file("block")), await ev(b.candidate, file("block"))];
    expect(pBlock).toMatchObject({ ok: true, summary: { bodies: [{ volume: 6000 }] } });
    expect(cBlock).toMatchObject({ ok: true, summary: { bodies: [{ volume: 6060 }] } }); // the candidate really computes another number
    // Another part is untouched by that row, though the candidate's edge counts differ everywhere.
    expect(await ev(b.candidate, file("plate", plate()))).toEqual(await ev(b.pinned, file("plate", plate())));
    // failFeature: exit 0 with a timeline error; crash: no output at all.
    expect(await ev(b.candidate, file("lid"))).toEqual({ ok: false, error: expect.stringContaining("feature Block failed") });
    expect((await ev(b.pinned, file("lid"))).ok).toBe(true);
    expect(await ev(b.candidate, file("hinge"))).toEqual({ ok: false, error: expect.stringContaining("eval exited 139") });
  });
});

describe("replaying a machine's designs", () => {
  test("[B2] identical builds give `same` for every part, with the numbers both produced", async () => {
    const b = builds({ "0.45.0": { edgesDelta: 8, areaScale: 1.2 } }); // differences the rule ignores
    const repo = fixtureRepo(tmp(), DESIGNS);
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: [{ name: "fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }] });
    expect(r).toMatchObject({ candidate: "0.45.0", baseline: "0.44.1", hostsDesigns: true, pass: true, advisory: [], notes: [] });
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
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: [{ name: "fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }] });
    expect(r.pass).toBe(false);
    const block = r.parts.find((p) => p.part === "block")!;
    expect(block.outcome).toBe("differs");
    expect(block.differences).toEqual([{ field: "volume_mm3", body: "Body1", old: 6000, new: 6000 * 1.001 }]);
    expect(r.parts.find((p) => p.part === "plate")!.outcome).toBe("same");
    // A difference inside the tolerance is not one.
    writeTable(b.tableFile, { "0.45.0": { parts: { block: { volumeScale: 1 + 5e-7 } } } });
    const within = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: [{ name: "fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }] });
    expect(within.pass).toBe(true);
    // Face count, body count and bounding box are caught too.
    for (const [behaviour, field] of [[{ facesDelta: 1 }, "faces"], [{ extraBody: true }, "body_count"], [{ bboxGrow: 0.5 }, "bbox"]] as const) {
      writeTable(b.tableFile, { "0.45.0": { parts: { block: behaviour } } });
      const rr = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: [{ name: "fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }] });
      expect(rr.parts.find((p) => p.part === "block")!.differences!.map((d) => d.field)).toEqual([field]);
    }
  });

  test("[B2] a candidate build that crashes on replay counts as a failure for that part", async () => {
    const b = builds({ "0.45.0": { parts: { block: { crash: true } } } });
    const repo = fixtureRepo(tmp(), DESIGNS);
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: [{ name: "fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }] });
    expect(r.pass).toBe(false);
    const block = r.parts.find((p) => p.part === "block")!;
    expect(block.outcome).toBe("candidate-error");
    expect(block.error).toContain("eval exited 139");
    expect(block.old).toEqual({ body_count: 1, faces: 6, volume_mm3: 6000 }); // it did replay under the pin
    expect(r.parts.find((p) => p.part === "plate")!.outcome).toBe("same");
  });

  test("[B2] a feature that fails only under the candidate, with exit code 0, is a candidate-error", async () => {
    const b = builds({ "0.45.0": { parts: { plate: { failFeature: "Corners" } } } });
    const repo = fixtureRepo(tmp(), DESIGNS);
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: [{ name: "fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }] });
    const p = r.parts.find((x) => x.part === "plate")!;
    expect(p.outcome).toBe("candidate-error");
    expect(p.error).toContain("feature Corners failed");
    expect(r.pass).toBe(false);
  });

  test("[B2] a design that already fails under the pinned build is reported as baseline-broken and does not hold the pin", async () => {
    const b = builds({});
    const repo = fixtureRepo(tmp(), { ...DESIGNS, "cad/broken/design.json": designJson("broken", plateWithImpossibleFillet()), "cad/garbage/design.json": "not a script" });
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: [{ name: "fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }] });
    expect(r.parts.map((p) => [p.part, p.outcome])).toEqual([["block", "same"], ["broken", "baseline-broken"], ["garbage", "baseline-broken"], ["plate", "same"]]);
    expect(r.parts[1]!.error).toContain("feature Corners failed"); // eval exited 0 there
    expect(r.parts[2]!.error).toContain("eval exited 1");
    expect(r.pass).toBe(true);
    expect(r.hostsDesigns).toBe(true);
  });

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

    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: [{ name: "fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }] });
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
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: [{ name: "local", repoRoot: repo.repoRoot, defaultBase: "main" }] });
    expect(r.parts.map((p) => [p.part, p.ref, p.old?.volume_mm3])).toEqual([["block", "main", 6000]]);
    // No defaultBase recorded: main is found; a branch that does not exist is skipped with a note.
    const noBase = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: [{ name: "local", repoRoot: repo.repoRoot }] });
    expect(noBase.parts.map((p) => p.ref)).toEqual(["main"]);
    const gone = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: [{ name: "local", repoRoot: repo.repoRoot, defaultBase: "release" }, { name: "missing", repoRoot: join(repo.repoRoot, "nope") }] });
    expect(gone.hostsDesigns).toBe(false);
    expect(gone.notes).toEqual(["local: there is no local branch release; skipped", "missing: the repository folder is missing; skipped"]);
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
    const run: Run = async (cmd, o) => {
      seen.push(readdirSync(dirname(cmd[2]!)).sort()); // everything sitting beside the script being replayed
      return replayRun(cmd, o);
    };
    const tmpRoot = tmp();
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: [{ name: "fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }], run, tmpRoot });
    expect(r.parts.map((p) => p.path)).toEqual(["cad/block/design.json", "cad/plate/design.json"]);
    expect(seen.length).toBe(4); // two parts × two builds, nothing else
    for (const files of seen) expect(files.filter((f) => f !== "pinned.json" && f !== "candidate.json")).toEqual(["design.json"]);
    expect(readdirSync(tmpRoot)).toEqual([]); // the temporary folder is removed afterwards
    const found = await readEnvironmentDesigns({ name: "fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }, join(tmpRoot, "x"));
    expect(found.designs.map((d) => d.part)).toEqual(["block", "plate"]);
  });

  test("[B2] designs in open session worktrees are replayed as advisory and never decide", async () => {
    const b = builds({ "0.45.0": { parts: { wip: { volumeScale: 3 } } } });
    const repo = fixtureRepo(tmp(), DESIGNS);
    const wt = tmp();
    mkdirSync(join(wt, "cad/wip"), { recursive: true });
    writeFileSync(join(wt, "cad/wip/design.json"), designJson("wip", box())); // uncommitted, as a session leaves it
    mkdirSync(join(wt, "cad/empty"), { recursive: true });
    const r = await replayMachine({
      candidate: b.candidate,
      baseline: b.pinned,
      environments: [{ name: "fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }],
      worktrees: () => [{ path: wt, label: "session: new lid", environment: "fixtures" }, { path: join(wt, "gone"), label: "removed" }],
    });
    expect(r.pass).toBe(true); // the differing worktree design does not hold the pin
    expect(r.parts.map((p) => p.outcome)).toEqual(["same", "same"]);
    expect(r.advisory).toEqual([expect.objectContaining({ part: "wip", worktree: "session: new lid", environment: "fixtures", outcome: "differs" })]);
    expect(r.advisory[0]!.ref).toBeUndefined();
    // A provider that throws costs the advisory list, not the replay.
    const thrown = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: [{ name: "fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }], worktrees: () => { throw new Error("session store offline"); } });
    expect(thrown.pass).toBe(true);
    expect(thrown.notes).toEqual(["open session worktrees could not be listed (session store offline)"]);
  });

  test("[B2] a replay that outlasts the per-design timeout is stopped and counts against the candidate", async () => {
    const b = builds({ "0.45.0": { parts: { block: { delayMs: 30_000 } } } });
    const repo = fixtureRepo(tmp(), DESIGNS);
    const started = Date.now();
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: [{ name: "fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }], timeoutMs: 1_500 });
    expect(Date.now() - started).toBeLessThan(15_000);
    const block = r.parts.find((p) => p.part === "block")!;
    expect(block.outcome).toBe("candidate-error");
    expect(block.error).toContain("did not finish within");
    expect(r.parts.find((p) => p.part === "plate")!.outcome).toBe("same");
  }, 30_000);

  test("[B2] at most `concurrency` designs are replayed at once", async () => {
    const b = builds({});
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`cad/p${i}/design.json`] = designJson(`p${i}`, box(10 + i, 10, 10));
    const repo = fixtureRepo(tmp(), files);
    let active = 0;
    let peak = 0;
    const run: Run = async (cmd, o) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      try {
        return await replayRun(cmd, o);
      } finally {
        active--;
      }
    };
    const r = await replayMachine({ candidate: b.candidate, baseline: b.pinned, environments: [{ name: "fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }], run, concurrency: 2 });
    expect(r.parts.length).toBe(6);
    expect(r.parts.every((p) => p.outcome === "same")).toBe(true);
    expect(peak).toBe(2);
  });

  test("[B2] with no baseline build the designs are replayed under the candidate for errors only", async () => {
    const b = builds({ "0.45.0": { parts: { block: { crash: true }, plate: { volumeScale: 5 } } } });
    const repo = fixtureRepo(tmp(), DESIGNS);
    const r = await replayMachine({ candidate: b.candidate, environments: [{ name: "fixtures", repoRoot: repo.repoRoot, defaultBase: "main" }] });
    expect(r.baseline).toBeUndefined();
    expect(r.parts.map((p) => [p.part, p.outcome])).toEqual([["block", "candidate-error"], ["plate", "same"]]); // nothing to compare the volume with
    expect(r.parts[1]!.old).toBeUndefined();
    expect(r.pass).toBe(false);
    expect(r.notes.join(" ")).toContain("for errors only");
    expect(existsSync(b.pinned.path)).toBe(true);
  });
});
