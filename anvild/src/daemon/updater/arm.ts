/**
 * Self-bootstrapping migration (stable-update-service spec §4.5 / D15). An existing host self-updates
 * via the OLD path (git pull + restart) onto a build that now carries the watchdog — but nothing has
 * installed the watchdog's service-manager unit yet. On first boot of such a build, the daemon arms the
 * watchdog ONCE by shelling `service.sh install-updater`. After that one hop, every future update runs
 * under the stable path.
 *
 * Idempotent + best-effort + non-blocking: it only acts when running under a service manager and the
 * unit is absent, spawns detached, and never throws into the boot path (the in-process settleAfterBoot
 * already provides basic resilience without the watchdog).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { serviceManager, type ServiceManager } from "../selfupdate";

const UPDATER_LABEL = "com.anvil.anvil-updater"; // must match scripts/service.sh

/** The anvild package dir (…/anvild) resolved from this module (src/daemon/updater/arm.ts). */
const anvildDir = join(import.meta.dir, "..", "..", "..");

/** Where the watchdog's unit file lives for a given service manager, or null when unmanaged. */
export function watchdogUnitPath(mgr: ServiceManager | null, home: string = homedir()): string | null {
  if (mgr === "launchd") return join(home, "Library", "LaunchAgents", `${UPDATER_LABEL}.plist`);
  if (mgr === "systemd") return join(home, ".config", "systemd", "user", `${UPDATER_LABEL}.service`);
  return null;
}

/** True when we're managed AND the watchdog unit isn't installed yet — i.e. this is the migration hop. */
export function needsArming(mgr: ServiceManager | null, home: string = homedir(), exists: (p: string) => boolean = existsSync): boolean {
  const path = watchdogUnitPath(mgr, home);
  return !!path && !exists(path);
}

/**
 * Arm the watchdog if this boot is the migration hop. Fire-and-forget; logs what it did. Injectable
 * `spawn` for tests. Returns true when an arming was kicked off, false when it was a no-op.
 */
export function armWatchdog(
  opts: {
    mgr?: ServiceManager | null;
    home?: string;
    exists?: (p: string) => boolean;
    spawn?: (cmd: string[]) => void;
    log?: (m: string) => void;
  } = {},
): boolean {
  const mgr = opts.mgr ?? serviceManager();
  const home = opts.home ?? homedir();
  const log = opts.log ?? ((m: string) => console.log(m));
  if (!needsArming(mgr, home, opts.exists ?? existsSync)) return false;
  const script = join(anvildDir, "scripts", "service.sh");
  if ((opts.exists ?? existsSync)(script) === false) return false; // packaged binary without the script — skip
  log(`[anvild] arming the update watchdog (one-time migration) via ${script} install-updater`);
  const spawn =
    opts.spawn ??
    ((cmd: string[]) => {
      // Detached + ignored stdio so a slow install can't hold the daemon's boot; errors are the
      // watchdog install's problem, surfaced in its own log, never fatal to the daemon.
      Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    });
  try {
    spawn(["bash", script, "install-updater"]);
    return true;
  } catch (e) {
    log(`[anvild] watchdog arming failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
