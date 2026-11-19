/**
 * Decides the whole MCP server map for one session's driver (mcp-integrations spec §4.3). A pure
 * function, so it is tested without a supervisor.
 */
import { homedir, tmpdir } from "node:os";
import type { McpSdkServerConfigWithInstance, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { McpIntegrationStatus, McpTransport, Session as SessionData } from "@protocol";
import { mcpPreset, substituteCwd } from "../mcp/presets";
import { RESERVED_MCP_KEYS, keyProblem, loopbackUrlProblem, transportProblem } from "../mcp/validate";

export interface McpSkipped {
  /** The integration's id (so the registry can tell which one). */
  id: string;
  label: string;
  reason: string;
}

export interface BuiltMcpServers {
  servers: Record<string, McpServerConfig>;
  skipped: McpSkipped[];
}

/** The only variables a stdio integration's process ever sees. */
export interface McpChildEnv {
  PATH: string;
  HOME: string;
  TMPDIR: string;
}

export function defaultMcpChildEnv(env: Record<string, string | undefined> = process.env): McpChildEnv {
  return { PATH: env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin", HOME: env.HOME || homedir(), TMPDIR: env.TMPDIR || tmpdir() };
}

/**
 * An ordinary session: not the concierge, not a team lead or member, not an autopilot planner or
 * builder. Only these get integrations in v1.
 */
export function isOrdinarySession(s: SessionData): boolean {
  return !s.isDefault && !s.teamRole && !s.workUnitRole && !s.workUnitId;
}

/**
 * Wrap a stdio command so the server never sees the session's credentials: `/usr/bin/env -i` with
 * only PATH, HOME and TMPDIR. (The SDK's own `env` option ADDS to the inherited environment — it
 * cannot remove the session token — so the wrap is the control. C0 A4.)
 */
export function wrapStdio(command: string, args: readonly string[], env: McpChildEnv): { command: string; args: string[] } {
  return { command: "/usr/bin/env", args: ["-i", `PATH=${env.PATH}`, `HOME=${env.HOME}`, `TMPDIR=${env.TMPDIR}`, command, ...args] };
}

/**
 * @param roleServer  The session's in-process servers, passed through UNCHANGED under their own keys:
 *                    the role server (`anvil`, `anvil_team`, `anvil_member`, `anvil_planning`) and/or
 *                    any other in-process server the supervisor adds (e.g. `anvil_cad`). May be
 *                    undefined or empty.
 * @param integrations The registry's live statuses (definition + health).
 *
 * 1. Start from `roleServer`.
 * 2. For an ordinary session, add each id in `session.mcpIntegrations` that is `enabled` and `ready`,
 *    under its `key`. http → `{ type: "http", url, alwaysLoad: true }` with the URL re-validated
 *    here; stdio → the `env -i` wrap with `{cwd}` substituted.
 * 3. Anything named in the session's list but not added is returned in `skipped`.
 *
 * Integration tools are never auto-allowed: this returns server configs only, and the caller must
 * not derive any `allowedTools` entry from them.
 */
export function buildMcpServers(
  session: SessionData,
  roleServer: Record<string, McpSdkServerConfigWithInstance> | undefined,
  integrations: readonly McpIntegrationStatus[],
  childEnv: McpChildEnv = defaultMcpChildEnv(),
): BuiltMcpServers {
  const servers: Record<string, McpServerConfig> = { ...(roleServer ?? {}) };
  const skipped: McpSkipped[] = [];
  if (!isOrdinarySession(session)) return { servers, skipped };

  const byId = new Map(integrations.map((i) => [i.id, i]));
  const seen = new Set<string>();
  for (const id of session.mcpIntegrations ?? []) {
    if (seen.has(id)) continue; // deduped
    seen.add(id);
    const i = byId.get(id);
    if (!i) continue; // unknown id: nothing to name, nothing to attach
    const skip = (reason: string): void => void skipped.push({ id: i.id, label: i.label, reason });

    if (!i.enabled || i.health.state === "disabled") {
      skip("switched off in Settings");
      continue;
    }
    if (i.health.state !== "ready") {
      skip(i.health.reason);
      continue;
    }
    const keyErr = keyProblem(i.key);
    if (keyErr || RESERVED_MCP_KEYS.includes(i.key) || i.key in servers) {
      skip(keyErr ?? `key "${i.key}" is already used by another server in this session`);
      continue;
    }

    let transport: McpTransport = i.transport;
    const resolve = mcpPreset(i.kind)?.resolveTransport;
    if (resolve) {
      let r: McpTransport | { skip: string };
      try {
        r = resolve(i, { session, cwd: session.cwd });
      } catch (e) {
        r = { skip: `could not prepare it: ${e instanceof Error ? e.message : String(e)}` };
      }
      if ("skip" in r) {
        skip(r.skip);
        continue;
      }
      transport = r;
    }
    // Re-validated on every build: the store is a plain JSON file a session's Bash could edit.
    const tErr = transportProblem(transport);
    if (tErr) {
      skip(tErr);
      continue;
    }
    if (transport.type === "http") {
      const bad = loopbackUrlProblem(transport.url);
      if (bad) {
        skip(bad);
        continue;
      }
      servers[i.key] = { type: "http", url: transport.url, alwaysLoad: true };
    } else {
      servers[i.key] = { ...wrapStdio(transport.command, substituteCwd(transport.args, session.cwd), childEnv), alwaysLoad: true };
    }
  }
  return { servers, skipped };
}

/** Keys of the in-process (`type: "sdk"`) servers in a driver's server map. */
export function inProcessKeys(servers: Record<string, McpServerConfig> | undefined): string[] {
  return Object.entries(servers ?? {})
    .filter(([, c]) => (c as { type?: string }).type === "sdk")
    .map(([k]) => k);
}
