/**
 * Health probes for MCP integrations (mcp-integrations spec §4.2, amended by agent-cad-and-browser
 * §4.14 item 31).
 *
 *  - http: one TCP connect to the URL's port, 1 s timeout.
 *  - stdio: resolve `command` on the daemon's PATH. The probe never launches the server.
 *  - a probe that throws is `unavailable` with the error text (fail closed: the server is not attached).
 *
 * A PATH lookup cannot see a server that starts and then hangs or crashes, so the tracker also takes a
 * report from the SDK's session-init message: a server that came back `failed` is held `unavailable`
 * until an operator-driven probe (see `HOLD_CLEARING`) — the automatic before-turn, client-connect and
 * timer probes do not clear it, or the very next turn would attach it again and pay the same startup stall.
 */
import { accessSync, constants, statSync } from "node:fs";
import { connect } from "node:net";
import { delimiter, isAbsolute, join } from "node:path";
import type { McpHealth, McpIntegration } from "@protocol";
import { loopbackUrlProblem } from "./validate";

export type McpProber = (integration: McpIntegration) => Promise<McpHealth> | McpHealth;

/** What asked for a probe. `start` daemon start · `check` the mcp.integration.check command ·
 *  `connect` a client connected · `set` session.set_mcp_integrations · `turn` before a turn on a
 *  session with integrations · `timer` the 60 s loop · `change` an integration was added or updated. */
export type McpProbeTrigger = "start" | "check" | "connect" | "set" | "turn" | "timer" | "change";

/** Triggers that clear a failed-at-session-start hold: the ones an operator causes on purpose (Check,
 *  toggling a session's tools, editing an integration) plus a daemon restart. A client merely
 *  reconnecting, the before-turn probe and the timer do not. */
const HOLD_CLEARING: ReadonlySet<McpProbeTrigger> = new Set(["start", "check", "set", "change"]);

export const TCP_PROBE_TIMEOUT_MS = 1000;

/** One TCP connect with a timeout. Resolves true when the port accepted. */
export function tcpProbe(host: string, port: number, timeoutMs = TCP_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const sock = connect({ host, port });
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
  });
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve `command` the way a shell would: a path (contains `/`) is checked as is; a bare name is
 *  searched on `pathEnv`. Returns the resolved path, or undefined when nothing executable is there. */
export function resolveOnPath(command: string, pathEnv: string = process.env.PATH ?? ""): string | undefined {
  if (!command) return undefined;
  if (command.includes("/")) return isAbsolute(command) && isExecutableFile(command) ? command : undefined;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, command);
    if (isExecutableFile(p)) return p;
  }
  return undefined;
}

/** The real prober. */
export const defaultMcpProber: McpProber = async (i) => {
  if (i.transport.type === "http") {
    const bad = loopbackUrlProblem(i.transport.url);
    if (bad) return { state: "unavailable", reason: bad };
    const u = new URL(i.transport.url);
    const port = u.port ? Number(u.port) : 80;
    const host = u.hostname === "[::1]" ? "::1" : u.hostname;
    return (await tcpProbe(host, port)) ? { state: "ready" } : { state: "unavailable", reason: `nothing is listening on port ${port}` };
  }
  return resolveOnPath(i.transport.command)
    ? { state: "ready" }
    : { state: "unavailable", reason: `command not found: ${i.transport.command}` };
};

export interface McpHealthEntry {
  health: McpHealth;
  checkedAt: number;
}

export const sameHealth = (a: McpHealth, b: McpHealth): boolean =>
  a.state === b.state && (a.state !== "unavailable" || a.reason === (b as { reason?: string }).reason);

const NOT_CHECKED: McpHealth = { state: "unavailable", reason: "not checked yet" };

/** The last known health of each integration, plus the failed-at-session-start holds. */
export class McpHealthTracker {
  private readonly entries = new Map<string, McpHealthEntry>();
  private readonly holds = new Map<string, string>(); // integrationId → reason

  constructor(
    private readonly prober: McpProber = defaultMcpProber,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Last known health. An integration never probed is `unavailable` (fail closed); a disabled one is
   *  `disabled` whatever the last probe said. */
  get(i: McpIntegration): McpHealthEntry {
    if (!i.enabled) return { health: { state: "disabled" }, checkedAt: this.entries.get(i.id)?.checkedAt ?? 0 };
    return this.entries.get(i.id) ?? { health: NOT_CHECKED, checkedAt: 0 };
  }

  /** Probe every integration. Returns the ids whose health changed. Never rejects. */
  async probeAll(integrations: readonly McpIntegration[], trigger: McpProbeTrigger): Promise<string[]> {
    if (HOLD_CLEARING.has(trigger)) this.holds.clear();
    const live = new Set(integrations.map((i) => i.id));
    for (const id of [...this.entries.keys()]) if (!live.has(id)) this.forget(id);
    const results = await Promise.all(
      integrations.map(async (i): Promise<[McpIntegration, McpHealth]> => {
        if (!i.enabled) return [i, { state: "disabled" }];
        const held = this.holds.get(i.id);
        if (held) return [i, { state: "unavailable", reason: held }];
        try {
          return [i, await this.prober(i)];
        } catch (e) {
          return [i, { state: "unavailable", reason: `health check failed: ${e instanceof Error ? e.message : String(e)}` }];
        }
      }),
    );
    const changed: string[] = [];
    const at = this.clock();
    for (const [i, health] of results) {
      const before = this.entries.get(i.id)?.health;
      if (!before || !sameHealth(before, health)) changed.push(i.id);
      this.entries.set(i.id, { health, checkedAt: at });
    }
    return changed;
  }

  /** The SDK reported this server `failed` when a session started. Hold it unavailable until an
   *  operator-driven probe. Returns whether the health changed. */
  markFailed(i: McpIntegration, reason: string): boolean {
    const health: McpHealth = { state: "unavailable", reason };
    const before = this.get(i).health;
    this.holds.set(i.id, reason);
    this.entries.set(i.id, { health, checkedAt: this.clock() });
    return !sameHealth(before, health);
  }

  forget(id: string): void {
    this.entries.delete(id);
    this.holds.delete(id);
  }
}
