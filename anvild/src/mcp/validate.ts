/**
 * Validation shared by the MCP integration store (on add/update) and `buildMcpServers` (again, every
 * time a driver starts — the store is a plain JSON file a session's Bash could edit). Dependency-light
 * on purpose: protocol types only. (mcp-integrations spec §4.1/§6)
 */
import type { McpIntegration, McpIntegrationKind, McpTransport } from "@protocol";

/** Server key grammar: becomes the tool prefix `mcp__<key>__`. No underscores, so `mcp__<key>__<tool>`
 *  always splits unambiguously and a key can never collide with a daemon server (`anvil_team`, …). */
export const MCP_KEY_RE = /^[a-z][a-z0-9]{1,23}$/;

/** Keys the daemon's own in-process servers use (or will: `anvil_cad` is Track A's). Never an
 *  integration key, whatever the grammar says. */
export const RESERVED_MCP_KEYS: readonly string[] = ["anvil", "anvil_team", "anvil_member", "anvil_planning", "anvil_cad"];

export const MCP_INTEGRATION_KINDS: readonly McpIntegrationKind[] = ["browser", "custom"];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Why `key` cannot be an integration key, or undefined when it can. */
export function keyProblem(key: unknown): string | undefined {
  if (typeof key !== "string" || !MCP_KEY_RE.test(key)) {
    return "key must be 2-24 characters: a lowercase letter, then lowercase letters or digits (no underscores)";
  }
  if (RESERVED_MCP_KEYS.includes(key)) return `key "${key}" is reserved for Anvil's own tools`;
  // A key is used as a property name in the driver's server map; one that names something every
  // object already has (`constructor`) would look "already used" there.
  if (key in Object.prototype) return `key "${key}" is not allowed`;
  return undefined;
}

/**
 * Why `command` cannot follow `/usr/bin/env -i NAME=value …` safely, or undefined when it can. `env`
 * reads a word containing `=` as one more assignment (so the NEXT word would run instead) and a word
 * starting with `-` as one of its own options; macOS `env` has no `--` to stop that.
 */
export function envWrapProblem(command: string): string | undefined {
  if (command.includes("=")) return 'command must not contain "="';
  if (command.startsWith("-")) return 'command must not start with "-"';
  return undefined;
}

/**
 * Why `url` is not an acceptable http integration URL, or undefined when it is. Loopback only:
 * parsed with `new URL()`, scheme `http:`, no username or password, hostname `127.0.0.1`,
 * `localhost` or `[::1]`.
 */
export function loopbackUrlProblem(url: unknown): string | undefined {
  if (typeof url !== "string" || !url.trim()) return "url is required";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "url is not a valid URL";
  }
  if (u.protocol !== "http:") return "url must use http: (loopback only)";
  if (u.username || u.password) return "url must not carry a username or password";
  if (!LOOPBACK_HOSTS.has(u.hostname)) return "url must point at this machine (127.0.0.1, localhost or [::1])";
  return undefined;
}

/** Why `t` is not a well-formed transport, or undefined when it is. */
export function transportProblem(t: unknown): string | undefined {
  if (!t || typeof t !== "object") return "transport is required";
  const tr = t as Record<string, unknown>;
  if (tr.type === "http") return loopbackUrlProblem(tr.url);
  if (tr.type === "stdio") {
    if (typeof tr.command !== "string" || !tr.command.trim()) return "command is required";
    if (/[\0\n\r]/.test(tr.command)) return "command must be a single line";
    const wrapErr = envWrapProblem(tr.command.trim());
    if (wrapErr) return wrapErr;
    if (!Array.isArray(tr.args) || tr.args.some((a) => typeof a !== "string" || a.includes("\0"))) return "args must be a list of strings";
    return undefined;
  }
  return 'transport type must be "http" or "stdio"';
}

/** A clean copy of a transport that already passed `transportProblem` (drops unknown fields). */
export function normalizeTransport(t: McpTransport): McpTransport {
  // The URL is stored and forwarded in its parsed, normalized form — exactly what was validated.
  return t.type === "http" ? { type: "http", url: new URL(t.url.trim()).href } : { type: "stdio", command: t.command.trim(), args: [...t.args] };
}

/** Whether a value read back from disk is a structurally usable integration record. Lenient about the
 *  URL (a hand-edited non-loopback URL is kept so the UI can show it and `buildMcpServers` can refuse
 *  it by name) but strict about everything the gate keys on. */
export function isStoredIntegration(v: unknown): v is McpIntegration {
  if (!v || typeof v !== "object") return false;
  const i = v as Record<string, unknown>;
  if (typeof i.id !== "string" || !i.id) return false;
  if (keyProblem(i.key)) return false;
  if (!MCP_INTEGRATION_KINDS.includes(i.kind as McpIntegrationKind)) return false;
  if (typeof i.label !== "string" || typeof i.exclusive !== "boolean" || typeof i.enabled !== "boolean") return false;
  const t = i.transport as Record<string, unknown> | undefined;
  if (!t || typeof t !== "object") return false;
  if (t.type === "http") return typeof t.url === "string";
  if (t.type === "stdio") return typeof t.command === "string" && Array.isArray(t.args) && t.args.every((a) => typeof a === "string");
  return false;
}
