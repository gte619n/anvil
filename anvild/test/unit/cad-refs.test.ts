/**
 * [A4] Reference bodies (agent-cad-and-browser spec §4.4 import_reference, §4.14 #4, owner item 45):
 * the source rules, the name in refs/, the embedded-STEP integrity check and the exact "no
 * interference" condition — plus the manager's working folder (decision 115).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { partRef } from "../../src/cadwork/partfolder";
import {
  embeddedReferences,
  interferenceCheck,
  interferenceRequest,
  referenceChecks,
  referenceName,
  resolveReferenceSource,
  DUPLICATE_REFERENCE,
  REFERENCE_CHANGED,
  REFERENCE_MAX_BYTES,
} from "../../src/cadwork/refs";
import { parseToolResult } from "../../src/cadwork/mcp-client";
import { coverageChecks, referenceGate, REFERENCE_NOT_COVERED } from "../../src/cadwork/refresh";
import { readDesignFile } from "../../src/cadwork/poststep";
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
const ruled = (must: string[]) => ({ kind: "ok", file: { expectations: { noInterferenceWith: must }, refs: [] } }) as any;
const failing = (checks: { id: string; ok: boolean; hard: boolean; measured: unknown }[]) => checks.filter((c) => !c.ok && c.hard).map((c) => `${c.id}: ${String(c.measured)}`);

describe("every embedded import is checked (the second import of a file name)", () => {
  test("[A4] re-review: two imports carrying the same file name fail closed ('duplicate reference import far.step'); the interference check covers the bodies of BOTH and finds the second one's overlap", async () => {
    const { ref, scriptSha } = refsPart([{ file: "far.step", step: "FAR", bodies: ["far_a"] }, { file: "far.step", step: "FAR", bodies: ["far_b"] }], { "far.step": "FAR" });
    const s = interferenceStub(["far_b"]);
    const g = await referenceGate(s.call as any, ref, ruled(["far.step"]), scriptSha, { designBodies: ["Body1"], referenceBodies: ["far_a", "far_b"] });
    const bad = failing(g.checks);
    expect(bad.find((l) => l.startsWith("ref far.step:"))).toContain(`${DUPLICATE_REFERENCE} far.step: 2 imports`);
    expect(s.asked).toEqual([["Body1", "far_a", "far_b"]]);
    expect(bad.find((l) => l.startsWith("interference far.step:"))).toContain("overlaps far_b by 600 mm³");
    // Neither import's bodies count as a checked reference.
    expect(bad.find((l) => l.startsWith("covered reference bodies:"))).toContain("far_a, far_b");
  });

  test("[A4] re-review: the SECOND import's bytes differ from refs/ — named on the duplicate line, and its body is not a known reference", async () => {
    const { ref, scriptSha } = refsPart([{ file: "far.step", step: "FAR", bodies: ["far_a"] }, { file: "far.step", step: "BLOCK AT ORIGIN", bodies: ["far_b"] }], { "far.step": "FAR" });
    const g = await referenceGate(interferenceStub([]).call as any, ref, ruled(["far.step"]), scriptSha, { designBodies: ["Body1"], referenceBodies: ["far_a", "far_b"] });
    const dup = failing(g.checks).find((l) => l.startsWith("ref far.step:"))!;
    expect(dup).toContain(DUPLICATE_REFERENCE);
    expect(dup).toContain("import 1 (ref-far.step-0, bodies far_a) matches");
    expect(dup).toContain(`import 2 (ref-far.step-1, bodies far_b) holds ${sha("BLOCK AT ORIGIN").slice(0, 12)}`);
    expect(failing(g.checks).find((l) => l.startsWith("covered reference bodies:"))).toContain("far_b");
    // The same import alone, with the bytes of refs/: everything passes.
    const one = refsPart([{ file: "far.step", step: "FAR", bodies: ["far_a"] }], { "far.step": "FAR" });
    const ok = await referenceGate(interferenceStub([]).call as any, one.ref, ruled(["far.step"]), one.scriptSha, { designBodies: ["Body1"], referenceBodies: ["far_a"] });
    expect(failing(ok.checks)).toEqual([]);
  });

  test("[A4] re-review: a reference body no checked import accounts for fails naming it — a stray BaseFeature body; an uncovered import whose bytes match refs/ fails on its own line", async () => {
    const { ref, scriptSha } = refsPart([{ file: "far.step", step: "FAR", bodies: ["far_a"] }, { file: "other.step", step: "OTHER", bodies: ["other_a"] }], { "far.step": "FAR", "other.step": "OTHER" });
    const g = await referenceGate(interferenceStub([]).call as any, ref, ruled(["far.step"]), scriptSha, { designBodies: ["Body1"], referenceBodies: ["far_a", "other_a", "ghost"] });
    const bad = failing(g.checks);
    expect(bad).toContain(`covered other.step: reference other.step ${REFERENCE_NOT_COVERED}`);
    expect(bad).toContain(`covered reference bodies: reference ghost ${REFERENCE_NOT_COVERED}`);
    expect(bad.some((l) => l.includes("far_a"))).toBe(false);
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
