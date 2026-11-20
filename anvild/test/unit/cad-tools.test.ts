/**
 * [A1] The `anvil_cad` tool server, its permission classes, and the service that owns it
 * (agent-cad-and-browser spec §4.4, §4.8, D10). Handlers are driven directly; SolidCraft is the fake.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionSuggestion } from "@protocol";
import {
  CAD_MCP_SERVER_NAME,
  CAD_MUTATING_TOOL_IDS,
  CAD_READ_ONLY_TOOL_IDS,
  CAD_TOOL_IDS,
  buildCadToolsServer,
  CAD_COMMAND_ALLOW,
  cadTools,
  isAllowedCommand,
  refusedCommand,
  refusedStep,
} from "../../src/agent/cad-tools";
import { registerCadProtectedRules } from "../../src/agent/cad-protected";
import { CAD_OWNER_CARD_TOOL_IDS } from "../../src/agent/cad-tool-ids";
import { isReadOnly } from "../../src/agent/danger-list";
import { PermissionBroker, makePreToolUseHook } from "../../src/agent/permissions";
import { QuestionBroker, makeCanUseTool } from "../../src/agent/questions";
import type { CadManager } from "../../src/cadwork/manager";
import { CadworkService, NO_SOLIDCRAFT } from "../../src/session/cadwork-service";
import type { Session } from "../../src/session/session";
import { BOX, STUB_GATE_DEPS, callable, cleanupTemp, fakeCadSession, recordingSpawn, stopServices, tempDir, tempRepo } from "../helpers/cad-work";
import { FAKE_SOLIDCRAFT, REFERENCE_PLATE } from "../helpers/fake-solidcraft";

afterEach(async () => {
  await stopServices();
  cleanupTemp();
});

const fake = (repo: string, extraEnv: Record<string, string> = {}, spawn = recordingSpawn()) =>
  fakeCadSession(repo, { resolveCli: () => ({ path: FAKE_SOLIDCRAFT, source: "env" }), readVersion: async () => "0.44.1", manager: { extraEnv, spawn: spawn.spawn } });

/** A manager stand-in that records what would have reached SolidCraft. */
function recordingManager() {
  const requests: any[] = [];
  const manager = {
    open: async () => ({ notes: [], reloaded: false, waitedForSlot: false, state: { status: "unverified", featureErrors: [], featureWarnings: [], conflict: false }, params: [], hasDesign: false }),
    request: async (_ref: unknown, req: unknown) => {
      requests.push(req);
      return { result: { isError: false, content: [{ type: "text", text: "{}" }], texts: ["{}"], text: "{}", json: {}, images: [] }, notes: [], reloaded: false, waitedForSlot: false, wrote: false, state: { status: "unverified", featureErrors: [], featureWarnings: [], conflict: false } };
    },
    status: () => undefined,
  } as unknown as CadManager;
  return { manager, requests };
}

describe("anvil_cad names and permission classes", () => {
  test("[A1] the server is named anvil_cad and exposes exactly the A1 tools", () => {
    expect(CAD_MCP_SERVER_NAME).toBe("anvil_cad");
    const { manager } = recordingManager();
    const defs = cadTools({ sessionId: "s", worktree: "/tmp", manager, unavailable: () => undefined, offerFile: () => true, ...STUB_GATE_DEPS });
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(
      // The A1 tools, plus Phase A2's check_part, propose_expectations and record_expectations, plus
      // Phase A4's import_reference, release_part, report_gap and request_dimensions.
      ["batch", "body_topology", "check_parameters", "check_part", "compare_picture", "describe_command", "execute", "export_part", "import_reference", "inspect_design", "list_commands", "measure", "open_part", "propose_expectations", "record_expectations", "redo", "release_part", "report_gap", "request_dimensions", "screenshot", "set_parameter", "skill_reference", "undo"],
    );
    // SolidCraft's own file tools are not there under any name.
    for (const hidden of ["open", "save", "export", "new_design", "crash_reports"]) expect(names).not.toContain(hidden);
    // Every tool is in exactly one permission class, and the ids are the SDK's mcp__server__tool form.
    expect([...CAD_TOOL_IDS].sort()).toEqual(names.map((n) => `mcp__anvil_cad__${n}`));
    expect(CAD_READ_ONLY_TOOL_IDS.filter((id) => CAD_MUTATING_TOOL_IDS.includes(id))).toEqual([]);
    expect(CAD_TOOL_IDS).toHaveLength(names.length);
    const server = buildCadToolsServer({ sessionId: "s", worktree: "/tmp", manager, unavailable: () => undefined, offerFile: () => true, ...STUB_GATE_DEPS });
    // (Not `server.name`: other suites replace the SDK module process-wide with a stub that names
    // every server "mock". The name that matters is the key the driver registers it under.)
    expect(server.type).toBe("sdk");
    const repo = tempRepo();
    const on = new CadworkService({ enabled: true, getSession: () => undefined, resolveCli: () => ({ path: FAKE_SOLIDCRAFT, source: "env" }) });
    expect(Object.keys(on.serversFor({ id: "s", cwd: repo } as any)!)).toEqual([CAD_MCP_SERVER_NAME]);
  });

  test("[A1] isReadOnly knows the read-only anvil_cad tools and none of the mutating ones", () => {
    expect([...CAD_READ_ONLY_TOOL_IDS].sort()).toEqual(
      ["body_topology", "check_part", "compare_picture", "describe_command", "inspect_design", "list_commands", "measure", "report_gap", "screenshot", "skill_reference"].map((t) => `mcp__anvil_cad__${t}`),
    );
    for (const id of CAD_READ_ONLY_TOOL_IDS) expect(isReadOnly(id)).toBe(true);
    expect([...CAD_MUTATING_TOOL_IDS].sort()).toEqual(
      ["batch", "check_parameters", "execute", "export_part", "import_reference", "open_part", "propose_expectations", "record_expectations", "redo", "release_part", "request_dimensions", "set_parameter", "undo"].map((t) => `mcp__anvil_cad__${t}`),
    );
    for (const id of CAD_MUTATING_TOOL_IDS) expect(isReadOnly(id)).toBe(false);
    expect(isReadOnly("mcp__anvil_cad__release_part")).toBe(false); // an unknown anvil_cad tool is not read-only by default
    expect(isReadOnly("mcp__other__measure")).toBe(false);
    expect(isReadOnly("Read")).toBe(true);
    expect(isReadOnly("Edit")).toBe(false);
  });

  /** A Session stub for the permission gate. */
  const gateSession = (autonomy: string) => {
    const asked: { requestId: string; tool: string; suggestions: PermissionSuggestion[] }[] = [];
    const session = {
      id: "sess_1",
      data: { autonomy, cwd: "/tmp/wt" },
      isAlwaysAllowed: () => false,
      rememberAllow: () => {},
      requestPermission: (requestId: string, tool: string, _input: unknown, suggestions: PermissionSuggestion[]) => void asked.push({ requestId, tool, suggestions }),
    } as unknown as Session;
    return { session, asked };
  };
  const ctx = { signal: new AbortController().signal } as any;
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test("[A1] mutating tools follow the autonomy policy like Edit; read-only ones like Read", async () => {
    const decide = async (autonomy: string, tool: string) => {
      const { session, asked } = gateSession(autonomy);
      const broker = new PermissionBroker();
      const pending = makePreToolUseHook(session, broker)({ tool_name: tool, tool_input: {} } as any, "t", ctx) as Promise<any>;
      await tick();
      const prompted = asked.length === 1;
      if (prompted) broker.resolve(asked[0]!.requestId, "allow");
      return { prompted, decision: (await pending).hookSpecificOutput.permissionDecision as string };
    };
    const table: Record<string, Record<string, boolean>> = {};
    for (const autonomy of ["prompt-all", "allowlist", "mostly-autonomous", "bypass"]) {
      table[autonomy] = {};
      for (const tool of ["Read", "mcp__anvil_cad__measure", "Edit", "mcp__anvil_cad__execute"]) table[autonomy]![tool] = (await decide(autonomy, tool)).prompted;
    }
    expect(table).toEqual({
      "prompt-all": { Read: true, mcp__anvil_cad__measure: true, Edit: true, mcp__anvil_cad__execute: true },
      allowlist: { Read: false, mcp__anvil_cad__measure: false, Edit: true, mcp__anvil_cad__execute: true },
      "mostly-autonomous": { Read: false, mcp__anvil_cad__measure: false, Edit: false, mcp__anvil_cad__execute: false },
      bypass: { Read: false, mcp__anvil_cad__measure: false, Edit: false, mcp__anvil_cad__execute: false },
    });
    // Under allowlist: every read-only id passes silently, every mutating id prompts.
    for (const id of CAD_READ_ONLY_TOOL_IDS) expect(await decide("allowlist", id)).toEqual({ prompted: false, decision: "allow" });
    for (const id of CAD_MUTATING_TOOL_IDS) expect(await decide("allowlist", id)).toEqual({ prompted: true, decision: "allow" });
    // With the daemon's CAD rules registered (as they are whenever cad-work is on), the one tool that
    // parks its own owner card is let through without a second, generic prompt; the rest are unchanged.
    const off = registerCadProtectedRules(tempDir());
    try {
      for (const id of CAD_MUTATING_TOOL_IDS) {
        expect(await decide("allowlist", id)).toEqual({ prompted: !CAD_OWNER_CARD_TOOL_IDS.includes(id), decision: "allow" });
      }
      expect(CAD_OWNER_CARD_TOOL_IDS).toEqual(["mcp__anvil_cad__propose_expectations", "mcp__anvil_cad__request_dimensions", "mcp__anvil_cad__release_part"]);
    } finally {
      off();
    }
  });

  test("[A1] the hook always decides an anvil_cad tool, so canUseTool is never needed and stays fail-closed", async () => {
    const opts = { signal: new AbortController().signal, toolUseID: "tool_1" } as any;
    for (const autonomy of ["prompt-all", "allowlist", "mostly-autonomous", "bypass"]) {
      for (const id of CAD_TOOL_IDS) {
        for (const answer of ["allow", "deny"] as const) {
          const { session, asked } = gateSession(autonomy);
          const broker = new PermissionBroker();
          const pending = makePreToolUseHook(session, broker)({ tool_name: id, tool_input: {} } as any, "t", ctx) as Promise<any>;
          await tick();
          if (asked.length) broker.resolve(asked[0]!.requestId, answer);
          const out = await pending;
          // A concrete allow/deny from the hook short-circuits before canUseTool. A bare
          // `{continue: true}` (no decision) is what would hand the call to canUseTool.
          expect(["allow", "deny"]).toContain(out.hookSpecificOutput?.permissionDecision);
          expect(out.continue).toBeUndefined();
        }
      }
    }
    // An ordinary session passes no allowedTools, so if a CAD call ever DID reach canUseTool
    // undecided (a hook crash), the backstop refuses it rather than waving it through.
    const session = { id: "sess_1", requestQuestion: () => {} } as unknown as Session;
    const canUseTool = makeCanUseTool(session, new QuestionBroker(), undefined);
    for (const id of CAD_TOOL_IDS) expect(((await canUseTool(id, {}, opts)) as any).behavior).toBe("deny");
  });
});

describe("anvil_cad tools", () => {
  test("[A1] open_part takes a name, never a path", async () => {
    const repo = tempRepo();
    const { tools, manager } = fake(repo);
    for (const bad of ["../x", "/tmp/evil", "cad/plate", "Plate", "a/../b", ".", ""]) {
      const r = await tools.open_part!({ part: bad });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("invalid part name");
    }
    expect(existsSync(join(repo, "cad"))).toBe(false); // nothing was created, nothing was started
    expect(existsSync(join(repo, "..", "x"))).toBe(false);
    expect(manager.liveCount()).toBe(0);
    // Nothing else works until a part is open.
    const early = await tools.measure!({});
    expect(early.isError).toBe(true);
    expect(early.text).toContain("call open_part");
    expect((await tools.execute!({ command: "solid.box", params: {} })).text).toContain("call open_part");

    const opened = await tools.open_part!({ part: "plate" });
    expect(opened.isError).toBe(false);
    expect(opened.json).toMatchObject({ part: "plate", folder: "cad/plate", created: true, has_design: false, state: "unverified", parameters: [], parts_in_repo: ["plate"] });
    expect(existsSync(join(repo, "cad", "plate"))).toBe(true);
    expect((await tools.open_part!({ part: "plate" })).json.created).toBe(false);
  });

  test("[A1] execute and batch refuse the commands that would touch files behind the daemon's back", async () => {
    // The ids below were read off the real binary: list_commands {filter:"file."} on SolidCraft 0.44.1.
    const realFileCommands = [
      "file.import", "file.new", "file.insert_step", "file.insert_mesh", "file.save", "file.save_as", "file.verify", "file.gpg_keys", "file.export",
      "file.export_step", "file.export_stl", "file.export_3mf", "file.export_obj", "file.export_urdf", "file.save_mesh", "file.send_to_slicer",
      "file.open_in_easyprint", "file.slicers", "file.import_cache_clear", "file.copy", "file.move", "file.trash", "file.insert_gerber", "file.gerber_files",
      "file.export_view_dxf",
    ];
    for (const id of [...realFileCommands, "file.open", "FILE.SAVE", " file.save ", "save", "open", "export", "new_design", "crash_reports", "settings.profile.export"]) {
      expect(refusedCommand(id)).toBeString();
    }
    expect(refusedCommand("file.insert_step")).toContain("import_reference");
    for (const fine of ["solid.box", "parameters.add", "parameters.change", "sketch.create", "inspect.interference", "timeline.export_script", "inspect.measure"]) {
      expect(refusedCommand(fine)).toBeUndefined();
    }

    const { manager, requests } = recordingManager();
    const tools = callable(cadTools({ sessionId: "s", worktree: tempRepo(), manager, unavailable: () => undefined, offerFile: () => true, ...STUB_GATE_DEPS }) as any);
    await tools.open_part!({ part: "plate" });
    for (const command of ["file.save", "file.open", "file.export", "file.new", "file.insert_step", "file.save_as", "file.trash", "save"]) {
      const r = await tools.execute!({ command, params: { path: "/tmp/x.sc" } });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(command);
    }
    const inBatch = await tools.batch!({ commands: [BOX(), { command: "file.export_step", params: { path: "/tmp/x.step" } }] });
    expect(inBatch.isError).toBe(true);
    expect(inBatch.text).toContain("step 2");
    // SolidCraft's batch also accepts TOOL names as steps (the real one ran `save` this way).
    expect((await tools.batch!({ commands: [{ command: "save", params: { path: "/tmp/x.sc" } }] })).isError).toBe(true);
    // A refused command wrapped inside another command is still refused.
    expect((await tools.execute!({ command: "sketch.draw.dimensioned", params: { command: "file.save", params: {} } })).isError).toBe(true);
    // The script export may not be pointed at a file either.
    expect((await tools.execute!({ command: "timeline.export_script", params: { path: "/tmp/x.json" } })).isError).toBe(true);
    expect(requests).toEqual([]); // none of it reached SolidCraft

    // Ordinary commands pass through untouched.
    await tools.execute!({ command: "solid.box", params: { length: 1, width: 1, height: 1 } });
    await tools.batch!({ commands: [BOX()] });
    expect(requests).toEqual([
      { tool: "execute", args: { command: "solid.box", params: { length: 1, width: 1, height: 1 } }, kind: "mutate" },
      { tool: "batch", args: { commands: [BOX()], verbose: false }, kind: "mutate" },
    ]);
  });

  test("[A1] the pass-through tools map to the right SolidCraft tool and request kind", async () => {
    const { manager, requests } = recordingManager();
    const tools = callable(cadTools({ sessionId: "s", worktree: tempRepo(), manager, unavailable: () => undefined, offerFile: () => true, ...STUB_GATE_DEPS }) as any);
    await tools.open_part!({ part: "plate" });
    await tools.set_parameter!({ name: "L", expression: "120 mm" });
    await tools.set_parameter!({ name: "W", value: 60 });
    await tools.check_parameters!({ set: { L: "100" }, summary: true });
    await tools.undo!({});
    await tools.redo!({});
    await tools.inspect_design!({ measure: false, timeline: "summary" });
    await tools.measure!({ summary: true });
    await tools.body_topology!({ body: "Body1", faces: "cylinders" });
    await tools.screenshot!({ width: 64, height: 48, path: "/tmp/shot.png" });
    await tools.list_commands!({ filter: "fillet" });
    await tools.describe_command!({ id: "solid.fillet" });
    await tools.skill_reference!({ skill: "solidcraft-modeling" });
    expect(requests).toEqual([
      // set_parameter ALWAYS goes through parameters.change {changes}: the only form that refuses an unknown name.
      { tool: "execute", args: { command: "parameters.change", params: { changes: { L: "120 mm" } } }, kind: "mutate" },
      { tool: "execute", args: { command: "parameters.change", params: { changes: { W: "60" } } }, kind: "mutate" },
      { tool: "check_parameters", args: { set: { L: "100" }, summary: true }, kind: "mutate" },
      { tool: "undo", args: {}, kind: "undo" },
      { tool: "redo", args: {}, kind: "redo" },
      { tool: "inspect_design", args: { measure: false, timeline: "summary" }, kind: "read" },
      { tool: "measure", args: { summary: true }, kind: "read" },
      { tool: "body_topology", args: { body: "Body1", faces: "cylinders" }, kind: "read" },
      { tool: "screenshot", args: { width: 64, height: 48 }, kind: "read" }, // the agent's `path` is dropped
      { tool: "list_commands", args: { filter: "fillet" }, kind: "read" },
      { tool: "describe_command", args: { id: "solid.fillet" }, kind: "read" },
      { tool: "skill_reference", args: { skill: "solidcraft-modeling" }, kind: "read" },
    ]);
    expect((await tools.set_parameter!({ name: "L" })).isError).toBe(true);
  });

  test("[A1] list_commands refuses an unfiltered listing", async () => {
    const repo = tempRepo();
    const { tools } = fake(repo);
    await tools.open_part!({ part: "plate" });
    for (const args of [{}, { filter: "" }, { filter: "   " }, { compact: true }]) {
      const r = await tools.list_commands!(args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("needs a `filter` or a `prefix`");
    }
    const filtered = await tools.list_commands!({ filter: "fillet" });
    expect(filtered.isError).toBe(false);
    expect(filtered.json.map((c: any) => c.id)).toEqual(["solid.fillet"]);
    expect((await tools.list_commands!({ prefix: "sketch." })).json.length).toBeGreaterThan(3);
    expect((await tools.describe_command!({ id: "solid.fillet" })).json.id).toBe("solid.fillet");
    expect((await tools.skill_reference!({ skill: "solidcraft-modeling" })).text).toContain("reference plate");
  });

  test("[A1] set_parameter changes an existing parameter and refuses an unknown name instead of creating it", async () => {
    const repo = tempRepo();
    const { tools } = fake(repo);
    await tools.open_part!({ part: "plate" });
    await tools.batch!({ commands: REFERENCE_PLATE });
    const set = await tools.set_parameter!({ name: "L", expression: "120" });
    expect(set.isError).toBe(false);
    expect(set.json).toMatchObject({ changed: { L: 120 }, errors: [] });
    expect((await tools.measure!({ summary: true })).json.total.volume_mm3).toBeCloseTo(35335.2, 1);

    const typo = await tools.set_parameter!({ name: "Lenght", expression: "90" });
    expect(typo.isError).toBe(true);
    expect(typo.text).toContain("unknown parameter `Lenght`");
    const names = (await tools.inspect_design!({ measure: false, sketches: false })).json.params.map((p: any) => p.name);
    expect(names).toEqual(["L", "W", "T", "inset"]); // not silently created
    const design = JSON.parse(readFileSync(join(repo, "cad", "plate", "design.json"), "utf8"));
    expect(JSON.stringify(design)).not.toContain("Lenght");

    // A value that breaks a feature is a success that says so — and the part is marked failed.
    const broken = await tools.set_parameter!({ name: "W", expression: "8" });
    expect(broken.isError).toBe(false);
    expect(broken.json.errors.map((e: any) => e.feature)).toContain("Corners");
    expect(broken.notes.join(" ")).toContain("failed to build");
    const after = await tools.measure!({ summary: true });
    expect(after.notes.join(" ")).toContain("cad/plate is in a FAILED state");
    // check_parameters tries a value and keeps nothing.
    const fixed = await tools.set_parameter!({ name: "W", expression: "50" });
    expect(fixed.json.errors).toEqual([]);
    const trial = await tools.check_parameters!({ set: { L: "80" }, summary: true });
    expect(trial.json.measure.total.volume_mm3).toBeCloseTo(23335.2, 1);
    expect((await tools.measure!({ summary: true })).json.total.volume_mm3).toBeCloseTo(35335.2, 1);
  });

  test("[A1] undo and redo revert a whole batch through the tools", async () => {
    const repo = tempRepo();
    const { tools } = fake(repo);
    await tools.open_part!({ part: "plate" });
    await tools.batch!({ commands: REFERENCE_PLATE });
    const undone = await tools.undo!({});
    expect(undone.isError).toBe(false);
    expect(undone.notes.join(" ")).toContain("as a whole");
    expect((await tools.measure!({ summary: true })).json.body_count).toBe(0);
    await tools.redo!({});
    expect((await tools.measure!({ summary: true })).json.total.volume_mm3).toBeCloseTo(23335.2, 1);
  });

  test("[A1] a screenshot comes back as MCP image content", async () => {
    const repo = tempRepo();
    const { tools } = fake(repo);
    await tools.open_part!({ part: "plate" });
    await tools.execute!(BOX());
    const shot = await tools.screenshot!({ width: 32, height: 24 });
    expect(shot.isError).toBe(false);
    expect(shot.content.map((c: any) => c.type)).toEqual(["image", "text"]);
    const image = shot.content[0];
    expect(image.mimeType).toBe("image/png");
    expect(Object.keys(image).sort()).toEqual(["data", "mimeType", "type"]); // the MCP image block the SDK turns into a tool-result image
    const png = Buffer.from(image.data, "base64");
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(shot.json).toMatchObject({ width: 32, height: 24, path: null });
    expect(readdirSync(join(repo, "cad", "plate")).filter((f) => f.endsWith(".png"))).toEqual([]); // nothing written
  });

  test("[A2] review 9: component.from_bodies and component.move_bodies are not allowed — on 0.44.1 they apply and then the script cannot be exported", async () => {
    for (const id of ["component.from_bodies", "component.move_bodies"]) {
      expect(isAllowedCommand(id)).toBe(false);
      expect(refusedCommand(id)).toContain(id);
      expect(refusedStep(id, { bodies: ["Body1"] })).toBeString();
    }
    // The rest of the family, which does export, is still there.
    for (const id of ["component.create", "component.activate", "component.rename", "component.copy_bodies"]) expect(isAllowedCommand(id)).toBe(true);
    // Through the tools: refused before it reaches SolidCraft, in execute and inside a batch.
    const repo = tempRepo();
    const { tools } = fakeCadSession(repo);
    await tools.open_part!({ part: "plate" });
    expect((await tools.execute!({ command: "solid.box", params: { length: 10, width: 10, height: 10, name: "B" } })).isError).toBe(false);
    const before = readFileSync(join(repo, "cad", "plate", "design.json"), "utf8");
    const one = await tools.execute!({ command: "component.from_bodies", params: { bodies: ["B"] } });
    expect(one.isError).toBe(true);
    expect(one.text).toContain("component.from_bodies");
    const many = await tools.batch!({ commands: [{ command: "solid.box", params: { length: 5, width: 5, height: 5, name: "C" } }, { command: "component.move_bodies", params: { bodies: ["B"] } }] });
    expect(many.isError).toBe(true);
    expect(many.text).toContain("step 2");
    expect(readFileSync(join(repo, "cad", "plate", "design.json"), "utf8")).toBe(before);
  });

  test("[A4] re-review: execute and batch refuse placing a reference again — occurrence.copy or a component pattern of a ref- component, or of one named by id or path; the agent's own components still copy", async () => {
    const refused: [string, Record<string, unknown>][] = [
      ["occurrence.copy", { occurrence: "ref-far.step:1", translate: [-100, 0, 0] }],
      ["occurrence.copy", { component: "ref-far.step" }],
      ["occurrence.copy", { component: " REF-far.step " }],
      ["occurrence.copy", { occurrence: 3 }],
      ["occurrence.copy", { occurrence: "Bracket:1", path: [3] }],
      ["occurrence.copy", {}],
      ["solid.pattern.rectangular", { components: ["ref-far.step"], dir1: [-1, 0, 0], count1: 2, spacing1: 100 }],
      ["solid.pattern.circular", { components: [2], axis: "Z", count: 3 }],
      ["sketch.draw.dimensioned", { command: "occurrence.copy", params: { occurrence: "ref-far.step:1" } }], // nested
    ];
    for (const [command, params] of refused) expect(refusedStep(command, params)).toContain("a reference may be placed once");
    for (const [command, params] of [
      ["occurrence.copy", { occurrence: "Bracket:1", translate: [10, 0, 0] }],
      ["occurrence.copy", { component: "Bracket" }],
      ["solid.pattern.rectangular", { components: ["Bracket"], dir1: [1, 0, 0], count1: 2, spacing1: 10 }],
      ["solid.pattern.rectangular", { features: ["Hole"], dir1: [-1, 0, 0], count1: 2, spacing1: 10 }],
      ["occurrence.move", { occurrence: "ref-far.step:1", translate: [1, 0, 0] }], // a move keeps one placement (checked where it is)
    ] as [string, Record<string, unknown>][])
      expect(refusedStep(command, params)).toBeUndefined();
    const { manager, requests } = recordingManager();
    const tools = callable(cadTools({ sessionId: "s", worktree: tempRepo(), manager, unavailable: () => undefined, offerFile: () => true, ...STUB_GATE_DEPS }) as any);
    await tools.open_part!({ part: "plate" });
    const one = await tools.execute!({ command: "occurrence.copy", params: { occurrence: "ref-far.step:1", translate: [-100, 0, 0] } });
    expect(one.isError).toBe(true);
    expect(one.text).toContain("a reference may be placed once");
    const many = await tools.batch!({ commands: [BOX(), { command: "occurrence.copy", params: { component: "ref-far.step" } }] });
    expect(many.isError).toBe(true);
    expect(many.text).toContain("step 2");
    expect(requests).toEqual([]);
  });

  test("[A1] execute and batch are default-deny: only allow-listed command ids run, and a new unknown id is refused", async () => {
    // Everything the reference plate and the fake's command table use is allowed…
    for (const step of REFERENCE_PLATE) expect(refusedStep(step.command, step.params)).toBeUndefined();
    for (const fine of ["solid.sweep", "surface.loft", "construct.plane.offset", "model.faces", "view.pick", "view.front", "material.assign", "parameters.rename", "timeline.suppress", "inspect.clearance"]) {
      expect(isAllowedCommand(fine)).toBe(true);
    }
    // …and everything the A1 review reached is not: hidden open/recover, imports, exports, plugins,
    // diagnostics, settings, whole families a part does not need, and ids no build has yet.
    const reached = [
      "doc.open", "doc.recover", "doc.recovery_list", "component.insert_design", "component.relink", "component.extract", "sketch.insert_dxf", "sketch.insert_svg",
      "sketch.export_dxf", "canvas.insert", "pointcloud.insert", "parameters.export", "parameters.import", "library.export", "sheet.export_dxf",
      "sheet.export_bend_table", "motion.export", "motion.export_animation", "render.export", "plugin.install", "plugin.run", "plugin.inspect",
      "diagnostics.report_issue", "diagnostics.crash_test", "settings.profile.import", "timeline.add", "inspect.compare_picture", "body.print_face",
      "future.thing", "solidcraft2.anything", "sketch", "", "solid.", ".box",
    ];
    for (const id of reached) {
      expect(isAllowedCommand(id)).toBe(false);
      expect(refusedCommand(id)).toBeString();
    }
    expect(refusedCommand("future.thing")).toContain("`future.thing`"); // the message names the command
    // The table is one reviewable list: every entry is a family with `*` (+ exceptions) or an explicit list.
    expect(CAD_COMMAND_ALLOW.length).toBeGreaterThan(10);
    expect(CAD_COMMAND_ALLOW.map((f) => f.family)).not.toContain("file");
    for (const f of CAD_COMMAND_ALLOW) expect("only" in f ? f.only.length > 0 : f.allow === "*").toBe(true);

    const { manager, requests } = recordingManager();
    const tools = callable(cadTools({ sessionId: "s", worktree: tempRepo(), manager, unavailable: () => undefined, offerFile: () => true, ...STUB_GATE_DEPS }) as any);
    await tools.open_part!({ part: "plate" });
    for (const command of ["future.thing", "doc.open", "plugin.run", "diagnostics.crash_test"]) {
      const r = await tools.execute!({ command, params: {} });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(command);
      const b = await tools.batch!({ commands: [BOX(), { command, params: {} }] });
      expect(b.isError).toBe(true);
      expect(b.text).toContain("step 2");
    }
    expect(requests).toEqual([]); // none of it reached SolidCraft
  });

  test("[A1] no step may carry a path, a file name or an address, at any depth", async () => {
    const pathy: [string, unknown][] = [
      ["timeline.export_script", { path: "x.json" }],
      ["solid.box", { length: 1, width: 1, height: 1, PATH: "x" }],
      ["solid.box", { length: 1, options: { deep: [{ file: "a.step" }] } }],
      ["solid.box", { filename: "a" }],
      ["solid.box", { url: "example.com/x" }],
      ["solid.box", { dir: "out" }],
      ["solid.box", { out: "x" }],
      ["solid.box", { output: "x" }],
      ["solid.extrude", { reference: "photo.png" }],
      ["sketch.text", { text: "hi", font: "/Library/Fonts/Arial.ttf" }],
      ["sketch.text", { text: "hi", font: "~/Fonts/a.ttf" }],
      ["sketch.text", { text: "hi", font: "%APPDATA%\\a.ttf" }],
      ["solid.box", { name: "../../etc" }],
      ["solid.box", { name: "https://example.com/a" }],
      ["solid.box", { name: "file:x" }],
      ["solid.sweep", { profile: "s1", path: "/tmp/curve" }], // a geometry key is still value-checked
      ["sketch.draw.dimensioned", { command: "sketch.rectangle.center", params: { center: [0, 0], corner: [1, 1], path: "x" } }],
    ];
    for (const [command, params] of pathy) expect(refusedStep(command, params)).toBeString();
    // Numbers under those names are geometry (an axis direction), and a sweep's `path` is a curve.
    const fine: [string, unknown][] = [
      ["solid.revolve", { axis: { origin: [0, 0, 0], dir: [0, 0, 1] } }],
      ["view.pick", { rays: [{ origin: [0, 0, 0], dir: [1, 0, 0] }], all: true }],
      ["solid.sweep", { profile: "Sketch1", path: ["l1", "l2"] }],
      ["solid.pipe", { path: ["l1"], diameter: 4 }],
      ["solid.box", { length: "L/2 - inset", width: 1, height: 1, name: "Box" }],
      ["solid.pattern.rectangular", { features: ["Hole"], dir1: [-1, 0, 0], count1: 2, spacing1: "L - 2*inset" }],
    ];
    for (const [command, params] of fine) expect(refusedStep(command, params)).toBeUndefined();

    const { manager, requests } = recordingManager();
    const tools = callable(cadTools({ sessionId: "s", worktree: tempRepo(), manager, unavailable: () => undefined, offerFile: () => true, ...STUB_GATE_DEPS }) as any);
    await tools.open_part!({ part: "plate" });
    const r = await tools.execute!({ command: "solid.box", params: { length: 1, width: 1, height: 1, path: "cad/plate/design.json" } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("the daemon owns every path");
    expect((await tools.batch!({ commands: [{ command: "solid.box", params: { nested: { file: "x" } } }] })).isError).toBe(true);
    expect(requests).toEqual([]);
  });

  test("[A1] bookkeeping bypasses are refused: edit.undo, edit.redo, checkpoints, tool names as batch steps, engine.commands", async () => {
    const { manager, requests } = recordingManager();
    const tools = callable(cadTools({ sessionId: "s", worktree: tempRepo(), manager, unavailable: () => undefined, offerFile: () => true, ...STUB_GATE_DEPS }) as any);
    await tools.open_part!({ part: "plate" });
    for (const command of ["edit.undo", "edit.redo", "edit.checkpoint", "edit.restore_checkpoint", "edit.repeat"]) {
      const r = await tools.execute!({ command, params: {} });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("undo and redo tools");
    }
    for (const step of ["undo", "redo", "set_parameter", "measure", "save"]) {
      expect((await tools.batch!({ commands: [{ command: step, params: { name: "L", value: 1 } }] })).isError).toBe(true);
    }
    expect((await tools.batch!({ commands: [{ command: "set_parameter", params: { name: "L", value: 1 } }] })).text).toContain("parameters.change");
    const all = await tools.execute!({ command: "engine.commands", params: {} });
    expect(all.isError).toBe(true);
    expect(all.text).toContain("list_commands");
    expect((await tools.execute!({ command: "engine.describe", params: { id: "solid.box" } })).isError).toBe(true);
    expect(requests).toEqual([]);
  });

  test("[A1] compare_picture gives one answer for every refusal, so it cannot be used to learn which files exist", async () => {
    const repo = tempRepo();
    const { manager, requests } = recordingManager();
    const tools = callable(cadTools({ sessionId: "s", worktree: repo, manager, unavailable: () => undefined, offerFile: () => true, ...STUB_GATE_DEPS }) as any);
    await tools.open_part!({ part: "plate" });
    mkdirSync(join(repo, "cad", "plate", "refs"), { recursive: true });
    writeFileSync(join(repo, "secret.png"), "png");
    symlinkSync(join(repo, "secret.png"), join(repo, "cad", "plate", "refs", "link.png"));
    const texts = new Set<string>();
    for (const reference of ["/etc/hosts", "/no/such/file", "../../secret.png", "../../no-such.png", "refs/link.png", "refs/missing.png"]) {
      const r = await tools.compare_picture!({ reference });
      expect(r.isError).toBe(true);
      texts.add(r.text);
    }
    expect(texts.size).toBe(1);
    expect(requests).toEqual([]);
  });

  test("[A1] compare_picture only reads a picture inside the part folder", async () => {
    const repo = tempRepo();
    const { manager, requests } = recordingManager();
    const tools = callable(cadTools({ sessionId: "s", worktree: repo, manager, unavailable: () => undefined, offerFile: () => true, ...STUB_GATE_DEPS }) as any);
    await tools.open_part!({ part: "plate" });
    mkdirSync(join(repo, "cad", "plate", "refs"), { recursive: true });
    writeFileSync(join(repo, "cad", "plate", "refs", "photo.png"), "png");
    writeFileSync(join(repo, "secret.png"), "png");
    symlinkSync(join(repo, "secret.png"), join(repo, "cad", "plate", "refs", "link.png"));
    for (const reference of ["/etc/hosts", "../../secret.png", "refs/link.png", "refs/missing.png"]) {
      expect((await tools.compare_picture!({ reference })).isError).toBe(true);
    }
    expect(requests).toEqual([]);
    await tools.compare_picture!({ reference: "refs/photo.png", view: "front" });
    expect(requests).toEqual([{ tool: "compare_picture", args: { reference: join(repo, "cad", "plate", "refs", "photo.png"), view: "front" }, kind: "read" }]);
  });

  test("[A1] export_part writes into .cache/exports and offers one file card per file", async () => {
    const repo = tempRepo();
    const { tools, emitted } = fake(repo);
    expect((await tools.export_part!({ part: "../x", formats: ["step"] })).text).toContain("invalid part name");
    expect((await tools.export_part!({ part: "plate", formats: ["step"] })).text).toContain("has no design yet");
    await tools.open_part!({ part: "plate" });
    await tools.batch!({ commands: REFERENCE_PLATE });
    const r = await tools.export_part!({ part: "plate", formats: ["step", "3mf", "glb"] });
    expect(r.isError).toBe(false);
    expect(r.json.exports.map((e: any) => [e.format, e.path, e.offered])).toEqual([
      ["step", "cad/plate/.cache/exports/plate.step", true],
      ["3mf", "cad/plate/.cache/exports/plate.3mf", true],
      ["glb", "cad/plate/.cache/exports/plate.glb", true],
    ]);
    const dir = join(repo, "cad", "plate", ".cache", "exports");
    expect(readdirSync(dir).sort()).toEqual(["plate.3mf", "plate.glb", "plate.step"]);
    expect(readFileSync(join(dir, "plate.step"), "utf8").startsWith("ISO-10303-21;")).toBe(true);
    expect(readFileSync(join(dir, "plate.glb")).subarray(0, 4).toString("latin1")).toBe("glTF");
    // One file.offer per file, emitted by the service into the session (not by the write-tool path).
    expect(emitted.map((e) => e.type)).toEqual(["file.offer", "file.offer", "file.offer"]);
    expect(emitted.map((e) => e.file.name)).toEqual(["plate.step", "plate.3mf", "plate.glb"]);
    expect(emitted[0].file).toMatchObject({ path: join(dir, "plate.step"), mime: "application/octet-stream" });
    expect(emitted[0].file.size).toBe(readFileSync(join(dir, "plate.step")).length);
    expect(emitted[0].file.downloadUrl).toContain("/api/sessions/sess_cad/files?path=");
    expect(decodeURIComponent(emitted[0].file.downloadUrl)).toContain("cad/plate/.cache/exports/plate.step");
    // Exports are generated, so git does not see them; the script it does.
    const status = Bun.spawnSync(["git", "-C", repo, "status", "--porcelain", "--untracked-files=all"]).stdout.toString();
    // (part.json is the placeholder expectations the helper records so that modeling is allowed.)
    expect(status.trim()).toBe("?? cad/plate/design.json\n?? cad/plate/part.json");
    // A format the binary cannot write is reported per format, without losing the others.
    emitted.length = 0;
    const mixed = await tools.export_part!({ part: "plate", formats: ["stl", "obj"] });
    expect(mixed.isError).toBe(true);
    expect(mixed.json.exports.map((e: any) => e.format)).toEqual(["stl"]);
    expect(mixed.json.errors[0]).toContain("obj");
    expect(emitted).toHaveLength(1);
  });
});

describe("cadwork service", () => {
  const session = (cwd: string, more: Record<string, unknown> = {}) => ({ id: "sess_1", cwd, ...more }) as any;

  test("[A1] with no binary CAD is unavailable with a reason, and every tool refuses with it", async () => {
    const repo = tempRepo();
    const spawn = recordingSpawn();
    const { service, tools, broadcasts } = fakeCadSession(repo, { resolveCli: () => undefined, manager: { spawn: spawn.spawn } });
    expect(service.status()).toEqual({ available: false, reason: NO_SOLIDCRAFT });
    expect(NO_SOLIDCRAFT).toContain("SolidCraft is not installed on this machine");
    expect(await service.refreshStatus()).toEqual({ available: false, reason: NO_SOLIDCRAFT });
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ v: 4, type: "cad.status", available: false, reason: NO_SOLIDCRAFT });
    expect(typeof broadcasts[0].ts).toBe("string");
    for (const [name, args] of [["open_part", { part: "plate" }], ["measure", {}], ["execute", { command: "solid.box" }], ["screenshot", {}], ["export_part", { part: "plate", formats: ["step"] }]] as const) {
      const r = await tools[name]!(args);
      expect(r.isError).toBe(true);
      expect(r.text).toBe(`CAD is not available on this machine: ${NO_SOLIDCRAFT}`);
    }
    expect(spawn.cmds).toEqual([]);
    expect(existsSync(join(repo, "cad"))).toBe(false);
    // A path that does not exist is unavailable too, with the path in the reason.
    const missing = new CadworkService({ enabled: true, getSession: () => undefined, resolveCli: () => ({ path: "/nope/solidcraft-cli", source: "env" }) });
    expect(missing.status()).toEqual({ available: false, reason: "solidcraft-cli was not found at /nope/solidcraft-cli" });
  });

  test("[A1] cad.status reports the version once the binary answers, and is broadcast only on change", async () => {
    const repo = tempRepo();
    const { service, broadcasts } = fakeCadSession(repo, { resolveCli: () => ({ path: FAKE_SOLIDCRAFT, source: "env" }) }); // the real --version reader
    expect(service.status()).toEqual({ available: true }); // before the version is known
    expect(await service.refreshStatus()).toEqual({ available: true, version: "0.44.1" });
    await service.refreshStatus();
    expect(broadcasts).toHaveLength(1);
    const ev = service.statusEvent();
    expect(ev).toMatchObject({ type: "cad.status", available: true, version: "0.44.1" });
    expect(Object.keys(ev).sort()).toEqual(["available", "ts", "type", "v", "version"]); // no reason/pinned when not set
    expect(service.unavailableReason()).toBeUndefined();
    // A binary that will not run is unavailable.
    const broken = new CadworkService({ enabled: true, getSession: () => undefined, resolveCli: () => ({ path: FAKE_SOLIDCRAFT, source: "env" }), readVersion: async () => undefined });
    expect((await broken.refreshStatus()).available).toBe(false);
    expect(broken.unavailableReason()).toContain("could not be run");
  });

  test("[A1] only an ordinary session in a git repo, with the capability on, gets the anvil_cad server", () => {
    const repo = tempRepo();
    const on = new CadworkService({ enabled: true, getSession: () => undefined, resolveCli: () => ({ path: FAKE_SOLIDCRAFT, source: "env" }) });
    const off = new CadworkService({ enabled: false, getSession: () => undefined, resolveCli: () => ({ path: FAKE_SOLIDCRAFT, source: "env" }) });
    const servers = on.serversFor(session(repo))!;
    expect(Object.keys(servers)).toEqual(["anvil_cad"]);
    expect(servers.anvil_cad!.type).toBe("sdk");
    expect(off.serversFor(session(repo))).toBeUndefined();
    expect(on.serversFor(session(tempDir()))).toBeUndefined(); // not a git repo
    expect(on.serversFor(session(join(repo, "gone")))).toBeUndefined();
    expect(on.serversFor(session(repo, { isDefault: true }))).toBeUndefined();
    expect(on.serversFor(session(repo, { teamRole: "lead" }))).toBeUndefined();
    expect(on.serversFor(session(repo, { teamRole: "member", parentId: "p" }))).toBeUndefined();
    expect(on.serversFor(session(repo, { workUnitRole: "planner", workUnitId: "u" }))).toBeUndefined();
    // A subfolder of the repo still addresses the repo's cad/ folder.
    mkdirSync(join(repo, "src"));
    expect(on.worktreeOf(session(join(repo, "src")))).toBe(repo);
    expect(Object.keys(on.serversFor(session(join(repo, "src")))!)).toEqual(["anvil_cad"]);
  });
});
