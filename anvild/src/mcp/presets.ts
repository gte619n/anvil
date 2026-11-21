/**
 * MCP integration presets (mcp-integrations spec §4.2, amended by agent-cad-and-browser §4.12).
 *
 * A preset describes one integration KIND: whether an operator may add it, what a new entry defaults
 * to, and — for kinds whose launch line depends on the session — how to resolve the transport when a
 * driver starts. Phase C1 ships `custom` only. Phase C2 registers `browser` here (with
 * `registerMcpPreset`) and its own approval model through `registerMcpKindGate` (agent/mcp-gate.ts);
 * until a kind is registered, `mcp.integration.add` refuses it.
 */
import type { McpHealth, McpIntegration, McpIntegrationKind, McpIntegrationStatus, McpTransport, Session as SessionData } from "@protocol";

export interface McpPresetContext {
  session: SessionData;
  /** The session's worktree — what `{cwd}` stands for. */
  cwd: string;
}

export interface McpPreset {
  kind: McpIntegrationKind;
  /** Name shown on the "Add" menu. */
  title: string;
  /** The default entry "Add" offers for this kind (the operator can edit it before saving). Absent for
   *  `custom`, which has no defaults: the operator types everything. */
  defaults?: () => Omit<McpIntegration, "id">;
  /**
   * Resolve the transport to launch for one session, when it differs from the stored one (the browser
   * preset computes its proxy port and per-session folders here). The result still goes through the
   * loopback check and the `env -i` wrap in `buildMcpServers`. Return `{ skip }` to leave the
   * integration out of this session with a reason the owner sees.
   */
  resolveTransport?: (integration: McpIntegration, ctx: McpPresetContext) => McpTransport | { skip: string };
  /** The kind defines its own key, transport and `exclusive`: `mcp.integration.add` takes them from
   *  `defaults()` whatever the client sent, and `update` cannot change them. */
  fixed?: boolean;
  /** A health check beyond the generic one (which only resolves the command on PATH). Consulted when
   *  the generic probe says `ready`; its answer replaces it. */
  health?: (integration: McpIntegration) => McpHealth;
  /** Extra fields for this kind's rows in `mcp.integrations` (the browser's mode and proxy state). */
  statusExtra?: (integration: McpIntegration) => Partial<McpIntegrationStatus>;
  /** The operator pressed Check: clear whatever the kind was holding against a retry. */
  onCheck?: (integration: McpIntegration) => void;
}

const presets = new Map<McpIntegrationKind, McpPreset>();

/** Register (or replace) a kind's preset. Returns a thunk that removes exactly this registration. */
export function registerMcpPreset(preset: McpPreset): () => void {
  presets.set(preset.kind, preset);
  return () => {
    if (presets.get(preset.kind) === preset) presets.delete(preset.kind);
  };
}

export function mcpPreset(kind: McpIntegrationKind): McpPreset | undefined {
  return presets.get(kind);
}

/** The kinds an operator can add on this build, in registration order. */
export function mcpPresetKinds(): McpIntegrationKind[] {
  return [...presets.keys()];
}

/** Replace `{cwd}` in each argument with the session worktree. It is the only substitution. */
export function substituteCwd(args: readonly string[], cwd: string): string[] {
  return args.map((a) => a.split("{cwd}").join(cwd));
}

export const CUSTOM_PRESET: McpPreset = { kind: "custom", title: "Custom" };
registerMcpPreset(CUSTOM_PRESET);
