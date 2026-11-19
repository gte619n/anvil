/**
 * The CAD domain service (agent-cad-and-browser spec §4.2–§4.4, §4.8). Owns the process manager and
 * hands each ordinary session its `anvil_cad` tool server; the Supervisor keeps thin delegates.
 *
 * Capability vs availability (§4.8): `cad-work` in `ANVIL_FEATURES` decides whether a session GETS the
 * server at all. Whether CAD can run right now (is there a binary? later: is it on the fleet pin?)
 * is the `cad.status` event, and the tools refuse with its reason — nothing is withdrawn from a live
 * driver.
 */
import { existsSync } from "node:fs";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { PROTOCOL_VERSION, type CadStatusEvent, type ServerEvent, type Session as SessionInfo } from "@protocol";
import { buildCadToolsServer, CAD_MCP_SERVER_NAME, type CadToolDeps } from "../agent/cad-tools";
import { buildFileOffer, maybeTaildrop } from "../agent/file-offer";
import { CadManager, type CadManagerOptions } from "../cadwork/manager";
import { solidcraftEnv } from "../cadwork/mcp-client";
import { gitToplevel } from "../cadwork/partfolder";
import { currentManagedSolidcraft, resolveSolidcraftCli, type ResolvedSolidcraft } from "../solidcraft/binary";
import { now } from "../util/envelope";
import type { Session } from "./session";

export interface CadStatus {
  available: boolean;
  /** Why CAD cannot run (only when unavailable). */
  reason?: string;
  /** The SolidCraft build this machine runs. */
  version?: string;
  /** The fleet-pinned version, once Track B manages the install. */
  pinned?: string;
}

export interface CadworkServiceDeps {
  /** `featureEnabled(config, "cad-work")`. Off → no session gets the server. */
  enabled: boolean;
  getSession: (id: string) => Session | undefined;
  /** Broadcast target for `cad.status` (omitted in unit tests). */
  registry?: { toAll(ev: ServerEvent): void };
  /** Finds the binary; default `resolveSolidcraftCli()`. */
  resolveCli?: () => ResolvedSolidcraft | undefined;
  /** Reads `<cli> --version`; injectable for tests. */
  readVersion?: (cliPath: string) => Promise<string | undefined>;
  /** Passed to the manager (spawn, clock, cap, FAKE_SC_* env in tests). */
  manager?: CadManagerOptions;
}

export const NO_SOLIDCRAFT = "SolidCraft is not installed on this machine (no solidcraft-cli found)";

/** `solidcraft-cli --version` → "0.44.1", with the same bare environment the manager uses. */
export async function readSolidcraftVersion(cliPath: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([cliPath, "--version"], { stdout: "pipe", stderr: "ignore", env: solidcraftEnv() });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    if ((await proc.exited) !== 0) return undefined;
    return /(\d+\.\d+\.\d+\S*)/.exec(out)?.[1];
  } catch {
    return undefined;
  }
}

export class CadworkService {
  readonly manager: CadManager;
  private readonly resolveCli: () => ResolvedSolidcraft | undefined;
  private readonly readVersion: (cliPath: string) => Promise<string | undefined>;
  /** `--version` per binary path: a string, or `null` when the binary would not run. */
  private readonly versions = new Map<string, string | null>();
  private lastBroadcast = "";

  constructor(private readonly deps: CadworkServiceDeps) {
    this.resolveCli = deps.resolveCli ?? (() => resolveSolidcraftCli());
    this.readVersion = deps.readVersion ?? readSolidcraftVersion;
    this.manager = new CadManager({ resolveCli: this.resolveCli, ...deps.manager });
  }

  get enabled(): boolean {
    return this.deps.enabled;
  }

  /** Whether CAD can run on this machine right now. Cheap and synchronous: re-resolved every call,
   *  so an install or a pin change takes effect without a restart. */
  status(): CadStatus {
    const pinned = currentManagedSolidcraft()?.version;
    const cli = this.resolveCli();
    if (!cli) return { available: false, reason: NO_SOLIDCRAFT, ...(pinned ? { pinned } : {}) };
    if (!existsSync(cli.path)) return { available: false, reason: `solidcraft-cli was not found at ${cli.path}`, ...(pinned ? { pinned } : {}) };
    const known = this.versions.get(cli.path);
    if (known === null) return { available: false, reason: `solidcraft-cli at ${cli.path} could not be run`, ...(pinned ? { pinned } : {}) };
    const version = cli.version ?? known;
    return { available: true, ...(version ? { version } : {}), ...(pinned ? { pinned } : {}) };
  }

  /** The reason the tools refuse with, or undefined when CAD is available. */
  unavailableReason(): string | undefined {
    const s = this.status();
    return s.available ? undefined : (s.reason ?? "CAD is unavailable");
  }

  statusEvent(): CadStatusEvent {
    return { v: PROTOCOL_VERSION, type: "cad.status", ts: now(), ...this.status() };
  }

  /** Ask the binary for its version, then broadcast `cad.status` if anything changed. Called at
   *  boot; Track B calls it again whenever the pin moves. */
  async refreshStatus(): Promise<CadStatus> {
    const cli = this.resolveCli();
    if (cli && existsSync(cli.path) && !cli.version) {
      const v = await this.readVersion(cli.path);
      this.versions.set(cli.path, v ?? null);
    }
    const status = this.status();
    const key = JSON.stringify(status);
    if (key !== this.lastBroadcast) {
      this.lastBroadcast = key;
      this.deps.registry?.toAll(this.statusEvent());
    }
    return status;
  }

  /** The worktree a session's parts live in: the git root of its cwd, or undefined outside a repo. */
  worktreeOf(session: Pick<SessionInfo, "cwd">): string | undefined {
    return gitToplevel(session.cwd);
  }

  /**
   * The capability-gated servers an ORDINARY session gets: `{ anvil_cad }` when `cad-work` is on
   * and its cwd is inside a git repo; otherwise undefined. Role sessions (concierge, team lead or
   * member, planner) never get it — their own tool server is chosen by the Supervisor.
   */
  serversFor(session: Pick<SessionInfo, "id" | "cwd" | "isDefault" | "teamRole" | "workUnitRole">): Record<string, McpSdkServerConfigWithInstance> | undefined {
    if (!this.deps.enabled) return undefined;
    if (session.isDefault || session.teamRole || session.workUnitRole === "planner") return undefined;
    const worktree = this.worktreeOf(session);
    if (!worktree) return undefined;
    return { [CAD_MCP_SERVER_NAME]: buildCadToolsServer(this.toolDeps(session.id, worktree)) };
  }

  /** The surface the tools call back into (exported for tests that drive handlers directly). */
  toolDeps(sessionId: string, worktree: string): CadToolDeps {
    return {
      sessionId,
      worktree,
      manager: this.manager,
      unavailable: () => this.unavailableReason(),
      offerFile: (absPath) => this.offerFile(sessionId, absPath),
    };
  }

  /** Emit a `file.offer` for a file the daemon wrote for this session (an export). False when the
   *  session is gone or the file is outside its cwd (it can only be served from inside it). */
  async offerFile(sessionId: string, absPath: string): Promise<boolean> {
    const s = this.deps.getSession(sessionId);
    if (!s) return false;
    const offer = buildFileOffer(s.id, s.data.cwd, absPath);
    if (!offer) return false;
    try {
      offer.taildropped = await maybeTaildrop(offer.path);
    } catch {
      /* Taildrop is best-effort — the in-chat download card is the reliable path */
    }
    s.emit({ type: "file.offer", file: offer });
    return true;
  }

  /** Stop every SolidCraft process (daemon shutdown). */
  shutdown(): Promise<void> {
    return this.manager.shutdown();
  }
}
