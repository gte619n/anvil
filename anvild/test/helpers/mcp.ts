/**
 * Shared fixtures for the MCP integration tests (Phase C1): a real Supervisor with the
 * "mcp-integrations" feature on, a fake clock and a fake prober; the `echo` stdio integration; and a
 * direct caller for the PreToolUse hook.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROTOCOL_VERSION, type McpHealth, type McpIntegration, type ServerEvent } from "@protocol";
import { makePreToolUseHook } from "../../src/agent/permissions";
import type { McpHookContext } from "../../src/agent/mcp-gate";
import type { PermissionBroker } from "../../src/agent/permissions";
import type { McpIntegrationInput } from "../../src/mcp/store";
import { ConnectionRegistry } from "../../src/server/registry";
import type { Session } from "../../src/session/session";
import { Supervisor } from "../../src/session/supervisor";

export const ECHO_FIXTURE = resolve(import.meta.dir, "..", "fixtures", "echo-mcp.mjs");

/** The stdio fixture integration every acceptance bullet uses: key `echo`. */
export const echoInput = (over: Partial<McpIntegrationInput> = {}): McpIntegrationInput => ({
  key: "echo",
  kind: "custom",
  label: "Echo",
  transport: { type: "stdio", command: process.execPath, args: [ECHO_FIXTURE, "--root", "{cwd}"] },
  exclusive: false,
  enabled: true,
  ...over,
});

export interface FakeClock {
  now: number;
  (): number;
  advance(ms: number): void;
}
export function fakeClock(start = 1_000_000): FakeClock {
  const c = (() => c.now) as FakeClock;
  c.now = start;
  c.advance = (ms) => void (c.now += ms);
  return c;
}

/** A prober whose answer per integration KEY the test sets; default ready. Counts its calls. */
export interface FakeProber {
  (i: McpIntegration): McpHealth;
  health: Map<string, McpHealth | Error>;
  calls: number;
}
export function fakeProber(): FakeProber {
  const p = ((i: McpIntegration) => {
    p.calls++;
    const h = p.health.get(i.key);
    if (h instanceof Error) throw h;
    return h ?? { state: "ready" };
  }) as FakeProber;
  p.health = new Map();
  p.calls = 0;
  return p;
}

/** A registry that records every broadcast and reports `clients` connections. */
export class RecordingRegistry extends ConnectionRegistry {
  readonly sent: ServerEvent[] = [];
  clients = 0;
  override toAll(event: ServerEvent): void {
    this.sent.push(event);
  }
  override all(): never[] {
    return new Array(this.clients).fill({}) as never[];
  }
  ofType<T extends ServerEvent["type"]>(type: T): Extract<ServerEvent, { type: T }>[] {
    return this.sent.filter((e) => e.type === type) as Extract<ServerEvent, { type: T }>[];
  }
}

export interface McpRig {
  dir: string;
  sup: Supervisor;
  registry: RecordingRegistry;
  clock: FakeClock;
  prober: FakeProber;
  broker: PermissionBroker;
  /** A new ordinary session (autonomy `mostly-autonomous` unless told otherwise). */
  session(over?: Partial<Session["data"]>): Promise<Session>;
  /** Flush + stop the supervisor, then remove the state dir. */
  cleanup(): Promise<void>;
}

export function mcpRig(opts: { features?: string[]; stateDir?: string; browser?: NonNullable<ConstructorParameters<typeof Supervisor>[0]["mcp"]>["browser"]; realProber?: boolean } = {}): McpRig {
  const dir = opts.stateDir ?? mkdtempSync(join(tmpdir(), "anvil-mcp-"));
  const registry = new RecordingRegistry();
  const clock = fakeClock();
  const prober = fakeProber();
  const sup = new Supervisor(
    { stateDir: dir, envFile: join(dir, "env"), features: opts.features ?? ["mcp-integrations"], mcp: { ...(opts.realProber ? {} : { prober }), clock, intervalMs: 0, browser: opts.browser } },
    registry,
  );
  return {
    dir,
    sup,
    registry,
    clock,
    prober,
    broker: (sup as unknown as { broker: PermissionBroker }).broker,
    async session(over = {}) {
      const s = await sup.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd: dir });
      Object.assign(s.data, { autonomy: "mostly-autonomous" }, over);
      return s;
    },
    async cleanup() {
      await sup.shutdown(); // flushes the debounced persist so nothing writes into a removed dir
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface HookOutcome {
  decision: "allow" | "deny";
  reason?: string;
}

/** Call the PreToolUse hook directly, as the SDK would. Resolves when the hook decides. */
export function callHook(session: Session, broker: PermissionBroker, tool: string, mcp: McpHookContext | undefined, input: Record<string, unknown> = {}): Promise<HookOutcome> {
  return callHookFull(session, broker, tool, mcp, input).then(({ decision, reason }) => ({ decision, reason }));
}

export interface FullHookOutcome extends HookOutcome {
  /** The input the tool will actually run with (the gate may have replaced it). */
  updatedInput?: Record<string, unknown>;
  /** Text the hook hands the model with this call's result. */
  additionalContext?: string;
}

/** As `callHook`, and also returns the input the hook hands back to the SDK. */
export function callHookFull(session: Session, broker: PermissionBroker, tool: string, mcp: McpHookContext | undefined, input: Record<string, unknown> = {}): Promise<FullHookOutcome> {
  const hook = makePreToolUseHook(session, broker, undefined, mcp);
  return (hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input } as never, "tu", { signal: new AbortController().signal }) as Promise<any>).then((out) => ({
    decision: out.hookSpecificOutput.permissionDecision,
    reason: out.hookSpecificOutput.permissionDecisionReason,
    updatedInput: out.hookSpecificOutput.updatedInput,
    additionalContext: out.hookSpecificOutput.additionalContext,
  }));
}

/** Let parked promises and microtasks run. */
export const settle = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Whether `p` is still pending after the microtask queue drained. */
export async function isPending(p: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  await settle();
  return (await Promise.race([p, Promise.resolve(marker)])) === marker;
}

/** The one permission request parked on a session (throws unless there is exactly one). */
export function parked(session: Session): { requestId: string; tool: string; suggestions: { decision: string; label: string }[] } {
  const all = [...session.pendingPermissions.values()];
  if (all.length !== 1) throw new Error(`expected exactly one parked permission, found ${all.length}`);
  return all[0]!;
}

/** A driver-shaped stub for the supervisor's private map (as test/unit/accounts-restart.test.ts). */
export interface FakeDriver {
  stopped: boolean;
  stop(): Promise<void>;
}
export function fakeDriver(): FakeDriver {
  const d: FakeDriver = {
    stopped: false,
    stop: async () => {
      d.stopped = true;
    },
  };
  return d;
}
export function driversOf(sup: Supervisor): Map<string, FakeDriver> {
  return (sup as unknown as { drivers: Map<string, FakeDriver> }).drivers;
}
