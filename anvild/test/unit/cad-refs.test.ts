/**
 * [A4] Reference bodies (agent-cad-and-browser spec §4.4 import_reference, §4.14 #4, owner item 45):
 * the source rules, the name in refs/, the embedded-STEP integrity check and the exact "no
 * interference" condition — plus the manager's working folder (decision 115).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { partRef } from "../../src/cadwork/partfolder";
import {
  embeddedReferences,
  liveReferences,
  readComponentList,
  referenceEditChecks,
  referencePlacementChecks,
  worldTransform,
  REFERENCE_MOVED,
  REFERENCE_NOT_GROUNDED,
  interferenceCheck,
  interferenceRequest,
  referenceChecks,
  referenceName,
  resolveReferenceSource,
  DUPLICATE_REFERENCE,
  REFERENCE_CHANGED,
  REFERENCE_MAX_BYTES,
  REFERENCE_RESHAPED,
  isReferenceMeasure,
  readReferenceMeasures,
  referenceDifferences,
  shapeDifferences,
} from "../../src/cadwork/refs";
import { parseToolResult } from "../../src/cadwork/mcp-client";
import { coverageChecks, designPlacementChecks, placementChecks, readPlacements, referenceGate, referenceGeometryChecks, DESIGN_PLACED_ONCE, REFERENCE_NOT_APPROVED, REFERENCE_NOT_RECORDED, REFERENCE_NOT_COVERED, REFERENCE_PLACED_ONCE } from "../../src/cadwork/refresh";
import { readDesignFile } from "../../src/cadwork/poststep";
import { makeReferenceReplay, makeTrueReferenceCheck, type TrueReferenceInput, type TrueReferenceResult } from "../../src/cadwork/refreplay";
import { FAKE_SOLIDCRAFT } from "../helpers/fake-solidcraft";
import { cleanupTemp, fakeManager, recordingSpawn, stopManagers, tempRepo } from "../helpers/cad-work";

afterEach(async () => {
  await stopManagers();
  cleanupTemp();
});

const reply = (j: unknown, isError = false) => parseToolResult({ content: [{ type: "text", text: JSON.stringify(j) }], ...(isError ? { isError: true } : {}) });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("reference sources", () => {
  test("[A4] source paths that escape are refused: .., absolute, a symlink, a symlink inside the download quarantine, a linked parent folder, .git, and a non-STEP", () => {
    const repo = tempRepo();
    const outside = tempRepo("anvil-cad-outside-");
    writeFileSync(join(outside, "secret.step"), "ISO");
    writeFileSync(join(repo, "ok.STEP"), "ISO-10303-21;");
    mkdirSync(join(repo, ".anvil-downloads"), { recursive: true });
    writeFileSync(join(repo, ".anvil-downloads", "dl.stp"), "ISO");
    symlinkSync(join(repo, "ok.STEP"), join(repo, ".anvil-downloads", "inside-link.step")); // points INSIDE the repo, still refused
    symlinkSync(join(outside, "secret.step"), join(repo, "out.step"));
    symlinkSync(outside, join(repo, "linked-dir"));
    writeFileSync(join(repo, "readme.txt"), "x");
    const refused: [string, string][] = [
      ["../" + outside.split("/").at(-1) + "/secret.step", "outside this repo"],
      ["a/../../x.step", "outside this repo"],
      [join(outside, "secret.step"), "absolute"],
      ["out.step", "symbolic link"],
      [".anvil-downloads/inside-link.step", "symbolic link"],
      ["linked-dir/secret.step", "symbolic link"],
      [".git/x.step", ".git"],
      ["readme.txt", "not a STEP"],
      ["missing.step", "does not exist"],
      ["", "must name"],
    ];
    for (const [file, why] of refused) {
      const r = resolveReferenceSource(repo, file);
      expect([file, r.ok]).toEqual([file, false]);
      expect((r as { error: string }).error).toContain(why);
    }
    // The repo and its download quarantine are fine; the extension is case-insensitive.
    for (const file of ["ok.STEP", ".anvil-downloads/dl.stp", "./sub/../ok.STEP"]) {
      const r = resolveReferenceSource(repo, file);
      expect([file, r.ok]).toEqual([file, true]);
    }
    const r = resolveReferenceSource(repo, "ok.STEP");
    expect(r.ok && r.sha256).toBe(sha("ISO-10303-21;"));
  });

  test("[A4] the 50 MB cap: a sparse 50 MB + 1 byte file is refused, and an injected cap applies", () => {
    expect(REFERENCE_MAX_BYTES).toBe(50 * 1024 * 1024);
    const repo = tempRepo();
    writeFileSync(join(repo, "big.step"), "");
    truncateSync(join(repo, "big.step"), REFERENCE_MAX_BYTES + 1); // sparse: no 50 MB written
    const big = resolveReferenceSource(repo, "big.step");
    expect(big.ok).toBe(false);
    expect((big as { error: string }).error).toContain("capped at 50 MB");
    writeFileSync(join(repo, "small.step"), "x".repeat(200));
    expect(resolveReferenceSource(repo, "small.step", { maxBytes: 100 }).ok).toBe(false);
    expect(resolveReferenceSource(repo, "small.step", { maxBytes: 200 }).ok).toBe(true);
  });

  test("[A4] a reference's name in refs/ is the file name reduced to safe characters, never a path or hidden", () => {
    expect(referenceName(".anvil-downloads/Motor Mount (v2).STEP")).toBe("Motor-Mount-v2.step");
    expect(referenceName("x/../..stp")).toBe("reference.stp");
    expect(referenceName("a/b/c/.hidden.step")).toBe("hidden.step");
    expect(referenceName("ünïcode.step")).toBe("n-code.step");
  });
});

describe("reference integrity and interference", () => {
  test("[A4] re-review: coverage fails closed — every recorded, embedded or imported reference body must be under a must-not-touch rule", () => {
    const emb = [{ file: "a.step", bodies: ["a1"] }, { file: "b.step", bodies: ["b1", "b2"] }];
    // Everything covered: no check at all.
    expect(coverageChecks(["a.step", "b.step"], ["a.step"], emb, ["a1", "b1", "b2"], new Set(["a.step", "b.step"]))).toEqual([]);
    // An embedded import and a part.json record that no rule names, and an imported body nothing accounts for.
    const c = coverageChecks(["a.step"], ["a.step", "c.step"], emb, ["a1", "b1", "b2", "stray"], new Set(["a.step", "b.step"]));
    expect(c.map((x) => [x.id, x.measured, x.ok, x.hard])).toEqual([
      ["covered b.step", `reference b.step ${REFERENCE_NOT_COVERED}`, false, true],
      ["covered c.step", `reference c.step ${REFERENCE_NOT_COVERED}`, false, true],
      ["covered reference bodies", `reference stray ${REFERENCE_NOT_COVERED}`, false, true],
    ]);
    // The script could not be read: every imported body is unaccounted for.
    expect(coverageChecks([], [], undefined, ["a1"], new Set()).map((x) => x.ok)).toEqual([false]);
  });


  test("[A4] embedded imports are read from the script's timeline.add import features; refs/x.step must have the embedded text's sha256, else 'reference changed; re-import' (unverified)", () => {
    const script = {
      about: {},
      commands: [
        { command: "timeline.add", params: { feature: { type: "box", name: "Plate" } } },
        { command: "timeline.add", params: { feature: { type: "import", name: "ref-a.step", file: "a.step", step: "AAA", body_names: ["a"] } } },
      ],
    };
    const emb = embeddedReferences(script);
    expect(emb).toEqual([{ file: "a.step", name: "ref-a.step", sha256: sha("AAA"), bodies: ["a"], bytes: 3 }]);
    expect(referenceChecks(["a.step"], () => ({ sha256: sha("AAA") }), emb)).toEqual({ checks: [{ id: "ref a.step", expected: "refs/a.step is the STEP embedded in the design", measured: `unchanged (${sha("AAA").slice(0, 12)})`, ok: true, hard: true }], unverified: false, clean: new Set(["a.step"]) });
    const changed = referenceChecks(["a.step"], () => ({ sha256: sha("BBB") }), emb);
    expect(changed.unverified).toBe(true);
    expect(changed.checks[0]!.ok).toBe(false);
    expect(String(changed.checks[0]!.measured)).toContain(REFERENCE_CHANGED);
    const missing = referenceChecks(["a.step", "b.step"], (n) => (n === "a.step" ? { missing: "cad/p/refs/a.step is missing" } : { sha256: "x" }), emb);
    expect(missing.unverified).toBe(false);
    expect(missing.checks.map((c) => [c.id, c.ok])).toEqual([["ref a.step", false], ["ref b.step", false]]);
    expect(String(missing.checks[1]!.measured)).toContain("does not contain refs/b.step");
    expect(referenceChecks(["a.step"], () => ({ sha256: "x" }), undefined).unverified).toBe(true);
  });

  test("[A4] interference: only count 0 with nothing unchecked, not truncated and within budget passes — an overlap names the pair and volume; unchecked, truncated or budget_exceeded fail", () => {
    const clear = { budget_exceeded: false, count: 0, interferences: [], truncated: false, unchecked: [] };
    expect(interferenceCheck("m.step", reply(clear))).toEqual({ id: "interference m.step", expected: "no overlap with refs/m.step", measured: "no overlap", ok: true, hard: true });
    const hit = interferenceCheck("m.step", reply({ ...clear, count: 1, interferences: [{ a: "Body1", b: "m", volume_mm3: 125.66 }] }));
    expect(hit).toMatchObject({ ok: false, measured: "Body1 overlaps m by 125.66 mm³" });
    for (const [bad, says] of [
      [{ ...clear, unchecked: [["Body1", "m"]] }, "not checked"],
      [{ ...clear, truncated: true }, "truncated"],
      [{ ...clear, budget_exceeded: true }, "budget exceeded"],
      [{ count: 0, interferences: [] }, "not checked"], // keys missing: never read as clear
    ] as [Record<string, unknown>, string][]) {
      const c = interferenceCheck("m.step", reply(bad));
      expect(c.ok).toBe(false);
      expect(String(c.measured)).toContain(says);
    }
    expect(interferenceCheck("m.step", reply("invalid parameters", true)).ok).toBe(false);
    expect(interferenceCheck("m.step", { error: "SolidCraft stopped" }).ok).toBe(false);
    // Design–design and reference–reference pairs are excluded, so `count` is only what matters.
    expect(interferenceRequest(["B1", "B2"], ["r1", "r2"])).toEqual({ command: "inspect.interference", params: { bodies: ["B1", "B2", "r1", "r2"], exclude_pairs: [["B1", "B2"], ["r1", "r2"]] } });
    expect(interferenceRequest(["B1"], ["r1"])).toEqual({ command: "inspect.interference", params: { bodies: ["B1", "r1"] } });
  });
});

/** A part folder whose design.json holds `imports` (STEP text per import) and whose refs/ holds `refs`. */
function refsPart(imports: { file: string; step: string; bodies: string[] }[], refs: Record<string, string>) {
  const repo = tempRepo();
  const ref = partRef(repo, "plate");
  mkdirSync(join(ref.dir, "refs"), { recursive: true });
  for (const [n, t] of Object.entries(refs)) writeFileSync(join(ref.dir, "refs", n), t);
  const commands = [
    { command: "timeline.add", params: { feature: { type: "box", name: "Plate" } } },
    ...imports.map((im, i) => ({ command: "timeline.add", params: { feature: { type: "import", name: `ref-${im.file}-${i}`, file: im.file, step: im.step, body_names: im.bodies } } })),
  ];
  writeFileSync(join(ref.dir, "design.json"), JSON.stringify({ about: {}, commands }, null, 2));
  return { ref, scriptSha: readDesignFile(ref.dir).scriptSha };
}
/** inspect.interference as SolidCraft answers it: `hot` bodies overlap Body1 by 600 mm³. */
function interferenceStub(hot: string[]) {
  const asked: string[][] = [];
  const call = async (_tool: string, args: Record<string, unknown>) => {
    const bodies = (args.params as { bodies: string[] }).bodies;
    asked.push(bodies);
    const hits = bodies.filter((b) => hot.includes(b)).map((b) => ({ a: "Body1", b, volume_mm3: 600 }));
    return reply({ budget_exceeded: false, count: hits.length, interferences: hits, truncated: false, unchecked: [] });
  };
  return { call, asked };
}
/** The design's bodies, each placed once (its world name is its own name). */
const once = (designBodies: string[], referenceBodies: string[]) => ({ designBodies, referenceBodies, placements: Object.fromEntries([...designBodies, ...referenceBodies].map((b) => [b, [b]])), references: [] });
const ruled = (must: string[]) => ({ kind: "ok", file: { expectations: { noInterferenceWith: must }, refs: [] } }) as any;
const failing = (checks: { id: string; ok: boolean; hard: boolean; measured: unknown }[]) => checks.filter((c) => !c.ok && c.hard).map((c) => `${c.id}: ${String(c.measured)}`);

describe("every embedded import is checked (the second import of a file name)", () => {
  test("[A4] re-review: two imports carrying the same file name fail closed ('duplicate reference import far.step'); the interference check covers the bodies of BOTH and finds the second one's overlap", async () => {
    const { ref, scriptSha } = refsPart([{ file: "far.step", step: "FAR", bodies: ["far_a"] }, { file: "far.step", step: "FAR", bodies: ["far_b"] }], { "far.step": "FAR" });
    const s = interferenceStub(["far_b"]);
    const g = await referenceGate(s.call as any, ref, ruled(["far.step"]), scriptSha, once(["Body1"], ["far_a", "far_b"]));
    const bad = failing(g.checks);
    expect(bad.find((l) => l.startsWith("ref far.step:"))).toContain(`${DUPLICATE_REFERENCE} far.step: 2 imports`);
    expect(s.asked).toEqual([["Body1", "far_a", "far_b"]]);
    expect(bad.find((l) => l.startsWith("interference far.step:"))).toContain("overlaps far_b by 600 mm³");
    // Neither import's bodies count as a checked reference.
    expect(bad.find((l) => l.startsWith("covered reference bodies:"))).toContain("far_a, far_b");
  });

  test("[A4] re-review: the SECOND import's bytes differ from refs/ — named on the duplicate line, and its body is not a known reference", async () => {
    const { ref, scriptSha } = refsPart([{ file: "far.step", step: "FAR", bodies: ["far_a"] }, { file: "far.step", step: "BLOCK AT ORIGIN", bodies: ["far_b"] }], { "far.step": "FAR" });
    const g = await referenceGate(interferenceStub([]).call as any, ref, ruled(["far.step"]), scriptSha, once(["Body1"], ["far_a", "far_b"]));
    const dup = failing(g.checks).find((l) => l.startsWith("ref far.step:"))!;
    expect(dup).toContain(DUPLICATE_REFERENCE);
    expect(dup).toContain("import 1 (ref-far.step-0, bodies far_a) matches");
    expect(dup).toContain(`import 2 (ref-far.step-1, bodies far_b) holds ${sha("BLOCK AT ORIGIN").slice(0, 12)}`);
    expect(failing(g.checks).find((l) => l.startsWith("covered reference bodies:"))).toContain("far_b");
    // The same import alone, with the bytes of refs/: everything passes.
    const one = refsPart([{ file: "far.step", step: "FAR", bodies: ["far_a"] }], { "far.step": "FAR" });
    const ok = await referenceGate(interferenceStub([]).call as any, one.ref, ruled(["far.step"]), one.scriptSha, once(["Body1"], ["far_a"]));
    expect(failing(ok.checks)).toEqual([]);
  });

  test("[A4] re-review: a reference body no checked import accounts for fails naming it — a stray BaseFeature body; an uncovered import whose bytes match refs/ fails on its own line", async () => {
    const { ref, scriptSha } = refsPart([{ file: "far.step", step: "FAR", bodies: ["far_a"] }, { file: "other.step", step: "OTHER", bodies: ["other_a"] }], { "far.step": "FAR", "other.step": "OTHER" });
    const g = await referenceGate(interferenceStub([]).call as any, ref, ruled(["far.step"]), scriptSha, once(["Body1"], ["far_a", "other_a", "ghost"]));
    const bad = failing(g.checks);
    expect(bad).toContain(`covered other.step: reference other.step ${REFERENCE_NOT_COVERED}`);
    expect(bad).toContain(`covered reference bodies: reference ghost ${REFERENCE_NOT_COVERED}`);
    expect(bad.some((l) => l.includes("far_a"))).toBe(false);
  });
});

describe("a reference may be placed once; interference checks every placement", () => {
  test("[A4] re-review: placements are read from inspect.measure names_only (world name per placement, by definition); a reply without that shape throws", () => {
    expect(readPlacements({ bodies: [{ definition: "Body1", name: "Body1" }, { definition: "far", name: "far" }, { definition: "far", name: "far (ref-far.step:2)" }], body_count: 3 })).toEqual({ Body1: ["Body1"], far: ["far", "far (ref-far.step:2)"] });
    expect(() => readPlacements({})).toThrow("no body list");
    expect(() => readPlacements({ bodies: [{ name: "far" }] })).toThrow("without a name and definition");
  });

  test("[A4] re-review: a reference placed twice (occurrence.copy of ref-far.step:1) is a hard fail 'reference far.step is placed 2 times; a reference may be placed once'; an imported body no import accounts for is named too; placed once passes", () => {
    const emb = [{ file: "far.step", bodies: ["far"] }];
    const twice = placementChecks(emb, ["far"], { Body1: ["Body1"], far: ["far", "far (ref-far.step:2)"] });
    expect(twice).toEqual([{ id: "placed far.step", expected: "the reference is placed once", measured: `reference far.step is placed 2 times; ${REFERENCE_PLACED_ONCE} (far, far (ref-far.step:2))`, ok: false, hard: true }]);
    expect(placementChecks(emb, ["far", "ghost"], { far: ["far"], ghost: ["ghost", "ghost (x:2)", "ghost (x:3)"] })[0]!.measured).toContain("reference body ghost is placed 3 times");
    expect(placementChecks(emb, ["far"], { far: ["far"] })).toEqual([]);
    expect(placementChecks(undefined, ["far"], { far: ["far", "far (ref-far.step:2)"] })[0]!.measured).toContain("is placed 2 times");
  });

  test("[A4] re-review: the gate sends every placement by world name — the copy moved onto the plate is found, and the part fails on both the placement and the overlap", async () => {
    const { ref, scriptSha } = refsPart([{ file: "far.step", step: "FAR", bodies: ["far"] }], { "far.step": "FAR" });
    const s = interferenceStub(["far (ref-far.step:2)"]);
    const g = await referenceGate(s.call as any, ref, ruled(["far.step"]), scriptSha, { designBodies: ["Body1"], referenceBodies: ["far"], placements: { Body1: ["Body1"], far: ["far", "far (ref-far.step:2)"] }, references: [] });
    expect(s.asked).toEqual([["Body1", "far", "far (ref-far.step:2)"]]);
    const bad = failing(g.checks);
    expect(bad).toContain(`placed far.step: reference far.step is placed 2 times; ${REFERENCE_PLACED_ONCE} (far, far (ref-far.step:2))`);
    expect(bad.find((l) => l.startsWith("interference far.step:"))).toContain("Body1 overlaps far (ref-far.step:2) by 600 mm³");
    // Placed once, the same reference passes.
    const ok = await referenceGate(interferenceStub([]).call as any, ref, ruled(["far.step"]), scriptSha, once(["Body1"], ["far"]));
    expect(failing(ok.checks)).toEqual([]);
  });
});

/** `component.list` as the real 0.44.1 answers it for the plate with far.step imported (A4 probe). */
const I4: [number[], number[], number[], number[]] = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
function realList(o: { name?: string; grounded?: boolean; transform?: number[][]; pending?: number[]; extraFeature?: string } = {}) {
  const occ = { component: 7, grounded: o.grounded ?? true, id: 8, name: `${o.name ?? "ref-far.step"}:1`, parent: 0, transform: o.transform ?? I4 };
  return {
    active: 0,
    active_path: [],
    components: [
      { bodies: ["Body1"], children: [occ], construction: [], features: ["Plate", "Corners", "Hole", "Holes"], id: 0, name: "Untitled", occurrences: [], parent: null, sketches: ["PlateSketch", "HolePts"] },
      { bodies: ["far"], children: [], construction: [], features: ["ref-far.step", ...(o.extraFeature ? [o.extraFeature] : [])], id: 7, name: o.name ?? "ref-far.step", occurrences: [occ], parent: 0, sketches: [] },
    ],
    pending_moves: o.pending ?? [],
  };
}
const TIMELINE = [{ id: 2, name: "Plate", type: "ExtrudeFeature" }, { id: 9, name: "ref-far.step", type: "BaseFeature" }];
const BODIES = [{ feature: 2, name: "Body1" }, { feature: 9, name: "far" }];
const EMB = [{ file: "far.step", name: "ref-far.step", bodies: ["far"] }];
const live = (o: Parameters<typeof realList>[0] = {}) => liveReferences(readComponentList(realList(o)), TIMELINE, BODIES);

describe("references stay where they were imported; every design placement is measured", () => {
  test("[A4] veto: component.list is read in the real shape (4 columns, translation last; grounded; pending_moves); a reference is found by its import feature, so a renamed one ('innocent') is still one; a reply without that shape throws", () => {
    const refs = live({ name: "innocent" });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ component: 7, name: "innocent", bodies: ["far"], imports: ["ref-far.step"], others: [], placements: [{ id: 8, name: "innocent:1", grounded: true, pending: false, world: I4 }] });
    // Found by its body too when the feature was renamed.
    expect(liveReferences(readComponentList(realList()), [{ id: 9, name: "renamed", type: "BaseFeature" }], BODIES)).toHaveLength(1);
    expect(() => readComponentList({})).toThrow("no component list");
    expect(() => readComponentList({ components: [{ id: 7, name: "x", bodies: [], features: [], occurrences: [{ id: 8, name: "x:1", parent: 0, grounded: true }] }], pending_moves: [] })).toThrow("4×4 transform");
    expect(() => readComponentList({ ...realList(), pending_moves: undefined })).toThrow("pending moves");
  });

  test("[A4] veto: a placement's world transform follows its parents (column-major); a parent placed twice cannot be told and counts as moved", () => {
    const list = readComponentList({
      active: 0,
      components: [
        { id: 0, name: "Untitled", bodies: [], features: [], occurrences: [] },
        { id: 11, name: "Sub", bodies: [], features: [], occurrences: [{ id: 12, name: "Sub:1", parent: 0, grounded: false, transform: [I4[0], I4[1], I4[2], [0, 0, 77, 1]] }] },
        { id: 13, name: "ref-x.step", bodies: ["far (2)"], features: ["ref-x.step"], occurrences: [{ id: 14, name: "ref-x.step:1", parent: 11, grounded: true, transform: [I4[0], I4[1], I4[2], [5, 0, 0, 1]] }] },
      ],
      pending_moves: [],
    });
    expect(worldTransform(list, list.components[2]!.occurrences[0]!)).toEqual([I4[0], I4[1], I4[2], [5, 0, 77, 1]]);
    const refs = liveReferences(list, [{ id: 15, name: "ref-x.step", type: "BaseFeature" }], [{ feature: 15, name: "far (2)" }]);
    expect(referencePlacementChecks(refs, [{ file: "x.step", name: "ref-x.step", bodies: ["far (2)"] }])[0]!.measured).toBe(`reference x.step ${REFERENCE_MOVED} (placement ref-x.step:1: its translation is [5, 0, 77])`);
    list.components[1]!.occurrences.push({ id: 16, name: "Sub:2", parent: 0, grounded: false, transform: I4 });
    expect(worldTransform(list, list.components[2]!.occurrences[0]!)).toBeUndefined();
  });

  test("[A4] veto: un-grounded and moved 1000 mm away is a hard fail 'reference far.step was moved from where it was imported' and '…is not grounded'; a pending move, a turn and a feature in its component fail too; identity, grounded passes", () => {
    expect(referencePlacementChecks(live(), EMB)).toEqual([]);
    const moved = referencePlacementChecks(live({ grounded: false, transform: [I4[0], I4[1], I4[2], [1000, 0, 0, 1]] }), EMB);
    expect(moved.map((c) => [c.id, c.measured, c.ok, c.hard])).toEqual([
      ["where far.step", `reference far.step ${REFERENCE_MOVED} (placement ref-far.step:1: its translation is [1000, 0, 0])`, false, true],
      ["grounded far.step", `reference far.step ${REFERENCE_NOT_GROUNDED} (placement ref-far.step:1)`, false, true],
    ]);
    expect(referencePlacementChecks(live({ pending: [8] }), EMB)[0]!.measured).toContain("a move is pending");
    expect(referencePlacementChecks(live({ transform: [[0, 1, 0, 0], [-1, 0, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] }), EMB)[0]!.measured).toContain("its translation is [0, 0, 0] and it is turned");
    expect(referencePlacementChecks(live({ extraFeature: "Box9" }), EMB)[0]!.measured).toBe("reference far.step was changed: Box9 is in its component");
    // Renamed, it is still reported by its refs/ file.
    expect(referencePlacementChecks(live({ name: "innocent", grounded: false }), EMB)[0]!.measured).toContain("reference far.step is not grounded (placement innocent:1)");
  });

  test("[A4] veto: the reference gate fails a moved reference (shared by refresh and verify), and a script feature naming a reference body ('Move1' of far) fails 'reference far.step is changed by feature Move1'", async () => {
    const { ref, scriptSha } = refsPart([{ file: "far.step", step: "FAR", bodies: ["far"] }], { "far.step": "FAR" });
    const design = { ...once(["Body1"], ["far"]), references: live({ grounded: false, transform: [I4[0], I4[1], I4[2], [1000, 0, 0, 1]] }) };
    const g = await referenceGate(interferenceStub([]).call as any, ref, ruled(["far.step"]), scriptSha, design);
    const bad = failing(g.checks);
    expect(bad).toContain(`where far.step: reference far.step ${REFERENCE_MOVED} (placement ref-far.step:1: its translation is [1000, 0, 0])`);
    expect(bad).toContain(`grounded far.step: reference far.step ${REFERENCE_NOT_GROUNDED} (placement ref-far.step:1)`);
    expect(failing((await referenceGate(interferenceStub([]).call as any, ref, ruled(["far.step"]), scriptSha, { ...once(["Body1"], ["far"]), references: live() })).checks)).toEqual([]);
    const script = { commands: [{ command: "timeline.add", params: { feature: { type: "import", name: "ref-far.step", file: "far.step", step: "FAR", body_names: ["far"] } } }, { command: "timeline.add", params: { feature: { bodies: ["far"], id: 10, name: "Move1", translate: ["300", "0", "0"], type: "move" } } }, { command: "timeline.add", params: { feature: { body_names: ["Body1"], name: "Plate", type: "extrude" } } }] };
    expect(referenceEditChecks(script as any, new Map([["far", "far.step"]]))).toEqual([{ id: "changed far.step", expected: "no feature changes a reference", measured: "reference far.step is changed by feature Move1 (it names far)", ok: false, hard: true }]);
    expect(referenceEditChecks({ commands: script.commands.filter((c) => c.params.feature.name !== "Move1") } as any, new Map([["far", "far.step"]]))).toEqual([]);
  });

  test("[A4] veto: a design body placed more than once is a hard fail 'body Body2 is placed 2 times; a design body may be placed once'; placed once passes", () => {
    expect(designPlacementChecks(["Body1", "Body2"], { Body1: ["Body1"], Body2: ["Body2", "Body2 (Design2:2)"] })).toEqual([{ id: "placed body Body2", expected: "the body is placed once", measured: `body Body2 is placed 2 times; ${DESIGN_PLACED_ONCE} (Body2, Body2 (Design2:2))`, ok: false, hard: true }]);
    expect(designPlacementChecks(["Body1"], { Body1: ["Body1"] })).toEqual([]);
  });
});

describe("the manager's working folder", () => {
  test("[A4] SolidCraft is spawned with its working folder set to the part folder (absolute), so a plain name it resolves stays inside the part (decision 115)", async () => {
    const repo = tempRepo();
    const log = recordingSpawn();
    const m = fakeManager({ spawn: log.spawn });
    const ref = partRef(repo, "plate");
    await m.open(ref);
    expect(log.cwds).toEqual([ref.dir]);
    expect(ref.dir.startsWith("/")).toBe(true);
  });
});

describe("a reference measures what its import did", () => {
  /** inspect.measure as the real 0.44.1 answers one block (A4 probe: the 10 mm block at [0, 0, -2]). */
  const block = (over: Record<string, unknown> = {}) => ({ name: "block", volume_mm3: 1000, bbox: { min: [0, 0, -2], max: [10, 10, 8] }, faces: 6, center_of_mass: [5, 5, 3], closed: true, ...over });
  const asImported = { name: "block", volume: 1000, bbox: { min: [0, 0, -2] as [number, number, number], max: [10, 10, 8] as [number, number, number] }, faces: 6, centerOfMass: [5, 5, 3] as [number, number, number] };

  test("[A4] veto: a reference body's measure is read from inspect.measure (volume, WORLD bounding box, faces, centre of mass) in the order asked, and any other answer throws; differences are named within 1e-6 of its size", () => {
    expect(readReferenceMeasures({ bodies: [block()] }, ["block"])).toEqual([asImported]);
    expect(readReferenceMeasures({ bodies: [block({ center_of_mass: undefined })] }, ["block"])[0]!.centerOfMass).toBeUndefined();
    expect(() => readReferenceMeasures({ bodies: [] }, ["block"])).toThrow("answered 0 bodies; 1 were asked for");
    expect(() => readReferenceMeasures({ bodies: [{ name: "block", error: "not closed" }] }, ["block"])).toThrow("could not be measured: not closed");
    expect(() => readReferenceMeasures({ bodies: [block({ volume_mm3: null })] }, ["block"])).toThrow("no volume, bounding box and face count");
    expect(() => readReferenceMeasures(undefined, ["block"])).toThrow();
    // The same numbers (a rounding far below 1e-6 of its size) match.
    expect(referenceDifferences([asImported], [{ ...asImported, bbox: { min: [-1.7763568394002505e-15, 0, -2], max: [10, 10, 8] }, volume: 1000 + 1e-7 }])).toEqual([]);
    // The A4 veto: offset by a point on the bottom face, -9 mm.
    expect(referenceDifferences([asImported], [{ ...asImported, volume: 100, bbox: { min: [0, 0, 7], max: [10, 10, 8] }, centerOfMass: [5, 5, 7.5] }])).toEqual([
      "volume 1000 → 100 mm³",
      "bounding box [0, 0, -2]…[10, 10, 8] → [0, 0, 7]…[10, 10, 8]",
      "centre of mass [5, 5, 3] → [5, 5, 7.5]",
    ]);
    expect(referenceDifferences([asImported], [{ ...asImported, faces: 7 }])).toEqual(["faces 6 → 7"]);
    expect(referenceDifferences([asImported], [{ ...asImported, bbox: { min: [0, 0, -2 + 1e-4], max: [10, 10, 8] } }])).toHaveLength(1); // 1e-4 mm is more than 1e-6 of 10 mm
    const { centerOfMass: _c, ...noCom } = asImported;
    expect(referenceDifferences([asImported], [noCom])).toEqual(["centre of mass [5, 5, 3] → not reported"]);
    expect(referenceDifferences([noCom], [asImported])).toEqual([]); // a build that never reported it (the fake)
    expect(referenceDifferences([asImported, { ...asImported, name: "b2" }], [asImported])).toEqual(["2 bodies → 1"]);
    expect(referenceDifferences([asImported, { ...asImported, name: "b2" }], [asImported, { ...asImported, name: "b2", volume: 1 }])).toEqual(["b2: volume 1000 → 1 mm³"]);
    expect(isReferenceMeasure({ sha256: "x", bodies: [asImported] })).toBe(true);
    for (const bad of [undefined, {}, { sha256: "x", bodies: [] }, { sha256: "x", bodies: [{ ...asImported, faces: "6" }] }, { sha256: 1, bodies: [asImported] }]) expect(isReferenceMeasure(bad)).toBe(false);
  });

  test("[A4] veto: the geometry check holds each byte-checked reference to the lock store's record of its import (same STEP text) as a fast pre-check, then to the TRUE import (exact shape: vol(true) = vol(live) = vol(true ∩ live)), and checks the design bodies against the true import; reshaped, moved or gone fails; no record needs adoption ('approve current reference'); a record for other text on a part with expectations, an unreadable record, no check, a failed check and an unmeasurable reference are unverified", async () => {
    const script = { about: {}, commands: [{ command: "timeline.add", params: { feature: { type: "import", name: "ref-block.step", file: "block.step", step: "BLOCK", body_names: ["block"] } } }] };
    const embedded = embeddedReferences(script);
    const exportDir = tempRepo("anvil-cad-geo-");
    const input = { embedded, clean: new Set(["block.step"]), script, referenceBodies: ["block"], designBodies: ["Body1"], placements: { block: ["block"], Body1: ["Body1"] }, must: new Set(["block.step"]), exportDir };
    const asked: any[] = [];
    const measuring = (b: Record<string, unknown> | "error", exportFails = false) => async (tool: string, args: any) => {
      asked.push({ tool, ...args });
      if (tool === "export") {
        if (exportFails) return reply({ error: "no" }, true);
        writeFileSync(args.path, `STEP of ${args.bodies.join(",")}`);
        return reply({ bytes: 1, format: "Step", path: args.path });
      }
      return b === "error" ? reply({ error: "no" }, true) : reply({ bodies: [b] });
    };
    const record = { references: { "block.step": { sha256: sha("BLOCK"), bodies: [asImported] } } };
    const noOverlap = reply({ count: 0, interferences: [], unchecked: [], budget_exceeded: false, truncated: false });
    const seen: TrueReferenceInput[] = [];
    const truth = (over: Partial<TrueReferenceResult> = {}) => async (i: TrueReferenceInput): Promise<TrueReferenceResult> => {
      seen.push(i);
      return { sha256: sha(i.step), asImported: [asImported], interference: noOverlap, shape: [{ label: "block", trueVolume: 1000, liveVolume: 1000, overlap: 1000 }], ...over };
    };
    const lines = (r: { checks: { id: string; ok: boolean; measured: unknown }[] }) => r.checks.map((c) => `${c.id}: ${c.ok ? "ok" : "FAIL"} ${String(c.measured)}`);
    // Untouched: the record matches, the true import is the same solid, no overlap with it.
    let r = await referenceGeometryChecks(measuring(block()), input, record, true, truth());
    expect(lines(r)).toEqual(["interference block.step as imported: ok no overlap", "geometry block.step: ok as imported"]);
    expect(r.unverified).toBe(false);
    // The live process exported the reference body and every design placement (by world name) into a
    // staging folder of its .cache, which is gone afterwards; the check got the embedded text and those bytes.
    expect(asked.filter((a) => a.tool === "export").map((a) => [a.bodies, a.format, a.path.startsWith(join(exportDir, ".cache", "truecheck-"))])).toEqual([[["block"], "step", true], [["Body1"], "step", true]]);
    expect(seen[0]!.step).toBe("BLOCK");
    expect(seen[0]!.live.map((l) => [l.label, l.bytes.toString()])).toEqual([["block", "STEP of block"]]);
    expect(seen[0]!.design.map((l) => [l.label, l.bytes.toString()])).toEqual([["Body1", "STEP of Body1"]]);
    expect(readdirSync(join(exportDir, ".cache"))).toEqual([]);
    // THE VETO: the summary numbers all match, but the live body shares less than its volume with the
    // true import (two holes enlarged, two shrunk) and the design overlaps the TRUE import.
    const hit = reply({ count: 1, interferences: [{ a: "Pin", b: "holey (as imported)", volume_mm3: 40.8407 }], unchecked: [], budget_exceeded: false, truncated: false });
    r = await referenceGeometryChecks(measuring(block()), input, record, true, truth({ interference: hit, shape: [{ label: "block", trueVolume: 1000, liveVolume: 1000, overlap: 959.1593 }] }));
    expect(lines(r)).toEqual([
      "interference block.step as imported: FAIL Pin overlaps holey (as imported) by 40.841 mm³",
      `geometry block.step: FAIL reference block.step ${REFERENCE_RESHAPED} (shape is not the import's: it shares 959.159 of the import's 1000 mm³ (the reference is 1000 mm³))`,
    ]);
    expect(r.unverified).toBe(false);
    // Within 1e-6 of its volume is the same solid; a body count that differs is named.
    expect(lines(await referenceGeometryChecks(measuring(block()), input, record, true, truth({ shape: [{ label: "block", trueVolume: 1000, liveVolume: 1000 + 1e-7, overlap: 1000 - 1e-7 }] }))).at(-1)).toBe("geometry block.step: ok as imported");
    expect(lines(await referenceGeometryChecks(measuring(block()), input, record, true, truth({ shape: [], bodyCount: { imported: 2, live: 1 } }))).at(-1)).toContain("2 bodies → 1");
    // Reshaped by a point (the pre-check sees it): a hard fail with the numbers.
    r = await referenceGeometryChecks(measuring(block({ volume_mm3: 100, bbox: { min: [0, 0, 7], max: [10, 10, 8] }, center_of_mass: [5, 5, 7.5] })), input, record, true, truth({ shape: [{ label: "block", trueVolume: 1000, liveVolume: 100, overlap: 100 }] }));
    expect(lines(r).at(-1)).toBe(`geometry block.step: FAIL reference block.step ${REFERENCE_RESHAPED} (volume 1000 → 100 mm³; bounding box [0, 0, -2]…[10, 10, 8] → [0, 0, 7]…[10, 10, 8]; centre of mass [5, 5, 3] → [5, 5, 7.5]; shape is not the import's: it shares 100 of the import's 1000 mm³ (the reference is 100 mm³))`);
    // Moved (its placement), measured in world coordinates.
    expect(lines(await referenceGeometryChecks(measuring(block({ bbox: { min: [0, 0, 98], max: [10, 10, 108] }, center_of_mass: [5, 5, 103] })), input, record, true, truth())).at(-1)).toContain(REFERENCE_RESHAPED);
    // Gone (suppressed, rolled back, deleted): its body is not in the design.
    expect(lines(await referenceGeometryChecks(measuring(block()), { ...input, referenceBodies: [] }, record, true, truth())).at(-1)).toBe(`geometry block.step: FAIL reference block.step ${REFERENCE_RESHAPED} (block is not in the design: its import is suppressed, rolled back or deleted)`);
    // No design bodies: the shape is still compared, nothing to interfere; a reference under no rule is not interference-checked.
    expect(lines(await referenceGeometryChecks(measuring(block()), { ...input, designBodies: [] }, record, true, truth()))).toEqual(["interference block.step as imported: ok no design bodies yet", "geometry block.step: ok as imported"]);
    expect(lines(await referenceGeometryChecks(measuring(block()), { ...input, must: new Set<string>() }, record, true, truth()))).toEqual(["geometry block.step: ok as imported"]);
    // ITEM 3 — a legacy approval (no record): never trusted from the current file. Still checked
    // against its import, and the part needs adoption: "approve current reference".
    for (const legacy of [{}, undefined]) {
      r = await referenceGeometryChecks(measuring(block()), input, legacy, true, truth());
      expect(lines(r)).toEqual(["interference block.step as imported: ok no overlap", "geometry block.step: ok as imported", `lock.references: FAIL ${REFERENCE_NOT_RECORDED} (refs/block.step)`]);
      expect(r.unverified).toBe(true);
    }
    // …and with no record, the pre-check runs against the true import's numbers.
    expect(lines(await referenceGeometryChecks(measuring(block({ volume_mm3: 100 })), input, undefined, true, truth())).find((l) => l.startsWith("geometry"))).toContain("volume 1000 → 100 mm³");
    // A record for OTHER text: on a part with expectations the reference was swapped without the card.
    const other = { references: { "block.step": { sha256: sha("OTHER"), bodies: [asImported] } } };
    r = await referenceGeometryChecks(measuring(block()), input, other, true, truth());
    expect(lines(r)[1]).toContain(`reference block.step ${REFERENCE_NOT_APPROVED} (approved ${sha("OTHER").slice(0, 12)}, the design holds ${sha("BLOCK").slice(0, 12)})`);
    expect(r.unverified).toBe(true);
    // …on a part with none yet (re-imported freely, so no rule names it): the true import decides.
    expect(lines(await referenceGeometryChecks(measuring(block()), { ...input, must: new Set<string>() }, other, false, truth()))).toEqual(["geometry block.step: ok as imported"]);
    // A reference no rule names (it fails "not covered" anyway) asks no card when unrecorded.
    expect(lines(await referenceGeometryChecks(measuring(block()), { ...input, must: new Set<string>() }, undefined, true, truth()))).toEqual(["geometry block.step: ok as imported"]);
    // Fail closed: every failure on the path to the true import is unverified, and the
    // as-imported interference line fails with it.
    for (const [lock, ck, call, why] of [
      [{ references: { "block.step": { sha256: sha("BLOCK"), bodies: [] } } }, truth(), measuring(block()), "cannot be read"],
      [record, undefined, measuring(block()), "could not be checked against its import: no SolidCraft process can be started here"],
      [record, async () => { throw new Error("no SolidCraft"); }, measuring(block()), "could not be checked against its import: no SolidCraft"],
      [record, async (i: TrueReferenceInput) => ({ ...(await truth()(i)), sha256: sha("OTHER") }), measuring(block()), "imported other text"],
      [record, truth(), measuring(block(), true), "could not be exported to STEP"],
      [record, truth(), measuring("error"), "reference block.step could not be measured"],
    ] as [any, any, any, string][]) {
      const f = await referenceGeometryChecks(call, input, lock, true, ck);
      expect(lines(f).join("\n")).toContain(why);
      expect(f.unverified).toBe(true);
      expect(f.checks.find((c) => c.id === "interference block.step as imported")!.ok).toBe(false);
      expect(f.checks.find((c) => c.id === "geometry block.step")!.ok).toBe(false);
    }
    // A failed interference reply against the true import is a hard fail, never "no overlap".
    expect(lines(await referenceGeometryChecks(measuring(block()), input, record, true, truth({ interference: reply({ count: 0, interferences: [], unchecked: [["a", "b"]], budget_exceeded: false, truncated: false }) })))[0]).toContain("1 pair(s) not checked");
    // An import whose script lists no bodies.
    const bare = { about: {}, commands: [{ command: "timeline.add", params: { feature: { type: "import", name: "ref-block.step", file: "block.step", step: "BLOCK" } } }] };
    expect(lines(await referenceGeometryChecks(measuring(block()), { ...input, embedded: embeddedReferences(bare), script: bare }, record, true, truth())).find((l) => l.startsWith("geometry"))).toContain("its import lists no bodies");
  });

  test("[A4] veto: the exact shape comparison — the same solid only when vol(true) = vol(live) = vol(true ∩ live) within 1e-6 of the import's volume", () => {
    const s = (trueVolume: number, liveVolume: number, overlap: number) => shapeDifferences([{ label: "b", trueVolume, liveVolume, overlap }]);
    expect(s(7869.026644707676, 7869.026644707674, 7869.026644707676)).toEqual([]);
    expect(s(7869.0266, 7869.0266, 7766.9249)).toHaveLength(1); // equal volumes, different solids (the holey veto, 90° turn)
    expect(s(1000, 1100, 1000)).toHaveLength(1); // the live body contains the import and more
    expect(s(1000, 1000, 0)).toHaveLength(1); // moved clear of where it was
    expect(shapeDifferences([{ label: "a", trueVolume: 1, liveVolume: 1, overlap: 1 }, { label: "b", trueVolume: 1, liveVolume: 1, overlap: 0.5 }])).toEqual(["b: shape is not the import's: it shares 0.5 of the import's 1 mm³ (the reference is 1 mm³)"]);
  });

  test("[A4] veto: the replay imports ONLY the reference's STEP text, in a throwaway process allowed nothing but its own temp folder, and measures what file.insert_step made; one process per binary and text (cached); no binary is an error", async () => {
    const log = recordingSpawn();
    const replay = makeReferenceReplay({ resolveCli: () => ({ path: FAKE_SOLIDCRAFT }), manager: { spawn: log.spawn } });
    const step = `ISO-10303-21; /* fake-solidcraft {"bodies":[{"name":"block","volume":1000,"faces":6,"min":[0,0,-2],"max":[10,10,8]}]} */`;
    const m = await replay(step, "block.step");
    expect(m).toEqual({ sha256: sha(step), bodies: [{ name: "block", volume: 1000, bbox: { min: [0, 0, -2], max: [10, 10, 8] }, faces: 6 }] });
    expect(log.cmds).toHaveLength(1);
    const allow = log.cmds[0]![log.cmds[0]!.indexOf("--allow-path") + 1]!;
    expect(allow).toContain("anvil-refreplay-");
    expect(log.cmds[0]).toContain("--require-allow-path");
    expect(await replay(step, "block.step")).toEqual(m); // cached: no second process
    expect(log.cmds).toHaveLength(1);
    await expect(makeReferenceReplay({ resolveCli: () => undefined })(step, "block.step")).rejects.toThrow("SolidCraft is not installed");
  });

  test("[A4] veto: the true-import check runs in a throwaway process (--allow-path its own temp folder, --require-allow-path, cwd there, no --in, PATH/HOME/TMPDIR only): the embedded text imported at the identity, the design bodies and the live reference body inserted from their STEP exports; interference design × true (names mapped back) and true × live (overlap = volume ⇔ same solid); nothing is left behind; no binary is an error", async () => {
    const log = recordingSpawn();
    const check = makeTrueReferenceCheck({ resolveCli: () => ({ path: FAKE_SOLIDCRAFT }), manager: { spawn: log.spawn } });
    const fake = (bodies: object[]) => `ISO-10303-21; /* fake-solidcraft ${JSON.stringify({ bodies })} */`;
    const blockBody = { name: "block", volume: 1000, faces: 6, min: [0, 0, -2], max: [10, 10, 8] };
    const step = fake([blockBody]);
    const pin = Buffer.from(fake([{ name: "Body1", volume: 400, faces: 3, min: [5, 5, 0], max: [15, 15, 4] }]));
    const r = await check({ file: "block.step", step, design: [{ label: "Body1", bytes: pin }], live: [{ label: "block", bytes: Buffer.from(step) }] });
    expect(r.sha256).toBe(sha(step));
    expect(r.asImported).toEqual([{ name: "block", volume: 1000, bbox: { min: [0, 0, -2], max: [10, 10, 8] }, faces: 6 }]);
    expect(interferenceCheck("block.step", r.interference!, { asImported: true })).toMatchObject({ id: "interference block.step as imported", ok: false, measured: "Body1 overlaps block (as imported) by 100 mm³" });
    expect(r.shape).toEqual([{ label: "block", trueVolume: 1000, liveVolume: 1000, overlap: 1000 }]);
    expect(shapeDifferences(r.shape)).toEqual([]);
    // A live body that is not the import: overlap below its volume.
    const moved = await check({ file: "block.step", step, design: [], live: [{ label: "block", bytes: Buffer.from(fake([{ ...blockBody, min: [0, 0, 0], max: [10, 10, 10] }])) }] });
    expect(moved.interference).toBeUndefined();
    expect(shapeDifferences(moved.shape)[0]).toContain("shares 800 of the import's 1000 mm³");
    expect(log.cmds).toHaveLength(2); // one throwaway process per check, never cached
    for (const [i, cmd] of log.cmds.entries()) {
      const allow = cmd[cmd.indexOf("--allow-path") + 1]!;
      expect(allow).toContain("anvil-truecheck-");
      expect(cmd).toContain("--require-allow-path");
      expect(cmd).toContain("--headless");
      expect(cmd).not.toContain("--in");
      expect(log.cwds[i]).toBe(allow);
      expect(Object.keys(log.envs[i]!).filter((k) => !k.startsWith("FAKE_SC_")).sort()).toEqual(["HOME", "PATH", "SOLIDCRAFT_GPU", "TMPDIR"]);
      expect(existsSync(allow)).toBe(false); // the folder is gone
    }
    // The live body count differs from the import's: said, not compared.
    expect((await check({ file: "block.step", step, design: [], live: [] })).bodyCount).toEqual({ imported: 1, live: 0 });
    await expect(makeTrueReferenceCheck({ resolveCli: () => undefined })({ file: "block.step", step, design: [], live: [] })).rejects.toThrow("SolidCraft is not installed");
  });
});
