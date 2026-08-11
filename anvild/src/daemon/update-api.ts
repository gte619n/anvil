/**
 * The FROZEN update API v1 logic layer (stable-update-service spec §4.3). This is the single place the
 * daemon's update surface is implemented; three thin transports delegate here:
 *   • `GET  /api/update/v1/check`   → {@link updateCheck}
 *   • `POST /api/update/v1/apply`   → {@link updateApply}
 *   • `GET  /api/update/v1/status`  → {@link updateStatus}
 *   • legacy WS `daemon.update` / `POST /api/daemon/update` (supervisor.daemonUpdate) also delegate here
 *
 * It composes the pinned-target + rollback primitives in selfupdate.ts with the persisted
 * UpdateStateStore, and is the STABLE contract a hub + a partially-updated fleet coordinate over — so
 * its response SHAPES are additive-only (guarded by the OpenAPI contract test). Everything it can't do
 * without a service manager (the actual restart) is injected, so the whole layer is unit-testable.
 */
import type { rest } from "@protocol";
import { UPDATE_API_VERSION } from "@protocol";
import { VERSION } from "../version";
import * as selfupdate from "./selfupdate";
import type { CommandRunner } from "./selfupdate";
import type { UpdateStateStore } from "./update-state";
import { shaMatches as shaEq } from "./sha"; // [BE2-33] shared, min-length-guarded

export interface UpdateApiDeps {
  state: UpdateStateStore;
  /** Where the web bundle is served from — feeds the smoke check. */
  webDir?: string;
  /** Injected so tests never spawn real git/bun; defaults to the real runner in selfupdate. */
  run?: CommandRunner;
  /** True when a service manager will respawn us — only then is a restart safe. */
  isManaged?: () => boolean;
  /** Ask the service manager to restart (applies the pulled code). */
  scheduleRestart?: () => void;
}

/** GET /api/update/v1/check — fetch + report how far behind + whether a restart alone would apply a
 *  prior stalled update. Never mutates the checkout. */
export async function updateCheck(deps: UpdateApiDeps): Promise<rest.update.CheckResponse> {
  const run = deps.run;
  const base = { updateApiVersion: UPDATE_API_VERSION, currentSha: selfupdate.runningSha() };
  try {
    const chk = await selfupdate.checkForUpdate(run);
    const targetSha = await selfupdate.resolveTargetSha(run).catch(() => "");
    return { ok: true, ...base, targetSha, behind: chk.behind, needsRestart: chk.needsRestart, output: chk.output };
  } catch (e) {
    return { ok: false, ...base, targetSha: "", behind: 0, needsRestart: false, output: "", error: msg(e) };
  }
}

/**
 * POST /api/update/v1/apply — move the checkout to a target SHA (pinned by the caller, or the resolved
 * upstream tip when omitted) and restart to apply. Records the pre-pull SHA to disk first so the
 * watchdog can roll back a bad boot. Phase transitions are persisted so `/status` (and a hub observing
 * the rollout) can follow along across the restart.
 */
// [BE2-28] Cross-transport concurrency guard. The legacy WS `private updating` flag only protected that
// one path; the v1 `/apply` route AND the fleet-rollout `applySelf` both delegate here and could
// interleave two applies — corrupting the checkout mid-`bun install`/build and poisoning `prePullSha`.
// A single module-level in-flight promise serializes ALL of them: a second apply while one is running
// gets a clean "already in progress" instead of racing the tree.
let applyInFlight: Promise<rest.update.ApplyResponse> | null = null;

export async function updateApply(req: rest.update.ApplyRequest, deps: UpdateApiDeps): Promise<rest.update.ApplyResponse> {
  if (applyInFlight) {
    return {
      ok: false,
      updateApiVersion: UPDATE_API_VERSION,
      currentVersion: VERSION,
      phase: "error",
      willRestart: false,
      prePullSha: deps.state.get().prePullSha,
      targetSha: deps.state.get().targetSha,
      output: "",
      error: "an update is already in progress",
    };
  }
  applyInFlight = doUpdateApply(req, deps);
  try {
    return await applyInFlight;
  } finally {
    applyInFlight = null;
  }
}

async function doUpdateApply(req: rest.update.ApplyRequest, deps: UpdateApiDeps): Promise<rest.update.ApplyResponse> {
  const run = deps.run;
  const currentVersion = VERSION;
  const running = selfupdate.runningSha();
  const base = { updateApiVersion: UPDATE_API_VERSION, currentVersion };
  try {
    deps.state.set({ phase: "checking" });
    const targetSha = (req.targetSha?.trim() || (await selfupdate.resolveTargetSha(run))).trim();
    const head = await selfupdate.headSha(run);

    // Already on the target ON DISK. If the running process is also that SHA, we're done. If not, a
    // prior update pulled the code but its restart never landed — just restart onto what's on disk.
    if (shaEq(head, targetSha)) {
      if (shaEq(running, targetSha)) {
        deps.state.set({ phase: "healthy", targetSha, prePullSha: running });
        return { ok: true, ...base, phase: "idle", willRestart: false, prePullSha: running, targetSha, output: `Already at ${targetSha}.` };
      }
      const willRestart = deps.isManaged?.() ?? false;
      deps.state.set({ phase: "restarting", targetSha, prePullSha: running });
      if (willRestart) deps.scheduleRestart?.();
      const note = willRestart ? "" : "\n\nNot running under the service manager — restart manually to apply.";
      return { ok: true, ...base, phase: "restarting", willRestart, prePullSha: running, targetSha, output: `On-disk build already at ${targetSha}; restarting to apply.${note}` };
    }

    deps.state.set({ phase: "building", targetSha, prePullSha: running });
    const upd = await selfupdate.applyUpdateToTarget(targetSha, {
      run,
      recordPrePull: (sha) => deps.state.set({ phase: "pulling", targetSha, prePullSha: sha }),
    });
    const willRestart = deps.isManaged?.() ?? false;
    deps.state.set({ phase: "restarting", targetSha, prePullSha: upd.prePullSha });
    if (willRestart) deps.scheduleRestart?.();
    const note = willRestart ? "" : "\n\nNot running under the service manager — restart manually to apply.";
    return { ok: true, ...base, phase: "restarting", willRestart, prePullSha: upd.prePullSha, targetSha, output: upd.output + note };
  } catch (e) {
    const rec = deps.state.set({ phase: "error", reason: msg(e) });
    return { ok: false, ...base, phase: "error", willRestart: false, prePullSha: rec.prePullSha, targetSha: rec.targetSha, output: "", error: msg(e) };
  }
}

/** GET /api/update/v1/status — read-only live phase for a hub to observe. Derives "healthy" when a
 *  "restarting" record's target now matches the running process AND the web bundle is servable, so the
 *  hub sees success without the daemon having to rewrite state post-boot (settleAfterBoot also does). */
export function updateStatus(deps: UpdateApiDeps): rest.update.StatusResponse {
  const rec = deps.state.get();
  const currentSha = selfupdate.runningSha();
  const webBundleOk = selfupdate.webBundleOk(deps.webDir);
  let phase = rec.phase;
  if (phase === "restarting" && rec.targetSha && shaEq(currentSha, rec.targetSha) && webBundleOk) phase = "healthy";
  return {
    ok: true,
    updateApiVersion: UPDATE_API_VERSION,
    phase,
    currentSha,
    currentVersion: VERSION,
    targetSha: rec.targetSha,
    prePullSha: rec.prePullSha,
    webBundleOk,
    ...(rec.reason ? { reason: rec.reason } : {}),
    ...(rec.updatedAt ? { updatedAt: rec.updatedAt } : {}),
  };
}

/**
 * Called once on daemon boot — the IN-DAEMON half of the "both shim + in-daemon gate" resilience model
 * (spec D5). If the persisted record shows we were mid-restart toward a target and the running process
 * is now that target AND the bundle is servable, mark the update healthy and adopt the new SHA as the
 * known-good to roll back to next time. This is the fast, cooperative path; the out-of-process watchdog
 * is the backstop for "the daemon never came up at all".
 */
export function settleAfterBoot(deps: UpdateApiDeps): void {
  const rec = deps.state.get();
  if (rec.phase !== "restarting") return;
  const currentSha = selfupdate.runningSha();
  if (rec.targetSha && shaEq(currentSha, rec.targetSha) && selfupdate.webBundleOk(deps.webDir)) {
    deps.state.set({ phase: "healthy", prePullSha: currentSha, reason: undefined });
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
