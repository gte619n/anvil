/**
 * Shared fixtures for the CAD suites (agent-cad-and-browser spec §8.1, §8.2): a temp git repo, a
 * fake clock, a spawn that records every command line, and a manager / service wired to the fake
 * SolidCraft (test/fixtures/fake-solidcraft.ts).
 *
 * HOW A TEST SPINS UP CAD AGAINST THE FAKE
 *   const repo = tempRepo();                                   // a real git repo in a temp folder
 *   const m = fakeManager({ extraEnv: { FAKE_SC_… } });         // unit: the manager alone
 *   const { service, tools, session } = fakeCadSession(repo);   // functional: service + agent tools
 *   await tools.open_part({ part: "plate" });
 *   await tools.batch({ commands: REFERENCE_PLATE });
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCadProtectedForTest } from "../../src/agent/cad-protected";
import { cadTools, type CadToolDeps } from "../../src/agent/cad-tools";
import { CadManager, type CadManagerOptions } from "../../src/cadwork/manager";
import { defaultMcpSpawn, type CadClock, type McpSpawn } from "../../src/cadwork/mcp-client";
import { CadworkService, type CadworkServiceDeps } from "../../src/session/cadwork-service";
import type { Session } from "../../src/session/session";
import { FAKE_SOLIDCRAFT } from "./fake-solidcraft";

const made: string[] = [];

/** A fresh git repo (real path) with one commit-less `main`. Removed by `cleanupTemp()`. */
export function tempRepo(prefix = "anvil-cad-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  const r = Bun.spawnSync(["git", "init", "-q", dir], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git init failed: ${r.stderr.toString()}`);
  return dir;
}

/** A temp folder that is NOT a git repo. */
export function tempDir(prefix = "anvil-cad-plain-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

export function cleanupTemp(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** A clock whose timers fire only when the test says so. */
export class FakeClock implements CadClock {
  private t = 1_000_000;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void; ms: number }>();
  /** Every delay ever asked for, in order (to assert the timeout a request was given). */
  readonly asked: number[] = [];
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.asked.push(ms);
    this.timers.set(id, { at: this.t + ms, fn, ms });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  /** Timers still armed, as their delays. */
  pending(): number[] {
    return [...this.timers.values()].map((t) => t.ms);
  }
  /** Move time forward, firing every timer that comes due, in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
    }
    this.t = end;
  }
}

export interface SpawnLog {
  spawn: McpSpawn;
  /** Every command line spawned, in order. */
  cmds: string[][];
  /** The environment each one got. */
  envs: Record<string, string>[];
}
/** The real spawn, recording what it was asked to run. */
export function recordingSpawn(): SpawnLog {
  const log: SpawnLog = {
    cmds: [],
    envs: [],
    spawn: (cmd, env) => {
      log.cmds.push(cmd);
      log.envs.push(env);
      return defaultMcpSpawn(cmd, env);
    },
  };
  return log;
}

const managers: CadManager[] = [];

/** A manager that runs the fake SolidCraft. Stopped by `stopManagers()`. */
export function fakeManager(opts: CadManagerOptions = {}): CadManager {
  const m = new CadManager({ resolveCli: () => ({ path: FAKE_SOLIDCRAFT }), ...opts });
  managers.push(m);
  return m;
}
export async function stopManagers(): Promise<void> {
  await Promise.all(managers.splice(0).map((m) => m.shutdown().catch(() => undefined)));
}

/** Poll until `cond()` holds (process exits and queue hand-offs are real, not clock-driven). */
export async function until(cond: () => boolean, what = "condition", timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** What a tool handler returned, flattened for assertions. */
export interface ToolReply {
  isError: boolean;
  /** Every text part joined by a newline. */
  text: string;
  /** The first text part parsed as JSON (SolidCraft's own reply), when it is JSON. */
  json: any;
  /** The `[anvil]` notes the daemon appended. */
  notes: string[];
  content: any[];
}
export type ToolCaller = Record<string, (args?: Record<string, unknown>) => Promise<ToolReply>>;

/** Wrap `cadTools()` definitions as `tools.<name>(args)`. Unknown names throw. */
export function callable(defs: { name: string; handler: (args: any, extra: unknown) => Promise<any> }[]): ToolCaller {
  const out: ToolCaller = {};
  for (const d of defs) {
    out[d.name] = async (args = {}) => {
      const r = await d.handler(args, {});
      const texts: string[] = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text);
      const own = texts.filter((t) => !t.startsWith("[anvil] "));
      let json: any;
      for (const t of own) {
        try {
          json = JSON.parse(t);
        } catch {
          /* a plain message */
        }
      }
      return { isError: r.isError === true, text: texts.join("\n"), json, notes: texts.filter((t) => t.startsWith("[anvil] ")), content: r.content ?? [] };
    };
  }
  return out;
}

/** A Session stand-in that records what the service emits into it (file offers). */
export function recordingSession(cwd: string, id = "sess_cad", data: Record<string, unknown> = {}) {
  const emitted: any[] = [];
  const session = {
    id,
    data: { id, cwd, autonomy: "allowlist", ...data },
    emit: (body: any) => {
      emitted.push(body);
      return body;
    },
  } as unknown as Session;
  return { session, emitted };
}

const services: CadworkService[] = [];

/** The gate half of `CadToolDeps` for suites that drive the tools against a bare manager (no service):
 *  modeling is never refused and the expectation tools answer "nothing happened". */
export const STUB_GATE_DEPS: Pick<CadToolDeps, "touch" | "modelingRefusal" | "recordExpectations" | "proposeExpectations" | "checkPart"> = {
  touch: () => undefined,
  modelingRefusal: () => undefined,
  recordExpectations: () => ({ ok: true }),
  proposeExpectations: async () => ({ ok: true, approved: false }),
  checkPart: async () => {
    throw new Error("no gate in this suite");
  },
};

/** Expectations that say nothing true about any part: for suites that are about the manager and the
 *  tools, not the gate. Recorded through the REAL record_expectations tool (see `fakeCadSession`). */
export const PLACEHOLDER_EXPECTATIONS = { bbox: [1, 1, 1], volume: 1, bodies: 1, holes: [] };
export const PLACEHOLDER_PROCESS = "placeholder";

/**
 * A REAL CadworkService with its real manager, plus one session's agent tools. The binary is
 * whatever the service resolves — the functional suite points `ANVIL_SOLIDCRAFT_CLI` at the fake.
 */
export function fakeCadSession(
  worktree: string,
  deps: Partial<CadworkServiceDeps> = {},
  sessionId = "sess_cad",
  /**
   * `auto` (default): `open_part` on a part with no expectations records `PLACEHOLDER_EXPECTATIONS`
   * through the real record_expectations tool, so suites about the manager and the tools (Phase A1)
   * can model without restating the rule every time. `manual`: nothing is recorded for the test —
   * what the gate suites (Phase A2) use.
   */
  opts: { expectations?: "auto" | "manual"; sessionData?: Record<string, unknown> } = {},
) {
  const { session, emitted } = recordingSession(worktree, sessionId, opts.sessionData);
  const sessions = new Map<string, Session>([[sessionId, session]]);
  const broadcasts: any[] = [];
  const service = new CadworkService({
    enabled: true,
    getSession: (id) => sessions.get(id),
    registry: { toAll: (ev) => void broadcasts.push(ev) },
    stateDir: tempDir("anvil-cad-state-"),
    ...deps,
  });
  services.push(service);
  const defs = cadTools(service.toolDeps(sessionId, worktree));
  const tools = callable(defs as any);
  if ((opts.expectations ?? "auto") === "auto") {
    const open = tools.open_part!;
    tools.open_part = async (args = {}) => {
      const r = await open(args);
      if (!r.isError && r.json?.modeling !== "allowed") {
        const rec = await tools.record_expectations!({ part: args.part, process: PLACEHOLDER_PROCESS, expectations: PLACEHOLDER_EXPECTATIONS });
        if (rec.isError) throw new Error(`placeholder expectations were refused: ${rec.text}`);
        r.notes = r.notes.filter((n) => !n.includes("has no expectations yet"));
        r.text = r.text.split("\n").filter((l) => !l.includes("has no expectations yet")).join("\n");
      }
      return r;
    };
  }
  /** Every expectations card broadcast so far that nobody has answered. */
  const openCards = () => {
    const done = new Set(broadcasts.filter((e) => e.type === "cad.expectations.resolved").map((e) => e.requestId));
    return broadcasts.filter((e) => e.type === "cad.expectations.request" && !done.has(e.requestId));
  };
  /** The newest `cad.design` for a part. */
  const design = (part: string) => broadcasts.filter((e) => e.type === "cad.design" && e.part === part).at(-1);
  return { service, manager: service.manager, tools, defs, session, sessions, emitted, broadcasts, openCards, design };
}
export async function stopServices(): Promise<void> {
  await Promise.all(services.splice(0).map((s) => s.shutdown().catch(() => undefined)));
  resetCadProtectedForTest();
}

/** A rules file with one FDM and one CNC process. */
export const RULES = {
  schema: 1,
  processes: [
    { id: "fdm-0.4", kind: "fdm", envelope: [250, 210, 220] },
    { id: "cnc-3axis", kind: "cnc", envelope: [300, 200, 100], drills: [3.4, 4.2, 5, 6.5], holeTolerance: 0.05 },
  ],
};
export function writeRules(worktree: string, rules: unknown = RULES): string {
  mkdirSync(join(worktree, "cad"), { recursive: true });
  const path = join(worktree, "cad", "rules.json");
  writeFileSync(path, JSON.stringify(rules, null, 2) + "\n");
  return path;
}

/** The reference plate's documented volume: the slab, less the four rounded corners, less four
 *  counterbored holes (⌀3.4 through, ⌀6.5 × 3.3 deep). 23335.167 mm³ at L=80, W=50, T=6. */
export const PLATE_VOLUME = "L*W*T - (4 - pi)*5^2*T - 4*(pi*1.7^2*(T - 3.3) + pi*3.25^2*3.3)";
export const PLATE_EXPECTATIONS = { bbox: ["L", "W", "T"], volume: PLATE_VOLUME, bodies: 1, holes: [{ diameter: 3.4, count: 4 }] };

/** Write a design.json for a part by hand (a checkout, a hand edit). */
export function writeDesign(worktree: string, part: string, commands: unknown[], about: Record<string, unknown> = { design: part, format: "solidcraft/58", version: "0.44.1" }): string {
  const dir = join(worktree, "cad", part);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "design.json");
  writeFileSync(path, JSON.stringify({ about, commands }, null, 2) + "\n");
  return path;
}

export const BOX = (name = "Box", size = 10) => ({ command: "solid.box", params: { length: size, width: size, height: size, name } });

/** Approve every expectations card that is waiting (what the owner's taps do), until none is left. */
export function approveCards(x: { service: CadworkService; openCards: () => any[] }): string[] {
  const kinds: string[] = [];
  for (let i = 0; i < 10; i++) {
    const open = x.openCards();
    if (open.length === 0) break;
    for (const c of open) {
      kinds.push(c.kind);
      x.service.respond(c.requestId, true);
    }
  }
  return kinds;
}

/**
 * The reference plate, built the way an agent is meant to: open, record expectations, model (the
 * hole pattern as its own request, so one `undo` removes exactly that feature), then the owner adopts
 * the repo's rules file. Returns the session and the gate after all of it.
 */
export async function buildPlate(
  repo: string,
  opts: { deps?: Partial<CadworkServiceDeps>; expectations?: unknown; process?: string; rules?: unknown | null; sessionId?: string; cli: string; adopt?: boolean } = { cli: "" },
) {
  if (opts.rules !== null) writeRules(repo, opts.rules ?? RULES);
  const x = fakeCadSession(repo, { resolveCli: () => ({ path: opts.cli, source: "env" }), ...opts.deps }, opts.sessionId ?? "sess_cad", { expectations: "manual" });
  const { tools } = x;
  const must = async (p: Promise<ToolReply>): Promise<ToolReply> => {
    const r = await p;
    if (r.isError) throw new Error(r.text);
    return r;
  };
  const { REFERENCE_PLATE } = await import("./fake-solidcraft");
  await must(tools.open_part!({ part: "plate" }));
  await must(tools.record_expectations!({ part: "plate", process: opts.process ?? "fdm-0.4", expectations: opts.expectations ?? PLATE_EXPECTATIONS }));
  await must(tools.batch!({ commands: REFERENCE_PLATE.slice(0, 15) }));
  await must(tools.batch!({ commands: REFERENCE_PLATE.slice(15) }));
  let gate = (await must(tools.check_part!({ part: "plate" }))).json;
  if (opts.adopt !== false && x.openCards().length) {
    approveCards(x);
    gate = (await must(tools.check_part!({ part: "plate" }))).json;
  }
  const check = async () => (await must(tools.check_part!({ part: "plate" }))).json;
  return { ...x, gate, check, partJson: join(repo, "cad", "plate", "part.json") };
}
