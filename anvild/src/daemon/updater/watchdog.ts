/**
 * The out-of-process update watchdog (stable-update-service spec §4.1, D5/D9/D17) — the STABLE backstop
 * that must survive a bricked daemon release. It runs as its OWN service-manager unit, separate from the
 * daemon, and:
 *   1. watches the shared `<stateDir>/update-state.json` for an update in flight (phase "restarting");
 *   2. arms a health gate and polls the daemon's localhost `/api/health` (spec D9);
 *   3. on success — the new build answers healthy with the target SHA and a servable bundle — records the
 *      landed build as the new known-good;
 *   4. on FAILURE — the gate elapses (the daemon crash-loops, hangs, or serves a broken bundle) — rolls
 *      the checkout back to the pre-pull SHA and restarts the daemon (spec D4/D8). The member self-heals
 *      locally; the hub only observes (spec D10).
 *
 * Everything with a side effect (health probe, git rollback, daemon restart, clock) is injected, so the
 * whole state machine is unit-tested without a real daemon or service manager, and driven for real by the
 * multi-daemon fleet-sim.
 */
import type { UpdateStateStore } from "../update-state";

/** What the daemon's /api/health tells the watchdog. null ⇒ unreachable this poll (mid-restart, or the
 *  new build won't boot). */
export interface HealthProbe {
  ok: boolean;
  version?: string; // "0.2.1+<sha>" — the +sha is compared to the target
  webBundleOk?: boolean; // the boot smoke (spec D14)
}

export interface WatchdogDeps {
  state: UpdateStateStore;
  health: () => Promise<HealthProbe | null>;
  /** Reset the checkout to the known-good SHA + rebuild (selfupdate.rollbackTo). */
  rollback: (sha: string) => Promise<void>;
  /** Ask the service manager to restart the DAEMON (selfupdate.scheduleRestart). */
  restartDaemon: () => void;
  now: () => number;
  /** The health gate (spec D11: 180s). */
  gateMs?: number;
  log?: (m: string) => void;
}

export type TickResult = "idle" | "waiting" | "healthy" | "rolled-back" | "rollback-failed";

const DEFAULT_GATE_MS = 180_000;

/** The short SHA embedded in a VERSION string ("0.2.1+abc1234" → "abc1234"). */
function shaOf(version: string | undefined): string {
  if (!version) return "";
  const i = version.indexOf("+");
  return i >= 0 ? version.slice(i + 1) : version;
}
/** Two abbreviated SHAs referring to the same commit (either may be the shorter abbreviation). */
function shaMatches(a: string, b: string): boolean {
  return !!a && !!b && (a.startsWith(b) || b.startsWith(a));
}

export class UpdateWatchdog {
  private armedTarget: string | null = null;
  private deadline = 0;
  private readonly gateMs: number;
  private readonly log: (m: string) => void;

  constructor(private readonly deps: WatchdogDeps) {
    this.gateMs = deps.gateMs ?? DEFAULT_GATE_MS;
    this.log = deps.log ?? (() => {});
  }

  /** One evaluation step. Returns what it decided so tests can assert the state machine directly. */
  async tick(): Promise<TickResult> {
    const rec = this.deps.state.get();
    if (rec.phase !== "restarting" || !rec.targetSha) {
      this.armedTarget = null; // not mid-update — disarm
      return "idle";
    }
    // Arm (or re-arm for a new target) — start the gate clock.
    if (this.armedTarget !== rec.targetSha) {
      this.armedTarget = rec.targetSha;
      this.deadline = this.deps.now() + this.gateMs;
      this.log(`[watchdog] armed for ${rec.targetSha}; gate ${Math.round(this.gateMs / 1000)}s`);
    }

    const h = await this.deps.health().catch(() => null);
    if (h && h.ok && h.webBundleOk && shaMatches(shaOf(h.version), rec.targetSha)) {
      // Landed: the new build is up, serving, and on the target SHA. Adopt it as the new known-good.
      this.deps.state.set({ phase: "healthy", prePullSha: shaOf(h.version) });
      this.armedTarget = null;
      this.log(`[watchdog] ${rec.targetSha} healthy — adopted as known-good`);
      return "healthy";
    }

    if (this.deps.now() < this.deadline) return "waiting";

    // Gate elapsed — the update failed to come up. Roll back to the pre-pull SHA and restart.
    this.armedTarget = null;
    const reason = `health gate timed out after ${Math.round(this.gateMs / 1000)}s (daemon did not become healthy on ${rec.targetSha})`;
    this.log(`[watchdog] ROLLBACK → ${rec.prePullSha}: ${reason}`);
    if (!rec.prePullSha) {
      this.deps.state.set({ phase: "error", reason: `${reason}; no pre-pull SHA recorded — cannot roll back automatically` });
      return "rollback-failed";
    }
    try {
      await this.deps.rollback(rec.prePullSha);
    } catch (e) {
      this.deps.state.set({ phase: "error", reason: `${reason}; rollback FAILED: ${e instanceof Error ? e.message : String(e)}` });
      return "rollback-failed";
    }
    this.deps.state.set({ phase: "rolled-back", targetSha: rec.prePullSha, reason });
    this.deps.restartDaemon();
    return "rolled-back";
  }

  /** Poll forever (production). `sleep` is injected only so tests can bound it; the real loop uses a
   *  timer. Never throws — a transient error becomes the next tick's problem. */
  async run(intervalMs: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    for (;;) {
      try {
        await this.tick();
      } catch (e) {
        this.log(`[watchdog] tick error: ${e instanceof Error ? e.message : String(e)}`);
      }
      await sleep(intervalMs);
    }
  }
}
