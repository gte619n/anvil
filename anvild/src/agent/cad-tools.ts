/**
 * The `anvil_cad` in-process MCP server (agent-cad-and-browser spec §4.4): how an ordinary session
 * models a part in SolidCraft. Every call goes to the daemon-owned process for the selected part
 * through the manager's queue (`cadwork/manager.ts`); the daemon owns every path and every file.
 *
 *  - `open_part {part}` selects (or creates) the part the following calls address. It takes a NAME,
 *    never a path.
 *  - Mutating pass-throughs: `execute`, `batch`, `set_parameter`, `check_parameters`, `undo`, `redo`.
 *    After each one the daemon rewrites `cad/<part>/design.json`.
 *  - Read-only pass-throughs: `inspect_design`, `measure`, `body_topology`, `screenshot`,
 *    `compare_picture`, `list_commands` (a filter is required), `describe_command`, `skill_reference`.
 *  - `export_part {part, formats}` writes into `cad/<part>/.cache/exports/` and offers each file as
 *    a download card.
 *
 * NOT exposed: SolidCraft's own `open`, `save`, `export`, `new_design`, `crash_reports` and its
 * bridged tools. `execute` / `batch` are DEFAULT-DENY: only the command ids in the allow-list
 * (`./cad-command-allow.ts`) run, and no step may carry a path, a file name or an address.
 *
 *  - `record_expectations` (once, before modeling), `propose_expectations` (the owner's card) and
 *    `check_part` (the gate in full). Modeling calls are refused on a part with no expectations.
 *
 * Phase A4: `import_reference` (a STEP from the repo or the download quarantine, as a fixed body),
 * `open_part {concept: true}` + `request_dimensions` (a picture with no dimensions), `report_gap`,
 * `release_part` (the release pack, after the owner's card). Each is optional on `CadToolDeps`, so a
 * suite that drives the tools against a bare manager does not have to provide them.
 */
import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { advisoryLines, failingLines, type GateResult } from "../cadwork/gate";
import type { CadManager, CadReply, PartState } from "../cadwork/manager";
import type { McpToolResult } from "../cadwork/mcp-client";
import { EXPORTS_DIR, listParts, partRef, type PartRef } from "../cadwork/partfolder";
import { DESIGN_FILE } from "../cadwork/poststep";
import { refusedStep } from "./cad-command-allow";
import { CAD_MCP_SERVER_NAME } from "./cad-tool-ids";

export { CAD_COMMAND_ALLOW, isAllowedCommand, refusedCommand, refusedStep } from "./cad-command-allow";

export { CAD_MCP_SERVER_NAME, CAD_MUTATING_TOOL_IDS, CAD_READ_ONLY_TOOL_IDS, CAD_TOOL_IDS } from "./cad-tool-ids";

export interface CadToolDeps {
  /** The session these tools belong to. */
  sessionId: string;
  /** The root of the session's git worktree; parts live in `<worktree>/cad/<part>/`. */
  worktree: string;
  manager: CadManager;
  /** Why CAD cannot run on this machine right now (no binary, off the fleet pin) — else undefined. */
  unavailable(): string | undefined;
  /** Surface a file the daemon wrote as a download card in the session. False when it could not be offered. */
  offerFile(absPath: string): boolean | Promise<boolean>;
  /** This session works on the part (its chat gets the part card and the adopt cards). */
  touch(ref: PartRef): void;
  /** Why modeling is refused on the part right now (no expectations recorded), else undefined. */
  modelingRefusal(ref: PartRef): string | undefined;
  /** Fixes the expected numbers from the declared parameter values and creates those parameters. For
   *  a part that already has geometry it parks an owner card and resolves when they answer. */
  recordExpectations(ref: PartRef, process: unknown, parameters: unknown, expectations: unknown): Promise<{ ok: true; approved?: boolean; by?: "agent-initial" | "owner" } | { ok: false; error: string }>;
  /** Parks the owner's card and resolves when they answer. */
  proposeExpectations(ref: PartRef, expectations: unknown, reason: unknown): Promise<{ ok: true; approved?: boolean } | { ok: false; error: string }>;
  /** Forces a refresh and returns the gate result in full. */
  checkPart(ref: PartRef): Promise<GateResult>;
  /** What the owner changed in the parameters panel since this session's last call (§4.9). Reading
   *  delivers: each note is returned once, and rides on the tool result that asked. */
  takeOwnerNotes?(): string[];
  /** Phase A4 (see CadworkService). */
  importReference?(ref: PartRef, file: unknown): Promise<{ ok: true; approved?: boolean; name?: string; bodies?: string[]; sha256?: string; replaced?: boolean } | { ok: false; error: string }>;
  startConcept?(ref: PartRef, process: unknown): Promise<{ ok: true; note?: string } | { ok: false; error: string }>;
  requestDimensions?(ref: PartRef, proposed: unknown): Promise<{ ok: true; approved: boolean; ownerParams?: Record<string, number> } | { ok: false; error: string }>;
  reportGap?(ref: PartRef, feature: unknown, detail: unknown): Promise<{ ok: true; gate?: GateResult } | { ok: false; error: string }>;
  exportRefusal?(ref: PartRef): string | undefined;
  releasePart?(ref: PartRef): Promise<{ ok: true; approved: boolean; dir?: string; files?: string[]; offered?: number } | { ok: false; error: string }>;
  pictureFile?(ref: PartRef, src: { picture?: unknown; attachment?: unknown }): { ok: true; abs: string; label: string } | { ok: false; error: string };
  recordPicture?(ref: PartRef, overlap: number, picture: string): void;
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface ToolOut {
  content: Content[];
  isError?: boolean;
  [k: string]: unknown;
}
const ok = (text: string): ToolOut => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolOut => ({ content: [{ type: "text", text }], isError: true });

const stateLine = (part: string, s: PartState): string => `cad/${part} is in a FAILED state: ${s.reason}`;

/** A SolidCraft result as MCP content: text stays text, images stay images (so a screenshot renders
 *  in chat), and anything the daemon has to say rides along as `[anvil]` text parts. */
function toContent(result: McpToolResult, notes: string[]): ToolOut {
  const content: Content[] = [];
  for (const c of result.content) {
    if (c.type === "text" && typeof (c as { text?: unknown }).text === "string") content.push({ type: "text", text: (c as { text: string }).text });
    else if (c.type === "image" && typeof (c as { data?: unknown }).data === "string") {
      content.push({ type: "image", data: (c as { data: string }).data, mimeType: String((c as { mimeType?: unknown }).mimeType ?? "image/png") });
    }
  }
  for (const n of notes) content.push({ type: "text", text: `[anvil] ${n}` });
  if (content.length === 0) content.push({ type: "text", text: "" });
  return { content, ...(result.isError ? { isError: true } : {}) };
}

function replyContent(ref: PartRef, reply: CadReply): ToolOut {
  const notes = [...reply.notes];
  // A design that is itself broken (conflict, failed replay, failed features) is said on every reply.
  // The gate's verdict is not: it fails all the way through a build, and check_part reports it.
  if (reply.state.status === "fail" && !reply.state.fromGate && notes.length === 0) notes.push(stateLine(ref.part, reply.state));
  return toContent(reply.result, notes);
}

const anyObject = z.record(z.string(), z.unknown());
const stepSchema = z.object({ command: z.string(), params: anyObject.optional() });
const exprSchema = z.union([z.number(), z.string()]);
/** What `record_expectations` / `propose_expectations` take (the daemon stamps who and when). */
const expectationsSchema = z.object({
  bbox: z.array(exprSchema).length(3).describe("Overall size in mm, any order: three numbers or formulas."),
  volume: exprSchema.describe("Volume in mm³: a number or a formula."),
  bodies: z.number().int().describe("How many solid bodies the part is (usually 1)."),
  holes: z
    .array(z.object({ diameter: exprSchema, count: z.number().int(), kind: z.enum(["through", "blind"]).optional() }))
    .describe("One row per hole diameter (a counterbored hole counts by its smallest diameter). [] for none."),
  tolerance: z.object({ length: z.number().optional(), volumeRel: z.number().optional() }).optional().describe("Defaults 0.01 mm and 0.001; at most 0.1 mm and 0.01."),
  noInterferenceWith: z.array(z.string()).optional(),
});
/** Formats `export_part` writes (the names SolidCraft's `export` takes) and their file extensions. */
export const EXPORT_FORMATS = { step: "step", "3mf": "3mf", glb: "glb", stl: "stl", obj: "obj", iges: "iges" } as const;

export function buildCadToolsServer(deps: CadToolDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: CAD_MCP_SERVER_NAME, version: "1.0.0", tools: cadTools(deps) });
}

/** The tool definitions (exported so tests can invoke handlers without a live SDK server). */
export function cadTools(deps: CadToolDeps): SdkMcpToolDefinition<any>[] {
  /** The part selected by `open_part` — per session, since each session gets its own server. */
  let current: PartRef | undefined;

  /** Run a handler with the availability check and uniform error reporting. */
  const guarded = async (fn: () => Promise<ToolOut>): Promise<ToolOut> => {
    const why = deps.unavailable();
    if (why) return fail(`CAD is not available on this machine: ${why}`);
    let out: ToolOut;
    try {
      out = await fn();
    } catch (e) {
      out = fail(e instanceof Error ? e.message : String(e));
    }
    // The owner may have changed a parameter in the panel while this call was queued or between
    // calls: say so on the very next result, whichever tool it is.
    for (const n of deps.takeOwnerNotes?.() ?? []) out.content.push({ type: "text", text: `[anvil] ${n}` });
    return out;
  };
  const selected = (): PartRef => {
    if (!current) throw new Error("no part is open: call open_part { part } first");
    return current;
  };
  const read = (name: string, args: Record<string, unknown>) =>
    guarded(async () => {
      const ref = selected();
      return replyContent(ref, await deps.manager.request(ref, { tool: name, args, kind: "read" }));
    });
  /** A MODELING call: refused on a dimensioned part that has no expectations yet (spec §4.5). */
  const mutate = (name: string, args: Record<string, unknown>, kind: "mutate" | "undo" | "redo" = "mutate", modeling = true) =>
    guarded(async () => {
      const ref = selected();
      if (modeling) {
        const refused = deps.modelingRefusal(ref);
        if (refused) return fail(refused);
      }
      return replyContent(ref, await deps.manager.request(ref, { tool: name, args, kind }));
    });
  /** Drop keys the agent may not set (paths), and undefined ones. */
  const clean = (args: Record<string, unknown>, drop: string[] = []): Record<string, unknown> =>
    Object.fromEntries(Object.entries(args).filter(([k, v]) => v !== undefined && !drop.includes(k)));

  return [
    tool(
      "open_part",
      "Select the part the following anvil_cad calls work on, creating it if it does not exist. A part is a NAME " +
        '(lowercase letters, digits, hyphens; e.g. "motor-mount"), never a path: it lives in cad/<part>/ in this repo. ' +
        "Its design is the script cad/<part>/design.json, which the daemon rewrites after every change — never edit, save or " +
        "open design files yourself. Work on one part at a time, name every driving dimension as a parameter, and fetch " +
        "skill_reference before the first build.",
      {
        part: z.string().describe('The part name, e.g. "plate". Not a path.'),
        concept: z.boolean().optional().describe("true for a BRAND-NEW part built from a picture with no dimensions: it may be modeled without expectations, and request_dimensions asks the owner for the numbers later."),
        process: z.string().optional().describe('With concept: the process id from cad/rules.json, e.g. "fdm-0.4".'),
      },
      async ({ part, concept, process }) =>
        guarded(async () => {
          const ref = partRef(deps.worktree, part); // throws on anything that is not a plain name
          const created = !existsSync(ref.dir);
          const opened = await deps.manager.open(ref);
          current = ref;
          deps.touch(ref);
          let conceptNote: string | undefined;
          if (concept === true) {
            if (!deps.startConcept) return fail("open_part: concept parts are not available here");
            const c = await deps.startConcept(ref, process);
            if (!c.ok) return fail(c.error);
            conceptNote = c.note;
          }
          const needs = deps.modelingRefusal(ref);
          const summary = {
            part: ref.part,
            folder: relative(ref.worktree, ref.dir),
            created,
            has_design: opened.hasDesign,
            state: opened.state.status,
            ...(opened.state.reason ? { reason: opened.state.reason } : {}),
            parameters: opened.params,
            parts_in_repo: listParts(ref.worktree),
            modeling: needs ? "refused until expectations are recorded" : "allowed",
          };
          const out = ok(JSON.stringify(summary));
          if (needs) out.content.push({ type: "text", text: `[anvil] ${needs}` });
          if (conceptNote) out.content.push({ type: "text", text: `[anvil] ${conceptNote}` });
          for (const n of opened.notes) out.content.push({ type: "text", text: `[anvil] ${n}` });
          return out;
        }),
    ),

    // ── mutating pass-throughs ──────────────────────────────────────────────────────────────────
    tool(
      "execute",
      "Run ONE SolidCraft command on the open part: {command, params}. Use describe_command for a command's parameters. " +
        "File commands (save, open, export, new, import) are refused: the daemon owns the files.",
      { command: z.string(), params: anyObject.optional(), verbose: z.boolean().optional() },
      async (a) => {
        const why = refusedStep(a.command, a.params);
        if (why) return fail(why);
        return mutate("execute", clean({ command: a.command, params: a.params ?? {}, verbose: a.verbose }));
      },
    ),
    tool(
      "batch",
      "Run several SolidCraft commands in order on the open part, all or nothing: {commands: [{command, params}]}. " +
        "A failing step rolls the whole batch back and names the step. `expect` checks the result against numbers you give.",
      {
        commands: z.array(stepSchema).min(1),
        verbose: z.boolean().optional(),
        expect: anyObject.optional(),
        coalesce_parameters: z.boolean().optional(),
        rollback: z.boolean().optional(),
      },
      async (a) => {
        for (const [i, step] of a.commands.entries()) {
          const why = refusedStep(step.command, step.params);
          if (why) return fail(`step ${i + 1}: ${why}`);
        }
        return mutate("batch", clean({ commands: a.commands, verbose: a.verbose ?? false, expect: a.expect, coalesce_parameters: a.coalesce_parameters, rollback: a.rollback }));
      },
    ),
    tool(
      "set_parameter",
      "Change an EXISTING user parameter of the open part: {name, expression}. An unknown name is refused (create parameters " +
        "with execute parameters.add). A value that breaks a feature still succeeds and lists the failed features under `errors`.",
      { name: z.string(), expression: z.union([z.string(), z.number()]).optional(), value: z.union([z.string(), z.number()]).optional() },
      async (a) => {
        const expr = a.expression ?? a.value;
        if (expr === undefined) return fail("set_parameter: give `expression` (e.g. \"120 mm\" or \"L/2\")");
        // Always the `changes` form: plain set_parameter silently CREATES an unknown name (A0 evidence).
        return mutate("execute", { command: "parameters.change", params: { changes: { [a.name]: String(expr) } } });
      },
    ),
    tool(
      "check_parameters",
      "Try parameter values on the open part WITHOUT keeping them: {set: {name: value}}. Returns what the measure and the " +
        "feature errors would be; the design is unchanged afterwards.",
      { set: anyObject, report: z.array(z.string()).optional(), summary: z.boolean().optional(), bodies: z.unknown().optional() },
      async (a) => mutate("check_parameters", clean(a), "mutate", false), // keeps nothing, so it is not a modeling call
    ),
    tool("undo", "Undo your last change to the open part as a whole (a batch is undone in one go).", {}, async () => mutate("undo", {}, "undo")),
    tool("redo", "Redo the change the last undo reverted.", {}, async () => mutate("redo", {}, "redo")),

    // ── read-only pass-throughs ─────────────────────────────────────────────────────────────────
    tool(
      "inspect_design",
      "The open part's parameters, bodies, sketches and timeline (features with their errors and warnings).",
      { measure: z.boolean().optional(), sketches: z.boolean().optional(), bodies: z.unknown().optional(), timeline: z.unknown().optional(), joints: z.boolean().optional() },
      async (a) => read("inspect_design", clean(a)),
    ),
    tool(
      "measure",
      "Volume, bounding box and face count of the open part's bodies (or one `body`); summary: true for the short form.",
      { body: z.string().optional(), items: z.unknown().optional(), names_only: z.boolean().optional(), summary: z.boolean().optional() },
      async (a) => read("measure", clean(a)),
    ),
    tool(
      "body_topology",
      'A body\'s faces and edges; faces: "cylinders" lists only the cylindrical faces (much smaller).',
      { body: z.string(), faces: z.enum(["all", "cylinders"]).optional() },
      async (a) => read("body_topology", clean(a)),
    ),
    tool(
      "screenshot",
      "A picture of the open part, shown in the chat.",
      {
        source: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        view: z.string().optional(),
        camera: anyObject.optional(),
        grid: z.boolean().optional(),
        axes: z.boolean().optional(),
      },
      async (a) => read("screenshot", clean(a, ["path"])),
    ),
    tool(
      "compare_picture",
      "Overlay the open part on a reference picture. `reference` is a file inside the part folder (cad/<part>/), given " +
        "relative to it, e.g. \"refs/photo.png\". Or `picture`: a PNG/JPEG anywhere in this repo, relative to its root " +
        "(e.g. \".anvil-downloads/photo.jpg\"), or `attachment`: \"latest\" (or the file name) for an image the user attached " +
        "in this chat — the daemon copies either into the part folder. On a concept part the overlap score is shown to the " +
        "owner as advisory.",
      {
        reference: z.string().optional(),
        picture: z.string().optional(),
        attachment: z.string().optional(),
        view: z.string().optional(),
        camera: anyObject.optional(),
        bodies: z.array(z.string()).optional(),
        crop_px: z.unknown().optional(),
        crop_fraction: z.unknown().optional(),
        fit: z.unknown().optional(),
        rows: z.unknown().optional(),
      },
      async (a) =>
        guarded(async () => {
          const ref = selected();
          const record = (reply: CadReply, label: string): ToolOut => {
            const overlap = reply.result.json?.overlap;
            if (!reply.result.isError && typeof overlap === "number") deps.recordPicture?.(ref, overlap, label);
            return replyContent(ref, reply);
          };
          const rest = clean(a, ["picture", "attachment", "reference"]);
          if (a.reference === undefined && (a.picture !== undefined || a.attachment !== undefined)) {
            if (!deps.pictureFile) return fail("compare_picture: `picture` and `attachment` are not available here; use `reference`");
            const pic = deps.pictureFile(ref, { picture: a.picture, attachment: a.attachment });
            if (!pic.ok) return fail(pic.error);
            return record(await deps.manager.request(ref, { tool: "compare_picture", args: { ...rest, reference: pic.abs }, kind: "read" }), pic.label);
          }
          // The daemon owns paths: the picture must be INSIDE the part folder (symlinks resolved).
          // One answer for every refusal, so the tool cannot be used to learn which files exist.
          const refuse = fail(`compare_picture: \`reference\` must name an existing picture inside cad/${ref.part}/ (for example "refs/photo.png")`);
          if (typeof a.reference !== "string" || isAbsolute(a.reference)) return refuse;
          const abs = resolve(ref.dir, a.reference);
          if (abs !== ref.dir && !abs.startsWith(ref.dir + "/")) return refuse;
          if (!existsSync(abs)) return refuse;
          const real = realpathSync(abs);
          if (real !== ref.dir && !real.startsWith(ref.dir + "/")) return refuse;
          return record(await deps.manager.request(ref, { tool: "compare_picture", args: { ...rest, reference: real }, kind: "read" }), relative(ref.worktree, real));
        }),
    ),
    tool(
      "list_commands",
      "SolidCraft command ids with one-line parameter docs. A `filter` (substring) or `prefix` is REQUIRED — the full list is ~400 KB.",
      {
        filter: z.string().optional(),
        prefix: z.string().optional(),
        compact: z.boolean().optional(),
        fields: z.array(z.string()).optional(),
        limit: z.number().optional(),
        offset: z.number().optional(),
      },
      async (a) => {
        if (!a.filter?.trim() && !a.prefix?.trim()) {
          return fail('list_commands needs a `filter` or a `prefix` (the unfiltered list is ~400 KB), e.g. { "filter": "fillet" } or { "prefix": "sketch." }');
        }
        return read("list_commands", clean(a));
      },
    ),
    tool("describe_command", "One SolidCraft command's documentation and parameter schema: {id}.", { id: z.string() }, async (a) => read("describe_command", clean(a))),
    tool(
      "skill_reference",
      'SolidCraft\'s modeling guide for agents: {skill: "solidcraft-modeling"}. Read it before the first build.',
      { skill: z.string(), file: z.string().optional() },
      async (a) => read("skill_reference", clean(a)),
    ),

    // ── expectations and the gate (spec §4.5) ───────────────────────────────────────────────────
    tool(
      "record_expectations",
      "Record what a part must be, BEFORE modeling it: {part, process, parameters, expectations}. Allowed once, for a part that has " +
        "none; modeling is refused until it is done, and afterwards only the owner can change it (propose_expectations). " +
        "`process` is an id from cad/rules.json. An expectation may be a number or a formula over parameter names " +
        '(+ - * / ^ ( ) and pi), e.g. bbox ["L","W","T"] or volume "L*W*T - 4*pi*1.7^2*T". `parameters` lists EVERY ' +
        'parameter name those formulas use with its value, e.g. {"L": 80, "W": 50, "T": 6} (use {} when every expectation ' +
        "is a plain number). The expected numbers are fixed from those values right now, and the daemon creates those " +
        "parameters in the design for you — do not add them again. A formula that uses an undeclared name is refused. " +
        "Changing a declared parameter later moves the expectation away from what was accepted and fails the gate; only " +
        "the owner can change the numbers. On a part that already has geometry this asks the owner on a card.",
      {
        part: z.string().describe("The part name (not a path)."),
        process: z.string().describe('A process id from cad/rules.json, e.g. "fdm-0.4".'),
        parameters: z.record(z.string(), z.union([z.number(), z.string()])).describe('Every parameter the expectation formulas use, with its value: {"L": 80} or {"L": "80 mm"}. {} when there are no formulas.'),
        expectations: expectationsSchema,
      },
      async ({ part, process, parameters, expectations }) =>
        guarded(async () => {
          const ref = partRef(deps.worktree, part);
          const r = await deps.recordExpectations(ref, process, parameters, expectations);
          if (!r.ok) return fail(r.error);
          if (r.approved === false) return ok(JSON.stringify({ part: ref.part, recorded: false, note: "The owner DENIED recording these expectations. Nothing was written." }));
          return ok(
            JSON.stringify({
              part: ref.part,
              recorded: true,
              process,
              approved_by: r.by ?? "agent-initial",
              parameters_created: Object.keys(parameters ?? {}),
              note: "Expectations are locked to the declared parameter values, and those parameters now exist in the design. Model the part from them, then call check_part.",
            }),
          );
        }),
    ),
    tool(
      "propose_expectations",
      "Ask the OWNER to change a part's locked expectations: {part, expectations, reason}. Shows them a card with each old " +
        "and new value and your reason, and waits for Approve or Deny. Nothing changes unless they approve. Give the full " +
        "new expectations, not a patch.",
      { part: z.string().describe("The part name (not a path)."), expectations: expectationsSchema, reason: z.string().describe("Why the expectations should change, for the owner to judge.") },
      async ({ part, expectations, reason }) =>
        guarded(async () => {
          const ref = partRef(deps.worktree, part);
          const r = await deps.proposeExpectations(ref, expectations, reason);
          if (!r.ok) return fail(r.error);
          if (!r.approved) return ok(JSON.stringify({ part: ref.part, approved: false, note: "The owner DENIED the change. The expectations are exactly as they were; nothing was written." }));
          return ok(JSON.stringify({ part: ref.part, approved: true, note: "The owner approved. The new expectations are locked; call check_part." }));
        }),
    ),
    tool(
      "check_part",
      "Measure a part now and return the geometry gate in full: {part}. `state` is pass, fail, unverified (not approved or " +
        "not measured yet), concept or gap; `failing` lists each failed check with what was expected and what was measured. " +
        "A part is not done while the gate fails or is unverified.",
      { part: z.string().describe("The part name (not a path).") },
      async ({ part }) =>
        guarded(async () => {
          const ref = partRef(deps.worktree, part);
          if (!existsSync(join(ref.dir, DESIGN_FILE)) && !deps.manager.status(ref)?.live) return fail(`cad/${ref.part} has no design yet: open_part it and build something first`);
          const gate = await deps.checkPart(ref);
          const out = ok(JSON.stringify({ part: ref.part, ...gate, failing: failingLines(gate), advisory: advisoryLines(gate) }));
          if (gate.needsAdoption) out.content.push({ type: "text", text: `[anvil] The owner has been shown a card to adopt the ${gate.needsAdoption === "rules" ? "changed cad/rules.json" : gate.needsAdoption}; the part stays unverified until they approve it.` });
          return out;
        }),
    ),

    // ── files ───────────────────────────────────────────────────────────────────────────────────
    tool(
      "export_part",
      "Export a part to files the owner can download: {part, formats}. Files are written to cad/<part>/.cache/exports/ " +
        "(not committed) and offered as download cards in the chat.",
      {
        part: z.string().describe("The part name (not a path)."),
        formats: z.array(z.enum(Object.keys(EXPORT_FORMATS) as [keyof typeof EXPORT_FORMATS, ...(keyof typeof EXPORT_FORMATS)[]])).min(1),
      },
      async ({ part, formats }) =>
        guarded(async () => {
          const ref = partRef(deps.worktree, part);
          if (!existsSync(join(ref.dir, DESIGN_FILE)) && !deps.manager.status(ref)?.live) {
            return fail(`cad/${ref.part} has no design yet: open_part it and build something first`);
          }
          const refused = deps.exportRefusal?.(ref);
          if (refused) return fail(refused);
          const outDir = join(ref.dir, EXPORTS_DIR);
          mkdirSync(outDir, { recursive: true });
          const wanted = [...new Set(formats)];
          // One queued job, so no other caller's change lands between two formats; a pending
          // refresh runs first so nothing is exported off a stale measurement (§4.3).
          const done = await deps.manager.run(
            ref,
            async (slot) => {
              const out: { format: string; path: string; result: McpToolResult }[] = [];
              for (const format of wanted) {
                const path = join(outDir, `${ref.part}.${EXPORT_FORMATS[format]}`);
                out.push({ format, path, result: await slot.call("export", { path, format }) });
              }
              return { out, notes: slot.notes, state: slot.state() };
            },
            { refreshFirst: true },
          );
          const exports: Record<string, unknown>[] = [];
          const errors: string[] = [];
          for (const e of done.out) {
            if (e.result.isError || !existsSync(e.path)) {
              errors.push(`${e.format}: ${e.result.text || "no file was written"}`);
              continue;
            }
            // The service emits the file.offer itself: `deliverablePath` only knows the write tools.
            const offered = await deps.offerFile(e.path);
            exports.push({ format: e.format, path: relative(ref.worktree, e.path), bytes: e.result.json?.bytes, offered });
          }
          const notes = [...done.notes];
          if (done.state.status === "fail" && !done.state.fromGate) notes.push(stateLine(ref.part, done.state));
          const res: ToolOut = { content: [{ type: "text", text: JSON.stringify({ part: ref.part, exports, ...(errors.length ? { errors } : {}) }) }], ...(errors.length ? { isError: true } : {}) };
          for (const n of notes) res.content.push({ type: "text", text: `[anvil] ${n}` });
          return res;
        }),
    ),

    // ── Phase A4 ────────────────────────────────────────────────────────────────────────────────
    tool(
      "import_reference",
      "Import a STEP the part must FIT (a mating part, a housing) as a fixed reference body: {part, file}. `file` is a path " +
        "in this repo relative to its root — downloads are in .anvil-downloads/ — at most 50 MB, .step/.stp. The daemon copies " +
        "it to cad/<part>/refs/ and the part must not touch it (it joins noInterferenceWith; once expectations are locked the " +
        "owner approves that on a card). Reference bodies are never measured as the part. Importing the same file again replaces it.",
      { part: z.string().describe("The part name (not a path)."), file: z.string().describe('A STEP file in this repo, e.g. ".anvil-downloads/motor.step".') },
      async ({ part, file }) =>
        guarded(async () => {
          if (!deps.importReference) return fail("import_reference is not available here");
          const ref = partRef(deps.worktree, part);
          const r = await deps.importReference(ref, file);
          if (!r.ok) return fail(r.error);
          if (r.approved === false) return ok(JSON.stringify({ part: ref.part, imported: false, note: "The owner DENIED adding this reference. Nothing was imported or written." }));
          return ok(JSON.stringify({ part: ref.part, imported: true, reference: `refs/${r.name}`, bodies: r.bodies, sha256: r.sha256, replaced: r.replaced ?? false, note: "The part must not touch these bodies; check_part checks it." }));
        }),
    ),
    tool(
      "request_dimensions",
      "For a CONCEPT part only: show the OWNER the named dimensions you propose, as editable numbers: {part, proposed: " +
        '[{name, value, unit?: "mm", note?}]}. The owner types the real values; the daemon stores exactly those as the part\'s ' +
        "dimensions and applies them to the design. Then call record_expectations with `parameters` equal to the returned " +
        "owner values. Do not ask for dimensions in chat (AskUserQuestion) — use this.",
      {
        part: z.string().describe("The part name (not a path)."),
        proposed: z.array(z.object({ name: z.string(), value: z.number(), unit: z.string().optional(), note: z.string().optional() })).min(1),
      },
      async ({ part, proposed }) =>
        guarded(async () => {
          if (!deps.requestDimensions) return fail("request_dimensions is not available here");
          const ref = partRef(deps.worktree, part);
          const r = await deps.requestDimensions(ref, proposed);
          if (!r.ok) return fail(r.error);
          if (!r.approved) return ok(JSON.stringify({ part: ref.part, confirmed: false, note: "The owner declined to give dimensions. Nothing was changed." }));
          return ok(JSON.stringify({ part: ref.part, confirmed: true, ownerParams: r.ownerParams, note: "These are the owner's numbers and are now in the design. Call record_expectations with parameters equal to them exactly." }));
        }),
    ),
    tool(
      "report_gap",
      "Say that SolidCraft cannot make a feature this part needs, instead of approximating it: {part, feature, detail}. The " +
        "part is blocked (export and release refused; autopilot stops) until the owner clears it.",
      { part: z.string().describe("The part name (not a path)."), feature: z.string().describe("The feature, e.g. \"variable fillet\"."), detail: z.string().describe("What you tried and what SolidCraft did.") },
      async ({ part, feature, detail }) =>
        guarded(async () => {
          if (!deps.reportGap) return fail("report_gap is not available here");
          const ref = partRef(deps.worktree, part);
          const r = await deps.reportGap(ref, feature, detail);
          if (!r.ok) return fail(r.error);
          return ok(JSON.stringify({ part: ref.part, state: r.gate?.state ?? "gap", gap: { feature, detail }, note: "The owner sees this on the part card. Stop working on this feature." }));
        }),
    ),
    tool(
      "release_part",
      "Release a part whose gate PASSES: {part}. The owner approves on a release card every time; on approval the daemon " +
        "writes cad/<part>/release/<part>-<sha7>/ (STEP, 3MF for FDM, four views, a spec sheet, a signed manifest) and offers " +
        "each file. Refused for a concept part, a part with a gap, or a gate that does not pass.",
      { part: z.string().describe("The part name (not a path).") },
      async ({ part }) =>
        guarded(async () => {
          if (!deps.releasePart) return fail("release_part is not available here");
          const ref = partRef(deps.worktree, part);
          const r = await deps.releasePart(ref);
          if (!r.ok) return fail(r.error);
          if (!r.approved) return ok(JSON.stringify({ part: ref.part, released: false, note: "The owner DENIED the release. Nothing was written." }));
          return ok(JSON.stringify({ part: ref.part, released: true, folder: r.dir ? relative(deps.worktree, r.dir) : undefined, files: (r.files ?? []).map((f) => relative(deps.worktree, f)), offered: r.offered }));
        }),
    ),
  ];
}
