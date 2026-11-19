/**
 * [A4] Functional scenario for Phase A4 (agent-cad-and-browser spec §5 "Phase A4", §4.7, §4.14 #4,
 * owner item 45): references and interference, concept parts and the dimensions card, gaps, and the
 * release pack. Real service / manager / refresh / lock store and the real agent tools; SolidCraft is
 * the fake. One test per Acceptance bullet in the spec's order, then the A4 extras and §7's rows.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoIdentity } from "../../src/cadwork/locks";
import { partRef } from "../../src/cadwork/partfolder";
import { REFERENCE_CHANGED } from "../../src/cadwork/refs";
import { expectedReleaseFiles, MANIFEST, NOT_A_DRAWING } from "../../src/cadwork/release";
import { RELEASE_AGENT_NUMBERS } from "../../src/session/cadwork-service";
import { FakeClock, RULES, approveCards, buildPlate, cleanupTemp, fakeCadSession, stopServices, tempRepo, until, writeRules, type ToolReply } from "../helpers/cad-work";
import { FAKE_SOLIDCRAFT } from "../helpers/fake-solidcraft";

const saved = process.env.ANVIL_SOLIDCRAFT_CLI;
beforeAll(() => void (process.env.ANVIL_SOLIDCRAFT_CLI = FAKE_SOLIDCRAFT));
afterAll(() => {
  if (saved === undefined) delete process.env.ANVIL_SOLIDCRAFT_CLI;
  else process.env.ANVIL_SOLIDCRAFT_CLI = saved;
});
afterEach(async () => {
  await stopServices();
  cleanupTemp();
});

const fake = { resolveCli: () => ({ path: FAKE_SOLIDCRAFT, source: "env" as const }) };
const text = (p: string) => readFileSync(p, "utf8");
const json = (p: string) => JSON.parse(text(p));
/** A STEP the fake reads back exactly: one box body from `min` to `max` (mm). */
function stepFile(repo: string, rel: string, min: number[], max: number[], name = "block"): string {
  const abs = join(repo, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  const v = (max[0]! - min[0]!) * (max[1]! - min[1]!) * (max[2]! - min[2]!);
  writeFileSync(abs, `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n/* fake-solidcraft ${JSON.stringify({ bodies: [{ name, volume: v, faces: 6, min, max }] })} */\nENDSEC;\nEND-ISO-10303-21;\n`);
  return abs;
}
type X = Awaited<ReturnType<typeof buildPlate>>;
/**
 * Run a tool call while playing the owner: every card that appears is answered by `answer` (true /
 * false, or the numbers for a dimensions card). Returns the reply and the cards that were shown.
 */
async function asOwner(x: Pick<X, "service" | "openCards">, call: Promise<ToolReply>, answer: (card: any) => boolean | Record<string, number> = () => true) {
  const shown: any[] = [];
  let settled = false;
  void call.finally(() => (settled = true));
  while (!settled) {
    for (const c of x.openCards()) {
      if (shown.some((s) => s.requestId === c.requestId)) continue;
      shown.push(c);
      const a = answer(c);
      if (typeof a === "object") x.service.respond(c.requestId, true, a);
      else x.service.respond(c.requestId, a);
    }
    await new Promise((r) => setTimeout(r, 2));
  }
  return { reply: await call, shown };
}
const failing = (g: any): string => (g.failing ?? []).join("\n");
/** check_part, with the owner adopting whatever the check asked them to (the repo's rules file). */
async function checked(x: { tools: any; service: any; openCards: () => any[] }, part: string): Promise<any> {
  await x.tools.check_part!({ part });
  approveCards(x);
  return (await x.tools.check_part!({ part })).json;
}

describe("Phase A4 acceptance", () => {
  test("[A4] acceptance 1: a part that overlaps its reference body fails the gate on interference; moved clear, it passes", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    expect(x.gate.state).toBe("pass");
    // A block reaching into the plate (the plate spans x −40…40, y −25…25, z 0…6).
    stepFile(repo, ".anvil-downloads/block.step", [0, 0, 0], [10, 10, 10]);
    const imp = await asOwner(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/block.step" }));
    expect(imp.reply.isError).toBe(false);
    expect(imp.shown.map((c) => c.kind)).toEqual(["propose"]); // expectations are locked: the owner adds the reference
    expect(imp.shown[0].rows.find((r: any) => r.label === "Must not touch")).toMatchObject({ old: "none", new: "block.step" });
    expect(imp.reply.json).toMatchObject({ imported: true, reference: "refs/block.step", bodies: ["block"] });
    expect(json(x.partJson).expectations.noInterferenceWith).toEqual(["block.step"]);
    let g = await x.check();
    expect(g.state).toBe("fail");
    const hit = g.checks.find((c: any) => c.id === "interference block.step");
    expect(hit.ok).toBe(false);
    expect(hit.measured).toBe("Body1 overlaps block by 600 mm³"); // 10 × 10 × 6 of the block lies inside the plate
    // The reference is not the part: volume, box and holes still measure the plate alone.
    for (const id of ["volume", "bbox.max", "bodies", "holes ⌀3.4 count"]) expect(g.checks.find((c: any) => c.id === id).ok).toBe(true);
    // Moved clear (the same reference, re-imported from its new position): pass.
    stepFile(repo, ".anvil-downloads/block.step", [100, 0, 0], [110, 10, 10]);
    const again = await asOwner(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/block.step" }));
    expect(again.reply.json).toMatchObject({ imported: true, replaced: true });
    g = await x.check();
    expect(g.state).toBe("pass");
    expect(g.checks.find((c: any) => c.id === "interference block.step")).toMatchObject({ ok: true, measured: "no overlap" });
    expect(g.checks.find((c: any) => c.id === "ref block.step").ok).toBe(true);
    // The design holds ONE import of it, embedded — no path.
    const imports = json(join(repo, "cad", "plate", "design.json")).commands.filter((c: any) => c.command === "timeline.add" && c.params.feature.type === "import");
    expect(imports).toHaveLength(1);
    expect(imports[0].params.feature.file).toBe("block.step");
    expect(imports[0].params.feature.step).toContain("fake-solidcraft");
    expect(JSON.stringify(imports[0])).not.toContain(".anvil-downloads");
  });

  test("[A4] acceptance 2: a concept part refuses export_part and release_part; the owner's dimensions card with L=95 sets ownerParams.L = 95 in the file and the lock store and the design's L to 95 whatever the agent proposed; after record_expectations it is dimensioned", async () => {
    const repo = tempRepo();
    writeRules(repo, RULES);
    const x = fakeCadSession(repo, fake, "sess_cad", { expectations: "manual" });
    const ref = partRef(repo, "bracket");
    const open = await x.tools.open_part!({ part: "bracket", concept: true, process: "fdm-0.4" });
    expect(open.isError).toBe(false);
    expect(open.json.modeling).toBe("allowed"); // a concept may be modeled without expectations
    expect(json(join(repo, "cad", "bracket", "part.json"))).toEqual({ schema: 1, process: "fdm-0.4", status: "concept" });
    expect(x.service.locks.findPart(repoIdentity(repo), "bracket")).toMatchObject({ status: "concept", approvedBy: "agent-initial" });
    // The agent models from a picture, with its own guess at the length.
    expect((await x.tools.batch!({ commands: [{ command: "parameters.add", params: { name: "L", expression: "60 mm" } }, { command: "solid.box", params: { length: "L", width: 20, height: 5, name: "Bracket" } }] })).isError).toBe(false);
    expect((await checked(x, "bracket")).state).toBe("concept");
    // Refused while a concept.
    const exp = await x.tools.export_part!({ part: "bracket", formats: ["step"] });
    expect(exp.isError).toBe(true);
    expect(exp.text).toContain("concept");
    const rel = await x.tools.release_part!({ part: "bracket" });
    expect(rel.isError).toBe(true);
    expect(rel.text).toContain("concept");
    expect(existsSync(join(repo, "cad", "bracket", "release"))).toBe(false);
    // The dimensions card: the agent proposes L = 60, W = 20; the owner types L = 95.
    const dims = await asOwner(x, x.tools.request_dimensions!({ part: "bracket", proposed: [{ name: "L", value: 60, unit: "mm", note: "overall length" }, { name: "W", value: 20, unit: "mm" }] }), (c) => (c.kind === "dimensions" ? { L: 95, W: 20 } : true));
    expect(dims.reply.isError).toBe(false);
    expect(dims.shown.map((c) => c.kind)).toEqual(["dimensions"]);
    expect(dims.shown[0].dimensions).toEqual([{ name: "L", value: 60, unit: "mm", note: "overall length" }, { name: "W", value: 20, unit: "mm" }]);
    expect(dims.reply.json.ownerParams).toEqual({ L: 95, W: 20 });
    expect(json(join(repo, "cad", "bracket", "part.json")).ownerParams).toEqual({ L: 95, W: 20 });
    expect(x.service.locks.findPart(repoIdentity(repo), "bracket")!.ownerParams).toEqual({ L: 95, W: 20 });
    expect(x.manager.status(ref)!.params.find((p) => p.name === "L")!.value).toBe(95);
    expect(x.manager.status(ref)!.params.find((p) => p.name === "W")!.value).toBe(20);
    // record_expectations with the owner's numbers: the part has geometry, so it is the owner's `initial` card.
    const rec = await asOwner(x, x.tools.record_expectations!({ part: "bracket", process: "fdm-0.4", parameters: { L: 95, W: 20 }, expectations: { bbox: ["L", "W", 5], volume: "L*W*5", bodies: 1, holes: [] } }));
    expect(rec.reply.isError).toBe(false);
    expect(rec.shown.map((c) => c.kind)).toContain("initial");
    const pf = json(join(repo, "cad", "bracket", "part.json"));
    expect(pf.status).toBe("dimensioned");
    expect(pf.ownerParams).toEqual({ L: 95, W: 20 });
    expect(x.service.locks.findPart(repoIdentity(repo), "bracket")).toMatchObject({ status: "dimensioned", approvedBy: "owner", ownerParams: { L: 95, W: 20 } });
    await asOwner(x, x.tools.check_part!({ part: "bracket" })); // adopt the repo's rules on the way
    const g = (await x.tools.check_part!({ part: "bracket" })).json;
    expect(g.state).toBe("pass");
    expect(g.checks.find((c: any) => c.id === "bbox.max")).toMatchObject({ expected: 95, measured: 95 });
  });

  test("[A4] acceptance 3: report_gap sets the state to gap and release_part is refused", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    expect(x.gate.state).toBe("pass");
    const r = await x.tools.report_gap!({ part: "plate", feature: "variable-radius fillet", detail: "solid.fillet takes one radius; the drawing needs 2→5 mm along the edge" });
    expect(r.isError).toBe(false);
    expect(r.json.state).toBe("gap");
    const g = await x.check();
    expect(g.state).toBe("gap");
    expect(g.gap).toMatchObject({ feature: "variable-radius fillet" });
    const ev = x.design("plate");
    expect(ev.gate.state).toBe("gap");
    expect(ev.gate.gap.detail).toContain("one radius");
    const rel = await x.tools.release_part!({ part: "plate" });
    expect(rel.isError).toBe(true);
    expect(rel.text).toContain("variable-radius fillet");
    expect(x.openCards()).toEqual([]); // refused before any card
    expect((await x.tools.export_part!({ part: "plate", formats: ["step"] })).isError).toBe(true);
    expect(existsSync(join(repo, "cad", "plate", "release"))).toBe(false);
  });

  test("[A4] acceptance 4: release_part on a passing part writes exactly the files of §4.7; the manifest hashes match and the HMAC verifies; the sheet says Not a drawing, lists every parameter and one hole row per distinct diameter; one file.offer per file", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    expect(x.gate.state).toBe("pass");
    expect(x.gate.approvedBy).toBe("agent-initial");
    const offersBefore = x.emitted.filter((e) => e.type === "file.offer").length;
    const r = await asOwner(x, x.tools.release_part!({ part: "plate" }));
    expect(r.reply.isError).toBe(false);
    expect(r.shown.map((c) => c.kind)).toEqual(["release"]);
    const sha = x.manager.status(partRef(repo, "plate"))!.scriptSha!;
    const dir = join(repo, "cad", "plate", "release", `plate-${sha.slice(0, 7)}`);
    expect(readdirSync(join(repo, "cad", "plate", "release"))).toEqual([`plate-${sha.slice(0, 7)}`]); // no temp folder left
    expect(readdirSync(dir).sort()).toEqual(expectedReleaseFiles("plate", "fdm"));
    expect(readdirSync(dir).sort()).toEqual(["front.png", "iso.png", "manifest.json", "plate.3mf", "plate.step", "right.png", "spec-sheet.html", "spec-sheet.md", "top.png"]);
    const m = json(join(dir, MANIFEST));
    for (const [f, h] of Object.entries(m.files)) expect(new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, f))).digest("hex")).toBe(h as string);
    expect(Object.keys(m.files).sort()).toEqual(expectedReleaseFiles("plate", "fdm").filter((f) => f !== MANIFEST));
    expect(x.service.verifyReleaseDir(dir)).toMatchObject({ ok: true });
    const md = text(join(dir, "spec-sheet.md"));
    const html = text(join(dir, "spec-sheet.html"));
    for (const sheet of [md, html]) {
      expect(sheet).toContain(NOT_A_DRAWING);
      for (const p of x.manager.status(partRef(repo, "plate"))!.params) expect(sheet).toContain(p.name);
      expect(sheet).toContain(sha);
    }
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toMatch(/<h1>Not a drawing<\/h1>/);
    // One hole-table row per distinct diameter: the plate has ⌀3.4 only (×4, with centres).
    const holes = html.split("<h2>Holes</h2>")[1]!.split("<h2>")[0]!;
    expect((holes.match(/<tr>/g) ?? []).length - 1).toBe(1);
    expect(holes).toContain("<td>3.4</td><td>4</td>");
    expect((holes.match(/\(-?\d+(\.\d+)?, -?\d+(\.\d+)?, -?\d+(\.\d+)?\)/g) ?? []).length).toBe(4);
    expect((html.match(/src="data:image\/png;base64,/g) ?? []).length).toBe(4); // the four views, embedded
    // One file.offer per file, each a file of the pack.
    const offers = x.emitted.filter((e) => e.type === "file.offer").slice(offersBefore);
    expect(offers).toHaveLength(9);
    expect(offers.map((o) => o.file.path.split("/").at(-1)).sort()).toEqual(expectedReleaseFiles("plate", "fdm"));
    // The card said the numbers were the agent's, and approving confirmed them.
    expect(r.shown[0].note).toBe(RELEASE_AGENT_NUMBERS);
    expect(x.service.locks.findPart(repoIdentity(repo), "plate")!.approvedBy).toBe("owner");
    expect(x.design("plate").released).toMatchObject({ path: `cad/plate/release/plate-${sha.slice(0, 7)}`, scriptSha: sha });
  });

  test("[A4] acceptance 4: on a failing part release_part writes nothing", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    expect((await x.tools.undo!({})).isError).toBe(false); // the hole pattern goes: volume and holes fail
    expect((await x.check()).state).toBe("fail");
    const r = await x.tools.release_part!({ part: "plate" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("the gate is fail");
    expect(x.openCards()).toEqual([]);
    expect(existsSync(join(repo, "cad", "plate", "release"))).toBe(false);
    expect(x.emitted.filter((e) => e.type === "file.offer")).toEqual([]);
  });

  test("[A4] acceptance 4: a copied release folder with an edited STEP does not get the Released badge", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    await asOwner(x, x.tools.release_part!({ part: "plate" }));
    const sha = x.manager.status(partRef(repo, "plate"))!.scriptSha!;
    const dir = join(repo, "cad", "plate", "release", `plate-${sha.slice(0, 7)}`);
    await x.check();
    expect(x.design("plate").released).toBeDefined();
    // Copy the pack, edit the STEP in the copy, and put the copy where the pack was.
    const copy = join(repo, "copy");
    cpSync(dir, copy, { recursive: true });
    writeFileSync(join(copy, "plate.step"), text(join(copy, "plate.step")).replace("ENDSEC;", "ENDSEC; /* edited */"));
    rmSync(dir, { recursive: true });
    renameSync(copy, dir);
    expect(x.service.verifyReleaseDir(dir)).toMatchObject({ ok: false, reason: "plate.step does not match its sha256 in the manifest" });
    await x.check();
    expect(x.design("plate").released).toBeUndefined();
    // A hand-made manifest that re-hashes the edit still has no valid HMAC.
    const m = json(join(dir, MANIFEST));
    m.files["plate.step"] = new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, "plate.step"))).digest("hex");
    writeFileSync(join(dir, MANIFEST), JSON.stringify(m));
    expect(x.service.verifyReleaseDir(dir)).toMatchObject({ ok: false, reason: "the manifest's HMAC does not verify on this machine" });
    await x.check();
    expect(x.design("plate").released).toBeUndefined();
  });
});

describe("Phase A4 extras", () => {
  test("[A4] reference integrity: editing refs/x.step makes the part unverified with 'reference changed; re-import'; a reference missing from refs/ fails", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    stepFile(repo, "vendor/clear.step", [100, 0, 0], [110, 10, 10], "clear");
    await asOwner(x, x.tools.import_reference!({ part: "plate", file: "vendor/clear.step" }));
    expect((await x.check()).state).toBe("pass");
    const refFile = join(repo, "cad", "plate", "refs", "clear.step");
    writeFileSync(refFile, text(refFile) + "/* edited */\n");
    let g = await x.check();
    expect(g.state).toBe("unverified");
    expect(failing(g)).toContain(REFERENCE_CHANGED);
    rmSync(refFile);
    g = await x.check();
    expect(g.state).toBe("fail");
    expect(failing(g)).toContain("refs/clear.step is missing");
  });

  test("[A4] importing before expectations exist is free, adds the reference to noInterferenceWith at record time, and keeps the part open to agent-initial expectations", async () => {
    const repo = tempRepo();
    writeRules(repo, RULES);
    const x = fakeCadSession(repo, fake, "sess_cad", { expectations: "manual" });
    await x.tools.open_part!({ part: "plate" });
    stepFile(repo, ".anvil-downloads/m3.step", [100, 0, 0], [110, 10, 10], "m3");
    const r = await x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/m3.step" });
    expect(r.isError).toBe(false);
    expect(x.openCards()).toEqual([]); // no card: nothing was locked yet
    const rec = await x.tools.record_expectations!({ part: "plate", process: "fdm-0.4", parameters: {}, expectations: { bbox: [10, 10, 10], volume: 1000, bodies: 1, holes: [] } });
    expect(rec.json).toMatchObject({ recorded: true, approved_by: "agent-initial" }); // a design of only references is still "new"
    const pf = json(join(repo, "cad", "plate", "part.json"));
    expect(pf.expectations.noInterferenceWith).toEqual(["m3.step"]);
    expect(pf.refs).toEqual([expect.objectContaining({ name: "m3.step", source: "refs/m3.step", bodies: ["m3"] })]);
  });

  test("[A4] after expectations exist, import_reference is the owner's card: Deny imports and writes nothing; unattended it is denied without a card", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    stepFile(repo, "vendor/a.step", [100, 0, 0], [110, 10, 10], "a");
    const before = { part: text(x.partJson), design: text(join(repo, "cad", "plate", "design.json")) };
    const r = await asOwner(x, x.tools.import_reference!({ part: "plate", file: "vendor/a.step" }), () => false);
    expect(r.reply.json).toMatchObject({ imported: false });
    expect(text(x.partJson)).toBe(before.part);
    expect(text(join(repo, "cad", "plate", "design.json"))).toBe(before.design);
    expect(existsSync(join(repo, "cad", "plate", "refs", "a.step"))).toBe(false);
    // An autopilot builder session: denied, no card.
    const y = fakeCadSession(repo, fake, "sess_builder", { expectations: "manual", sessionData: { workUnitRole: "builder" } });
    await y.tools.open_part!({ part: "plate" });
    const u = await y.tools.import_reference!({ part: "plate", file: "vendor/a.step" });
    expect(u.isError).toBe(true);
    expect(u.text).toContain("unattended");
    expect(y.openCards()).toEqual([]);
  });

  test("[A4] the 50 MB cap (injected) and the source rules: .., absolute paths, a symlink, a symlink inside the quarantine and a non-STEP are refused before anything is copied", async () => {
    const repo = tempRepo();
    writeRules(repo, RULES);
    const x = fakeCadSession(repo, { ...fake, referenceMaxBytes: 1000 }, "sess_cad", { expectations: "manual" });
    await x.tools.open_part!({ part: "plate" });
    stepFile(repo, "big.step", [0, 0, 0], [1, 1, 1]);
    writeFileSync(join(repo, "big.step"), text(join(repo, "big.step")) + "x".repeat(2000));
    const outside = stepFile(join(repo, ".."), `outside-${Date.now()}.step`, [0, 0, 0], [1, 1, 1]);
    const ok = stepFile(repo, "fine.step", [0, 0, 0], [1, 1, 1]);
    mkdirSync(join(repo, ".anvil-downloads"), { recursive: true });
    require("node:fs").symlinkSync(ok, join(repo, ".anvil-downloads", "link.step"));
    require("node:fs").symlinkSync(outside, join(repo, "out-link.step"));
    writeFileSync(join(repo, "notes.txt"), "x");
    const cases: [string, string][] = [
      ["big.step", "capped at"],
      ["../" + outside.split("/").at(-1), "outside this repo"],
      [outside, "absolute"],
      [".anvil-downloads/link.step", "symbolic link"],
      ["out-link.step", "symbolic link"],
      ["notes.txt", "not a STEP"],
      [".git/config.step", "inside .git"],
    ];
    for (const [file, why] of cases) {
      const r = await x.tools.import_reference!({ part: "plate", file });
      expect([file, r.isError]).toEqual([file, true]);
      expect(r.text).toContain(why);
    }
    expect(existsSync(join(repo, "cad", "plate", "refs"))).toBe(false);
    rmSync(outside);
  });

  test("[A4] an interference reply with unchecked pairs, a truncated list or an exhausted budget fails the gate", async () => {
    for (const mode of ["unchecked", "truncated", "budget"]) {
      const repo = tempRepo();
      const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT, deps: { manager: { extraEnv: { FAKE_SC_INTERFERENCE: mode } } } });
      stepFile(repo, "vendor/far.step", [500, 0, 0], [510, 10, 10], "far"); // nowhere near the plate
      await asOwner(x, x.tools.import_reference!({ part: "plate", file: "vendor/far.step" }));
      const g = await x.check();
      expect([mode, g.state]).toEqual([mode, "fail"]);
      const c = g.checks.find((k: any) => k.id === "interference far.step");
      expect(c.ok).toBe(false);
      expect(c.measured).toContain(mode === "unchecked" ? "not checked" : mode === "truncated" ? "truncated" : "budget exceeded");
      await stopServices();
    }
  });

  test("[A4] the release card shows under bypass and after a remembered allow with no generic prompt, and is denied without a card when unattended", async () => {
    const { makePreToolUseHook, PermissionBroker } = await import("../../src/agent/permissions");
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    const asked: string[] = [];
    const session = (data: Record<string, unknown>) =>
      ({ id: "s", data: { cwd: repo, ...data }, isAlwaysAllowed: () => true, rememberAllow: () => undefined, requestPermission: (id: string) => void asked.push(id) }) as any;
    const hook = (s: any) => makePreToolUseHook(s, new PermissionBroker())({ tool_name: "mcp__anvil_cad__release_part", tool_input: { part: "plate" } } as any, "t", { signal: new AbortController().signal } as any) as Promise<any>;
    for (const autonomy of ["bypass", "allowlist", "prompt-all", "mostly-autonomous"]) {
      expect((await hook(session({ autonomy }))).hookSpecificOutput.permissionDecision).toBe("allow"); // the typed card IS the prompt
    }
    expect(asked).toEqual([]); // no generic permission card in front, even with a remembered allow
    expect((await hook(session({ autonomy: "bypass", workUnitRole: "builder" }))).hookSpecificOutput.permissionDecision).toBe("deny");
    // The service shows its card every time (twice → two cards), and denies an unattended session outright.
    for (let i = 0; i < 2; i++) {
      const r = await asOwner(x, x.tools.release_part!({ part: "plate" }), () => false);
      expect(r.shown.map((c) => c.kind)).toEqual(["release"]);
      expect(r.reply.json).toMatchObject({ released: false });
    }
    const y = fakeCadSession(repo, fake, "sess_builder", { expectations: "manual", sessionData: { workUnitRole: "builder" } });
    const u = await y.tools.release_part!({ part: "plate" });
    expect(u.isError).toBe(true);
    expect(u.text).toContain("unattended");
    expect(y.openCards()).toEqual([]);
    expect(existsSync(join(repo, "cad", "plate", "release"))).toBe(false);
  });

  test("[A4] a release of agent-initial numbers says so on the card and confirms them (approvedBy → owner); an owner-approved part's card has no such note", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    expect(x.service.locks.findPart(repoIdentity(repo), "plate")!.approvedBy).toBe("agent-initial");
    const r = await asOwner(x, x.tools.release_part!({ part: "plate" }));
    expect(r.shown[0].note).toBe(RELEASE_AGENT_NUMBERS);
    expect(r.shown[0].rows.find((row: any) => row.label === "Numbers approved by").new).toContain("NOT confirmed");
    expect(x.service.locks.findPart(repoIdentity(repo), "plate")!.approvedBy).toBe("owner");
    expect((await x.check()).approvedBy).toBe("owner");
    const again = await asOwner(x, x.tools.release_part!({ part: "plate" }), () => false);
    expect(again.shown[0].note).toBeUndefined();
    // A denied release of agent numbers confirms nothing.
    const repo2 = tempRepo();
    const z = await buildPlate(repo2, { cli: FAKE_SOLIDCRAFT });
    await asOwner(z, z.tools.release_part!({ part: "plate" }), () => false);
    expect(z.service.locks.findPart(repoIdentity(repo2), "plate")!.approvedBy).toBe("agent-initial");
  });

  test("[A4] a record whose declared parameter values differ from ownerParams is refused", async () => {
    const repo = tempRepo();
    writeRules(repo, RULES);
    const x = fakeCadSession(repo, fake, "sess_cad", { expectations: "manual" });
    await x.tools.open_part!({ part: "bracket", concept: true, process: "fdm-0.4" });
    await x.tools.batch!({ commands: [{ command: "parameters.add", params: { name: "L", expression: "60 mm" } }, { command: "solid.box", params: { length: "L", width: 20, height: 5 } }] });
    // Before the owner gave dimensions, a concept cannot be recorded at all.
    const early = await x.tools.record_expectations!({ part: "bracket", process: "fdm-0.4", parameters: { L: 60 }, expectations: { bbox: ["L", 20, 5], volume: "L*100", bodies: 1, holes: [] } });
    expect(early.isError).toBe(true);
    expect(early.text).toContain("request_dimensions");
    await asOwner(x, x.tools.request_dimensions!({ part: "bracket", proposed: [{ name: "L", value: 60 }] }), (c) => (c.kind === "dimensions" ? { L: 95 } : true));
    for (const parameters of [{ L: 60 }, {}, { L: "95.5 mm" }]) {
      const r = await x.tools.record_expectations!({ part: "bracket", process: "fdm-0.4", parameters, expectations: { bbox: [95, 20, 5], volume: 9500, bodies: 1, holes: [] } });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("differ from the dimensions the owner typed");
    }
    expect(x.openCards()).toEqual([]);
    expect(json(join(repo, "cad", "bracket", "part.json")).status).toBe("concept");
    // Bad numbers on the card are refused server-side and the card stays open.
    const pending = x.tools.request_dimensions!({ part: "bracket", proposed: [{ name: "L", value: 95 }] });
    await until(() => x.openCards().length === 1, "the dimensions card");
    const card = x.openCards()[0];
    for (const bad of [{ L: "95" }, { L: Number.NaN }, {}, { L: 95, X: 1 }]) expect(() => x.service.respond(card.requestId, true, bad)).toThrow();
    expect(x.openCards()).toHaveLength(1);
    x.service.respond(card.requestId, false);
    expect((await pending).json.confirmed).toBe(false);
  });

  test("[A4] report_gap survives a manager restart and an edit of part.json; only the owner's Clear gap (or an approved expectation change) clears it", async () => {
    const repo = tempRepo();
    const stateDir = join(tempRepo("anvil-cad-a4-state-"), "state");
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT, deps: { stateDir } });
    await x.tools.report_gap!({ part: "plate", feature: "thread", detail: "no thread feature" });
    expect((await x.check()).state).toBe("gap");
    await stopServices(); // the daemon goes away…
    const y = fakeCadSession(repo, { ...fake, stateDir }, "sess_cad", { expectations: "manual" });
    await y.tools.open_part!({ part: "plate" });
    let g = (await y.tools.check_part!({ part: "plate" })).json;
    expect(g.state).toBe("gap"); // …and the gap is still there
    expect(g.gap.feature).toBe("thread");
    // Editing the gap out of part.json does not clear it: the lock store holds it.
    const pf = json(join(repo, "cad", "plate", "part.json"));
    delete pf.gap;
    writeFileSync(join(repo, "cad", "plate", "part.json"), JSON.stringify(pf, null, 2) + "\n");
    g = (await y.tools.check_part!({ part: "plate" })).json;
    expect(g.state).toBe("gap");
    await y.service.clearGap(repo, "plate");
    g = (await y.tools.check_part!({ part: "plate" })).json;
    expect(g.state).toBe("pass");
    expect(g.gap).toBeUndefined();
    // An approved expectation change also clears a gap.
    await y.tools.report_gap!({ part: "plate", feature: "knurl", detail: "no knurl" });
    expect((await y.tools.check_part!({ part: "plate" })).json.state).toBe("gap");
    const cur = json(join(repo, "cad", "plate", "part.json")).expectations;
    await asOwner(y, y.tools.propose_expectations!({ part: "plate", expectations: { bbox: cur.bbox, volume: cur.volume, bodies: 1, holes: cur.holes }, reason: "knurl dropped from the design" }));
    expect((await y.tools.check_part!({ part: "plate" })).json.state).not.toBe("gap");
  });

  test("[A4] cad.design broadcasts are bounded: 20 sequential awaited mutating calls within 2 s of fake-clock time give at most 5, the last showing the final state; forced refreshes still broadcast at once", async () => {
    const repo = tempRepo();
    const clock = new FakeClock();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT, deps: { manager: { clock } } });
    const ref = partRef(repo, "plate");
    await until(() => !x.manager.status(ref)!.busy, "idle");
    clock.advance(10_000);
    const designs = () => x.broadcasts.filter((e) => e.type === "cad.design" && e.part === "plate");
    const before = designs().length;
    for (let i = 0; i < 20; i++) {
      const r = await x.tools.execute!({ command: "solid.box", params: { length: 5, width: 5, height: 5, corner: [200 + 10 * i, 0, 0], name: `B${i}` } });
      expect(r.isError).toBe(false);
      await until(() => !x.manager.status(ref)!.busy && !x.manager.status(ref)!.refreshPending, "the refresh");
      clock.advance(100); // 20 calls × 100 ms = 2 s of manager time
    }
    clock.advance(500); // the trailing emit
    const sent = designs().slice(before);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.length).toBeLessThanOrEqual(5);
    const last = sent.at(-1)!;
    expect(last.rev).toBe(x.service.snapshot(ref)!.rev); // the newest state, not a stale one
    expect(x.service.snapshot(ref)!.outcome.measurement!.bodies).toBe(21);
    // A forced refresh (check_part) is broadcast at once, inside the window.
    const n = designs().length;
    await x.tools.check_part!({ part: "plate" });
    expect(designs().length).toBe(n + 1);
  });

  test("[A4] the part card's thumbnail is a PNG next to the preview, recorded by the daemon and served by the same route; the event carries its path and the script size, never image data", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    await x.check();
    const ev = x.design("plate");
    expect(ev.thumbnail).toBe(`cad/plate/.cache/thumb-${ev.rev}.png`);
    expect(readFileSync(join(repo, ev.thumbnail)).subarray(1, 4).toString()).toBe("PNG");
    expect(x.service.previewEntry(repo, ev.thumbnail)).toMatchObject({ abs: join(repo, ev.thumbnail) });
    expect(x.service.previewEntry(repo, "cad/plate/.cache/thumb-x.png")).toBeUndefined();
    expect(x.service.previewEntry(repo, "cad/plate/part.json")).toBeUndefined();
    expect(ev.scriptBytes).toBe(readFileSync(join(repo, "cad", "plate", "design.json")).length);
    expect(JSON.stringify(ev)).not.toContain("base64");
  });

  test("[A4] a concept's compare_picture score (a repo picture or the newest chat attachment) is shown on the card as an ADVISORY line that never blocks", async () => {
    const repo = tempRepo();
    writeRules(repo, RULES);
    const stateDir = join(tempRepo("anvil-cad-a4-state-"), "state");
    const x = fakeCadSession(repo, { ...fake, stateDir }, "sess_cad", { expectations: "manual", sessionData: {} });
    await x.tools.open_part!({ part: "knob", concept: true, process: "fdm-0.4" });
    await x.tools.execute!({ command: "solid.box", params: { length: 10, width: 10, height: 10 } });
    mkdirSync(join(repo, "photos"), { recursive: true });
    // A tiny real PNG (the fake does not decode it, the daemon only copies it).
    const bytes = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108000000003a7e9b550000000a4944415408d763f80f00010101005f2fb8a80000000049454e44ae426082", "hex");
    writeFileSync(join(repo, "photos", "knob.png"), bytes);
    const r = await x.tools.compare_picture!({ picture: "photos/knob.png", view: "front" });
    expect(r.isError).toBe(false);
    expect(r.json.overlap).toBe(0.9);
    const g = await checked(x, "knob");
    expect(g.state).toBe("concept");
    expect(g.advisory.join("\n")).toContain("90% overlap with photos/knob.png");
    expect(g.checks.find((c: any) => c.id === "picture.overlap")).toMatchObject({ hard: false });
    // A picture outside the repo or not a picture is refused.
    expect((await x.tools.compare_picture!({ picture: "../x.png" })).isError).toBe(true);
    expect((await x.tools.compare_picture!({ picture: "cad/rules.json" })).isError).toBe(true);
    // The user's newest attached image.
    const att = join(stateDir, "sessions", "sess_cad", "attachments");
    mkdirSync(att, { recursive: true });
    writeFileSync(join(att, "att_1.png"), bytes);
    writeFileSync(join(att, "att_1.json"), JSON.stringify({ mediaType: "image/png", name: "photo.png", ext: "png" }));
    const a = await x.tools.compare_picture!({ attachment: "latest" });
    expect(a.isError).toBe(false);
    expect((await x.tools.check_part!({ part: "knob" })).json.advisory.join("\n")).toContain("attachment photo.png");
  });
});
