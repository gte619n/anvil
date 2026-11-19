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
import { cadTools } from "../../src/agent/cad-tools";
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

/**
 * A REAL CadworkService with its real manager, plus one session's agent tools. The binary is
 * whatever the service resolves — the functional suite points `ANVIL_SOLIDCRAFT_CLI` at the fake.
 */
export function fakeCadSession(worktree: string, deps: Partial<CadworkServiceDeps> = {}, sessionId = "sess_cad") {
  const { session, emitted } = recordingSession(worktree, sessionId);
  const sessions = new Map<string, Session>([[sessionId, session]]);
  const broadcasts: any[] = [];
  const service = new CadworkService({
    enabled: true,
    getSession: (id) => sessions.get(id),
    registry: { toAll: (ev) => void broadcasts.push(ev) },
    ...deps,
  });
  services.push(service);
  const defs = cadTools(service.toolDeps(sessionId, worktree));
  return { service, manager: service.manager, tools: callable(defs as any), defs, session, sessions, emitted, broadcasts };
}
export async function stopServices(): Promise<void> {
  await Promise.all(services.splice(0).map((s) => s.shutdown().catch(() => undefined)));
}

/** Write a design.json for a part by hand (a checkout, a hand edit). */
export function writeDesign(worktree: string, part: string, commands: unknown[], about: Record<string, unknown> = { design: part, format: "solidcraft/58", version: "0.44.1" }): string {
  const dir = join(worktree, "cad", part);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "design.json");
  writeFileSync(path, JSON.stringify({ about, commands }, null, 2) + "\n");
  return path;
}

export const BOX = (name = "Box", size = 10) => ({ command: "solid.box", params: { length: size, width: size, height: size, name } });
