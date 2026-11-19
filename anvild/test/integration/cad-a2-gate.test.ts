/**
 * [A2] Functional scenario for Phase A2 (agent-cad-and-browser spec §5 "Phase A2", §7, §8.2): the
 * real CadworkService, CadManager, lock store, refresh and gate, driven through the agent's
 * `anvil_cad` tools, with SolidCraft replaced by the fake server through `ANVIL_SOLIDCRAFT_CLI`.
 * Where a bullet is about permissions it goes through the REAL PreToolUse hook of a real session;
 * where it is about the fleet it runs real daemons talking over real HTTP on loopback.
 *
 * One test per Acceptance bullet (the Edit and lock-store sentences of the fifth bullet are two
 * tests), then the §7 rows tagged A2, then the hub sync of §4.14 item 42.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { CAD_SYSTEM_PROMPT } from "../../src/agent/cad-tool-ids";
import { cadTools } from "../../src/agent/cad-tools";
import { makePreToolUseHook, type PermissionBroker } from "../../src/agent/permissions";
import { AccountStore } from "../../src/auth/accounts";
import { LOCKS_APPROVE_PATH, LOCKS_PUSH_PATH, repoKey } from "../../src/cadwork/locks";
import { partRef } from "../../src/cadwork/partfolder";
import { lockedBlockSha, readPartFile } from "../../src/cadwork/partfile";
import { createServer, type ServerHandle } from "../../src/server/http";
import { ConnectionRegistry } from "../../src/server/registry";
import type { Session } from "../../src/session/session";
import { Supervisor } from "../../src/session/supervisor";
import { PLATE_EXPECTATIONS, PLATE_VOLUME, RULES, approveCards, buildPlate, callable, cleanupTemp, fakeCadSession, stopServices, tempRepo, until, writeRules } from "../helpers/cad-work";
import { FAKE_SOLIDCRAFT, REFERENCE_PLATE } from "../helpers/fake-solidcraft";
import { PLATE_PARAMETERS, plateBuild } from "../helpers/cad-work";

/** The plate's modeling commands: the reference plate less the parameters `record_expectations` already created. */
const PLATE_BUILD = plateBuild(REFERENCE_PLATE);

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ["ANVIL_SOLIDCRAFT_CLI", "ANVIL_CAD_MAX_PROCS", "ANVIL_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"]) saved[k] = process.env[k];
  process.env.ANVIL_SOLIDCRAFT_CLI = FAKE_SOLIDCRAFT; // every service below resolves the fake, as production resolves a real binary
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "sk-ant-oat-test-placeholder"; // a server will not boot without a credential; no turn is run
  delete process.env.ANVIL_CAD_MAX_PROCS;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const supervisors: Supervisor[] = [];
const servers: ServerHandle[] = [];
const sockets: WebSocket[] = [];
const stateDirs: string[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  await stopServices();
  for (const s of supervisors.splice(0)) await s.shutdown().catch(() => undefined);
  for (const s of servers.splice(0)) await s.shutdown().catch(() => undefined);
  for (const d of stateDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  cleanupTemp();
  delete process.env.ANVIL_BASE_URL;
});

const CLI = FAKE_SOLIDCRAFT;
const plate = (repo: string, opts: Omit<Parameters<typeof buildPlate>[1], "cli"> = {}) => buildPlate(repo, { ...opts, cli: CLI });
const text = (path: string) => readFileSync(path, "utf8");
const editJson = (path: string, fn: (doc: any) => void) => {
  const doc = JSON.parse(text(path));
  fn(doc);
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
};
const BIGGER = { ...PLATE_EXPECTATIONS, bbox: ["L", "W", "T + 2"], volume: `${PLATE_VOLUME} + 2*L*W` };

function tempState(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  stateDirs.push(dir);
  return dir;
}
function accountsIn(stateDir: string): AccountStore {
  const accounts = new AccountStore(stateDir);
  if (accounts.list().length === 0) accounts.add("test", "sk-ant-oat01-testtesttest-0000"); // (a restarted daemon already has it)
  return accounts;
}
/** A real Supervisor with cad-work on, and everything its CAD service broadcasts. */
function supervisor(features: string[] = ["cad-work"]) {
  const stateDir = tempState("anvil-cad-a2-state-");
  const registry = new ConnectionRegistry();
  const broadcasts: any[] = [];
  const toAll = registry.toAll.bind(registry);
  registry.toAll = ((ev: any) => {
    broadcasts.push(ev);
    return toAll(ev);
  }) as typeof registry.toAll;
  const sup = new Supervisor({ stateDir, accounts: accountsIn(stateDir), envFile: join(stateDir, "env"), features }, registry);
  supervisors.push(sup);
  const openCards = () => {
    const done = new Set(broadcasts.filter((e) => e.type === "cad.expectations.resolved").map((e) => e.requestId));
    return broadcasts.filter((e) => e.type === "cad.expectations.request" && !done.has(e.requestId));
  };
  return { sup, stateDir, broadcasts, openCards };
}
const createCmd = (cwd: string, more: Record<string, unknown> = {}) => ({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd, ...more }) as any;
const hookCtx = { signal: new AbortController().signal } as any;
/** The real gate of a real session, recording every permission card it parks. */
function gateOf(sup: Supervisor, s: Session) {
  const asked: { requestId: string; tool: string; suggestions: any[] }[] = [];
  const realRequest = s.requestPermission.bind(s);
  s.requestPermission = ((requestId: string, tool: string, input: unknown, suggestions: any) => {
    asked.push({ requestId, tool, suggestions });
    return realRequest(requestId, tool, input as any, suggestions);
  }) as typeof s.requestPermission;
  const hook = makePreToolUseHook(s, (sup as unknown as { broker: PermissionBroker }).broker);
  const run = (tool: string, input: Record<string, unknown>) => hook({ tool_name: tool, tool_input: input } as any, "t", hookCtx) as Promise<any>;
  const decided = async (tool: string, input: Record<string, unknown>) => (await run(tool, input)).hookSpecificOutput as { permissionDecision: string; permissionDecisionReason?: string };
  return { asked, run, decided };
}
/** A real session of a real supervisor with the plate built, approved and passing. */
async function supervisedPlate(autonomy = "bypass") {
  const repo = tempRepo();
  writeRules(repo);
  const ctx = supervisor();
  const s = await ctx.sup.create(createCmd(repo, { autonomy }));
  const tools = callable(cadTools(ctx.sup.cadwork.toolDeps(s.id, repo)) as any);
  await tools.open_part!({ part: "plate" });
  expect((await tools.record_expectations!({ part: "plate", process: "fdm-0.4", parameters: PLATE_PARAMETERS, expectations: PLATE_EXPECTATIONS })).isError).toBe(false);
  expect((await tools.batch!({ commands: PLATE_BUILD })).isError).toBe(false);
  await tools.check_part!({ part: "plate" });
  for (const c of ctx.openCards()) ctx.sup.respondCadExpectations(c.requestId, true);
  expect((await tools.check_part!({ part: "plate" })).json.state).toBe("pass");
  return { ...ctx, repo, s, tools, partJson: join(repo, "cad", "plate", "part.json") };
}

describe("Phase A2 acceptance", () => {
  test("[A2] acceptance 1: modeling on a dimensioned part before record_expectations is refused", async () => {
    const repo = tempRepo();
    const { tools, manager } = fakeCadSession(repo, {}, "sess_cad", { expectations: "manual" });
    const opened = await tools.open_part!({ part: "plate" });
    expect(opened.isError).toBe(false);
    expect(opened.json.modeling).toBe("refused until expectations are recorded"); // a brand-new part is `dimensioned`
    const attempts = [
      () => tools.execute!({ command: "solid.box", params: { length: 10, width: 10, height: 10 } }),
      () => tools.batch!({ commands: PLATE_BUILD }),
      () => tools.set_parameter!({ name: "L", expression: "120" }),
      () => tools.undo!({}),
      () => tools.redo!({}),
    ];
    for (const attempt of attempts) {
      const r = await attempt();
      expect(r.isError).toBe(true);
      expect(r.text).toContain("cad/plate has no expectations yet");
      expect(r.text).toContain("record_expectations");
    }
    // Nothing was built and nothing was written: there is no design to describe after the fact.
    expect(existsSync(join(repo, "cad", "plate", "design.json"))).toBe(false);
    expect(existsSync(join(repo, "cad", "plate", "part.json"))).toBe(false);
    expect((await tools.measure!({ summary: true })).json.body_count).toBe(0);
    expect(manager.status(partRef(repo, "plate"))!.scriptSha).toBeUndefined();
    // Once they are recorded, the same calls go through.
    expect((await tools.record_expectations!({ part: "plate", process: "fdm-0.4", parameters: PLATE_PARAMETERS, expectations: PLATE_EXPECTATIONS })).isError).toBe(false);
    expect((await tools.batch!({ commands: PLATE_BUILD })).isError).toBe(false);
    expect((await tools.measure!({ summary: true })).json.body_count).toBe(1);
  });

  test("[A2] acceptance 2: the plate with the documented volume formula and holes [{diameter: 3.4, count: 4}] passes; removing the pattern feature fails naming the hole count and the volume", async () => {
    const repo = tempRepo();
    const x = await plate(repo);
    const exp = JSON.parse(text(x.partJson)).expectations;
    expect(exp.volume).toBe(PLATE_VOLUME);
    expect(exp.volume.startsWith("L*W*T - ")).toBe(true);
    expect(exp.holes).toEqual([{ diameter: 3.4, count: 4 }]);
    expect(x.gate.state).toBe("pass");
    expect(x.gate.failing).toEqual([]);
    expect(x.gate.checks.find((c: any) => c.id === "volume")).toMatchObject({ ok: true, hard: true });
    expect(x.gate.checks.find((c: any) => c.id === "volume").measured).toBeCloseTo(23335.167, 2);
    expect(x.gate.checks.find((c: any) => c.id === "holes ⌀3.4 count")).toMatchObject({ expected: 4, measured: 4, ok: true });

    // Remove the pattern feature (the last request the agent made).
    expect((await x.tools.undo!({})).isError).toBe(false);
    const g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.failing).toEqual(["volume: expected 23335.167, measured 23737.2209", "holes ⌀3.4 count: expected 4, measured 1"]);
    expect(x.manager.status(partRef(repo, "plate"))!.state.status).toBe("fail");
    // Putting it back passes again.
    await x.tools.redo!({});
    expect((await x.check()).state).toBe("pass");
  });

  test("[A2] acceptance 3: a second record_expectations is refused; propose_expectations parks a card; Deny leaves part.json byte-identical; Approve rewrites it and updates the lock store", async () => {
    const repo = tempRepo();
    const x = await plate(repo);
    const key = repoKey(repo);
    const second = await x.tools.record_expectations!({ part: "plate", process: "fdm-0.4", parameters: PLATE_PARAMETERS, expectations: { ...PLATE_EXPECTATIONS, volume: 1 } });
    expect(second.isError).toBe(true);
    expect(second.text).toContain("only once");
    expect(second.text).toContain("propose_expectations");

    const before = text(x.partJson);
    const lockBefore = x.service.locks.getPart(key, "plate")!;
    expect(lockBefore.approvedBy).toBe("agent-initial");
    expect(lockBefore.sha).toBe(lockedBlockSha((readPartFile(join(repo, "cad", "plate")) as any).file));

    // Deny.
    const denied = x.tools.propose_expectations!({ part: "plate", expectations: BIGGER, reason: "The plate should be 2 mm thicker." });
    await until(() => x.openCards().length === 1, "the expectations card");
    const card = x.openCards()[0];
    expect(card).toMatchObject({ type: "cad.expectations.request", kind: "propose", part: "plate", sessionId: "sess_cad", reason: "The plate should be 2 mm thicker." });
    expect(card.rows.find((r: any) => r.label === "Bounding box (mm)")).toEqual({ label: "Bounding box (mm)", old: "L × W × T  (= 6 × 50 × 80)", new: "L × W × T + 2  (= 8 × 50 × 80)" });
    expect(card.rows.find((r: any) => r.label === "Volume (mm³)").old).toContain("(= 23335.167)");
    expect(card.rows.find((r: any) => r.label === "Volume (mm³)").new).toContain("(= 31335.167)");
    expect(text(x.partJson)).toBe(before); // parked: nothing is written while the card waits
    expect(x.service.respond(card.requestId, false)).toBe(true);
    const deniedReply = await denied;
    expect(deniedReply.isError).toBe(false);
    expect(deniedReply.json).toMatchObject({ approved: false });
    expect(deniedReply.text).toContain("DENIED");
    expect(text(x.partJson)).toBe(before); // byte-identical
    expect(x.service.locks.getPart(key, "plate")).toEqual(lockBefore);
    expect(x.service.respond(card.requestId, true)).toBe(false); // a card is answered once
    expect((await x.check()).state).toBe("pass");
    expect(text(x.partJson)).toBe(before);

    // Approve.
    const approved = x.tools.propose_expectations!({ part: "plate", expectations: BIGGER, reason: "The plate should be 2 mm thicker." });
    await until(() => x.openCards().length === 1, "the second card");
    x.service.respond(x.openCards()[0].requestId, true);
    expect((await approved).json).toMatchObject({ approved: true });
    const after = JSON.parse(text(x.partJson));
    expect(text(x.partJson)).not.toBe(before);
    expect(after.expectations.bbox).toEqual(["L", "W", "T + 2"]);
    expect(after.expectations.lockedBy).toBe("owner");
    expect(after.process).toBe("fdm-0.4"); // nothing else in the file is disturbed
    expect(after.measured).toBeDefined();
    const lockAfter = x.service.locks.getPart(key, "plate")!;
    expect(lockAfter.approvedBy).toBe("owner");
    expect(lockAfter.sha).not.toBe(lockBefore.sha);
    expect(lockAfter.sha).toBe(lockedBlockSha(after));
    expect(lockAfter.values!.bbox).toEqual([8, 50, 80]);
    // The part has not changed, so against the NEW expectations it now fails — approved, not adopted-pending.
    const g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.needsAdoption).toBeUndefined();
    expect(g.failing).toEqual(["bbox.min: expected 8, measured 6", "volume: expected 31335.167, measured 23335.167"]);
  });

  test("[A2] acceptance 4: propose_expectations prompts under bypass and after an earlier always-allow for another tool, and its card offers no always-allow", async () => {
    const x = await supervisedPlate("allowlist");
    const gate = gateOf(x.sup, x.s);
    const tool = "mcp__anvil_cad__propose_expectations";
    const args = { part: "plate", expectations: BIGGER, reason: "thicker" };

    // An earlier "always allow" answer, for another tool.
    const edit = gate.run("Edit", { file_path: join(x.repo, "README.md"), old_string: "a", new_string: "b" });
    await until(() => gate.asked.length === 1, "the Edit prompt");
    expect(gate.asked[0]!.suggestions.map((s) => s.decision)).toContain("allow_always");
    x.sup.resolvePermission(gate.asked[0]!.requestId, "allow_always");
    expect((await edit).hookSpecificOutput.permissionDecision).toBe("allow");
    expect(x.s.isAlwaysAllowed("Edit")).toBe(true);

    for (const autonomy of ["allowlist", "bypass", "mostly-autonomous"] as const) {
      x.s.data.autonomy = autonomy;
      const cardsBefore = x.openCards().length;
      // The permission gate lets the call through to the tool, whose own card is the prompt…
      expect((await gate.decided(tool, args)).permissionDecision).toBe("allow");
      const call = x.tools.propose_expectations!(args);
      // …and that card is parked EVERY time, whatever the policy and whatever was remembered.
      await until(() => x.openCards().length === cardsBefore + 1, `the expectations card under ${autonomy}`);
      const card = x.openCards().at(-1);
      expect(card.kind).toBe("propose");
      expect(card.suggestions).toBeUndefined(); // a typed card: Approve / Deny, nothing to remember
      expect(JSON.stringify(card)).not.toContain("allow_always");
      expect(Object.keys(card).sort()).toEqual(["cwd", "kind", "part", "reason", "requestId", "rows", "sessionId", "ts", "type", "v"]);
      expect(x.s.data.status).toBe("awaiting_permission"); // the session shows it is waiting on the owner
      x.sup.respondCadExpectations(card.requestId, false);
      expect((await call).json.approved).toBe(false);
    }
    expect(gate.asked).toHaveLength(1); // only the Edit prompt: no generic card ever stood in front
    expect(x.s.isAlwaysAllowed(tool)).toBe(false);
    // The command takes exactly { requestId, approve }: there is no way to say "always".
    expect(() => x.sup.respondCadExpectations("cadx_nope", true)).toThrow("no pending expectations card");

    // Unattended (an autopilot builder): denied at the gate with no card, and the tool refuses too.
    x.s.data.workUnitRole = "builder";
    x.s.data.autonomy = "bypass";
    const cards = x.openCards().length;
    const out = await gate.decided(tool, args);
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain("unattended");
    const direct = await x.tools.propose_expectations!(args);
    expect(direct.isError).toBe(true);
    expect(direct.text).toContain("unattended");
    expect(x.openCards()).toHaveLength(cards);
  });

  test("[A2] acceptance 5: an Edit to cad/plate/part.json is denied under bypass", async () => {
    const x = await supervisedPlate("bypass");
    const gate = gateOf(x.sup, x.s);
    const before = text(x.partJson);
    for (const [tool, input] of [
      ["Edit", { file_path: x.partJson, old_string: '"volume"', new_string: '"volume "' }],
      ["Write", { file_path: "cad/plate/part.json", content: "{}" }],
      ["NotebookEdit", { notebook_path: x.partJson }],
    ] as const) {
      const out = await gate.decided(tool, input as any);
      expect(out.permissionDecision).toBe("deny");
      expect(out.permissionDecisionReason).toContain("written by the anvil_cad tools only");
    }
    expect(gate.asked).toEqual([]); // refused outright, no card to talk one's way past
    expect(text(x.partJson)).toBe(before);
    // Even after "always allow Edit", and for every other part.
    x.s.rememberAllow("Edit");
    expect((await gate.decided("Edit", { file_path: join(x.repo, "cad", "bracket", "part.json"), old_string: "a", new_string: "b" })).permissionDecision).toBe("deny");
    // The same session can still edit ordinary files under bypass.
    expect((await gate.decided("Edit", { file_path: join(x.repo, "README.md"), old_string: "a", new_string: "b" })).permissionDecision).toBe("allow");
  });

  test("[A2] acceptance 6: rewriting part.json's expectations on disk (as Bash would) gives unverified with needsAdoption expectations, even with lockedBy owner; adopting on the card restores pass", async () => {
    const repo = tempRepo();
    const x = await plate(repo);
    expect(x.gate.state).toBe("pass");
    await x.tools.undo!({}); // the part is now WRONG: one hole, too much material
    expect((await x.check()).state).toBe("fail");
    // What an agent would write to make it pass: the measured numbers, signed with the owner's name.
    editJson(x.partJson, (doc) => {
      doc.expectations = { ...doc.expectations, lockedBy: "owner", lockedAt: "2026-01-01T00:00:00.000Z", volume: 23737.2209, holes: [{ diameter: 3.4, count: 1 }] };
    });
    const g = await x.check();
    expect(g.state).toBe("unverified"); // not pass, though every number now "matches"
    expect(g.needsAdoption).toBe("expectations");
    expect(g.failing).toEqual([expect.stringContaining("lock.expectations")]);
    expect(x.manager.status(partRef(repo, "plate"))!.state.status).toBe("unverified");
    expect(x.service.locks.getPart(repoKey(repo), "plate")!.approvedBy).toBe("agent-initial"); // the file's claim changed nothing
    // The owner is shown what they would be accepting.
    const cards = x.openCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "adopt-expectations", part: "plate" });
    expect(cards[0].rows.find((r: any) => r.label === "Volume (mm³)")).toEqual({ label: "Volume (mm³)", old: "23335.167", new: "23737.2209" });
    expect(cards[0].rows.find((r: any) => r.label === "Holes")).toEqual({ label: "Holes", old: "⌀3.4 ×4", new: "⌀3.4 ×1" });
    expect(cards[0].rows.find((r: any) => r.label.startsWith("Approved by")).new).toBe("owner");
    // Adopting on the card records the new hash, and the gate passes against the adopted values.
    x.service.respond(cards[0].requestId, true);
    const adopted = await x.check();
    expect(adopted.state).toBe("pass");
    expect(adopted.needsAdoption).toBeUndefined();
    const lock = x.service.locks.getPart(repoKey(repo), "plate")!;
    expect(lock.approvedBy).toBe("owner");
    expect(lock.values!.holes).toEqual([{ diameter: 3.4, count: 1 }]);
    expect(x.openCards()).toEqual([]);
  });

  test("[A2] acceptance 7: with expectations bbox [L, W, T], an agent set_parameter L=120 fails with \"expected value moved without owner approval\"; the same change by the owner passes", async () => {
    const repo = tempRepo();
    const x = await plate(repo);
    expect(JSON.parse(text(x.partJson)).expectations.bbox).toEqual(["L", "W", "T"]);
    const ref = partRef(repo, "plate");

    // The agent changes the parameter the expectations are written in.
    expect((await x.tools.set_parameter!({ name: "L", expression: "120" })).isError).toBe(false);
    const moved = await x.check();
    expect(moved.state).toBe("fail");
    const line = moved.failing.find((l: string) => l.startsWith("accepted"));
    expect(line).toContain("expected value moved without owner approval");
    expect(line).toContain("bbox[2] 80 → 120"); // old and new, listed
    expect(line).toContain("volume 23335.167 → 35335.167");
    expect(moved.failing.join("\n")).toContain("bbox.max: expected 80, measured 120");
    expect(x.service.locks.getPart(repoKey(repo), "plate")!.values!.bbox).toEqual([6, 50, 80]); // the accepted numbers held
    expect(x.design("plate").by).toBe("agent");

    // Back to 80, then the SAME change through the owner's entry point (what `cad.param.set` calls).
    await x.tools.set_parameter!({ name: "L", expression: "80" });
    expect((await x.check()).state).toBe("pass");
    const owner = await x.service.setParamAsOwner(ref, "L", "120");
    expect(owner.ok).toBe(true);
    expect(owner.gate!.state).toBe("pass");
    expect(owner.gate!.checks.find((c) => c.id === "bbox.max")).toMatchObject({ expected: 120, measured: 120, ok: true });
    expect(owner.gate!.checks.find((c) => c.id === "volume")!.expected).toBeCloseTo(35335.167, 2);
    expect(x.service.locks.getPart(repoKey(repo), "plate")!.values!.bbox).toEqual([6, 50, 120]); // re-derived AND accepted
    expect(x.design("plate").by).toBe("panel");
    expect((await x.check()).state).toBe("pass");
    // The owner's entry point refuses what SolidCraft refuses, and then accepts nothing.
    const bad = await x.service.setParamAsOwner(ref, "Nope", "1");
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("unknown parameter");
    expect(x.service.locks.getPart(repoKey(repo), "plate")!.values!.bbox).toEqual([6, 50, 120]);
    // A plain-number expectation does not follow the owner's change: it fails visibly, which is correct.
    const repo2 = tempRepo();
    const y = await plate(repo2, { expectations: { ...PLATE_EXPECTATIONS, bbox: [80, 50, 6] } });
    expect(y.gate.state).toBe("pass");
    const plain = await y.service.setParamAsOwner(partRef(repo2, "plate"), "L", "120");
    expect(plain.gate!.state).toBe("fail");
    expect(plain.gate!.checks.find((c) => c.id === "bbox.max")).toMatchObject({ expected: 80, measured: 120, ok: false });
  });

  test("[A2] acceptance 8: a tolerance edited on disk to 1.0 and adopted is still fail on the cap check", async () => {
    const repo = tempRepo();
    const x = await plate(repo);
    editJson(x.partJson, (doc) => {
      doc.expectations.tolerance = { length: 1.0, volumeRel: 0.001 };
    });
    const pending = await x.check();
    expect(pending.state).toBe("unverified");
    expect(pending.needsAdoption).toBe("expectations");
    const card = x.openCards()[0];
    expect(card.rows.find((r: any) => r.label === "Tolerance").new).toBe("1 mm, 0.1% volume"); // the owner sees what they are asked to accept
    x.service.respond(card.requestId, true);
    const adopted = await x.check();
    expect(adopted.needsAdoption).toBeUndefined(); // adopted…
    expect(adopted.state).toBe("fail"); // …and still not passing
    expect(adopted.failing).toEqual(["tolerance.length: expected at most 0.1 mm, measured 1"]);
    // Recording such a tolerance in the first place is refused outright.
    const repo2 = tempRepo();
    const y = fakeCadSession(repo2, {}, "s2", { expectations: "manual" });
    await y.tools.open_part!({ part: "plate" });
    const loose = await y.tools.record_expectations!({ part: "plate", process: "fdm-0.4", parameters: PLATE_PARAMETERS, expectations: { ...PLATE_EXPECTATIONS, tolerance: { length: 1.0 } } });
    expect(loose.isError).toBe(true);
    expect(loose.text).toContain("looser than the cap of 0.1 mm");
    expect(existsSync(join(repo2, "cad", "plate", "part.json"))).toBe(false);
  });

  test("[A2] acceptance 9: changing cad/rules.json on disk gives unverified with needsAdoption rules", async () => {
    const repo = tempRepo();
    const x = await plate(repo);
    expect(x.gate.state).toBe("pass");
    // Loosen the envelope tenfold.
    writeRules(repo, { ...RULES, processes: RULES.processes.map((p) => ({ ...p, envelope: p.envelope.map((v) => v * 10) })) });
    const g = await x.check();
    expect(g.state).toBe("unverified");
    expect(g.needsAdoption).toBe("rules");
    expect(g.failing).toEqual([expect.stringContaining("lock.rules")]);
    const card = x.openCards()[0];
    expect(card.kind).toBe("adopt-rules");
    expect(card.rulesDiff.filter((d: any) => d.op === "-").map((d: any) => d.line.trim())).toContain("250,");
    expect(card.rulesDiff.filter((d: any) => d.op === "+").map((d: any) => d.line.trim())).toContain("2500,");
    // Denied: still unverified, and the old rules stay the approved ones.
    x.service.respond(card.requestId, false);
    expect((await x.check()).state).toBe("unverified");
    // Approved: the new hash is recorded and the part is judged by the new rules.
    expect(approveCards(x)).toEqual(["adopt-rules"]);
    const adopted = await x.check();
    expect(adopted.state).toBe("pass");
    expect(adopted.checks.find((c: any) => c.id === "rules.envelope").expected).toBe("fits 2100 × 2200 × 2500 mm (fdm-0.4)");
  });

  test("[A2] acceptance 10: an envelope smaller than the part fails on the envelope check; minWall gives an advisory line and the state is still pass", async () => {
    const small = tempRepo();
    const x = await plate(small, { rules: { schema: 1, processes: [{ id: "fdm-0.4", kind: "fdm", envelope: [60, 60, 60] }] } });
    expect(x.gate.state).toBe("fail");
    expect(x.gate.failing).toEqual(["rules.envelope: expected fits 60 × 60 × 60 mm (fdm-0.4), measured 6 × 50 × 80 mm"]);

    const walls = tempRepo();
    const y = await plate(walls, { rules: { schema: 1, processes: [{ id: "fdm-0.4", kind: "fdm", envelope: [250, 210, 220], minWall: 1.2 }] } });
    expect(y.gate.state).toBe("pass");
    expect(y.gate.advisory).toEqual(["rules.minWall: walls at least 1.2 mm — not measured: SolidCraft cannot measure wall thickness, so check this by eye"]);
    expect(y.gate.checks.find((c: any) => c.id === "rules.minWall")).toMatchObject({ hard: false });
    expect(y.design("plate").gate.checks.some((c: any) => c.id === "rules.minWall" && !c.hard)).toBe(true); // it reaches the card

    // The other rule outcomes: a drill that is not listed (cnc), and a process the file does not have.
    const cnc = tempRepo();
    const z = await plate(cnc, { process: "cnc-3axis", rules: { schema: 1, processes: [{ id: "cnc-3axis", kind: "cnc", envelope: [300, 200, 100], drills: [3, 4, 5] }] } });
    expect(z.gate.state).toBe("fail");
    expect(z.gate.failing).toEqual([expect.stringContaining("rules.drill ⌀3.4")]);
    const unknown = tempRepo();
    const u = await plate(unknown, { process: "sla-resin" });
    expect(u.gate.state).toBe("fail");
    expect(u.gate.failing.join()).toContain('unknown process "sla-resin"');
  });
});

describe("Phase A2 edge cases and gaming (§7)", () => {
  test("[A2] a cut that misses (success reported, volume unchanged) fails the volume check", async () => {
    const repo = tempRepo();
    const x = await plate(repo, { deps: { manager: { extraEnv: { FAKE_SC_MISS_CUTS: "1" } } } });
    // Every modeling call reported success…
    expect(x.manager.status(partRef(repo, "plate"))!.state.featureErrors).toEqual([]);
    // …but no material came off, and the volume check is the backstop.
    expect(x.gate.state).toBe("fail");
    expect(x.gate.failing[0]).toMatch(/^volume: expected 23335\.167, measured 2387[0-9]\./);
    expect(x.gate.failing).toContain("holes ⌀3.4 count: expected 4, measured 0");
  });

  test("[A2] the owner denies an expectation change: nothing is written and the agent is told it was denied", async () => {
    const repo = tempRepo();
    const x = await plate(repo);
    const before = { part: text(x.partJson), design: text(join(repo, "cad", "plate", "design.json")), lock: JSON.stringify(x.service.locks.snapshot()) };
    const call = x.tools.propose_expectations!({ part: "plate", expectations: BIGGER, reason: "thicker" });
    await until(() => x.openCards().length === 1, "the card");
    x.service.respond(x.openCards()[0].requestId, false);
    const reply = await call;
    expect(reply.isError).toBe(false);
    expect(reply.json).toEqual({ part: "plate", approved: false, note: "The owner DENIED the change. The expectations are exactly as they were; nothing was written." });
    expect(text(x.partJson)).toBe(before.part);
    expect(text(join(repo, "cad", "plate", "design.json"))).toBe(before.design);
    expect(JSON.stringify(x.service.locks.snapshot())).toBe(before.lock);
    expect(x.broadcasts.filter((e) => e.type === "cad.expectations.resolved").at(-1)).toMatchObject({ approved: false });
    // A proposal with no reason, or for a part with nothing to change, never reaches the owner.
    expect((await x.tools.propose_expectations!({ part: "plate", expectations: BIGGER, reason: " " })).text).toContain("`reason`");
    expect((await x.tools.propose_expectations!({ part: "other", expectations: BIGGER, reason: "x" })).text).toContain("record_expectations first");
    expect((await x.tools.propose_expectations!({ part: "plate", expectations: { ...BIGGER, tolerance: { volumeRel: 0.5 } }, reason: "x" })).text).toContain("looser than the cap");
    expect(x.openCards()).toEqual([]);
  });

  test("[A2] gamed: the agent cannot set expectations after measuring — modeling is refused first, and later changes need the owner", async () => {
    const repo = tempRepo();
    const x = fakeCadSession(repo, {}, "sess_cad", { expectations: "manual" });
    writeRules(repo);
    await x.tools.open_part!({ part: "plate" });
    // 1. Build first, describe afterwards: there is nothing to measure, because nothing can be built.
    expect((await x.tools.batch!({ commands: PLATE_BUILD })).isError).toBe(true);
    expect((await x.tools.measure!({ summary: true })).json.body_count).toBe(0);
    // 2. Record, build something else, then try to re-describe it to match.
    await x.tools.record_expectations!({ part: "plate", process: "fdm-0.4", parameters: PLATE_PARAMETERS, expectations: PLATE_EXPECTATIONS });
    await x.tools.batch!({ commands: PLATE_BUILD.slice(0, -1) }); // one hole, not four
    const measured = (await x.tools.measure!({ summary: true })).json.total.volume_mm3;
    const again = await x.tools.record_expectations!({ part: "plate", process: "fdm-0.4", parameters: PLATE_PARAMETERS, expectations: { ...PLATE_EXPECTATIONS, volume: measured, holes: [{ diameter: 3.4, count: 1 }] } });
    expect(again.isError).toBe(true);
    // 3. Delete part.json and record afresh: the lock store remembers that this part was approved.
    rmSync(join(repo, "cad", "plate", "part.json"));
    const afresh = await x.tools.record_expectations!({ part: "plate", process: "fdm-0.4", parameters: PLATE_PARAMETERS, expectations: { ...PLATE_EXPECTATIONS, volume: measured, holes: [{ diameter: 3.4, count: 1 }] } });
    expect(afresh.isError).toBe(true);
    expect(afresh.text).toContain("restore cad/plate/part.json from git");
    expect(existsSync(join(repo, "cad", "plate", "part.json"))).toBe(false);
    const g = (await x.tools.check_part!({ part: "plate" })).json;
    expect(g.state).toBe("unverified");
    expect((await x.tools.execute!({ command: "solid.box", params: { length: 1, width: 1, height: 1 } })).isError).toBe(true); // and modeling stops
    // 4. Declare the part a "concept" on disk to skip the rule: not honoured without approval.
    writeFileSync(join(repo, "cad", "plate", "part.json"), JSON.stringify({ schema: 1, process: "fdm-0.4", status: "concept" }));
    const concept = await x.tools.execute!({ command: "solid.box", params: { length: 1, width: 1, height: 1 } });
    expect(concept.isError).toBe(true);
    expect(concept.text).toContain("was not approved");
    expect((await x.tools.check_part!({ part: "plate" })).json.state).toBe("unverified");
  });

  test("[A2] gamed: editing part.json by any route leaves a hash the lock store does not know, so the part is unverified until the owner adopts it", async () => {
    const repo = tempRepo();
    const x = await plate(repo);
    const edits: ((doc: any) => void)[] = [
      (doc) => void (doc.expectations.volume = 1),
      (doc) => void (doc.expectations.bodies = 2),
      (doc) => void (doc.expectations.holes = []),
      (doc) => void (doc.expectations.lockedBy = "owner"),
      (doc) => void (doc.process = "cnc-3axis"),
      (doc) => void delete doc.expectations,
    ];
    const original = text(x.partJson);
    for (const edit of edits) {
      writeFileSync(x.partJson, original);
      expect((await x.check()).state).toBe("pass");
      editJson(x.partJson, edit);
      const g = await x.check();
      expect(g.state).toBe("unverified");
      expect(g.needsAdoption).toBe("expectations");
    }
    // The daemon's own `measured` block is not part of what is locked: changing it does not need adopting.
    writeFileSync(x.partJson, original);
    editJson(x.partJson, (doc) => void (doc.measured.volume = 1));
    const g = await x.check();
    expect(g.state).toBe("pass");
    expect(JSON.parse(text(x.partJson)).measured.volume).toBeCloseTo(23335.167, 2); // and the daemon simply re-measures
    // A hand edit of the lock store itself that leaves it unreadable resets it: adopt again, never pass.
    writeFileSync(x.service.locks.file, "{ tampered");
  });

  test("[A2] gamed: expectations written as bare parameter names do not follow the parameters — by set_parameter, execute or batch", async () => {
    const repo = tempRepo();
    const x = await plate(repo, { expectations: { bbox: ["L", "W", "T"], volume: PLATE_VOLUME, bodies: 1, holes: [{ diameter: 3.4, count: 4 }] } });
    expect(x.gate.state).toBe("pass");
    const routes = [
      () => x.tools.set_parameter!({ name: "W", expression: "60" }),
      () => x.tools.execute!({ command: "parameters.change", params: { changes: { W: "60" } } }),
      () => x.tools.batch!({ commands: [{ command: "parameters.change", params: { name: "W", expression: "60" } }] }),
    ];
    for (const route of routes) {
      expect((await route()).isError).toBe(false);
      const g = await x.check();
      expect(g.state).toBe("fail");
      expect(g.failing.join("\n")).toContain("expected value moved without owner approval: bbox[1] 50 → 60");
      await x.tools.undo!({});
      expect((await x.check()).state).toBe("pass"); // back where the owner accepted it
    }
    expect(x.service.locks.getPart(repoKey(repo), "plate")!.values!.bbox).toEqual([6, 50, 80]);
  });

  test("[A2] gamed: tolerances so loose anything passes are capped on every evaluation, not only when recorded", async () => {
    const repo = tempRepo();
    const x = await plate(repo);
    await x.tools.undo!({}); // wrong part: 1.7% too much volume, three holes missing
    for (const tolerance of [{ length: 1.0, volumeRel: 0.001 }, { length: 0.01, volumeRel: 1.0 }, { length: 50, volumeRel: 50 }]) {
      editJson(x.partJson, (doc) => void (doc.expectations.tolerance = tolerance));
      await x.check();
      approveCards(x); // even with the owner's adoption of the loosened block
      const g = await x.check();
      expect(g.state).toBe("fail");
      expect(g.failing.some((l: string) => l.startsWith("tolerance."))).toBe(true);
      expect(g.failing).toContain("volume: expected 23335.167, measured 23737.2209"); // and the mismatch is still reported
    }
  });

  test("[A2] gamed: loosening rules.json — the Edit always prompts, and any change needs adoption", async () => {
    const x = await supervisedPlate("bypass");
    const gate = gateOf(x.sup, x.s);
    const rulesPath = join(x.repo, "cad", "rules.json");
    x.s.rememberAllow("Edit");
    x.s.rememberAllow("Write");
    // The edit route: a card every time, with no "always allow", under bypass.
    for (const [tool, input] of [["Edit", { file_path: rulesPath, old_string: "250", new_string: "2500" }], ["Write", { file_path: "cad/rules.json", content: "{}" }]] as const) {
      const before = gate.asked.length;
      const pending = gate.run(tool, input as any);
      await until(() => gate.asked.length === before + 1, `the ${tool} prompt`);
      const card = gate.asked.at(-1)!;
      expect(card.suggestions.map((s) => s.decision)).toEqual(["allow", "deny"]);
      x.sup.resolvePermission(card.requestId, "deny");
      expect((await pending).hookSpecificOutput.permissionDecision).toBe("deny");
    }
    // Any other route (Bash): the file changes, the hash is unknown, the part is unverified.
    writeRules(x.repo, { schema: 1, processes: [{ id: "fdm-0.4", kind: "fdm", envelope: [9999, 9999, 9999] }] });
    const g = (await x.tools.check_part!({ part: "plate" })).json;
    expect(g.state).toBe("unverified");
    expect(g.needsAdoption).toBe("rules");
    expect(x.openCards().map((c) => c.kind)).toEqual(["adopt-rules"]);
    // Unattended, the edit is denied and no adopt card is raised: the part just stays unverified.
    for (const c of x.openCards()) x.sup.respondCadExpectations(c.requestId, false);
    x.s.data.workUnitRole = "builder";
    expect((await gate.decided("Write", { file_path: rulesPath, content: "{}" })).permissionDecision).toBe("deny");
    const before = x.openCards().length;
    expect((await x.tools.check_part!({ part: "plate" })).json.state).toBe("unverified");
    expect(x.openCards()).toHaveLength(before);
  });

  test("[A2] gamed: an always-prompt card cannot be answered once with \"always allow\" — it has no such option and is checked before the remembered-allow lookup", async () => {
    const x = await supervisedPlate("bypass");
    const gate = gateOf(x.sup, x.s);
    const rulesPath = join(x.repo, "cad", "rules.json");
    // A client sends "allow_always" anyway: it is an allow-once and nothing is remembered.
    const first = gate.run("Write", { file_path: rulesPath, content: "{}" });
    await until(() => gate.asked.length === 1, "the first prompt");
    expect(gate.asked[0]!.suggestions.some((s) => s.decision === "allow_always")).toBe(false);
    x.sup.resolvePermission(gate.asked[0]!.requestId, "allow_always");
    expect((await first).hookSpecificOutput.permissionDecision).toBe("allow");
    expect(x.s.isAlwaysAllowed("Write")).toBe(false);
    // Even with the tool genuinely remembered, the protected check comes first: asked again.
    x.s.rememberAllow("Write");
    const second = gate.run("Write", { file_path: rulesPath, content: "{}" });
    await until(() => gate.asked.length === 2, "the second prompt");
    x.sup.resolvePermission(gate.asked[1]!.requestId, "deny");
    expect((await second).hookSpecificOutput.permissionDecision).toBe("deny");
    // The expectations card has only approve: true | false, and the deny list has no card at all.
    for (let i = 0; i < 2; i++) {
      const call = x.tools.propose_expectations!({ part: "plate", expectations: BIGGER, reason: "again" });
      await until(() => x.openCards().length === 1, "the expectations card");
      x.sup.respondCadExpectations(x.openCards()[0].requestId, false);
      expect((await call).json.approved).toBe(false);
    }
    expect((await gate.decided("Bash", { command: `cat ${x.stateDir}/cadwork/locks.json` })).permissionDecision).toBe("deny");
    expect((await gate.decided("Bash", { command: "solidcraft-cli run cad/plate/design.json --out x.step" })).permissionDecision).toBe("deny");
    expect(gate.asked).toHaveLength(2);
  });

  test("[A2] a session with the anvil_cad server gets the CAD paragraph in its system prompt, and other sessions do not", async () => {
    const repo = tempRepo();
    const on = supervisor();
    const s = await on.sup.create(createCmd(repo));
    const prompt = ((on.sup as any).ensureDriver(s.id) as any).systemPrompt().append as string;
    expect(prompt).toContain(CAD_SYSTEM_PROMPT);
    for (const phrase of ["ONE part at a time", "record_expectations", "Name every driving dimension as a parameter", "never say a part is done while the gate fails", "report_gap", "skill_reference"]) {
      expect(CAD_SYSTEM_PROMPT).toContain(phrase);
    }
    const off = supervisor([]);
    const plain = await off.sup.create(createCmd(repo));
    expect(((off.sup as any).ensureDriver(plain.id) as any).systemPrompt().append).not.toContain("CAD PARTS");
  });
});

// ── hub sync (§4.14 item 42): real daemons over real HTTP ────────────────────────────────────────

interface Daemon {
  handle: ServerHandle;
  url: string;
  stateDir: string;
  id: string;
  frames: any[];
  send: (cmd: Record<string, unknown>) => void;
}
const REMOTE = "git@example.com:me/widgets.git";
async function boot(stateDir: string, port = 0, more: Record<string, unknown> = {}): Promise<Daemon> {
  const handle = createServer({ host: "127.0.0.1", port, stateDir, envFile: join(stateDir, "env"), accounts: accountsIn(stateDir), features: ["cad-work"], resolveIdentity: async () => ({ trust: "sameUser" as const }), ...more });
  servers.push(handle);
  const frames: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
  sockets.push(ws);
  ws.onmessage = (m) => void frames.push(JSON.parse(String(m.data)));
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws error"));
  });
  return { handle, url: `http://127.0.0.1:${handle.port}`, stateDir, id: readFileSync(join(stateDir, "server-id"), "utf8").trim(), frames, send: (cmd) => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: "t", ...cmd })) };
}
/** A hub with one paired member, both real daemons on loopback. */
async function fleet() {
  const hubState = tempState("anvil-cad-a2-hub-");
  const memberState = tempState("anvil-cad-a2-member-");
  writeFileSync(join(hubState, "server-id"), "srv_hub_test\n");
  writeFileSync(join(memberState, "server-id"), "srv_member_test\n");
  writeFileSync(join(memberState, "pairing.json"), JSON.stringify({ hubServerId: "srv_hub_test", at: "2026-11-19T00:00:00.000Z" }));
  const member = await boot(memberState);
  writeFileSync(join(hubState, "fleet.json"), JSON.stringify({ members: [{ serverId: "srv_member_test", serverName: "member", host: "127.0.0.1", url: `${member.url}/` }] }));
  const hub = await boot(hubState);
  process.env.ANVIL_BASE_URL = hub.url; // how this hub tells members where it is (read live)
  expect(hub.frames[0]).toMatchObject({ type: "server.hello", role: "hub" });
  expect(member.frames[0]).toMatchObject({ type: "server.hello", role: "member", hubServerId: "srv_hub_test" });
  return { hub, member };
}
/** A clone of "the same repo" (same remote URL) on a machine. */
function clone(): string {
  const repo = tempRepo();
  const r = Bun.spawnSync(["git", "-C", repo, "remote", "add", "origin", REMOTE]);
  if (r.exitCode !== 0) throw new Error("git remote add failed");
  return repo;
}
/** What `git pull` would bring to another machine: the committed files of the part and the rules. */
function sync(from: string, to: string): void {
  mkdirSync(join(to, "cad", "plate"), { recursive: true });
  for (const f of ["cad/rules.json", "cad/plate/design.json", "cad/plate/part.json"]) cpSync(join(from, f), join(to, f));
}
/** A session on a daemon, its tools, and the cards that daemon has open. */
async function sessionOn(d: Daemon, repo: string) {
  const sup = d.handle.supervisor;
  const s = await sup.create(createCmd(repo));
  const tools = callable(cadTools(sup.cadwork.toolDeps(s.id, repo)) as any);
  const openCards = () => {
    const done = new Set(d.frames.filter((e) => e.type === "cad.expectations.resolved").map((e) => e.requestId));
    return d.frames.filter((e) => e.type === "cad.expectations.request" && !done.has(e.requestId));
  };
  const check = async () => (await tools.check_part!({ part: "plate" })).json;
  /** Wait for the cards of the last check to arrive over the socket, then approve them all. */
  const approveAll = async (expected: number) => {
    await until(() => openCards().length >= expected, `${expected} card(s) on the socket`);
    for (const c of openCards()) sup.respondCadExpectations(c.requestId, true);
  };
  return { sup, s, tools, openCards, check, approveAll };
}
async function builtOn(d: Daemon, repo: string) {
  writeRules(repo);
  const x = await sessionOn(d, repo);
  await x.tools.open_part!({ part: "plate" });
  expect((await x.tools.record_expectations!({ part: "plate", process: "fdm-0.4", parameters: PLATE_PARAMETERS, expectations: PLATE_EXPECTATIONS })).isError).toBe(false);
  expect((await x.tools.batch!({ commands: PLATE_BUILD })).isError).toBe(false);
  expect((await x.check()).needsAdoption).toBe("rules");
  await x.approveAll(1);
  expect((await x.check()).state).toBe("pass");
  return x;
}
const settle = async (...ds: Daemon[]) => {
  for (let i = 0; i < 3; i++) for (const d of ds) await d.handle.supervisor.cadwork.lockSync.settled();
};

describe("Phase A2 lock store hub sync (§4.14 item 42)", () => {
  test("[A2] hub sync: a part approved on machine 1 is pass on machine 2 with no adopt card once synced", async () => {
    const { hub, member } = await fleet();
    const repo1 = clone();
    const repo2 = clone();
    expect(repoKey(repo1)).toBe(repoKey(repo2)); // one repo, two machines
    // Machine 1 (the hub): the part is built, and the owner approves there.
    await builtOn(hub, repo1);
    await settle(hub, member);
    const key = repoKey(repo1);
    const locks1 = hub.handle.supervisor.cadwork.locks;
    const locks2 = member.handle.supervisor.cadwork.locks;
    expect(locks2.getPart(key, "plate")).toEqual(locks1.getPart(key, "plate"));
    expect(locks2.getRules(key)).toEqual(locks1.getRules(key));
    expect(locks2.hub()).toEqual({ serverId: "srv_hub_test", url: hub.url });
    // Machine 2 pulls the repo and opens the part: pass, and nobody is asked anything.
    sync(repo1, repo2);
    const two = await sessionOn(member, repo2);
    await two.tools.open_part!({ part: "plate" });
    const g = await two.check();
    expect(g.state).toBe("pass");
    expect(g.needsAdoption).toBeUndefined();
    await new Promise((r) => setTimeout(r, 50));
    expect(member.frames.filter((e) => e.type === "cad.expectations.request")).toEqual([]);
    expect(member.frames.filter((e) => e.type === "cad.design").at(-1)).toMatchObject({ part: "plate", cwd: repo2 });
    expect(member.frames.filter((e) => e.type === "cad.design").at(-1).gate.state).toBe("pass");
  });

  test("[A2] hub sync: a hash the hub does not know is unverified with an adopt card on machine 2, and adopting there applies on machine 1", async () => {
    const { hub, member } = await fleet();
    const repo1 = clone();
    const repo2 = clone();
    const one = await builtOn(hub, repo1);
    await settle(hub, member);
    sync(repo1, repo2);
    const two = await sessionOn(member, repo2);
    await two.tools.open_part!({ part: "plate" });
    expect((await two.check()).state).toBe("pass");
    // On machine 2 the expectations are changed on disk: a hash nobody in the fleet has approved.
    editJson(join(repo2, "cad", "plate", "part.json"), (doc) => void (doc.expectations.tolerance = { length: 0.05, volumeRel: 0.001 }));
    const g = await two.check();
    expect(g.state).toBe("unverified");
    expect(g.needsAdoption).toBe("expectations");
    await until(() => two.openCards().length === 1, "the adopt card on machine 2");
    expect(two.openCards()[0]).toMatchObject({ kind: "adopt-expectations", sessionId: two.s.id });
    // The owner answers over the socket of machine 2 (the wire command of §4.8).
    member.send({ type: "cad.expectations.respond", requestId: two.openCards()[0].requestId, approve: true, cid: "c1" });
    await until(() => member.frames.some((e) => e.type === "cad.expectations.resolved" && e.approved === true), "the card to be resolved");
    await until(() => member.frames.some((e) => e.type === "ack" || e.cid === "c1"), "the ack");
    await settle(member, hub, member);
    expect((await two.check()).state).toBe("pass");
    // The approval went to the hub and is the fleet's now.
    const key = repoKey(repo1);
    const hubLock = hub.handle.supervisor.cadwork.locks.getPart(key, "plate")!;
    expect(hubLock.machine).toBe("srv_member_test");
    expect(hubLock.approvedBy).toBe("owner");
    expect(member.handle.supervisor.cadwork.locks.pending()).toEqual([]);
    // Machine 1 pulls the changed file: pass, with no adopt card of its own.
    const cardsBefore = one.openCards().length;
    cpSync(join(repo2, "cad", "plate", "part.json"), join(repo1, "cad", "plate", "part.json"));
    const g1 = await one.check();
    expect(g1.state).toBe("pass");
    expect(one.openCards()).toHaveLength(cardsBefore);
  });

  test("[A2] hub sync: a member that cannot reach the hub uses its copy, applies its own approval locally, queues it, and delivers it when the hub is back", async () => {
    const { hub, member } = await fleet();
    const repo1 = clone();
    const repo2 = clone();
    await builtOn(hub, repo1);
    await settle(hub, member);
    sync(repo1, repo2);
    const hubPort = hub.handle.port;
    const hubState = hub.stateDir;
    await hub.handle.shutdown(); // the hub goes away
    servers.splice(servers.indexOf(hub.handle), 1);

    const two = await sessionOn(member, repo2);
    await two.tools.open_part!({ part: "plate" });
    expect((await two.check()).state).toBe("pass"); // the last copy still answers
    // An approval made while offline (the rules change, and the owner adopts on this machine).
    writeRules(repo2, { ...RULES, processes: [...RULES.processes, { id: "sls", kind: "fdm", envelope: [300, 300, 300] }] });
    expect((await two.check()).needsAdoption).toBe("rules");
    await two.approveAll(1);
    await settle(member);
    expect((await two.check()).state).toBe("pass"); // applied locally at once
    const memberLocks = member.handle.supervisor.cadwork.locks;
    expect(memberLocks.pending()).toHaveLength(1); // …and queued for the hub
    expect(JSON.parse(readFileSync(memberLocks.file, "utf8")).pending).toHaveLength(1); // durably

    // The hub comes back on the same address; the member's next retry delivers.
    const back = await boot(hubState, hubPort);
    const key = repoKey(repo2);
    expect(back.handle.supervisor.cadwork.locks.getRules(key)!.sha).not.toBe(memberLocks.getRules(key)!.sha);
    await member.handle.supervisor.cadwork.lockSync.retry();
    await settle(member, back, member);
    expect(memberLocks.pending()).toEqual([]);
    expect(back.handle.supervisor.cadwork.locks.getRules(key)).toEqual(memberLocks.getRules(key));
    expect(back.handle.supervisor.cadwork.locks.getRules(key)!.machine).toBe("srv_member_test");
    expect((await two.check()).state).toBe("pass");
  });

  test("[A2] hub sync routes keep the fleet posture: JSON only, a proven other user is rejected, a member takes pushes only from its own hub, a hub takes approvals only from its members", async () => {
    const { hub, member } = await fleet();
    const post = (base: string, path: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
      fetch(`${base}${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
    const lock = { repo: "r", part: "evil", sha: "x", approvedBy: "owner", status: "dimensioned", at: "2030-01-01T00:00:00.000Z" };
    const memberLocks = member.handle.supervisor.cadwork.locks;
    const hubLocks = hub.handle.supervisor.cadwork.locks;

    // Not JSON (what a cross-origin "simple request" can send): refused before anything is read.
    expect((await post(member.url, LOCKS_PUSH_PATH, JSON.stringify({ hubServerId: "srv_hub_test", parts: [lock], rules: [] }), { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(hub.url, LOCKS_APPROVE_PATH, JSON.stringify({ serverId: "srv_member_test", parts: [lock], rules: [] }), { "content-type": "text/plain" })).status).toBe(415);
    // A browser page on another origin.
    expect((await post(hub.url, LOCKS_APPROVE_PATH, { serverId: "srv_member_test", parts: [lock], rules: [] }, { "content-type": "application/json", origin: "https://evil.example" })).status).toBe(403);
    // A push that does not come from the hub this member is paired with.
    const wrongHub = await post(member.url, LOCKS_PUSH_PATH, { hubServerId: "srv_someone_else", hubUrl: "http://evil:1", parts: [lock], rules: [] });
    expect(wrongHub.status).toBe(403);
    expect(await wrongHub.json()).toMatchObject({ ok: false, error: "unknown hub" });
    // An approval from a machine this hub never paired.
    const stranger = await post(hub.url, LOCKS_APPROVE_PATH, { serverId: "srv_stranger", parts: [lock], rules: [] });
    expect(stranger.status).toBe(403);
    expect(await stranger.json()).toMatchObject({ ok: false, error: "unknown fleet member" });
    // The hub itself is paired to no hub, so it accepts no push at all.
    expect((await post(hub.url, LOCKS_PUSH_PATH, { hubServerId: "srv_hub_test", parts: [lock], rules: [] })).status).toBe(403);
    expect(memberLocks.getPart("r", "evil")).toBeUndefined();
    expect(hubLocks.getPart("r", "evil")).toBeUndefined();
    expect(memberLocks.hub()?.url).not.toBe("http://evil:1");

    // A PROVEN different tailnet user is rejected on both routes, even with the right ids.
    const strictState = tempState("anvil-cad-a2-strict-");
    writeFileSync(join(strictState, "pairing.json"), JSON.stringify({ hubServerId: "srv_hub_test", at: "t" }));
    writeFileSync(join(strictState, "fleet.json"), JSON.stringify({ members: [{ serverId: "srv_member_test", serverName: "m", host: "127.0.0.1", url: `${member.url}/` }] }));
    const strict = await boot(strictState, 0, { resolveIdentity: async () => ({ trust: "otherUser" as const, reject: "different tailnet user" }) });
    const asOther = { "content-type": "application/json", "Tailscale-User-Login": "someone@else.example" };
    for (const [path, body] of [[LOCKS_PUSH_PATH, { hubServerId: "srv_hub_test", parts: [lock], rules: [] }], [LOCKS_APPROVE_PATH, { serverId: "srv_member_test", parts: [lock], rules: [] }]] as const) {
      const r = await post(strict.url, path, body, asOther);
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ ok: false, error: "different tailnet user" });
    }
    expect(strict.handle.supervisor.cadwork.locks.snapshot()).toEqual({ parts: [], rules: [] });

    // A daemon without cad-work has neither route.
    const plainState = tempState("anvil-cad-a2-plain-");
    const plain = createServer({ host: "127.0.0.1", port: 0, stateDir: plainState, envFile: join(plainState, "env"), accounts: accountsIn(plainState), features: [] });
    servers.push(plain);
    expect((await post(`http://127.0.0.1:${plain.port}`, LOCKS_APPROVE_PATH, { serverId: "x", parts: [], rules: [] })).status).toBe(404);

    // And the legitimate calls do work: a real member approval, answered with the hub's merged store.
    const ok = await post(hub.url, LOCKS_APPROVE_PATH, { serverId: "srv_member_test", parts: [{ ...lock, part: "good" }], rules: [] });
    expect(ok.status).toBe(200);
    const reply = (await ok.json()) as any;
    expect(reply).toMatchObject({ ok: true, hubServerId: "srv_hub_test" });
    expect(reply.parts.map((p: any) => p.part)).toEqual(["good"]);
    await settle(hub, member);
    expect(memberLocks.getPart("r", "good")).toBeDefined(); // and it was broadcast on
  });

  test("[A2] a socket that opens later is sent the current cad.design of every part and every card still waiting", async () => {
    const stateDir = tempState("anvil-cad-a2-solo-");
    const d = await boot(stateDir);
    expect(d.frames[0]).toMatchObject({ type: "server.hello", role: "standalone" });
    const repo = tempRepo();
    writeRules(repo);
    const x = await sessionOn(d, repo);
    await x.tools.open_part!({ part: "plate" });
    await x.tools.record_expectations!({ part: "plate", process: "fdm-0.4", parameters: PLATE_PARAMETERS, expectations: PLATE_EXPECTATIONS });
    await x.tools.batch!({ commands: PLATE_BUILD });
    expect((await x.check()).needsAdoption).toBe("rules");
    await until(() => x.openCards().length === 1, "the adopt card");
    // (record_expectations now creates the declared parameters, so it is a refresh of its own: wait for the CHECKED design.)
    await until(() => d.frames.filter((e) => e.type === "cad.design").at(-1)?.rev === x.sup.cadwork.snapshot(partRef(repo, "plate"))?.rev && d.frames.filter((e) => e.type === "cad.design").at(-1)?.busy === false, "the checked design on the socket");
    const live = d.frames.filter((e) => e.type === "cad.design").at(-1);
    expect(live).toMatchObject({ v: PROTOCOL_VERSION, type: "cad.design", cwd: repo, part: "plate", busy: false, by: "agent", sessionIds: [x.s.id] });
    expect(live.gate).toMatchObject({ state: "unverified", needsAdoption: "rules", staleBuild: false });
    expect(live.params.map((p: any) => [p.name, p.value, p.unit])).toEqual([["L", 80, "mm"], ["W", 50, "mm"], ["T", 6, "mm"], ["inset", 8, "mm"]]);

    // A second device connects now.
    const late: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${d.handle.port}/ws`);
    sockets.push(ws);
    ws.onmessage = (m) => void late.push(JSON.parse(String(m.data)));
    await until(() => late.some((e) => e.type === "todoist.status"), "the opening frames");
    expect(late.filter((e) => e.type === "cad.design")).toHaveLength(1);
    expect(late.find((e) => e.type === "cad.design")).toMatchObject({ part: "plate", rev: live.rev });
    const replayed = late.filter((e) => e.type === "cad.expectations.request");
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ requestId: x.openCards()[0].requestId, kind: "adopt-rules", replay: true });
    // Answered from the second device; both devices see it retired.
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: "t", type: "cad.expectations.respond", requestId: replayed[0].requestId, approve: true }));
    await until(() => late.some((e) => e.type === "cad.expectations.resolved") && d.frames.some((e) => e.type === "cad.expectations.resolved"), "both devices to see the answer");
    expect((await x.check()).state).toBe("pass");
    // An unknown card id is a command error, not a silent success.
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: "t", type: "cad.expectations.respond", requestId: "cadx_missing", approve: true, cid: "c9" }));
    await until(() => late.some((e) => e.cid === "c9"), "the error reply");
    expect(JSON.stringify(late.find((e) => e.cid === "c9"))).toContain("no pending expectations card");
  });
});
