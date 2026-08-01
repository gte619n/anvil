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
import { shaMatches, shaOf } from "../sha"; // [BE2-33] shared, min-length-guarded

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
// [BE2-33] shaOf/shaMatches are shared (min-length-guarded) — see ../sha.ts.

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
    // [BE2-29] Arm across the WHOLE mutating window, not just "restarting". A crash mid-`bun install`/
    // build leaves the phase at "pulling"/"building" with the checkout already moved to the target; the
    // old guard (restarting-only) left the watchdog idle, so launchd respawned broken source with nothing
    // armed to roll it back — the longest hole in the "survives a bricked release" backstop.
    const inFlight = rec.phase === "pulling" || rec.phase === "building" || rec.phase === "restarting";
    if (!inFlight || !rec.targetSha) {
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

    // [BE2-29] During pulling/building the daemon is still UP doing the work (install/build are async
    // spawns; the old bundle keeps serving). A live, healthy daemon that simply hasn't restarted yet is
    // NOT a failure — only a crash (unreachable) is. So past the gate in these phases, keep waiting while
    // the daemon is alive; roll back only once it goes unreachable/unhealthy. ("restarting" keeps its
    // original semantics: a live-but-not-on-target daemon there means the restart never landed → roll back.)
    if ((rec.phase === "pulling" || rec.phase === "building") && h && h.ok) {
      return "waiting";
    }

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
    // [BE2-31] rollback() spends minutes resetting + rebuilding; the gate is a deadline, not proof of
    // failure — the original boot may have finally gone healthy on the target DURING those minutes.
    // Re-probe before the (previously UNCONDITIONAL) restart: if the target is now healthy, DON'T restart
    // it backwards — that reset of a now-healthy daemon is the restart-storm class this backstop exists
    // to prevent. But note rollback() has ALREADY reset the checkout to prePullSha, so disk == prePullSha
    // is the known-good; we must NOT record the target as known-good (that would make a future failed
    // update "roll back" to the un-reverted target, and the next restart reverts this process anyway).
    // So record the truthful rolled-back-to-prePullSha state and just leave the healthy process running;
    // it boots the reverted (safe) source on its next natural restart, with no forced backwards restart now.
    const after = await this.deps.health().catch(() => null);
    if (after && after.ok && after.webBundleOk && shaMatches(shaOf(after.version), rec.targetSha)) {
      this.deps.state.set({
        phase: "rolled-back",
        targetSha: rec.prePullSha,
        reason: `${reason}; ${rec.targetSha} became healthy during rollback but disk was already reverted — left the healthy process running instead of restarting it backwards`,
      });
      this.log(`[watchdog] ${rec.targetSha} became healthy during rollback; disk reverted to ${rec.prePullSha}, skipping the backwards restart`);
      return "rolled-back";
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
