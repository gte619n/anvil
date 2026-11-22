/**
 * [A3] The daemon side of the parameters panel (agent-cad-and-browser spec §4.8, §4.9): which `cwd` a
 * client command may name, what `cad.param.set` refuses, which file the preview route will hand out,
 * the parts list, and the once-only owner-change note. Real Supervisor / service; SolidCraft is the fake.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { AccountStore } from "../../src/auth/accounts";
import { partRef } from "../../src/cadwork/partfolder";
import { ConnectionRegistry } from "../../src/server/registry";
import { CWD_REFUSED } from "../../src/session/cadwork-service";
import { BadCommand } from "../../src/session/errors";
import { Supervisor } from "../../src/session/supervisor";
import { cleanupTemp, fakeCadSession, stopServices, tempDir, tempRepo } from "../helpers/cad-work";
import { FAKE_SOLIDCRAFT } from "../helpers/fake-solidcraft";

const saved = process.env.ANVIL_SOLIDCRAFT_CLI;
beforeAll(() => void (process.env.ANVIL_SOLIDCRAFT_CLI = FAKE_SOLIDCRAFT));
afterAll(() => {
  if (saved === undefined) delete process.env.ANVIL_SOLIDCRAFT_CLI;
  else process.env.ANVIL_SOLIDCRAFT_CLI = saved;
});
const supervisors: Supervisor[] = [];
const states: string[] = [];
afterEach(async () => {
  await stopServices();
  for (const s of supervisors.splice(0)) await s.shutdown().catch(() => undefined);
  for (const d of states.splice(0)) rmSync(d, { recursive: true, force: true });
  cleanupTemp();
});
function supervisor(features: string[] = ["cad-work"]) {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "anvil-cad-a3-unit-")));
  states.push(stateDir);
  const accounts = new AccountStore(stateDir);
  accounts.add("test", "sk-ant-oat01-testtesttest-0000");
  const sup = new Supervisor({ stateDir, accounts, envFile: join(stateDir, "env"), features }, new ConnectionRegistry());
  supervisors.push(sup);
  return sup;
}
const createCmd = (cwd: string) => ({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd }) as any;
const fake = { resolveCli: () => ({ path: FAKE_SOLIDCRAFT, source: "env" as const }) };
const plate = async (x: ReturnType<typeof fakeCadSession>) => {
  await x.tools.open_part!({ part: "plate" });
  const r = await x.tools.batch!({ commands: [{ command: "parameters.add", params: { name: "L", expression: "80 mm" } }, { command: "solid.box", params: { length: "L", width: 50, height: 6, name: "Plate" } }] });
  expect(r.isError).toBe(false);
  await x.tools.check_part!({ part: "plate" });
};

test("[A3] cwd is validated server-side: only the worktree of an existing session or a registered environment is accepted", async () => {
  const sup = supervisor();
  const repo = tempRepo();
  const envRepo = tempRepo();
  const stranger = tempRepo(); // a perfectly good git repo the daemon was never told about
  mkdirSync(join(repo, "sub", "dir"), { recursive: true });
  // Nothing is known yet: every path is refused, a real repo included.
  expect(() => sup.cadWorktree(repo)).toThrow(BadCommand);
  await sup.create(createCmd(join(repo, "sub", "dir"))); // a session whose cwd is a SUB-FOLDER of the worktree
  sup.addEnvironment("widgets", envRepo);

  expect(sup.cadWorktree(repo)).toBe(repo); // the session's git toplevel
  expect(sup.cadWorktree(repo + "/")).toBe(repo);
  expect(sup.cadWorktree(envRepo)).toBe(envRepo); // a registered environment's repo
  for (const bad of [stranger, join(repo, "sub", "dir"), join(repo, "sub"), tempDir(), "/", "/etc", "/tmp", "", "relative/path", "../" + repo, undefined, null, 7, { cwd: repo }, join(repo, "..")]) {
    expect(() => sup.cadWorktree(bad)).toThrow(CWD_REFUSED);
  }
  // A link TO a known worktree resolves to it; a link from inside it to somewhere else does not get in.
  const link = join(tempDir(), "link");
  symlinkSync(repo, link);
  expect(sup.cadWorktree(link)).toBe(repo);
  const out = join(tempDir(), "out");
  symlinkSync(stranger, out);
  expect(() => sup.cadWorktree(out)).toThrow(CWD_REFUSED);

  // The three commands and the preview route all go through it.
  await expect(sup.cadPartsListEvent(stranger, "c1")).rejects.toThrow(CWD_REFUSED);
  await expect(sup.setCadParam(stranger, "plate", "L", "120", "c2")).rejects.toThrow(CWD_REFUSED);
  await expect(sup.refreshCadDesign(stranger, "plate")).rejects.toThrow(CWD_REFUSED);
  expect(await sup.cadPartsListEvent(repo, "c3")).toMatchObject({ type: "cad.parts.list.result", cid: "c3", cwd: repo, parts: [] });
});

test("[A3] with cad-work off every cad command is refused, whatever the cwd", async () => {
  const sup = supervisor([]);
  const repo = tempRepo();
  await sup.create(createCmd(repo));
  expect(() => sup.cadWorktree(repo)).toThrow("cad-work is not enabled");
  await expect(sup.cadPartsListEvent(repo)).rejects.toThrow("cad-work is not enabled");
});

test("[A3] cad.param.set refuses a bad part name, a part with no design, and a missing name or expression — without starting SolidCraft", async () => {
  const repo = tempRepo();
  const x = fakeCadSession(repo, fake);
  mkdirSync(join(repo, "cad", "ghost"), { recursive: true });
  await expect(x.service.setParam(repo, "../etc", "L", "1")).rejects.toThrow("invalid part name");
  await expect(x.service.setParam(repo, "cad/plate", "L", "1")).rejects.toThrow("invalid part name");
  expect(await x.service.setParam(repo, "ghost", "L", "1")).toEqual({ ok: false, error: "cad/ghost has no design yet" });
  expect((await x.service.setParam(repo, "ghost", "", "1")).error).toContain("`name`");
  expect((await x.service.setParam(repo, "ghost", "L", "  ")).error).toContain("`expression`");
  expect((await x.service.setParam(repo, "ghost", "L", { a: 1 })).error).toContain("`expression`");
  expect(x.manager.liveCount()).toBe(0);
  await expect(x.service.refreshDesign(repo, "nope")).rejects.toThrow("cad/nope does not exist");
});

test("[A3] the preview route's file: only cad/<part>/.cache/preview-<rev>.glb of that worktree, never a link out of it", async () => {
  const repo = tempRepo();
  const x = fakeCadSession(repo, fake);
  await plate(x);
  const ev = x.design("plate");
  const abs = x.service.previewFile(repo, ev.preview)!;
  expect(abs).toBe(join(repo, ev.preview));
  expect(readFileSync(abs).subarray(0, 4).toString("latin1")).toBe("glTF");
  const secret = join(tempDir(), "secret.glb");
  writeFileSync(secret, "secret");
  symlinkSync(secret, join(repo, "cad", "plate", ".cache", "preview-999.glb"));
  for (const bad of [
    "cad/plate/design.json",
    "cad/plate/part.json",
    "cad/plate/.cache/design.conflict.json",
    "cad/plate/.cache/exports/plate.glb",
    `cad/plate/.cache/../.cache/preview-${ev.rev}.glb`,
    `../${repo.split("/").pop()}/${ev.preview}`,
    join(repo, ev.preview), // absolute
    "cad/plate/.cache/preview-999.glb", // exists, but is a link to a file outside the part
    "cad/plate/.cache/preview-123456.glb", // no such revision
    "cad/Plate/.cache/preview-1.glb",
    "cad/../cad/plate/.cache/preview-1.glb",
    ".git/config",
    "",
  ]) {
    expect(x.service.previewFile(repo, bad)).toBeUndefined();
  }
});

test("[A3] cad.parts.list reports every part folder with its gate state, preview and liveness, and starts nothing", async () => {
  const repo = tempRepo();
  const x = fakeCadSession(repo, fake);
  await plate(x);
  mkdirSync(join(repo, "cad", "bracket"), { recursive: true });
  writeFileSync(join(repo, "cad", "bracket", "design.json"), JSON.stringify({ about: { design: "bracket", format: "solidcraft/58" }, commands: [] }));
  mkdirSync(join(repo, "cad", "Not A Part"), { recursive: true });
  symlinkSync(join(repo, "cad", "plate"), join(repo, "cad", "alias"));
  const live = x.manager.liveCount();
  const parts = await x.service.listParts(repo);
  expect(parts.map((p) => p.part)).toEqual(["bracket", "plate"]); // not the invalid name, not the link
  const ev = x.design("plate");
  expect(parts[1]).toMatchObject({ part: "plate", hasDesign: true, live: true, rev: ev.rev, preview: ev.preview, gate: { state: ev.gate.state } });
  expect(parts[0]).toMatchObject({ part: "bracket", hasDesign: true, live: false, busy: false, rev: 0 });
  expect(parts[0]!.preview).toBeUndefined();
  expect(parts[0]!.gate.state).not.toBe("pass"); // never measured: it cannot be passing
  expect(x.manager.liveCount()).toBe(live);
  expect(x.manager.status(partRef(repo, "bracket"))).toBeUndefined();
});

test("[A3] the owner-change note names the parameter and value, reaches every session on the part, and is delivered once", async () => {
  const repo = tempRepo();
  const x = fakeCadSession(repo, fake);
  await plate(x);
  x.service.touch("sess_other", partRef(repo, "plate"));
  expect(x.service.takeOwnerNotes("sess_cad")).toEqual([]);
  expect(await x.service.setParam(repo, "plate", "L", "120")).toEqual({ ok: true });
  expect(await x.service.setParam(repo, "plate", "L", "100 + 25")).toEqual({ ok: true });
  // A refused change is not a change: no note.
  expect((await x.service.setParam(repo, "plate", "Nope", "1")).ok).toBe(false);

  const other = x.service.takeOwnerNotes("sess_other");
  expect(other).toHaveLength(2);
  expect(other[0]).toContain("owner changed L to 120");
  expect(other[0]).toContain("cad/plate");
  expect(other[1]).toContain("owner changed L to 100 + 25 (= 125)");
  // Through the agent's tools: on the next result, whichever tool it is, and never again.
  const next = await x.tools.measure!({ summary: true });
  expect(next.isError).toBe(false);
  expect(next.notes.filter((n) => n.includes("owner changed L"))).toHaveLength(2);
  const after = await x.tools.measure!({ summary: true });
  expect(after.text).not.toContain("owner changed");
  expect(x.service.takeOwnerNotes("sess_cad")).toEqual([]);
  expect(x.service.takeOwnerNotes("sess_unknown")).toEqual([]);
  // A session that is reset loses notes it never read.
  await x.service.setParam(repo, "plate", "L", "90");
  x.service.cancelSession("sess_cad");
  expect(x.service.takeOwnerNotes("sess_cad")).toEqual([]);
});
