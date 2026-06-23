/**
 * Daemon self-update (arch §5). The daemon runs from TS source under a launchd service that
 * serves the *built* web bundle from web/dist. A deploy is therefore: pull the daemon's own
 * source repo, rebuild web/dist, then restart so the new source is re-read. This module does all
 * three so it can be triggered from any client instead of shelling into the host (see service.sh,
 * which does the same steps by hand).
 *
 * All steps shell out asynchronously (Bun.spawn) so a slow build never blocks the event loop /
 * other sessions. Restart is done with `launchctl kickstart -k` (the same path service.sh uses):
 * launchd's KeepAlive does NOT respawn after a clean SIGTERM exit (verified empirically), so a bare
 * self-SIGTERM would shut the daemon down for good — kickstart -k deterministically kills + respawns.
 */
import { join } from "node:path";

/** launchd service label (must match LABEL in scripts/service.sh). */
const SERVICE_LABEL = "com.anvil.anvild";

/** The anvild package dir (where package.json + build:web live): .../anvild */
const anvildDir = join(import.meta.dir, "..", "..");

/** True when we were started by the launchd launcher (service.sh sets ANVIL_MANAGED). Only then
 *  is exiting safe — launchd respawns us. Run via `bun dev` it would just die, so we don't. */
export function isManaged(): boolean {
  return process.env.ANVIL_MANAGED === "launchd";
}

async function run(cmd: string[], cwd: string): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, out: `${stdout}${stderr}`.trim() };
}

/** Resolve the daemon's own git repo root from the anvild source dir. */
async function repoRoot(): Promise<string> {
  const r = await run(["git", "rev-parse", "--show-toplevel"], anvildDir);
  if (r.code !== 0) throw new Error(`not a git checkout: ${r.out || `exit ${r.code}`}`);
  return r.out.trim();
}

/** Fetch and report how many commits behind upstream the daemon's checkout is. */
export async function checkForUpdate(): Promise<{ behind: number; output: string }> {
  const root = await repoRoot();
  const fetch = await run(["git", "fetch", "--quiet"], root);
  if (fetch.code !== 0) throw new Error(`git fetch failed: ${fetch.out || `exit ${fetch.code}`}`);
  const upstream = await run(["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root);
  if (upstream.code !== 0) {
    throw new Error("no upstream branch configured for the daemon's checkout — can't check for updates");
  }
  const counted = await run(["git", "rev-list", "--count", "HEAD..@{u}"], root);
  if (counted.code !== 0) throw new Error(`git rev-list failed: ${counted.out || `exit ${counted.code}`}`);
  const behind = Number.parseInt(counted.out.trim(), 10) || 0;
  const ref = upstream.out.trim();
  return { behind, output: behind === 0 ? `Up to date with ${ref}.` : `${behind} commit(s) behind ${ref}.` };
}

/** Fast-forward the checkout, reinstall deps, and rebuild the web bundle. Throws on any failure
 *  (with the failing step's output) so the caller never restarts onto a broken tree. */
export async function applyUpdate(): Promise<{ output: string }> {
  const root = await repoRoot();
  const log: string[] = [];

  const pull = await run(["git", "pull", "--ff-only"], root);
  log.push(`$ git pull --ff-only\n${pull.out}`);
  if (pull.code !== 0) throw new Error(`git pull failed (local changes / not fast-forward?):\n${pull.out}`);

  const install = await run(["bun", "install"], anvildDir);
  log.push(`$ bun install\n${install.out}`);
  if (install.code !== 0) throw new Error(`bun install failed:\n${install.out}`);

  const build = await run(["bun", "run", "build:web"], anvildDir);
  log.push(`$ bun run build:web\n${build.out}`);
  if (build.code !== 0) throw new Error(`web build failed:\n${build.out}`);

  return { output: log.join("\n\n") };
}

/** Restart via `launchctl kickstart -k` after a short delay (so the result event flushes first).
 *  KeepAlive does NOT respawn a clean SIGTERM exit, so the daemon must ask launchd to relaunch it:
 *  kickstart -k SIGKILLs the current instance (after its SIGTERM graceful flush) and starts a fresh
 *  one that re-reads the updated source + serves the new bundle. The launchctl child is detached so
 *  it isn't torn down with us — by the time the kill lands, launchd has already queued the relaunch. */
export function scheduleRestart(): void {
  const uid = process.getuid?.() ?? 0;
  setTimeout(() => {
    try {
      Bun.spawn(["launchctl", "kickstart", "-k", `gui/${uid}/${SERVICE_LABEL}`], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      // Fallback: at least stop cleanly. (Should never happen — launchctl always exists on macOS.)
      process.kill(process.pid, "SIGTERM");
    }
  }, 1000).unref?.();
}
