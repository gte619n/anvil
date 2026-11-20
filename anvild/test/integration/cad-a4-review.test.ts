/**
 * [A3]/[A4] The A4 review's findings (decisions 152–154), each reproduced and closed on the real
 * service / manager / refresh / lock store with the fake SolidCraft:
 *
 *  - every owner card is drawn from ACCEPTED values: "old" is what was approved, a parameter the agent
 *    moved is its own row, approving approves exactly the rows shown, and a card whose contents
 *    changed while it was open is refused and redrawn (propose, import_reference, adopt);
 *  - the Release button only for a session of the part's own worktree, and a card raised with no
 *    turn running leaves the session's status alone;
 *  - the Released badge needs the WHOLE script sha; file-browser litter does not remove it;
 *  - replacing a reference is said as such on the card;
 *  - dimensions are positive and bounded, one open dimensions card per part per session;
 *  - per-part timer state is dropped when a part's process stops.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { cadTools } from "../../src/agent/cad-tools";
import { AccountStore } from "../../src/auth/accounts";
import { MOVED_WITHOUT_APPROVAL } from "../../src/cadwork/gate";
import { repoIdentity } from "../../src/cadwork/locks";
import { partRef } from "../../src/cadwork/partfolder";
import { MANIFEST, releaseKey } from "../../src/cadwork/release";
import { dispatch } from "../../src/server/dispatch";
import { ConnectionRegistry } from "../../src/server/registry";
import { DIMENSIONS_CARD_OPEN, UNAPPROVED_PARAMETER } from "../../src/session/cadwork-service";
import { REFERENCE_NOT_COVERED } from "../../src/cadwork/refresh";
import { importFeatureName } from "../../src/cadwork/refs";
import { Supervisor } from "../../src/session/supervisor";
import { PLATE_EXPECTATIONS, RULES, buildPlate, callable, cleanupTemp, fakeCadSession, modelPlate, stopServices, tempRepo, until, writeRules, type ToolReply } from "../helpers/cad-work";
import { FAKE_SOLIDCRAFT } from "../helpers/fake-solidcraft";

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ["ANVIL_SOLIDCRAFT_CLI", "CLAUDE_CODE_OAUTH_TOKEN"]) saved[k] = process.env[k];
  process.env.ANVIL_SOLIDCRAFT_CLI = FAKE_SOLIDCRAFT;
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "sk-ant-oat-test-placeholder";
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const supervisors: Supervisor[] = [];
const stateDirs: string[] = [];
afterEach(async () => {
  await stopServices();
  for (const s of supervisors.splice(0)) await s.shutdown().catch(() => undefined);
  for (const d of stateDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  cleanupTemp();
});

const fake = { resolveCli: () => ({ path: FAKE_SOLIDCRAFT, source: "env" as const }) };
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
type X = Pick<Awaited<ReturnType<typeof buildPlate>>, "service" | "openCards">;
const row = (card: any, label: string) => card.rows.find((r: any) => r.label === label);

/** Run a tool call while playing the owner: each new card is answered by `answer`. */
async function asOwner(x: X, call: Promise<ToolReply>, answer: (card: any) => boolean | Record<string, number> = () => true) {
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
/** A STEP the fake reads back: one box body, and the B-rep entity a real STEP declares per solid. */
function stepFile(repo: string, rel: string, min: number[], max: number[], name = "block"): string {
  const abs = join(repo, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  const v = (max[0]! - min[0]!) * (max[1]! - min[1]!) * (max[2]! - min[2]!);
  writeFileSync(abs, `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#10 = MANIFOLD_SOLID_BREP('${name}', #11);\n/* fake-solidcraft ${JSON.stringify({ bodies: [{ name, volume: v, faces: 6, min, max }] })} */\nENDSEC;\nEND-ISO-10303-21;\n`);
  return abs;
}
const TIGHTER = { ...PLATE_EXPECTATIONS, tolerance: { length: 0.05 } };
const editJsonFile = (p: string, f: (doc: any) => void) => {
  const doc = JSON.parse(readFileSync(p, "utf8"));
  f(doc);
  writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
};

describe("A4 review: owner cards approve exactly what they show (decision 153)", () => {
  test("[A4] review: the agent sets L=120, then proposes only a tighter tolerance — the card's old numbers are the accepted ones, L is its own row; denied the gate still fails on L, approved it passes with L accepted by the owner", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    expect(x.gate.state).toBe("pass");
    expect((await x.tools.set_parameter!({ name: "L", expression: "120" })).isError).toBe(false);
    let g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.failing.join("\n")).toContain(MOVED_WITHOUT_APPROVAL);

    // Denied: nothing is approved — the L change included.
    const no = await asOwner(x, x.tools.propose_expectations!({ part: "plate", expectations: TIGHTER, reason: "tighter length tolerance" }), () => false);
    const card = no.shown[0];
    expect(card.kind).toBe("propose");
    // "Old" is the ACCEPTED numbers (L = 80), never the design's current values.
    expect(row(card, "Bounding box (mm)").old).toBe("L × W × T  (= 6 × 50 × 80)");
    expect(row(card, "Bounding box (mm)").new).toBe("L × W × T  (= 6 × 50 × 120)");
    expect(row(card, "Parameter L")).toEqual({ label: "Parameter L", old: "80", new: `120 (${UNAPPROVED_PARAMETER})`, unapproved: true });
    expect(card.rows.filter((r: any) => r.unapproved)).toHaveLength(1); // W and T did not move
    g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.failing.join("\n")).toContain("L 80 → 120");

    // Approved: exactly what the card showed — the tolerance AND L = 120 — is the owner's.
    const yes = await asOwner(x, x.tools.propose_expectations!({ part: "plate", expectations: TIGHTER, reason: "tighter length tolerance" }));
    expect(yes.reply.isError).toBe(false);
    expect(row(yes.shown[0], "Parameter L").new).toBe(`120 (${UNAPPROVED_PARAMETER})`);
    g = await x.check();
    expect(g.failing).toEqual([]);
    expect(g.state).toBe("pass");
    expect(g.approvedBy).toBe("owner");
    const lock = x.service.locks.findPart(repoIdentity(repo), "plate")!;
    expect(lock.declared).toMatchObject({ L: 120, W: 50, T: 6 });
    expect(lock.values!.bbox).toEqual([6, 50, 120]);
  });

  test("[A4] review: a propose card whose parameters change while it is open is refused on approval and redrawn showing the new value", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    const call = x.tools.propose_expectations!({ part: "plate", expectations: TIGHTER, reason: "tighter length tolerance" });
    await until(() => x.openCards().length === 1, "the propose card");
    const first = x.openCards()[0];
    expect(first.rows.some((r: any) => r.unapproved)).toBe(false); // nothing had moved yet
    // The agent moves L while the card is open; the owner then approves the card as drawn.
    expect((await x.tools.set_parameter!({ name: "L", expression: "130" })).isError).toBe(false);
    expect(x.service.respond(first.requestId, true)).toBe(true);
    expect(x.broadcasts.find((e) => e.type === "cad.expectations.resolved" && e.requestId === first.requestId)).toMatchObject({ approved: false, superseded: true });
    expect(x.service.locks.findPart(repoIdentity(repo), "plate")!.approvedBy).toBe("agent-initial"); // nothing approved
    // A fresh card, showing L's move.
    await until(() => x.openCards().length === 1 && x.openCards()[0].requestId !== first.requestId, "the redrawn card");
    const second = x.openCards()[0];
    expect(row(second, "Parameter L")).toMatchObject({ old: "80", new: `130 (${UNAPPROVED_PARAMETER})` });
    x.service.respond(second.requestId, true);
    expect((await call).isError).toBe(false);
    expect((await x.check()).state).toBe("pass");
    expect(x.service.locks.findPart(repoIdentity(repo), "plate")!.declared).toMatchObject({ L: 130, W: 50, T: 6 });
  });

  test("[A4] review: the agent sets L=120, then imports a clear reference — the card shows the accepted numbers and L as its own row; denied nothing is imported and the gate fails on L, approved it passes with L accepted", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    expect((await x.tools.set_parameter!({ name: "L", expression: "120" })).isError).toBe(false);
    stepFile(repo, ".anvil-downloads/block.step", [200, 0, 0], [210, 10, 10]); // clear of the plate
    const no = await asOwner(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/block.step" }), () => false);
    expect(no.reply.json).toMatchObject({ imported: false });
    const card = no.shown[0];
    expect(card.kind).toBe("propose");
    expect(row(card, "Bounding box (mm)").old).toBe("L × W × T  (= 6 × 50 × 80)");
    expect(row(card, "Parameter L")).toMatchObject({ old: "80", new: `120 (${UNAPPROVED_PARAMETER})`, unapproved: true });
    expect(json(x.partJson).refs ?? []).toEqual([]);
    expect((await x.check()).failing.join("\n")).toContain("L 80 → 120");

    const yes = await asOwner(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/block.step" }));
    expect(yes.reply.json).toMatchObject({ imported: true });
    const g = await x.check();
    expect(g.failing).toEqual([]);
    expect(g.state).toBe("pass");
    expect(g.approvedBy).toBe("owner");
    expect(x.service.locks.findPart(repoIdentity(repo), "plate")!.declared).toMatchObject({ L: 120, W: 50, T: 6 });
  });

  test("[A3] review: an adopt card drawn at L=80 (fresh state) is refused on approval after the agent set L=120 while it was open, and redrawn showing 120", async () => {
    const repo = tempRepo();
    const first = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    expect(first.gate.state).toBe("pass");
    await first.service.shutdown();
    // The same repo on a machine whose lock store has never seen it.
    const x = fakeCadSession(repo, fake, "sess_cad", { expectations: "manual" });
    await x.tools.open_part!({ part: "plate" });
    await x.tools.check_part!({ part: "plate" });
    await until(() => x.openCards().some((c) => c.kind === "adopt-expectations"), "the adopt card");
    for (const c of x.openCards().filter((c) => c.kind === "adopt-rules")) x.service.respond(c.requestId, true);
    const card = x.openCards().find((c) => c.kind === "adopt-expectations")!;
    expect(row(card, "Bounding box (mm)").new).toBe("L × W × T  (= 6 × 50 × 80)");
    const ref = partRef(repo, "plate");
    // The agent changes L; the owner's tap on the card as drawn lands in the same instant (inside
    // the change's queue slot, before any refresh could redraw the card).
    let answered: boolean | undefined;
    await x.manager.request(ref, {
      tool: "execute",
      args: { command: "parameters.change", params: { changes: { L: "120 mm" } } },
      kind: "mutate",
      afterWrite: () => void (answered = x.service.respond(card.requestId, true)),
    });
    expect(answered).toBe(true);
    expect(x.broadcasts.find((e) => e.type === "cad.expectations.resolved" && e.requestId === card.requestId)).toMatchObject({ approved: false, superseded: true });
    const lock = x.service.locks.findPart(repoIdentity(repo), "plate");
    expect(lock?.values).toBeUndefined(); // the 80 mm card approved nothing — and nothing at 120 either
    // Redrawn with what is there now.
    await until(() => x.openCards().some((c) => c.kind === "adopt-expectations" && c.requestId !== card.requestId), "the redrawn adopt card");
    const fresh = x.openCards().find((c) => c.kind === "adopt-expectations")!;
    expect(row(fresh, "Bounding box (mm)").new).toBe("L × W × T  (= 6 × 50 × 120)");
    x.service.respond(fresh.requestId, true);
    const g = (await x.tools.check_part!({ part: "plate" })).json;
    expect(g.state).toBe("pass");
    expect(x.service.locks.findPart(repoIdentity(repo), "plate")).toMatchObject({ approvedBy: "owner", declared: { L: 120, W: 50, T: 6 } });
  });

  test("[A3] review: an adopt card drawn with the agent's moved L lists it as its own row; approving accepts exactly that", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    expect((await x.tools.set_parameter!({ name: "L", expression: "120" })).isError).toBe(false);
    // part.json edited on disk (a tolerance): an adopt card, drawn while L is moved.
    const pj = json(x.partJson);
    pj.expectations.tolerance = { length: 0.05, volumeRel: 0.01 };
    writeFileSync(x.partJson, JSON.stringify(pj, null, 2) + "\n");
    await x.tools.check_part!({ part: "plate" });
    await until(() => x.openCards().some((c) => c.kind === "adopt-expectations"), "the adopt card");
    const card = x.openCards().find((c) => c.kind === "adopt-expectations")!;
    expect(row(card, "Parameter L")).toMatchObject({ old: "80", new: `120 (${UNAPPROVED_PARAMETER})`, unapproved: true });
    expect(row(card, "Bounding box (mm)").old).toBe("6 × 50 × 80"); // the accepted numbers
    x.service.respond(card.requestId, true);
    const g = (await x.tools.check_part!({ part: "plate" })).json;
    expect(g.state).toBe("pass");
    expect(x.service.locks.findPart(repoIdentity(repo), "plate")).toMatchObject({ approvedBy: "owner", declared: { L: 120, W: 50, T: 6 } });
  });

  test("[A4] review: replacing a reference says so on the card — old and new sha and body counts", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    stepFile(repo, ".anvil-downloads/block.step", [200, 0, 0], [210, 10, 10]);
    const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
    const one = await asOwner(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/block.step" }));
    expect(one.reply.json).toMatchObject({ imported: true });
    expect(row(one.shown[0], "Reference").new).toBe(`adds refs/block.step (sha ${sha(join(repo, ".anvil-downloads/block.step")).slice(0, 12)}, 1 body)`);
    const oldSha = sha(join(repo, "cad", "plate", "refs", "block.step"));
    stepFile(repo, ".anvil-downloads/block.step", [300, 0, 0], [310, 10, 10]);
    const newSha = sha(join(repo, ".anvil-downloads/block.step"));
    const two = await asOwner(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/block.step" }));
    expect(two.reply.json).toMatchObject({ imported: true, replaced: true });
    const card = two.shown[0];
    expect(row(card, "Reference")).toEqual({ label: "Reference", old: "refs/block.step", new: `Replaces refs/block.step: old sha ${oldSha.slice(0, 12)} → new sha ${newSha.slice(0, 12)}`, unapproved: true });
    expect(row(card, "Reference bodies")).toEqual({ label: "Reference bodies", old: "1 (block)", new: "1 (solids declared in the new file)" });
    expect(card.reason).toContain(`REPLACING the existing refs/block.step (sha256 ${oldSha.slice(0, 12)})`);
  });
});

describe("A4 re-review: an owner card's write re-checks its snapshot inside the part's queue (decision 204)", () => {
  const designJson = (repo: string) => json(join(repo, "cad", "plate", "design.json"));
  const imports = (repo: string) => designJson(repo).commands.filter((c: any) => c.command === "timeline.add" && c.params?.feature?.type === "import");
  /** The plate, with a hook that runs once inside the NEXT script write after `arm()` (i.e. inside a
   *  queued change — import_reference's import, while it holds the part's queue). */
  async function plateWithHook(repo: string) {
    let armed: (() => void) | undefined;
    const x = await buildPlate(repo, {
      cli: FAKE_SOLIDCRAFT,
      deps: {
        manager: {
          beforeScriptRename: () => {
            const f = armed;
            armed = undefined;
            f?.();
          },
        },
      },
    });
    return { ...x, arm: (f: () => void) => void (armed = f) };
  }

  test("[A4] re-review: the card shows Process fdm-0.4; part.json is rewritten to cnc-3axis while the approved import runs — nothing is recorded, the import is rolled back in full (feature, refs/, part.json), redo cannot bring it back, and the redrawn card shows cnc-3axis", async () => {
    const repo = tempRepo();
    const x = await plateWithHook(repo);
    expect(x.gate.state).toBe("pass");
    const lockBefore = x.service.locks.findPart(repoIdentity(repo), "plate")!;
    const scriptBefore = readFileSync(join(repo, "cad", "plate", "design.json"), "utf8");
    stepFile(repo, ".anvil-downloads/block.step", [200, 0, 0], [210, 10, 10]);
    // Inside the import (the part's queue held), something rewrites part.json — what Bash can do.
    x.arm(() => editJsonFile(x.partJson, (doc) => void (doc.process = "cnc-3axis")));
    let n = 0;
    const r = await asOwner(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/block.step" }), () => n++ === 0); // approve the first card only
    expect(r.shown).toHaveLength(2);
    expect(row(r.shown[0], "Process")).toMatchObject({ old: "fdm-0.4", new: "fdm-0.4" });
    // Redrawn from what is there now: the process the owner would be approving is said.
    expect(row(r.shown[1], "Process")).toMatchObject({ old: "cnc-3axis", new: "cnc-3axis" });
    expect(row(r.shown[1], "Reference").new).toMatch(/^adds refs\/block\.step/); // rolled back: still an add, not a replace
    expect(r.reply.json).toMatchObject({ imported: false });
    // Nothing was recorded and nothing of the import is left.
    expect(x.service.locks.findPart(repoIdentity(repo), "plate")).toEqual(lockBefore);
    const pj = json(x.partJson);
    expect(pj.process).toBe("cnc-3axis"); // the edit itself is the editor's, not approved
    expect(pj.refs ?? []).toEqual([]);
    expect(pj.expectations.noInterferenceWith ?? []).toEqual([]);
    expect(existsSync(join(repo, "cad", "plate", "refs", "block.step"))).toBe(false);
    expect(imports(repo)).toEqual([]);
    expect(readFileSync(join(repo, "cad", "plate", "design.json"), "utf8")).toBe(scriptBefore);
    const redo = await x.tools.redo!({});
    expect(redo.isError).toBe(true);
    expect(redo.text).toContain("nothing to redo");
    expect(imports(repo)).toEqual([]);
    // The gate does not pass on the unapproved process.
    const g = await x.check();
    expect(g.state).not.toBe("pass");
    expect(g.failing.join("\n")).not.toContain("interference");
  });

  test("[A4] re-review: a parameter change queued ahead of the approved import refuses the approval BEFORE anything is imported; the card is redrawn with the move, and denied nothing is left in the design", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    stepFile(repo, ".anvil-downloads/block.step", [200, 0, 0], [210, 10, 10]);
    const ref = partRef(repo, "plate");
    const call = x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/block.step" });
    await until(() => x.openCards().length === 1, "the import card");
    const first = x.openCards()[0];
    // The agent's change is already in the part's queue when the owner taps Approve.
    const change = x.manager.request(ref, { tool: "execute", args: { command: "parameters.change", params: { changes: { L: "130 mm" } } }, kind: "mutate" });
    expect(x.service.respond(first.requestId, true)).toBe(true);
    await change;
    await until(() => x.openCards().some((c) => c.requestId !== first.requestId), "the redrawn card");
    const second = x.openCards()[0];
    expect(row(second, "Parameter L")).toMatchObject({ old: "80", new: `130 (${UNAPPROVED_PARAMETER})`, unapproved: true });
    expect(row(second, "Reference").new).toMatch(/^adds refs\/block\.step/);
    // While the redrawn card is open, nothing was imported.
    expect(existsSync(join(repo, "cad", "plate", "refs", "block.step"))).toBe(false);
    expect(imports(repo)).toEqual([]);
    x.service.respond(second.requestId, false);
    expect((await call).json).toMatchObject({ imported: false });
    expect(imports(repo)).toEqual([]);
    expect(json(x.partJson).refs ?? []).toEqual([]);
    const g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.failing.join("\n")).toContain("L 80 → 130");
    expect(g.failing.join("\n")).not.toContain(REFERENCE_NOT_COVERED);
  });

  test("[A4] re-review: an import that fails after it began (SolidCraft reports no bodies) is rolled back and the tool says so truthfully", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    const lockBefore = x.service.locks.findPart(repoIdentity(repo), "plate")!;
    // A STEP the fake imports with no solids in it.
    const abs = join(repo, ".anvil-downloads", "empty.step");
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n/* fake-solidcraft ${JSON.stringify({ bodies: [] })} */\nENDSEC;\nEND-ISO-10303-21;\n`);
    const r = await asOwner(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/empty.step" }));
    expect(r.reply.isError).toBe(true);
    expect(r.reply.text).toContain("reported no bodies");
    expect(r.reply.text).toContain("Nothing was imported: the design, refs/ and part.json are as they were.");
    expect(existsSync(join(repo, "cad", "plate", "refs", "empty.step"))).toBe(false);
    expect(imports(repo)).toEqual([]);
    expect(json(x.partJson).refs ?? []).toEqual([]);
    expect(x.service.locks.findPart(repoIdentity(repo), "plate")).toEqual(lockBefore);
    expect((await x.check()).state).toBe("pass");
  });

  test("[A4] re-review: the replace rows are worked out on every round — a refs/ file that appears while the card is open makes the redrawn card say Replaces", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    stepFile(repo, ".anvil-downloads/block.step", [200, 0, 0], [210, 10, 10]);
    const call = x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/block.step" });
    await until(() => x.openCards().length === 1, "the import card");
    const first = x.openCards()[0];
    expect(row(first, "Reference").new).toMatch(/^adds /);
    expect(first.reason).not.toContain("REPLACING");
    const planted = stepFile(repo, "cad/plate/refs/block.step", [300, 0, 0], [310, 10, 10]);
    const plantedSha = createHash("sha256").update(readFileSync(planted)).digest("hex");
    x.service.respond(first.requestId, true);
    await until(() => x.openCards().some((c) => c.requestId !== first.requestId), "the redrawn card");
    const second = x.openCards()[0];
    expect(row(second, "Reference").new).toContain(`Replaces refs/block.step: old sha ${plantedSha.slice(0, 12)}`);
    expect(second.reason).toContain(`REPLACING the existing refs/block.step (sha256 ${plantedSha.slice(0, 12)})`);
    x.service.respond(second.requestId, false);
    expect((await call).json).toMatchObject({ imported: false });
  });

  test("[A4] re-review: the gate fails closed — a reference in the design that no must-not-touch rule names (an import feature, a refs record in part.json) fails with 'reference <name> is not covered'", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    const ref = partRef(repo, "plate");
    const step = stepFile(repo, "cad/plate/refs/motor.step", [200, 0, 0], [210, 10, 10], "motor");
    // The daemon's import route, used past import_reference (what the vetoed bug left behind).
    const ins = await x.manager.request(ref, { tool: "execute", args: { command: "file.insert_step", params: { path: step, name: importFeatureName("motor.step") } }, kind: "mutate" });
    expect(ins.result.isError).toBe(false);
    let g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.failing.join("\n")).toContain(`reference motor.step ${REFERENCE_NOT_COVERED}`);
    // A refs record in part.json with no rule fails the same way (refs are outside the locked block).
    await x.tools.undo!({});
    const pj = json(x.partJson);
    pj.refs = [{ name: "pump.step", source: "refs/pump.step", sha256: "0".repeat(64), bodies: ["pump"], at: new Date().toISOString() }];
    writeFileSync(x.partJson, JSON.stringify(pj, null, 2) + "\n");
    g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.failing.join("\n")).toContain(`reference pump.step ${REFERENCE_NOT_COVERED}`);
  });

  test("[A4] re-review: an adopt-ownerParams card that also approves a parameter the agent moved shows the numbers it leads to (accepted → new); approving records exactly those", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    expect((await x.tools.set_parameter!({ name: "L", expression: "120" })).isError).toBe(false);
    const pj = json(x.partJson);
    pj.ownerParams = { L: 120 };
    writeFileSync(x.partJson, JSON.stringify(pj, null, 2) + "\n");
    await x.check();
    await until(() => x.openCards().some((c) => c.kind === "adopt-ownerParams"), "the dimensions card");
    const card = x.openCards().find((c) => c.kind === "adopt-ownerParams")!;
    expect(row(card, "Parameter L")).toMatchObject({ old: "80", new: `120 (${UNAPPROVED_PARAMETER})`, unapproved: true });
    expect(row(card, "Bounding box (mm)")).toEqual({ label: "Bounding box (mm)", old: "L × W × T  (= 6 × 50 × 80)", new: "L × W × T  (= 6 × 50 × 120)" });
    expect(row(card, "Volume (mm³)").old).toContain("(= 23335.167)");
    expect(row(card, "Volume (mm³)").new).toContain("(= 35335.167)");
    expect(row(card, "L")).toEqual({ label: "L", new: "120" });
    x.service.respond(card.requestId, true);
    await until(() => x.broadcasts.some((e) => e.type === "cad.expectations.resolved" && e.requestId === card.requestId), "the answer");
    const lock = x.service.locks.findPart(repoIdentity(repo), "plate")!;
    expect(lock).toMatchObject({ ownerParams: { L: 120 }, declared: { L: 120, W: 50, T: 6 } });
    expect(lock.values!.bbox).toEqual([6, 50, 120]);
    expect((await x.check()).state).toBe("pass");
  });

  test("[A4] re-review: a parameter nobody approved and no expected number uses is never approved silently — it stays out of `declared`", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    const ref = partRef(repo, "plate");
    const add = await x.manager.request(ref, { tool: "execute", args: { command: "parameters.add", params: { name: "Z", expression: "7 mm" } }, kind: "mutate" });
    expect(add.result.isError).toBe(false);
    const r = await asOwner(x, x.tools.propose_expectations!({ part: "plate", expectations: TIGHTER, reason: "tighter length tolerance" }));
    expect(r.reply.isError).toBe(false);
    expect(r.shown[0].rows.some((x: any) => String(x.label).includes("Z"))).toBe(false); // not a row: it is not approved
    const lock = x.service.locks.findPart(repoIdentity(repo), "plate")!;
    expect(lock.declared).toEqual({ L: 80, W: 50, T: 6 });
    expect((await x.check()).state).toBe("pass");
  });
});

describe("A4 review: the Release button and session status", () => {
  /** A real Supervisor with cad-work on, two sessions on two repos; the plate built on the first. */
  async function twoRepos() {
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "anvil-cad-a4r-state-")));
    stateDirs.push(stateDir);
    const registry = new ConnectionRegistry();
    const broadcasts: any[] = [];
    const toAll = registry.toAll.bind(registry);
    registry.toAll = ((ev: any) => {
      broadcasts.push(ev);
      return toAll(ev);
    }) as typeof registry.toAll;
    const accounts = new AccountStore(stateDir);
    accounts.add("test", "sk-ant-oat01-testtesttest-0000");
    const sup = new Supervisor({ stateDir, accounts, envFile: join(stateDir, "env"), features: ["cad-work"], sessionQueryFn: (() => { throw new Error("no model query in this test"); }) as any }, registry);
    supervisors.push(sup);
    const create = (cwd: string) => sup.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd } as any);
    const repo = tempRepo();
    const other = tempRepo();
    writeRules(repo, RULES);
    const a = await create(repo);
    const b = await create(other);
    const tools = callable(cadTools(sup.cadwork.toolDeps(a.id, repo)) as any);
    await modelPlate(tools);
    await tools.check_part!({ part: "plate" });
    const open = () => {
      const done = new Set(broadcasts.filter((e) => e.type === "cad.expectations.resolved").map((e) => e.requestId));
      return broadcasts.filter((e) => e.type === "cad.expectations.request" && !done.has(e.requestId));
    };
    for (const c of open()) sup.respondCadExpectations(c.requestId, true);
    expect((await tools.check_part!({ part: "plate" })).json.state).toBe("pass");
    const sent: any[] = [];
    const conn = { id: "conn_test", attached: new Set<string>() };
    const send = async (cmd: Record<string, unknown>) => {
      await dispatch(conn, JSON.stringify({ v: PROTOCOL_VERSION, ts: "t", ...cmd }), (ev) => void sent.push(ev), { supervisor: sup, registry, push: undefined as any });
      await until(() => sent.some((e) => e.cid === cmd.cid), `the reply to ${String(cmd.cid)}`, 20_000);
      return sent.filter((e) => e.cid === cmd.cid);
    };
    return { sup, repo, other, a, b, open, send, sent };
  }

  test("[A4] review: cad.release.request is refused for a session of another worktree, and a release card raised with no turn running leaves the session's status alone", async () => {
    const x = await twoRepos();
    const statusOf = (id: string) => (x.sup as any).sessions.get(id).data.status;
    const bBefore = statusOf(x.b.id);
    // Session b works in another repo: it cannot be the one the card is raised in.
    const wrong = await x.send({ type: "cad.release.request", cid: "r1", cwd: x.repo, part: "plate", sessionId: x.b.id });
    expect(wrong.at(-1)).toMatchObject({ type: "command.error" });
    expect(wrong.at(-1).message).toContain("does not work in");
    expect(x.open()).toEqual([]);
    expect(statusOf(x.b.id)).toBe(bBefore);
    // Session a is the part's own: the card is raised — and a's status (no turn) does not change.
    const aBefore = statusOf(x.a.id);
    expect(aBefore).not.toBe("awaiting_permission");
    await x.send({ type: "cad.release.request", cid: "r2", cwd: x.repo, part: "plate", sessionId: x.a.id });
    await until(() => x.open().some((c) => c.kind === "release"), "the release card");
    expect(statusOf(x.a.id)).toBe(aBefore);
    x.sup.respondCadExpectations(x.open().find((c) => c.kind === "release")!.requestId, false);
    await new Promise((r) => setTimeout(r, 20));
    expect(statusOf(x.a.id)).toBe(aBefore);
    expect(statusOf(x.b.id)).toBe(bBefore);
  });

  test("[A4] review: a tool's owner card shows awaiting_permission only while the session's turn is running, and gives it back after", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    const s = x.session as any;
    const seen: string[] = [];
    s.setStatus = (st: string) => {
      seen.push(st);
      s.data.status = st;
    };
    // Idle (no turn): the card leaves the status alone.
    s.data.status = "idle";
    await asOwner(x, x.tools.release_part!({ part: "plate" }), () => false);
    expect(seen).toEqual([]);
    expect(s.data.status).toBe("idle");
    // Mid-turn: waiting on the owner while the card is up, back to running_tool after.
    s.data.status = "running_tool";
    const call = x.tools.release_part!({ part: "plate" });
    await until(() => x.openCards().some((c) => c.kind === "release"), "the release card");
    expect(s.data.status).toBe("awaiting_permission");
    x.service.respond(x.openCards().find((c) => c.kind === "release")!.requestId, false);
    await call;
    expect(s.data.status).toBe("running_tool");
  });
});

describe("A4 review: the Released badge", () => {
  test("[A4] review: a verifying pack whose manifest names a different script with the same 7-character prefix does not get the Released badge; file-browser litter in the pack does not remove it", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    const r = await asOwner(x, x.tools.release_part!({ part: "plate" }));
    expect(r.reply.isError).toBe(false);
    const dir = join(repo, r.reply.json.folder);
    await x.check();
    expect(x.design("plate").released).toBeDefined();
    // Finder / Windows litter: ignored.
    for (const f of [".DS_Store", "._plate.step", "Thumbs.db"]) writeFileSync(join(dir, f), "litter");
    expect(x.service.verifyReleaseDir(dir)).toMatchObject({ ok: true });
    await x.check();
    expect(x.design("plate").released).toBeDefined();
    // A manifest, correctly signed with this machine's key, for ANOTHER script sharing the prefix.
    const m = json(join(dir, MANIFEST));
    const sha: string = m.scriptSha;
    const other = sha.slice(0, 7) + [...sha.slice(7)].map((c) => (c === "0" ? "1" : "0")).join("");
    expect(other).not.toBe(sha);
    const body = { part: m.part, scriptSha: other, solidcraft: m.solidcraft, createdAt: m.createdAt, files: m.files };
    const canonical = JSON.stringify({ part: body.part, scriptSha: body.scriptSha, solidcraft: body.solidcraft, createdAt: body.createdAt, files: Object.keys(body.files).sort().map((k) => [k, body.files[k]]) });
    const key = releaseKey((x.service as any).stateDir);
    writeFileSync(join(dir, MANIFEST), JSON.stringify({ schema: 1, ...body, hmac: createHmac("sha256", key).update(canonical).digest("hex") }, null, 2));
    expect(x.service.verifyReleaseDir(dir)).toMatchObject({ ok: true }); // a valid pack — of the other script
    await x.check();
    expect(x.design("plate").released).toBeUndefined();
  });
});

describe("A4 review: dimensions", () => {
  async function concept() {
    const repo = tempRepo();
    writeRules(repo, RULES);
    const x = fakeCadSession(repo, fake, "sess_cad", { expectations: "manual" });
    await x.tools.open_part!({ part: "bracket", concept: true, process: "fdm-0.4" });
    await x.tools.batch!({ commands: [{ command: "parameters.add", params: { name: "L", expression: "60 mm" } }, { command: "solid.box", params: { length: "L", width: 20, height: 5, name: "Bracket" } }] });
    return x;
  }

  test("[A4] review: non-positive, non-finite and over-1e6 mm dimensions are refused by the daemon and the card stays open; a second request_dimensions for the part is refused while one is open", async () => {
    const x = await concept();
    const bad = await x.tools.request_dimensions!({ part: "bracket", proposed: [{ name: "L", value: -60, unit: "mm" }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("above 0");
    const call = x.tools.request_dimensions!({ part: "bracket", proposed: [{ name: "L", value: 60, unit: "mm" }] });
    await until(() => x.openCards().some((c) => c.kind === "dimensions"), "the dimensions card");
    const again = await x.tools.request_dimensions!({ part: "bracket", proposed: [{ name: "L", value: 70, unit: "mm" }] });
    expect(again.isError).toBe(true);
    expect(again.text).toContain(DIMENSIONS_CARD_OPEN);
    expect(x.openCards().filter((c) => c.kind === "dimensions")).toHaveLength(1);
    const card = x.openCards().find((c) => c.kind === "dimensions")!;
    for (const v of [0, -1, 1e6 + 1, 1e308, Number.POSITIVE_INFINITY]) {
      expect(() => x.service.respond(card.requestId, true, { L: v })).toThrow();
      expect(x.openCards().some((c) => c.requestId === card.requestId)).toBe(true); // still open
    }
    expect(x.service.respond(card.requestId, true, { L: 1e6 })).toBe(true);
    expect((await call).json.ownerParams).toEqual({ L: 1e6 });
  });
});

describe("A4 review: per-part timer state", () => {
  test("[A4] review: when a part's process stops, its busy notice and cad.design coalescer state are dropped (a pending trailing emit goes out first)", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    const ref = partRef(repo, "plate");
    const svc = x.service as any;
    expect(svc.emitState.has(ref.key)).toBe(true);
    // A trailing emit armed for the part (as a burst would leave it), then the process stops.
    const st = svc.emitState.get(ref.key);
    st.timer = setTimeout(() => undefined, 60_000);
    const before = x.broadcasts.filter((e) => e.type === "cad.design").length;
    await x.manager.shutdown();
    await until(() => !svc.emitState.has(ref.key), "the coalescer state to be dropped");
    expect(svc.busyTimers.has(ref.key)).toBe(false);
    expect(svc.busyEpoch.has(ref.key)).toBe(false);
    expect(x.broadcasts.filter((e) => e.type === "cad.design").length).toBe(before + 1); // the pending emit, flushed
  });
});

describe("A4 re-review: a denied adopt card", () => {
  test("[A4] re-review: denying an adopt-expectations card does not redraw the same card — a client that keeps denying sees one card, not a stream; a change to what it would show, or the owner's Rebuild, asks again", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    expect(x.gate.state).toBe("pass");
    const adoptCards = () => x.broadcasts.filter((e) => e.type === "cad.expectations.request" && e.kind === "adopt-expectations");
    // Expectations edited outside the approval flow: one adopt card.
    editJsonFile(x.partJson, (d) => void (d.expectations.holes = []));
    let g = await x.check();
    expect(g.needsAdoption).toBe("expectations");
    expect(adoptCards()).toHaveLength(1);
    // A client that denies whatever it is shown, as fast as it can.
    for (let i = 0; i < 20; i++) {
      for (const c of x.openCards()) x.service.respond(c.requestId, false);
      g = await x.check();
    }
    expect(adoptCards()).toHaveLength(1);
    expect(x.openCards()).toEqual([]);
    expect(g.state).toBe("unverified"); // denied is not approved: the part stays unverified
    expect(g.needsAdoption).toBe("expectations");
    // What the card would show changes: it is asked again (once).
    editJsonFile(x.partJson, (d) => void (d.process = "cnc-3axis"));
    await x.check();
    expect(adoptCards()).toHaveLength(2);
    x.service.respond(x.openCards()[0].requestId, false);
    await x.check();
    expect(adoptCards()).toHaveLength(2);
    // The owner's Rebuild on the part card asks again, and approving then adopts.
    await x.service.refreshDesign(repo, "plate");
    await x.check();
    expect(adoptCards()).toHaveLength(3);
    x.service.respond(x.openCards()[0].requestId, true);
    await until(() => x.openCards().length === 0, "the approval");
    expect((await x.check()).needsAdoption).toBeUndefined();
  });
});
