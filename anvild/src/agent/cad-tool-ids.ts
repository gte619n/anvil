/**
 * The `anvil_cad` tool names and their permission classes (agent-cad-and-browser spec §4.4, D10).
 * Kept free of the SDK and zod so the permission code (`danger-list.ts`) can import it cheaply.
 *
 * NONE of these ids is ever put in a driver's `allowedTools`: every call goes through the
 * PreToolUse hook, where read-only tools are allowed under `allowlist` and the mutating ones follow
 * the session's autonomy policy exactly like `Edit`.
 */
export const CAD_MCP_SERVER_NAME = "anvil_cad";

/** Read-only pass-through tools: they never change the design or write a file. */
export const CAD_READ_ONLY_TOOLS = [
  "inspect_design",
  "measure",
  "body_topology",
  "screenshot",
  "compare_picture",
  "list_commands",
  "describe_command",
  "skill_reference",
  // Runs the gate and returns its result. It changes nothing about the design (the daemon records
  // its own measurement in part.json), so it is allowed wherever `measure` is.
  "check_part",
] as const;

/** Tools that change the design, create the part folder, or write files into it. */
export const CAD_MUTATING_TOOLS = ["open_part", "execute", "batch", "set_parameter", "check_parameters", "undo", "redo", "export_part", "record_expectations", "propose_expectations"] as const;

/**
 * Tools that park their own typed owner card on every call (spec §4.4 "always prompt, with no always
 * allow"). The protected check (`agent/cad-protected.ts`) lets them through the permission gate with
 * no generic prompt — the typed card IS the prompt — and denies them in an unattended session.
 */
export const CAD_OWNER_CARD_TOOLS = ["propose_expectations"] as const;

export const cadToolId = (tool: string): string => `mcp__${CAD_MCP_SERVER_NAME}__${tool}`;

/** Tool ids as the SDK exposes them (`mcp__anvil_cad__<tool>`). */
export const CAD_READ_ONLY_TOOL_IDS: readonly string[] = CAD_READ_ONLY_TOOLS.map(cadToolId);
export const CAD_MUTATING_TOOL_IDS: readonly string[] = CAD_MUTATING_TOOLS.map(cadToolId);
export const CAD_TOOL_IDS: readonly string[] = [...CAD_READ_ONLY_TOOL_IDS, ...CAD_MUTATING_TOOL_IDS];
export const CAD_OWNER_CARD_TOOL_IDS: readonly string[] = CAD_OWNER_CARD_TOOLS.map(cadToolId);

/** The paragraph a session with the `anvil_cad` server gets in its system prompt (spec §4.4). */
export const CAD_SYSTEM_PROMPT =
  "\n\nCAD PARTS (anvil_cad tools): Work on ONE part at a time (open_part). Before the first modeling call on a part, " +
  "record what it must be with record_expectations (bounding box, volume, body count, holes); modeling is refused until " +
  "you do, and after that only the owner can change the expectations (propose_expectations shows them a card). Name " +
  "every driving dimension as a parameter and build from the parameters. Fetch skill_reference before the first build. " +
  "Call check_part to see the geometry gate; never say a part is done while the gate fails or is unverified. If SolidCraft " +
  "cannot make a feature the part needs, call report_gap instead of approximating it. Never edit cad/*/part.json or " +
  "design.json yourself: the daemon writes them.";
