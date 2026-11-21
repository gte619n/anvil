/**
 * [A2] The holes the adversarial review of Phase A2 found, each as the reviewer's repro, now failing
 * to get through (agent-cad-and-browser spec §4.5, §6, §7 "Gamed"). Real service, manager, refresh
 * and lock store through the agent's own tools; SolidCraft is the fake (the two repros that need the
 * real kernel are also in test/real/cad-a2.test.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MOVED_WITHOUT_APPROVAL } from "../../src/cadwork/gate";
import { repoIdentity, repoKey } from "../../src/cadwork/locks";
import { partRef } from "../../src/cadwork/partfolder";
import { INITIAL_AFTER_GEOMETRY, parseDeclared } from "../../src/session/cadwork-service";
import { BOX, PLATE_EXPECTATIONS, PLATE_PARAMETERS, RULES, approveCards, buildPlate, cleanupTemp, fakeCadSession, stopServices, tempRepo, until, writeDesign, writeRules } from "../helpers/cad-work";
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

const CLI = FAKE_SOLIDCRAFT;
const fake = { resolveCli: () => ({ path: CLI, source: "env" as const }) };
const manual = (repo: string, sessionData: Record<string, unknown> = {}, id = "sess_cad") => fakeCadSession(repo, fake, id, { expectations: "manual", sessionData });
const text = (p: string) => readFileSync(p, "utf8");
const partJson = (repo: string, part = "plate") => join(repo, "cad", part, "part.json");
const lockOf = (x: { service: any }, repo: string, part = "plate") => x.service.locks.findPart(repoIdentity(repo), part);
const editJson = (path: string, fn: (doc: any) => void) => {
  const doc = JSON.parse(text(path));
  fn(doc);
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
};

describe("Phase A2 review", () => {
  test("[A2] review 1: expectations cannot be set after measuring through deferred pinning — the numbers are fixed at record time from declared parameters, and undeclared formulas are refused", async () => {
    const repo = tempRepo();
    writeRules(repo, RULES);
    const x = manual(repo);
    await x.tools.open_part!({ part: "box" });
    const formulas = { bbox: ["A", "B", "C"], volume: "V", bodies: 1, holes: [] };
    // The reviewer's first step: formulas over names that do not exist, to be filled in after measuring.
    const blind = await x.tools.record_expectations!({ part: "box", process: "fdm-0.4", parameters: {}, expectations: formulas });
    expect(blind.isError).toBe(true);
    expect(blind.text).toContain("Every parameter a formula uses must be listed in `parameters`");
    const missing = await x.tools.record_expectations!({ part: "box", process: "fdm-0.4", expectations: formulas });
    expect(missing.isError).toBe(true); // the argument is required
    const partial = await x.tools.record_expectations!({ part: "box", process: "fdm-0.4", parameters: { A: 1, B: 1, C: 1 }, expectations: formulas });
    expect(partial.isError).toBe(true);
    expect(partial.text).toContain("volume");
    for (const bad of [{ A: "B + 1" }, { A: "measure()" }, { "A B": 1 }, { A: Number.NaN }, { pi: 3 }]) {
      expect((await x.tools.record_expectations!({ part: "box", process: "fdm-0.4", parameters: { B: 1, C: 1, V: 1, ...bad }, expectations: formulas })).isError).toBe(true);
    }
    expect(existsSync(partJson(repo, "box"))).toBe(false);
    expect(lockOf(x, repo, "box")).toBeUndefined();
    expect(x.manager.status(partRef(repo, "box"))!.params).toEqual([]); // nothing was created by the refused calls

    // Declared honestly it records — and the numbers are fixed NOW, before anything is modeled.
    const ok = await x.tools.record_expectations!({ part: "box", process: "fdm-0.4", parameters: { A: 1, B: 2, C: "3 mm", V: 6 }, expectations: formulas });
    expect(ok.isError).toBe(false);
    expect(ok.json).toMatchObject({ recorded: true, approved_by: "agent-initial", parameters_created: ["A", "B", "C", "V"] });
    const lock = lockOf(x, repo, "box");
    expect(lock.values).toEqual({ bbox: [1, 2, 3], volume: 6, bodies: 1, holes: [] });
    expect(lock.declared).toEqual({ A: 1, B: 2, C: 3, V: 6 });
    // The daemon created the declared parameters in the design itself, and wrote the script.
    expect(x.manager.status(partRef(repo, "box"))!.params.map((p: any) => [p.name, p.value])).toEqual([["A", 1], ["B", 2], ["C", 3], ["V", 6]]);
    expect(JSON.parse(text(join(repo, "cad", "box", "design.json"))).commands.filter((c: any) => c.command === "parameters.add").map((c: any) => c.params.name)).toEqual(["A", "B", "C", "V"]);

    // Now the attack: build something else, measure it, and move the parameters to the measurement.
    expect((await x.tools.execute!({ command: "solid.box", params: { length: 13, width: 17, height: 19, name: "Blob" } })).isError).toBe(false);
    const measured = (await x.tools.measure!({ summary: true })).json.total.volume_mm3;
    expect(measured).toBe(13 * 17 * 19);
    expect((await x.tools.execute!({ command: "parameters.add", params: { name: "A", expression: "13" } })).isError).toBe(true); // they exist already
    for (const [name, v] of [["A", 13], ["B", 17], ["C", 19], ["V", measured]] as const) expect((await x.tools.set_parameter!({ name, expression: String(v) })).isError).toBe(false);
    await x.tools.check_part!({ part: "box" });
    approveCards(x); // the owner adopts the rules file (nothing else is on offer)
    const g = (await x.tools.check_part!({ part: "box" })).json;
    expect(g.state).toBe("fail"); // NOT pass
    expect(g.failing.join("\n")).toContain(MOVED_WITHOUT_APPROVAL);
    expect(g.checks.find((c: any) => c.id === "volume")).toMatchObject({ expected: 6, measured, ok: false }); // still checked against what was recorded
    expect(lockOf(x, repo, "box").values.volume).toBe(6);
    expect(lockOf(x, repo, "box").approvedBy).toBe("agent-initial");
    expect(x.openCards()).toEqual([]);
    // And a second record_expectations (the other way to "fix" it) is refused.
    expect((await x.tools.record_expectations!({ part: "box", process: "fdm-0.4", parameters: {}, expectations: { bbox: [13, 17, 19], volume: measured, bodies: 1, holes: [] } })).text).toContain("already has expectations");
  });

  test("[A2] review 1: a lock entry with no accepted numbers is invalid (needs adoption, 'no accepted value'), never pinned later; a proposal whose formulas do not evaluate is refused before any card", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: CLI });
    expect(x.gate.state).toBe("pass");
    // The store as a pre-fix daemon (or a tamperer) would leave it: the right hash, no numbers.
    const lock = lockOf(x, repo);
    const { values: _gone, ...bare } = lock;
    x.service.locks.putPart(bare);
    const g = await x.check();
    expect(g.state).toBe("unverified");
    expect(g.needsAdoption).toBe("expectations");
    expect(g.failing.join("\n")).toContain("no accepted value");
    expect(g.failing.join("\n")).toContain("holds no accepted numbers");
    expect(g.checks.some((c: any) => c.id === "volume")).toBe(false); // nothing to compare against: not "the formulas as they are now"
    expect(lockOf(x, repo).values).toBeUndefined(); // the refresh did not pin anything
    // The owner's adoption fixes the numbers, at approval.
    expect(x.openCards().map((c: any) => c.kind)).toEqual(["adopt-expectations"]);
    approveCards(x);
    expect((await x.check()).state).toBe("pass");
    expect(lockOf(x, repo)).toMatchObject({ approvedBy: "owner", values: { bbox: [6, 50, 80] } });

    // propose_expectations: formulas that do not evaluate never reach the owner.
    const n = x.broadcasts.filter((e: any) => e.type === "cad.expectations.request").length;
    const bad = await x.tools.propose_expectations!({ part: "plate", expectations: { ...PLATE_EXPECTATIONS, volume: "L*W*Height" }, reason: "typo" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Height");
    expect(x.broadcasts.filter((e: any) => e.type === "cad.expectations.request")).toHaveLength(n);
  });

  test("[A2] review 2: a hand-written design.json does not open the agent-initial route — record_expectations becomes an owner card, is denied unattended, and writes nothing on Deny", async () => {
    const repo = tempRepo();
    writeRules(repo, RULES);
    // The reviewer's repro: write the design by hand, replay it, measure, then "record" what was measured.
    writeDesign(repo, "plate", [BOX("Blob", 10)]);
    const x = manual(repo);
    const opened = await x.tools.open_part!({ part: "plate" });
    expect(opened.json).toMatchObject({ has_design: true, modeling: "refused until expectations are recorded" });
    // Inspection of a part with a design and no expectations still works.
    const measured = (await x.tools.measure!({ summary: true })).json.total.volume_mm3;
    expect(measured).toBe(1000);
    expect((await x.tools.inspect_design!({})).isError).toBe(false);
    expect((await x.tools.execute!(BOX("More", 5))).isError).toBe(true); // modeling is still refused

    const numbers = { bbox: [10, 10, 10], volume: measured, bodies: 1, holes: [] };
    const pending = x.tools.record_expectations!({ part: "plate", process: "fdm-0.4", parameters: {}, expectations: numbers });
    await until(() => x.openCards().length === 1, "the owner card");
    const card = x.openCards()[0];
    expect(card).toMatchObject({ kind: "initial", part: "plate", sessionId: "sess_cad", note: INITIAL_AFTER_GEOMETRY });
    expect(card.rows.map((r: any) => r.label)).toEqual(expect.arrayContaining(["Process", "Status", "Volume (mm³)", "Bounding box (mm)"]));
    expect(card.rows.find((r: any) => r.label === "Volume (mm³)").new).toBe("1000");
    expect(existsSync(partJson(repo))).toBe(false); // nothing yet
    expect(lockOf(x, repo)).toBeUndefined();
    x.service.respond(card.requestId, false);
    const denied = await pending;
    expect(denied.isError).toBe(false);
    expect(denied.json).toMatchObject({ recorded: false });
    expect(existsSync(partJson(repo))).toBe(false);
    expect(lockOf(x, repo)).toBeUndefined();
    expect((await x.tools.check_part!({ part: "plate" })).json.state).toBe("unverified");

    // Approved by the owner, the numbers are the OWNER's, not agent-initial.
    const again = x.tools.record_expectations!({ part: "plate", process: "fdm-0.4", parameters: {}, expectations: numbers });
    await until(() => x.openCards().some((c: any) => c.kind === "initial"), "the second card");
    x.service.respond(x.openCards().find((c: any) => c.kind === "initial").requestId, true);
    expect((await again).json).toMatchObject({ recorded: true, approved_by: "owner" });
    expect(lockOf(x, repo)).toMatchObject({ approvedBy: "owner", values: { volume: 1000 } });

    // A part built LIVE with a stray parameter, no design.json yet at first: also not pristine.
    await x.tools.open_part!({ part: "other" });
    const other = partRef(repo, "other");
    await x.manager.request(other, { tool: "execute", args: { command: "parameters.add", params: { name: "Z", expression: "1" } }, kind: "mutate" });
    const second = x.tools.record_expectations!({ part: "other", process: "fdm-0.4", parameters: {}, expectations: numbers });
    await until(() => x.openCards().some((c: any) => c.part === "other" && c.kind === "initial"), "a card for the non-empty part");
    x.service.respond(x.openCards().find((c: any) => c.part === "other" && c.kind === "initial").requestId, false);
    expect((await second).json).toMatchObject({ recorded: false });

    // Unattended: no card, a plain refusal.
    const repo2 = tempRepo();
    writeDesign(repo2, "plate", [BOX("Blob", 10)]);
    const auto = manual(repo2, { workUnitRole: "builder" }, "sess_auto");
    await auto.tools.open_part!({ part: "plate" });
    const refused = await auto.tools.record_expectations!({ part: "plate", process: "fdm-0.4", parameters: {}, expectations: numbers });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("unattended");
    expect(auto.openCards()).toEqual([]);
    expect(existsSync(partJson(repo2))).toBe(false);
  });

  test("[A2] review 4: a propose approval is for what the card showed — a process changed on disk while it was open is not laundered; every card shows process and status", async () => {
    const repo = tempRepo();
    writeRules(repo, { ...RULES, processes: [...RULES.processes, { id: "fdm-loose", kind: "fdm", envelope: [1000, 1000, 1000] }] });
    const x = await buildPlate(repo, { cli: CLI });
    expect(x.gate.state).toBe("pass");
    const before = text(x.partJson);
    const pending = x.tools.propose_expectations!({ part: "plate", expectations: PLATE_EXPECTATIONS, reason: "no change, really" });
    await until(() => x.openCards().length === 1, "the card");
    const first = x.openCards()[0];
    expect(first.rows.find((r: any) => r.label === "Process")).toMatchObject({ old: "fdm-0.4", new: "fdm-0.4" });
    expect(first.rows.find((r: any) => r.label === "Status")).toMatchObject({ new: "dimensioned" });
    // While the owner is looking at it, the process is swapped on disk (as Bash could).
    editJson(x.partJson, (doc) => void (doc.process = "fdm-loose"));
    x.service.respond(first.requestId, true);
    // Not written: a FRESH card is raised, and it shows the process that is there now.
    await until(() => x.openCards().length === 1 && x.openCards()[0].requestId !== first.requestId, "a fresh card");
    const second = x.openCards()[0];
    expect(second.rows.find((r: any) => r.label === "Process")).toMatchObject({ old: "fdm-loose", new: "fdm-loose" });
    expect(lockOf(x, repo).approvedBy).toBe("agent-initial"); // nothing was approved by the first tap
    expect(JSON.parse(text(x.partJson)).expectations).toEqual(JSON.parse(before).expectations);
    x.service.respond(second.requestId, false);
    expect((await pending).json).toMatchObject({ approved: false });
    // The swapped process is still an unapproved change.
    const g = await x.check();
    expect(g.state).toBe("unverified");
    expect(g.needsAdoption).toBe("expectations");
  });

  test("[A2] review 5: adding a remote after approval does not orphan the locks — they are found under either identity of the repo", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: CLI });
    expect(x.gate.state).toBe("pass");
    const pathKey = repoKey(repo);
    expect(pathKey).toBe(repo);
    expect(lockOf(x, repo)).toMatchObject({ repo, path: repo });
    expect(Bun.spawnSync(["git", "-C", repo, "remote", "add", "origin", "git@example.com:me/plates.git"]).exitCode).toBe(0);
    expect(repoKey(repo)).toBe("git@example.com:me/plates");
    expect(repoIdentity(repo)).toEqual({ key: "git@example.com:me/plates", remote: "git@example.com:me/plates", path: repo });
    // The reviewer's repro expected every lock to vanish here. They do not:
    const g = await x.check();
    expect(g.state).toBe("pass");
    expect(g.needsAdoption).toBeUndefined();
    expect(x.openCards()).toEqual([]);
    // …and "a lock exists under any identity" still blocks a second record_expectations.
    expect((await x.tools.record_expectations!({ part: "plate", process: "fdm-0.4", parameters: PLATE_PARAMETERS, expectations: PLATE_EXPECTATIONS })).text).toContain("already has expectations");
    // A new approval is stored under the remote, with both identities, and is the one found from then on.
    expect(await x.service.setParam(repo, "plate", "L", "120")).toEqual({ ok: true });
    expect(lockOf(x, repo)).toMatchObject({ repo: "git@example.com:me/plates", remote: "git@example.com:me/plates", path: repo, values: { bbox: [6, 50, 120] } });
    expect((await x.check()).state).toBe("pass");
    // Another repo at another path with another remote sees none of it.
    const stranger = tempRepo();
    expect(x.service.locks.findPart(repoIdentity(stranger), "plate")).toBeUndefined();
    // A path-only match counts only on the machine the approval was made on.
    expect(x.service.locks.findPart({ key: "git@example.com:other/repo", remote: "git@example.com:other/repo", path: repo }, "plate", "srv_elsewhere")).toBeUndefined();
  });

  test("[A2] review 7: adopting ownerParams records what the card showed — a card drawn for other values approves nothing", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: CLI });
    editJson(x.partJson, (doc) => void (doc.ownerParams = { L: 80 }));
    await x.check();
    await until(() => x.openCards().some((c: any) => c.kind === "adopt-ownerParams"), "the dimensions card");
    const card = x.openCards().find((c: any) => c.kind === "adopt-ownerParams");
    expect(card.rows).toEqual([{ label: "L", new: "80" }]);
    // The file changes again before the owner taps: the card on screen says L = 80, the file now says 999.
    editJson(x.partJson, (doc) => void (doc.ownerParams = { L: 999 }));
    x.service.respond(card.requestId, true);
    expect(x.broadcasts.find((e: any) => e.type === "cad.expectations.resolved" && e.requestId === card.requestId)).toMatchObject({ approved: false });
    expect(lockOf(x, repo).ownerParams).toBeUndefined(); // 999 was never approved
    const g = await x.check();
    expect(g.needsAdoption).toBe("ownerParams");
    // The card for what is actually there can be approved.
    await until(() => x.openCards().some((c: any) => c.kind === "adopt-ownerParams" && c.rows[0].new === "999"), "the fresh card");
    const fresh = x.openCards().find((c: any) => c.kind === "adopt-ownerParams");
    x.service.respond(fresh.requestId, true);
    // The approval is written in the part's queue (decision 204): it lands with the card's answer.
    await until(() => x.broadcasts.some((e: any) => e.type === "cad.expectations.resolved" && e.requestId === fresh.requestId), "the answer");
    expect(x.broadcasts.find((e: any) => e.type === "cad.expectations.resolved" && e.requestId === fresh.requestId)).toMatchObject({ approved: true });
    expect(lockOf(x, repo).ownerParams).toEqual({ L: 999 });
  });

  test("[A2] review 10: the gate says who approved the numbers; Confirm numbers raises the owner's card (numbers, process, status) and approving it makes the owner the approver", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: CLI });
    expect(x.gate.state).toBe("pass"); // an agent's own numbers are fine for an interactive pass…
    expect(x.gate.approvedBy).toBe("agent-initial"); // …but everyone can see whose they are
    expect(x.design("plate").gate.approvedBy).toBe("agent-initial");
    const ref = partRef(repo, "plate");
    expect(x.service.confirmNumbers("sess_gone", ref)).toMatchObject({ ok: false });
    expect(x.service.confirmNumbers("sess_cad", ref)).toEqual({ ok: true });
    const card = x.openCards()[0];
    expect(card).toMatchObject({ kind: "confirm", part: "plate", sessionId: "sess_cad" });
    expect(card.rows.find((r: any) => r.label === "Process")).toMatchObject({ new: "fdm-0.4" });
    expect(card.rows.find((r: any) => r.label === "Status")).toMatchObject({ new: "dimensioned" });
    expect(card.rows.find((r: any) => r.label === "Bounding box (mm)").new).toContain("80");
    expect(card.rows.find((r: any) => r.label === "Volume (mm³)").new).toContain("23335.167");
    expect(x.service.confirmNumbers("sess_cad", ref)).toMatchObject({ ok: true, note: "a card is already open" });
    expect(x.openCards()).toHaveLength(1);
    // Deny: nothing changes.
    x.service.respond(card.requestId, false);
    expect(lockOf(x, repo).approvedBy).toBe("agent-initial");
    // Approve: the owner is the approver of exactly that block; the part still passes.
    x.service.confirmNumbers("sess_cad", ref);
    const sha = lockOf(x, repo).sha;
    const confirmCard = x.openCards()[0];
    x.service.respond(confirmCard.requestId, true);
    // Written in the part's queue (decision 204): it lands with the card's answer.
    await until(() => x.broadcasts.some((e: any) => e.type === "cad.expectations.resolved" && e.requestId === confirmCard.requestId), "the answer");
    expect(lockOf(x, repo)).toMatchObject({ approvedBy: "owner", sha, values: { bbox: [6, 50, 80] } });
    const g = await x.check();
    expect(g).toMatchObject({ state: "pass", approvedBy: "owner" });
    await until(() => x.design("plate").gate.approvedBy === "owner", "the card to hear of it");
    expect(x.service.confirmNumbers("sess_cad", ref)).toMatchObject({ ok: false, error: expect.stringContaining("already approved by the owner") });
    // A card drawn for a block that then changed approves nothing.
    const repo2 = tempRepo();
    const y = await buildPlate(repo2, { cli: CLI, sessionId: "sess_two" });
    y.service.confirmNumbers("sess_two", partRef(repo2, "plate"));
    editJson(y.partJson, (doc) => void (doc.expectations.volume = 1));
    const yCard = y.openCards().find((c: any) => c.kind === "confirm");
    y.service.respond(yCard.requestId, true);
    await until(() => y.broadcasts.some((e: any) => e.type === "cad.expectations.resolved" && e.requestId === yCard.requestId), "the answer");
    expect(y.broadcasts.find((e: any) => e.type === "cad.expectations.resolved" && e.requestId === yCard.requestId)).toMatchObject({ approved: false });
    expect(lockOf(y, repo2).approvedBy).toBe("agent-initial");
  });

  test("[A2] review 11: declared parameter values are lengths or plain numbers — `mm` is accepted, `deg` is refused", async () => {
    expect(parseDeclared({ L: "80 mm", W: 50, T: "6" })).toEqual({ ok: true, values: { L: 80, W: 50, T: 6 }, expressions: { L: "80 mm", W: "50", T: "6" } });
    for (const bad of [{ A: "30 deg" }, { A: "30deg" }, { A: "30 in" }, { A: "L*2" }]) {
      const r = parseDeclared(bad);
      expect(r.ok).toBe(false);
    }
    // Through the tool, nothing is recorded.
    const repo = tempRepo();
    writeRules(repo, RULES);
    const x = fakeCadSession(repo, { resolveCli: () => ({ path: FAKE_SOLIDCRAFT, source: "env" }) }, "sess_cad", { expectations: "manual" });
    await x.tools.open_part!({ part: "plate" });
    const r = await x.tools.record_expectations!({ part: "plate", process: "fdm-0.4", parameters: { A: "30 deg" }, expectations: { ...PLATE_EXPECTATIONS, bbox: ["A", 1, 1] } });
    expect(r.isError).toBe(true);
    expect(existsSync(join(repo, "cad", "plate", "part.json"))).toBe(false);
  });
});
