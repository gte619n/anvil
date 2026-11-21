/**
 * [A5] Functional scenario for Phase A5, the merge guard (agent-cad-and-browser spec §4.11, §5 "Phase
 * A5", §7). Real git repos in temp folders, the real service / manager / refresh / lock store, and
 * `verify-cli.ts` run as a real subprocess the way an agent's shell runs it; SolidCraft is the fake.
 * One test per Acceptance bullet, then §7's A5 rows and gamed rows.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MOVED_WITHOUT_APPROVAL } from "../../src/cadwork/gate";
import { partRef } from "../../src/cadwork/partfolder";
import { REFERENCE_CHANGED } from "../../src/cadwork/refs";
import { verifyParts } from "../../src/cadwork/verify";
import { PIN_FILE } from "../../src/solidcraft/pin";
import { BOX, buildPlate, cleanupTemp, fakeCadSession, recordingSpawn, stopServices, tempDir, tempRepo, writeDesign, writeRules, RULES, type ToolReply } from "../helpers/cad-work";
import { git, runVerifyCli, twoBranchMerge } from "../helpers/cad-verify";
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
const stateOf = (x: { service: { locks: { file: string } } }) => x.service.locks.file.replace(/\/cadwork\/locks\.json$/, "");
/** verify-cli in `cwd` against the service's own lock store, on the fake. */
const cli = (cwd: string, stateDir: string, args: string[] = [], env: Record<string, string | undefined> = {}) =>
  runVerifyCli(cwd, [...args, "--json"], { ANVIL_STATE_DIR: stateDir, ANVIL_SOLIDCRAFT_CLI: FAKE_SOLIDCRAFT, ...env });
const partOf = (run: { json?: any }, part = "plate") => run.json?.parts?.find((p: any) => p.part === part);
const failingIds = (p: any): string[] => p.checks.filter((c: any) => c.hard && !c.ok).map((c: any) => c.id);

/** A STEP the fake reads back exactly: one box body from `min` to `max` (mm). */
function stepFile(repo: string, rel: string, min: number[], max: number[], name = "block"): string {
  const abs = join(repo, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  const v = (max[0]! - min[0]!) * (max[1]! - min[1]!) * (max[2]! - min[2]!);
  writeFileSync(abs, `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n/* fake-solidcraft ${JSON.stringify({ bodies: [{ name, volume: v, faces: 6, min, max }] })} */\nENDSEC;\nEND-ISO-10303-21;\n`);
  return abs;
}
/** Run a tool call while the owner approves every card it raises. */
async function asOwner(x: { service: any; openCards: () => any[] }, call: Promise<ToolReply>): Promise<ToolReply> {
  let settled = false;
  void call.finally(() => (settled = true));
  while (!settled) {
    for (const c of x.openCards()) x.service.respond(c.requestId, true);
    await new Promise((r) => setTimeout(r, 2));
  }
  return call;
}
/** Every file under a folder with its bytes, for "nothing was written" comparisons (git's own folder left out). */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(p, `${statSync(p).mtimeMs}:${readFileSync(p, "base64")}`);
    }
  };
  walk(dir);
  return out;
}

describe("Phase A5 acceptance", () => {
  test("[A5] acceptance 1: two branches each change a different parameter of one part; after a clean text merge verify-cli exits non-zero because part.json's measured no longer matches the replay", async () => {
    const m = await twoBranchMerge(FAKE_SOLIDCRAFT);
    // The merge was clean and holds BOTH changes; part.json is branch a's, measured from a's script.
    const params = Object.fromEntries(m.designDoc().commands.filter((c: any) => c.command === "parameters.add").map((c: any) => [c.params.name, c.params.expression]));
    expect(params).toMatchObject({ L: "120 mm", T: "6.5 mm", W: "50 mm" });
    expect(git(m.repo, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(m.partDoc().measured.volume).toBeCloseTo(35335.167, 2); // L = 120, T = 6: what a measured
    const run = await cli(m.repo, m.stateDir);
    expect(run.code).toBe(1);
    const p = partOf(run);
    expect(p.state).toBe("fail");
    expect(p.ok).toBe(false);
    // What fails is exactly the stored measurement against the replay…
    expect(failingIds(p)).toEqual(["measured.scriptSha", "measured.bbox.min", "measured.volume"]);
    expect(p.checks.find((c: any) => c.id === "measured.volume")).toMatchObject({ measured: m.partDoc().measured.volume });
    expect(p.checks.find((c: any) => c.id === "measured.volume").expected).toBeCloseTo(38306.279, 2); // the replay: L = 120, T = 6.5
    // …while the replayed geometry itself is what the owner accepted on both branches.
    for (const id of ["lock.expectations", "lock.rules", "accepted", "features", "volume", "bbox.max", "bodies", "holes ⌀3.4 count"]) expect(p.checks.find((c: any) => c.id === id).ok).toBe(true);
    // The human-readable form says so too, with the same exit code.
    const plain = await runVerifyCli(m.repo, [], { ANVIL_STATE_DIR: m.stateDir, ANVIL_SOLIDCRAFT_CLI: FAKE_SOLIDCRAFT });
    expect(plain.code).toBe(1);
    expect(plain.stdout).toContain("plate");
    expect(plain.stdout).toContain("measured.scriptSha");
    expect(plain.stdout).toContain("FAILED: do not commit this merge");
  });

  test("[A5] acceptance 2: after the refresh runs on the merged script and the result passes, verify-cli exits 0", async () => {
    const m = await twoBranchMerge(FAKE_SOLIDCRAFT);
    expect((await cli(m.repo, m.stateDir)).code).toBe(1);
    // The refresh on the merged script (check_part reloads the design from disk and re-measures).
    const g = (await m.tools.check_part!({ part: "plate" })).json;
    expect(g.failing).toEqual([]);
    expect(g.state).toBe("pass");
    expect(m.partDoc().measured.volume).toBeCloseTo(38306.279, 2);
    const run = await cli(m.repo, m.stateDir);
    expect(run.code).toBe(0);
    expect(partOf(run)).toMatchObject({ state: "pass", ok: true, failing: [] });
    // Committed, and checked against the merge base the way the prompt tells the agent to.
    git(m.repo, "commit", "-q", "-am", "re-measured after the merge");
    const since = await cli(m.repo, m.stateDir, ["--changed-since", m.base]);
    expect(since.code).toBe(0);
    expect(since.json.selection).toMatchObject({ changedSince: m.base, changed: ["plate"], rulesChanged: false });
    const plain = await runVerifyCli(m.repo, ["--changed-since", m.base], { ANVIL_STATE_DIR: m.stateDir, ANVIL_SOLIDCRAFT_CLI: FAKE_SOLIDCRAFT });
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain("OK: every selected part passes.");
  });

  test("[A5] acceptance 3: a part.json whose expectations do not match the lock store exits non-zero (adoption pending)", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    expect(x.gate.state).toBe("pass");
    const stateDir = stateOf(x);
    expect((await cli(repo, stateDir)).code).toBe(0);
    // Edited outside the approval flow: a looser volume tolerance (still within the caps).
    const doc = JSON.parse(readFileSync(x.partJson, "utf8"));
    doc.expectations.tolerance.volumeRel = 0.005;
    writeFileSync(x.partJson, JSON.stringify(doc, null, 2) + "\n");
    const run = await cli(repo, stateDir);
    expect(run.code).toBe(1);
    const p = partOf(run);
    expect(p.state).toBe("unverified");
    expect(p.needsAdoption).toBe("expectations");
    expect(p.reason).toContain("adoption pending (expectations)");
    expect(p.checks.find((c: any) => c.id === "lock.expectations")).toMatchObject({ ok: false });
    expect(p.checks.find((c: any) => c.id === "lock.expectations").measured).toContain("changed outside the approval flow");
    // A lock store that never saw this repo (a fresh machine) is the same: not approved here yet.
    const empty = tempDir("anvil-cad-a5-empty-state-");
    const fresh = await cli(repo, empty);
    expect(fresh.code).toBe(1);
    expect(partOf(fresh).needsAdoption).toBe("expectations");
    expect(partOf(fresh).checks.find((c: any) => c.id === "lock.expectations").measured).toContain("not approved on this fleet yet");
  });
});

describe("Phase A5 edge cases and gaming (§7)", () => {
  test("[A5] two sessions on two worktrees of one repo, same part: different keys and processes; verify judges each checkout against the one shared approval", async () => {
    const repo = tempRepo();
    git(repo, "checkout", "-q", "-b", "main");
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    git(repo, "add", "cad");
    git(repo, "commit", "-q", "-m", "plate");
    const wt = join(tempDir("anvil-cad-a5-wt-"), "a");
    git(repo, "worktree", "add", "-q", "-b", "a", wt);
    const main = partRef(repo, "plate");
    const other = partRef(wt, "plate");
    expect(other.key).not.toBe(main.key);
    expect((await x.service.setParamAsOwner(other, "L", "120 mm")).ok).toBe(true);
    const a = x.manager.status(other)!;
    const b = x.manager.status(main)!;
    expect(a.live && b.live).toBe(true);
    expect(a.pid).not.toBe(b.pid); // two processes, one per checkout
    git(wt, "commit", "-q", "-am", "L = 120");
    const stateDir = stateOf(x);
    // The approval is the repo's (shared): the worktree that has L = 120 passes…
    const onA = await cli(wt, stateDir);
    expect(onA.code).toBe(0);
    // …and the checkout still at L = 80 is told the accepted numbers moved: git and A5 reconcile them.
    const onMain = await cli(repo, stateDir);
    expect(onMain.code).toBe(1);
    expect(partOf(onMain).checks.find((c: any) => c.id === "accepted").measured).toContain(MOVED_WITHOUT_APPROVAL);
    // Verify ran in processes of its own: the sessions' live processes are untouched.
    expect(x.manager.status(other)!.pid).toBe(a.pid);
    expect(x.manager.status(main)!.pid).toBe(b.pid);
  });

  test("[A5] gamed: a merge that edits the expectations text fails as adoption pending, even with a matching measured block", async () => {
    const repo = tempRepo();
    git(repo, "checkout", "-q", "-b", "main");
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    git(repo, "add", "cad");
    git(repo, "commit", "-q", "-m", "plate");
    const base = git(repo, "rev-parse", "HEAD");
    // A branch that rewrites the volume formula so a smaller plate would pass (text only, no tools).
    git(repo, "checkout", "-q", "-b", "loose");
    const doc = JSON.parse(readFileSync(x.partJson, "utf8"));
    doc.expectations.volume = "L*W*T";
    doc.expectations.holes = [];
    writeFileSync(x.partJson, JSON.stringify(doc, null, 2) + "\n");
    git(repo, "commit", "-q", "-am", "simplify expectations");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-edit", "loose");
    expect(JSON.parse(readFileSync(x.partJson, "utf8")).expectations.volume).toBe("L*W*T");
    const run = await cli(repo, stateOf(x), ["--changed-since", base]);
    expect(run.code).toBe(1);
    const p = partOf(run);
    expect(p.state).toBe("unverified");
    expect(p.needsAdoption).toBe("expectations");
    // The stored measurement still matches the replay: that is not what the guard trusts.
    expect(p.checks.filter((c: any) => c.id.startsWith("measured.")).every((c: any) => c.ok)).toBe(true);
  });

  test("[A5] gamed: part.json.measured rewritten to match the replay never makes a failing part pass (decision 97)", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    // The agent moves L without approval; the gate fails on it.
    expect((await x.tools.set_parameter!({ name: "L", expression: "100" })).isError).toBe(false);
    expect((await x.check()).state).toBe("fail");
    // …and part.json's measurement is (re)written to be exactly the replay's: it agrees.
    const run = await cli(repo, stateOf(x));
    expect(run.code).toBe(1);
    const p = partOf(run);
    expect(p.checks.filter((c: any) => c.id.startsWith("measured.")).every((c: any) => c.ok)).toBe(true);
    expect(p.state).toBe("fail");
    expect(p.checks.find((c: any) => c.id === "accepted").measured).toContain(MOVED_WITHOUT_APPROVAL);
    expect(p.checks.find((c: any) => c.id === "volume").ok).toBe(false);
  });

  test("[A5] a design.json that fails the script screen is refused: no SolidCraft process is started and nothing is written", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    const outside = join(tempDir("anvil-cad-a5-outside-"), "stolen.json");
    const design = join(repo, "cad", "plate", "design.json");
    const doc = JSON.parse(readFileSync(design, "utf8"));
    doc.commands.push({ command: "parameters.export", params: { path: outside } });
    writeFileSync(design, JSON.stringify(doc, null, 2) + "\n");
    const spawned = recordingSpawn();
    const r = await verifyParts({ worktree: repo, binary: { path: FAKE_SOLIDCRAFT }, lockStore: x.service.locks, manager: { spawn: spawned.spawn } });
    expect(r.ok).toBe(false);
    expect(r.parts[0]).toMatchObject({ part: "plate", state: "fail", ok: false });
    expect(r.parts[0]!.reason).toContain("refused by Anvil's script screen");
    expect(r.parts[0]!.reason).toContain("parameters.export");
    expect(spawned.cmds).toEqual([]); // never handed to SolidCraft
    expect(existsSync(outside)).toBe(false);
    const run = await cli(repo, stateOf(x));
    expect(run.code).toBe(1);
    expect(partOf(run).reason).toContain("script screen");
  });

  test("[A5] a design with a feature error fails on the feature-error check (timeline[].error), though the replay itself succeeded", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    const design = join(repo, "cad", "plate", "design.json");
    // W = 8 leaves no room for the R5 corner fillets: the batch loads, the fillet feature carries an error.
    writeFileSync(design, readFileSync(design, "utf8").replace('"expression": "50 mm"', '"expression": "8 mm"'));
    const run = await cli(repo, stateOf(x));
    expect(run.code).toBe(1);
    const p = partOf(run);
    expect(p.state).toBe("fail");
    const features = p.checks.find((c: any) => c.id === "features");
    expect(features).toMatchObject({ ok: false, hard: true });
    expect(features.measured).toContain("Corners:");
    expect(p.checks.find((c: any) => c.id === "design")).toBeUndefined(); // it loaded; it is the FEATURE that failed
  });

  test("[A5] references: an overlapping reference fails on interference, a clear one passes with the reference left out of the measurement, and an edited refs/ file fails as changed", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    const stateDir = stateOf(x);
    stepFile(repo, ".anvil-downloads/block.step", [0, 0, 0], [10, 10, 10]);
    expect((await asOwner(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/block.step" }))).isError).toBe(false);
    expect((await x.check()).state).toBe("fail");
    let run = await cli(repo, stateDir);
    expect(run.code).toBe(1);
    expect(partOf(run).checks.find((c: any) => c.id === "interference block.step")).toMatchObject({ ok: false, measured: "Body1 overlaps block by 600 mm³" });
    // Moved clear and re-imported: passes, and the 1000 mm³ block is not part of the measured volume.
    stepFile(repo, ".anvil-downloads/block.step", [100, 0, 0], [110, 10, 10]);
    expect((await asOwner(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/block.step" }))).isError).toBe(false);
    expect((await x.check()).state).toBe("pass");
    run = await cli(repo, stateDir);
    expect(run.code).toBe(0);
    const p = partOf(run);
    expect(p.checks.find((c: any) => c.id === "interference block.step")).toMatchObject({ ok: true, measured: "no overlap" });
    expect(p.measurement.volume).toBeCloseTo(23335.167, 2);
    expect(p.measurement.bodies).toBe(1);
    // The committed copy in refs/ edited by hand: the embedded text no longer matches it.
    const refFile = join(repo, "cad", "plate", "refs", "block.step");
    writeFileSync(refFile, readFileSync(refFile, "utf8").replace("ENDSEC;\nEND", "ENDSEC;\n/* edited */\nEND"));
    run = await cli(repo, stateDir);
    expect(run.code).toBe(1);
    expect(partOf(run).state).toBe("unverified");
    expect(partOf(run).checks.find((c: any) => c.id === "ref block.step").measured).toContain(REFERENCE_CHANGED);
  });

  test("[A5] gap → fail; concept → reported, not failing", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    const stateDir = stateOf(x);
    // A concept part beside it: modeled from a picture, dimensions not confirmed.
    expect((await x.tools.open_part!({ part: "bracket", concept: true, process: "fdm-0.4" })).isError).toBe(false);
    expect((await x.tools.batch!({ commands: [{ command: "parameters.add", params: { name: "L", expression: "60 mm" } }, { command: "solid.box", params: { length: "L", width: 20, height: 5, name: "Bracket" } }] })).isError).toBe(false);
    expect((await x.tools.check_part!({ part: "bracket" })).json.state).toBe("concept");
    let run = await cli(repo, stateDir);
    expect(run.code).toBe(0);
    expect(partOf(run, "bracket")).toMatchObject({ state: "concept", ok: true });
    expect(partOf(run, "bracket").reason).toContain("reported, not failing");
    expect(partOf(run, "plate")).toMatchObject({ state: "pass", ok: true });
    const plain = await runVerifyCli(repo, [], { ANVIL_STATE_DIR: stateDir, ANVIL_SOLIDCRAFT_CLI: FAKE_SOLIDCRAFT });
    expect(plain.code).toBe(0);
    expect(plain.stdout).toMatch(/bracket\s+concept\s+ok/);
    // The plate is blocked on a feature SolidCraft cannot make: the guard fails on it.
    expect((await x.tools.report_gap!({ part: "plate", feature: "variable-radius fillet", detail: "the drawing needs 2→5 mm" })).isError).toBe(false);
    run = await cli(repo, stateDir);
    expect(run.code).toBe(1);
    expect(partOf(run, "plate")).toMatchObject({ state: "gap", ok: false });
    expect(partOf(run, "plate").reason).toContain("variable-radius fillet");
    expect(partOf(run, "bracket").ok).toBe(true);
  });

  test("[A5] --changed-since selects the parts changed since the merge base (committed, uncommitted and untracked), every part when cad/rules.json changed, and none for a change outside cad/", async () => {
    const repo = tempRepo();
    git(repo, "checkout", "-q", "-b", "main");
    writeRules(repo, RULES);
    const x = fakeCadSession(repo, fake, "sess_cad", { expectations: "manual" });
    for (const part of ["alpha", "beta", "gamma"]) writeDesign(repo, part, [BOX("Box", 10)]);
    writeFileSync(join(repo, "README.md"), "hello\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "three parts");
    const base = git(repo, "rev-parse", "HEAD");
    const stateDir = stateOf(x);
    const sel = async (args: string[]) => (await cli(repo, stateDir, args)).json;
    expect((await sel(["--changed-since", base])).parts).toEqual([]);
    // A change outside cad/ selects nothing.
    writeFileSync(join(repo, "README.md"), "changed\n");
    git(repo, "commit", "-q", "-am", "docs");
    expect((await sel(["--changed-since", base])).parts.map((p: any) => p.part)).toEqual([]);
    // Committed on a side branch and merged; uncommitted; untracked (a new part).
    git(repo, "checkout", "-q", "-b", "side");
    writeDesign(repo, "alpha", [BOX("Box", 12)]);
    git(repo, "commit", "-q", "-am", "alpha");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-edit", "side");
    writeDesign(repo, "beta", [BOX("Box", 14)]); // not committed
    writeDesign(repo, "delta", [BOX("Box", 8)]); // untracked
    mkdirSync(join(repo, "cad", "gamma", ".cache"), { recursive: true });
    writeFileSync(join(repo, "cad", "gamma", ".cache", "preview-9.glb"), "x"); // daemon-written: not a change
    let r = await sel(["--changed-since", base]);
    expect(r.selection.changed).toEqual(["alpha", "beta", "delta"]);
    expect(r.parts.map((p: any) => p.part)).toEqual(["alpha", "beta", "delta"]);
    // A merged-in ref is an ancestor now: the same answer from the side branch's name.
    expect((await sel(["--changed-since", "side"])).selection.changed).toEqual(["beta", "delta"]);
    // --part adds to the selection.
    expect((await sel(["--changed-since", base, "--part", "gamma"])).parts.map((p: any) => p.part)).toEqual(["alpha", "beta", "delta", "gamma"]);
    // A deleted part folder has nothing to verify.
    git(repo, "rm", "-q", "-r", "cad/alpha");
    r = await sel(["--changed-since", base]);
    expect(r.selection.changed).toContain("alpha");
    expect(r.parts.map((p: any) => p.part)).toEqual(["beta", "delta"]);
    // cad/rules.json changed: every part.
    writeRules(repo, { ...RULES, processes: [...RULES.processes, { id: "sla", kind: "sla", envelope: [100, 100, 100] }] });
    r = await sel(["--changed-since", base]);
    expect(r.selection.rulesChanged).toBe(true);
    expect(r.parts.map((p: any) => p.part)).toEqual(["beta", "delta", "gamma"]);
    // No flag: every part.
    expect((await sel([])).parts.map((p: any) => p.part)).toEqual(["beta", "delta", "gamma"]);
  });

  test("[A5] exit code 2: no binary, a pinned build that is not installed, not a git repo, an unknown ref, a bad argument, an unreadable lock store", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    const stateDir = stateOf(x);
    const noBinary = await runVerifyCli(repo, [], { ANVIL_STATE_DIR: stateDir, ANVIL_SOLIDCRAFT_CLI: join(tempDir(), "solidcraft-cli") });
    expect(noBinary.code).toBe(2);
    expect(noBinary.stderr).toContain("solidcraft-cli was not found");
    // A pin recorded in the state dir with no verified install: the daemon would refuse CAD here, so does the guard.
    const pinned = tempDir("anvil-cad-a5-pinned-");
    writeFileSync(join(pinned, PIN_FILE), JSON.stringify({ version: "0.44.1", sha256: "a".repeat(64), pinnedAt: new Date().toISOString() }));
    const off = await runVerifyCli(repo, [], { ANVIL_STATE_DIR: pinned });
    expect(off.code).toBe(2);
    expect(off.stderr).toContain("pins SolidCraft 0.44.1, which is not installed");
    const notRepo = await runVerifyCli(tempDir(), [], { ANVIL_STATE_DIR: stateDir, ANVIL_SOLIDCRAFT_CLI: FAKE_SOLIDCRAFT });
    expect(notRepo.code).toBe(2);
    expect(notRepo.stderr).toContain("not inside a git repository");
    const badRef = await runVerifyCli(repo, ["--changed-since", "no-such-branch"], { ANVIL_STATE_DIR: stateDir, ANVIL_SOLIDCRAFT_CLI: FAKE_SOLIDCRAFT });
    expect(badRef.code).toBe(2);
    expect(badRef.stderr).toContain("is not a commit");
    expect((await runVerifyCli(repo, ["--binary", "/bin/sh"], { ANVIL_STATE_DIR: stateDir, ANVIL_SOLIDCRAFT_CLI: FAKE_SOLIDCRAFT })).code).toBe(2); // there is no such flag
    expect((await runVerifyCli(repo, ["--changed-since"], { ANVIL_STATE_DIR: stateDir, ANVIL_SOLIDCRAFT_CLI: FAKE_SOLIDCRAFT })).code).toBe(2);
    expect((await runVerifyCli(repo, ["--part", "../etc"], { ANVIL_STATE_DIR: stateDir, ANVIL_SOLIDCRAFT_CLI: FAKE_SOLIDCRAFT })).code).toBe(2);
    // An unreadable lock store is reported and left exactly where it is (never quarantined by a reader).
    const corrupt = tempDir("anvil-cad-a5-corrupt-");
    mkdirSync(join(corrupt, "cadwork"));
    writeFileSync(join(corrupt, "cadwork", "locks.json"), "{ not json");
    const bad = await runVerifyCli(repo, [], { ANVIL_STATE_DIR: corrupt, ANVIL_SOLIDCRAFT_CLI: FAKE_SOLIDCRAFT });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("could not be read");
    expect(readdirSync(join(corrupt, "cadwork"))).toEqual(["locks.json"]);
    expect(readFileSync(join(corrupt, "cadwork", "locks.json"), "utf8")).toBe("{ not json");
  });

  test("[A5] verify never writes: the lock store, part.json, design.json, rules.json and the worktree are byte-identical after failing and passing runs; a state dir with no lock store gets no folder", async () => {
    const m = await twoBranchMerge(FAKE_SOLIDCRAFT);
    const stateBefore = snapshot(m.stateDir);
    const repoBefore = snapshot(m.repo);
    const status = git(m.repo, "status", "--porcelain", "--untracked-files=all");
    const exclude = readFileSync(join(m.repo, ".git", "info", "exclude"), "utf8");
    expect((await cli(m.repo, m.stateDir)).code).toBe(1);
    expect((await runVerifyCli(m.repo, ["--changed-since", m.base], { ANVIL_STATE_DIR: m.stateDir, ANVIL_SOLIDCRAFT_CLI: FAKE_SOLIDCRAFT })).code).toBe(1);
    expect(await m.service.verifyParts(m.repo)).toMatchObject({ ok: false });
    expect(snapshot(m.stateDir)).toEqual(stateBefore);
    expect(snapshot(m.repo)).toEqual(repoBefore);
    expect(git(m.repo, "status", "--porcelain", "--untracked-files=all")).toBe(status);
    expect(readFileSync(join(m.repo, ".git", "info", "exclude"), "utf8")).toBe(exclude);
    // Passing runs write nothing either.
    await m.tools.check_part!({ part: "plate" });
    const after = snapshot(m.repo);
    const lockAfter = snapshot(m.stateDir);
    expect((await cli(m.repo, m.stateDir)).code).toBe(0);
    expect(snapshot(m.repo)).toEqual(after);
    expect(snapshot(m.stateDir)).toEqual(lockAfter);
    // A state dir with nothing in it stays empty: the read-only store creates no folder.
    const bare = tempDir("anvil-cad-a5-bare-");
    expect((await cli(m.repo, bare)).code).toBe(1);
    expect(readdirSync(bare)).toEqual([]);
  });

  test("[A5] the service's verifyParts (what Phase B3's hook calls) gives the CLI's verdicts in process, and refuses with the reason when CAD is unavailable here", async () => {
    const m = await twoBranchMerge(FAKE_SOLIDCRAFT);
    const before = await m.service.verifyParts(m.repo, { changedSince: m.base });
    expect(before.ok).toBe(false);
    expect(before.selection.changed).toEqual(["plate"]);
    expect(before.parts.map((p) => [p.part, p.state])).toEqual([["plate", "fail"]]);
    expect(before.parts[0]!.failing[0]).toStartWith("measured.scriptSha");
    await m.tools.check_part!({ part: "plate" });
    const after = await m.service.verifyParts(m.repo, { parts: ["plate"] });
    expect(after).toMatchObject({ ok: true, parts: [{ part: "plate", state: "pass", ok: true }] });
    // Off the pin (or no binary): no verdict, the reason instead.
    m.service.setPinSource(async () => ({ available: false, reason: "this machine is not on the fleet's SolidCraft pin" }));
    await m.service.refreshStatus();
    const off = await m.service.verifyParts(m.repo);
    expect(off.ok).toBe(false);
    expect(off.error).toContain("not on the fleet's SolidCraft pin");
    expect(off.parts).toEqual([]);
  });
});


