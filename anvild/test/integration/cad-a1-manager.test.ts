/**
 * [A1] Functional scenario for Phase A1 (agent-cad-and-browser spec §5 "Phase A1", §8.2): the real
 * CadworkService and CadManager, driven through the agent's `anvil_cad` tools, with SolidCraft
 * replaced by the fake server through `ANVIL_SOLIDCRAFT_CLI` (the same route production resolves a
 * binary by). One test per Acceptance bullet, in the spec's order, then the A1 functional edge case.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { CAD_TOOL_IDS, cadTools } from "../../src/agent/cad-tools";
import { makePreToolUseHook, type PermissionBroker } from "../../src/agent/permissions";
import { AccountStore } from "../../src/auth/accounts";
import { loadConfig } from "../../src/config";
import { partRef } from "../../src/cadwork/partfolder";
import { scriptSha } from "../../src/cadwork/poststep";
import { ConnectionRegistry } from "../../src/server/registry";
import { Supervisor } from "../../src/session/supervisor";
import { FakeClock, callable, cleanupTemp, fakeCadSession, stopServices, tempDir, tempRepo, until, writeDesign } from "../helpers/cad-work";
import { FAKE_SOLIDCRAFT, REFERENCE_PLATE, startFake } from "../helpers/fake-solidcraft";

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ["ANVIL_SOLIDCRAFT_CLI", "ANVIL_CAD_MAX_PROCS"]) saved[k] = process.env[k];
  process.env.ANVIL_SOLIDCRAFT_CLI = FAKE_SOLIDCRAFT; // every service below resolves the fake, as production would resolve a real binary
  delete process.env.ANVIL_CAD_MAX_PROCS;
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

/** A real Supervisor whose features come from an ANVIL_FEATURES value, exactly as main.ts reads it. */
function supervisor(anvilFeatures: string | undefined) {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "anvil-cad-a1-state-")));
  stateDirs.push(stateDir);
  const config = loadConfig({ HOME: stateDir, ...(anvilFeatures === undefined ? {} : { ANVIL_FEATURES: anvilFeatures }) });
  // A driver cannot be constructed without a Claude credential; no turn is ever run with this one.
  const accounts = new AccountStore(stateDir);
  accounts.add("test", "sk-ant-oat01-testtesttest-0000");
  const sup = new Supervisor({ stateDir, accounts, envFile: join(stateDir, "env"), features: config.features }, new ConnectionRegistry());
  supervisors.push(sup);
  return { sup, config };
}
const createCmd = (cwd: string, more: Record<string, unknown> = {}) => ({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd, ...more }) as any;
/** What the session's driver was actually constructed with. */
const driverOf = (sup: Supervisor, id: string) => (sup as any).ensureDriver(id) as { mcpServers?: Record<string, unknown>; extraAllowedTools?: string[] };

describe("Phase A1 acceptance", () => {
  test("[A1] acceptance 1: open_part then the 16-command batch writes cad/plate/design.json, which replays in a fresh process to the live volume", async () => {
    const repo = tempRepo();
    const { tools, service } = fakeCadSession(repo);
    expect(service.status().available).toBe(true);
    expect(REFERENCE_PLATE).toHaveLength(16);

    expect((await tools.open_part!({ part: "plate" })).isError).toBe(false);
    const built = await tools.batch!({ commands: REFERENCE_PLATE });
    expect(built.isError).toBe(false);
    expect(built.json).toMatchObject({ completed: 16, ok: true });

    const live = (await tools.measure!({})).json;
    expect(live.total.volume_mm3).toBeCloseTo(23335.2, 1);
    expect(live.bodies[0].faces).toBe(22);

    // The script exists, is the committed-shape file, and is what the manager says it wrote.
    const path = join(repo, "cad", "plate", "design.json");
    expect(existsSync(path)).toBe(true);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(doc.about.design).toBe("plate");
    expect(doc.about.format).toBe("solidcraft/58");
    expect(doc.commands.length).toBeGreaterThan(0);
    expect(service.manager.status(partRef(repo, "plate"))!.scriptSha).toBe(scriptSha(doc.commands));

    // Replay it in a FRESH process that has nothing to do with the manager: same volume, to the bit.
    const fresh = await startFake({ allow: [join(repo, "cad", "plate")], inFile: path });
    try {
      const replayed = (await fresh.call("measure", {})).json;
      expect(replayed.total.volume_mm3).toBe(live.total.volume_mm3);
      expect(replayed.bodies[0].faces).toBe(22);
      expect(replayed.bodies[0].bbox).toEqual(live.bodies[0].bbox);
    } finally {
      await fresh.close();
    }
  });

  test("[A1] acceptance 2: killing the process between two calls, the second call succeeds and the design is intact", async () => {
    const repo = tempRepo();
    const { tools, manager } = fakeCadSession(repo);
    const ref = partRef(repo, "plate");
    await tools.open_part!({ part: "plate" });
    await tools.batch!({ commands: REFERENCE_PLATE });
    const first = await tools.measure!({ summary: true }); // call one
    expect(first.isError).toBe(false);
    const script = readFileSync(join(ref.dir, "design.json"), "utf8");

    const pid = manager.status(ref)!.pid!;
    process.kill(pid, "SIGKILL");
    await until(() => manager.status(ref)!.live === false, "the manager to see the process die");

    const second = await tools.measure!({ summary: true }); // call two
    expect(second.isError).toBe(false);
    expect(second.json.total.volume_mm3).toBe(first.json.total.volume_mm3);
    expect(second.json.bodies[0].faces).toBe(22);
    expect(manager.status(ref)!.pid).not.toBe(pid);
    expect(readFileSync(join(ref.dir, "design.json"), "utf8")).toBe(script);
    // …and it is still a working design: a change after the restart lands on top of it.
    expect((await tools.set_parameter!({ name: "L", expression: "120" })).isError).toBe(false);
    expect((await tools.measure!({ summary: true })).json.total.volume_mm3).toBeCloseTo(35335.2, 1);
  });

  test("[A1] acceptance 3: with a cap of 1, a second part's first call waits and then succeeds when the first goes idle", async () => {
    const repo = tempRepo();
    process.env.ANVIL_CAD_MAX_PROCS = "1"; // the cap comes from the environment, as on a real machine
    const clock = new FakeClock();
    let a: ReturnType<typeof fakeCadSession>;
    try {
      a = fakeCadSession(repo, { manager: { clock, extraEnv: { FAKE_SC_DELAY_MS: "50" } } }, "sess_a");
    } finally {
      delete process.env.ANVIL_CAD_MAX_PROCS;
    }
    const { manager, service } = a;
    expect(manager.maxProcs).toBe(1);
    // A second session of the same daemon, working on a second part.
    const b = callable(cadTools(service.toolDeps("sess_b", repo)) as any);
    const [plate, bracket] = [partRef(repo, "plate"), partRef(repo, "bracket")];

    await a.tools.open_part!({ part: "plate" });
    const busy = a.tools.batch!({ commands: REFERENCE_PLATE }); // the first part is busy
    let done = false;
    const firstCall = b.open_part!({ part: "bracket" }).then((r) => {
      done = true;
      return r;
    });
    await until(() => manager.status(bracket)?.waitingForSlot === true, "the second part to wait for a slot");
    expect(done).toBe(false);
    expect(manager.status(bracket)).toMatchObject({ waitingForSlot: true, live: false }); // "waiting for a CAD slot" is visible
    expect(manager.liveCount()).toBe(1);

    expect((await busy).isError).toBe(false); // the first part goes idle…
    const opened = await firstCall; // …and the second part's first call succeeds
    expect(opened.isError).toBe(false);
    expect(opened.json).toMatchObject({ part: "bracket", state: "unverified" });
    expect(opened.notes.join(" ")).toContain("waited for a CAD slot");
    expect(manager.status(bracket)).toMatchObject({ waitingForSlot: false, live: true });
    expect(manager.status(plate)!.live).toBe(false); // the idle process made room
    expect(manager.liveCount()).toBe(1);

    // Nothing of the first part was lost, and it takes the slot back when it is used again.
    expect((await a.tools.measure!({ summary: true })).json.total.volume_mm3).toBeCloseTo(23335.2, 1);
    expect(manager.liveCount()).toBe(1);
    // Left alone for 10 minutes, the last process exits by itself and the slot is simply free.
    clock.advance(10 * 60_000);
    await until(() => manager.liveCount() === 0, "the idle exit");
    const later = await b.measure!({ summary: true });
    expect(later.isError).toBe(false);
    expect(later.notes.join(" ")).not.toContain("waited for a CAD slot");
  });

  test("[A1] acceptance 4: editing design.json on disk, then calling measure, the result reflects the edited file", async () => {
    const repo = tempRepo();
    const { tools } = fakeCadSession(repo);
    await tools.open_part!({ part: "plate" });
    await tools.batch!({ commands: REFERENCE_PLATE });
    expect((await tools.measure!({ summary: true })).json.total.volume_mm3).toBeCloseTo(23335.2, 1);

    // A hand edit (or a checkout, or a merge): L goes from 80 to 120 in the script itself.
    const path = join(repo, "cad", "plate", "design.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    const L = doc.commands.find((c: any) => c.command === "parameters.add" && c.params.name === "L");
    expect(L.params.expression).toBe("80 mm");
    L.params.expression = "120 mm";
    writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");

    const measured = await tools.measure!({ summary: true });
    expect(measured.isError).toBe(false);
    expect(measured.json.total.volume_mm3).toBeCloseTo(35335.2, 1); // the edited file, not the old session
    expect(measured.notes.join(" ")).toContain("was changed on disk, so the design was reloaded");
    expect((await tools.inspect_design!({ measure: false, sketches: false })).json.params[0]).toMatchObject({ name: "L", value: 120 });
    // The hand-edited file was read, not rewritten.
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(doc);
  });

  test('[A1] acceptance 5: open_part {part:"../x"} is refused; under allowlist measure does not prompt and execute does', async () => {
    const repo = tempRepo();
    const { sup } = supervisor("cad-work");
    const s = await sup.create(createCmd(repo, { autonomy: "allowlist" }));
    expect(s.data.autonomy).toBe("allowlist");
    expect(Object.keys(driverOf(sup, s.id).mcpServers ?? {})).toEqual(["anvil_cad"]);

    // The tools this session got refuse a path where a part name belongs.
    const tools = callable(cadTools(sup.cadwork.toolDeps(s.id, repo)) as any);
    const refused = await tools.open_part!({ part: "../x" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("invalid part name");
    expect(refused.text).toContain("not a path");
    expect(existsSync(join(repo, "cad"))).toBe(false);
    expect(existsSync(join(repo, "..", "x"))).toBe(false);
    expect(sup.cadwork.manager.liveCount()).toBe(0);

    // The permission gate, with the real session: a read passes silently, a change asks.
    const hook = makePreToolUseHook(s, (sup as unknown as { broker: PermissionBroker }).broker); // the gate the driver registers
    const ctx = { signal: new AbortController().signal } as any;
    const asked: any[] = [];
    const realRequest = s.requestPermission.bind(s);
    s.requestPermission = ((requestId: string, tool: string, input: unknown, suggestions: any) => {
      asked.push({ requestId, tool });
      return realRequest(requestId, tool, input as any, suggestions);
    }) as typeof s.requestPermission;

    const measure = (await hook({ tool_name: "mcp__anvil_cad__measure", tool_input: {} } as any, "t1", ctx)) as any;
    expect(measure.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(asked).toEqual([]);
    expect(s.hasPendingPermission()).toBe(false);

    const pending = hook({ tool_name: "mcp__anvil_cad__execute", tool_input: { command: "solid.box" } } as any, "t2", ctx) as Promise<any>;
    await until(() => asked.length === 1, "the permission prompt");
    expect(asked[0].tool).toBe("mcp__anvil_cad__execute");
    expect(s.hasPendingPermission()).toBe(true);
    sup.resolvePermission(asked[0].requestId, "deny");
    expect((await pending).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("[A1] acceptance 6: with cad-work absent from ANVIL_FEATURES, the session has no anvil_cad server", async () => {
    const repo = tempRepo();
    for (const features of [undefined, "", "browser,solidcraft-pin"]) {
      const { sup, config } = supervisor(features);
      expect(config.features).not.toContain("cad-work");
      const s = await sup.create(createCmd(repo));
      const driver = driverOf(sup, s.id);
      expect(driver.mcpServers).toBeUndefined(); // exactly what an ordinary session had before this feature
      expect(driver.extraAllowedTools).toBeUndefined();
      expect(sup.cadwork.enabled).toBe(false);
    }

    // The control: the same session on a daemon WITH the flag gets it — and still no allowedTools
    // entry, so every anvil_cad call has to go through the PreToolUse hook.
    const { sup, config } = supervisor("cad-work");
    expect(config.features).toEqual(["cad-work"]);
    const s = await sup.create(createCmd(repo));
    const driver = driverOf(sup, s.id);
    expect(Object.keys(driver.mcpServers!)).toEqual(["anvil_cad"]);
    expect((driver.mcpServers!.anvil_cad as any).type).toBe("sdk");
    expect(driver.extraAllowedTools).toBeUndefined();
    for (const id of CAD_TOOL_IDS) expect(driver.extraAllowedTools ?? []).not.toContain(id);
    // Not a git repo → no CAD, flag or not. Role sessions keep their own server only.
    const plain = await sup.create(createCmd(tempDir()));
    expect(driverOf(sup, plain.id).mcpServers).toBeUndefined();
    const lead = await sup.create(createCmd(repo, { teamRole: "lead" }));
    expect(Object.keys(driverOf(sup, lead.id).mcpServers!)).toEqual(["anvil_team"]);
  });
});

describe("Phase A1 functional edge cases", () => {
  test("[A1] a design.json that fails to replay: the process starts empty, the part fails with the failing step, and the file is kept until a change succeeds", async () => {
    const repo = tempRepo();
    const path = writeDesign(repo, "plate", [...REFERENCE_PLATE.slice(0, 4), { command: "solid.bogus", params: {} }]);
    const original = readFileSync(path, "utf8");
    const { tools, manager } = fakeCadSession(repo);

    const opened = await tools.open_part!({ part: "plate" });
    expect(opened.isError).toBe(false);
    expect(opened.json.state).toBe("fail");
    // The failing step of the script, a `timeline.add` (the batch load names the step's command).
    expect(opened.json.reason).toBe("design.json failed to replay: step 5 (timeline.add): unknown command `solid.bogus`");
    expect(opened.json.has_design).toBe(true);
    expect(opened.json.parameters).toEqual([]); // empty: not even the four parameters before the bad step
    expect(opened.notes.join(" ")).toContain("started EMPTY");

    const measured = await tools.measure!({ summary: true });
    expect(measured.json.body_count).toBe(0);
    expect(measured.notes.join(" ")).toContain("FAILED state");
    expect((await tools.execute!({ command: "solid.bogus", params: {} })).isError).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(original); // untouched by reads and by failed changes

    const built = await tools.batch!({ commands: REFERENCE_PLATE });
    expect(built.isError).toBe(false);
    expect(readFileSync(path, "utf8")).not.toBe(original);
    expect(manager.status(partRef(repo, "plate"))!.state.status).toBe("unverified");
    expect(readFileSync(join(repo, "cad", "plate", ".cache", "design.unreplayable.json"), "utf8")).toBe(original);
    expect((await tools.measure!({ summary: true })).notes).toEqual([]);
  });

  test("[A1] cad.status follows server.hello on a daemon with cad-work, and is absent without it", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "sk-ant-oat-test-placeholder"; // as test/unit/features.test.ts boots a server
    const { createServer } = await import("../../src/server/http");
    const frames = (port: number) =>
      new Promise<any[]>((resolve, reject) => {
        const seen: any[] = [];
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.onmessage = (m) => {
          const ev = JSON.parse(String(m.data));
          seen.push(ev);
          if (ev.type === "todoist.status") {
            ws.close();
            resolve(seen);
          }
        };
        ws.onerror = () => reject(new Error("ws error"));
      });
    const boot = (features: string[]) => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "anvil-cad-a1-srv-")));
      stateDirs.push(dir);
      return createServer({ host: "127.0.0.1", port: 0, stateDir: dir, envFile: join(dir, "env"), features });
    };
    const on = boot(["cad-work"]);
    const off = boot([]);
    try {
      const withCad = await frames(on.port);
      expect(withCad[0].type).toBe("server.hello");
      expect(withCad[0].capabilities).toContain("cad-work");
      const status = withCad.filter((f) => f.type === "cad.status");
      expect(status).toHaveLength(1);
      expect(status[0]).toMatchObject({ v: PROTOCOL_VERSION, type: "cad.status", available: true });
      expect(status[0].reason).toBeUndefined();

      const without = await frames(off.port);
      expect(without[0].capabilities).not.toContain("cad-work");
      expect(without.filter((f) => f.type === "cad.status")).toEqual([]);
    } finally {
      on.stop();
      off.stop();
    }
  });
});
