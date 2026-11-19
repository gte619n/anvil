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
] as const;

/** Tools that change the design, create the part folder, or write files into it. */
export const CAD_MUTATING_TOOLS = ["open_part", "execute", "batch", "set_parameter", "check_parameters", "undo", "redo", "export_part"] as const;

export const cadToolId = (tool: string): string => `mcp__${CAD_MCP_SERVER_NAME}__${tool}`;

/** Tool ids as the SDK exposes them (`mcp__anvil_cad__<tool>`). */
export const CAD_READ_ONLY_TOOL_IDS: readonly string[] = CAD_READ_ONLY_TOOLS.map(cadToolId);
export const CAD_MUTATING_TOOL_IDS: readonly string[] = CAD_MUTATING_TOOLS.map(cadToolId);
export const CAD_TOOL_IDS: readonly string[] = [...CAD_READ_ONLY_TOOL_IDS, ...CAD_MUTATING_TOOL_IDS];
