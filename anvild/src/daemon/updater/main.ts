/**
 * Entrypoint for the update watchdog process (stable-update-service spec §4.1, D17). Launched as its own
 * launchd/systemd unit by scripts/service.sh, ALONGSIDE the daemon — deliberately a separate, minimal
 * process so it survives a daemon build that won't boot and can roll it back from the outside.
 *
 * Wiring only: it resolves the shared state dir + the daemon's local port, then hands real
 * fetch/git/service-manager effects to the injectable {@link UpdateWatchdog}. Keep this file tiny — it is
 * part of the stable surface and should change about as often as service.sh does.
 */
import { loadConfig } from "../../config";
import { installTimestampedConsole } from "../lifecycle";
import { rollbackTo, scheduleRestart } from "../selfupdate";
import { UpdateStateStore } from "../update-state";
import { UpdateWatchdog, type HealthProbe } from "./watchdog";

installTimestampedConsole();

const config = loadConfig();
// [BE2-30] The watchdog writes through its own sidecar file, never the daemon's update-state.json —
// the two processes' read-modify-writes used to race on one file and silently erase each other's
// fields (atomic write ≠ atomic RMW). Readers merge; see UpdateStateStore.
const state = new UpdateStateStore(config.stateDir, { role: "watchdog" });
const healthUrl = `http://localhost:${config.port}/api/health`;
const POLL_MS = 3_000;

async function probeHealth(): Promise<HealthProbe | null> {
  try {
    const r = await fetch(healthUrl, { signal: AbortSignal.timeout(4_000) });
    if (!r.ok) return { ok: false };
    const h = (await r.json()) as { ok?: boolean; version?: string; webBundleOk?: boolean };
    return { ok: !!h.ok, version: h.version, webBundleOk: h.webBundleOk };
  } catch {
    return null; // unreachable this poll (mid-restart, or the new build won't boot)
  }
}

const watchdog = new UpdateWatchdog({
  state,
  health: probeHealth,
  rollback: (sha) => rollbackTo(sha).then(() => {}),
  restartDaemon: scheduleRestart,
  now: () => Date.now(),
  log: (m) => console.log(m),
});

console.log(`[anvil-updater] watching ${healthUrl} (poll ${POLL_MS / 1000}s, gate 180s)`);
void watchdog.run(POLL_MS);

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`[anvil-updater] ${sig} — exiting`);
    process.exit(0);
  });
}
