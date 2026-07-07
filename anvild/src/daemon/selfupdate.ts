/**
 * Daemon self-update (arch §5). The daemon runs from TS source under a service manager (launchd on
 * macOS, systemd --user on Linux) that serves the *built* web bundle from web/dist. A deploy is
 * therefore: pull the daemon's own source repo, rebuild web/dist, then restart so the new source is
 * re-read. This module does all three so it can be triggered from any client instead of shelling
 * into the host (see service.sh, which does the same steps by hand).
 *
 * All steps shell out asynchronously (Bun.spawn) so a slow build never blocks the event loop /
 * other sessions. Restart uses the same mechanism service.sh does for the host's service manager:
 *   • launchd  — `launchctl kickstart -k`: KeepAlive does NOT respawn after a clean SIGTERM exit
 *     (verified empirically), so a bare self-SIGTERM would shut the daemon down for good; kickstart
 *     -k deterministically kills + respawns.
 *   • systemd  — `systemctl --user restart`: deterministic kill + respawn (Restart=always would
 *     also respawn a clean exit, but the explicit restart matches launchd's semantics).
 */
import { join } from "node:path";
import { VERSION } from "../version";

/** Service label — must match LABEL in scripts/service.sh (launchd) / the systemd unit name. */
const SERVICE_LABEL = "com.anvil.anvild";

/** The short SHA the RUNNING process was built from — captured once at startup in version.ts (the part
 *  after `+` in VERSION). Empty when git wasn't reachable at startup. */
function runningSha(): string {
  const i = VERSION.indexOf("+");
  return i >= 0 ? VERSION.slice(i + 1) : "";
}

/** Whether two abbreviated SHAs refer to the same commit (either may be the shorter abbreviation). */
function shaMatches(a: string, b: string): boolean {
  return !!a && !!b && (a.startsWith(b) || b.startsWith(a));
}

/** The anvild package dir (where package.json + build:web live): .../anvild */
const anvildDir = join(import.meta.dir, "..", "..");

/** Service manager that launched us, as reported by the launcher's ANVIL_MANAGED (set in
 *  service.sh). null when unmanaged (e.g. `bun dev`), where exiting/restarting would just die. */
export type ServiceManager = "launchd" | "systemd";

export function serviceManager(): ServiceManager | null {
  const m = process.env.ANVIL_MANAGED;
  return m === "launchd" || m === "systemd" ? m : null;
}

/** True when a service manager started us and will respawn us. Only then is restarting safe —
 *  run via `bun dev` a restart would just kill the daemon, so we don't. */
export function isManaged(): boolean {
  return serviceManager() !== null;
}

/** Runs a command and returns its exit code + combined output. Injectable so the update FLOW can be
 *  tested without spawning real git/bun (the default spawns for real). */
export type CommandRunner = (cmd: string[], cwd: string) => Promise<{ code: number; out: string }>;

const runDefault: CommandRunner = async (cmd, cwd) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, out: `${stdout}${stderr}`.trim() };
};

/** Resolve the daemon's own git repo root from the anvild source dir. Throws a human-actionable
 *  message (surfaced verbatim in the client's "Update failed:" line) when this Mac's Anvil wasn't
 *  installed from a git clone — self-update only works on a git checkout it can `git pull`. */
async function repoRoot(run: CommandRunner): Promise<string> {
  const r = await run(["git", "rev-parse", "--show-toplevel"], anvildDir);
  if (r.code !== 0) {
    throw new Error(
      `This host's Anvil isn't a git checkout (${anvildDir}), so it can't self-update. ` +
        `Re-install it from a git clone (run scripts/service.sh from a cloned repo on this host), then Update Anvil will work here.`,
    );
  }
  return r.out.trim();
}

/**
 * Fetch and report update state: how many commits behind upstream the checkout is, AND whether the
 * running process is stale relative to the on-disk checkout. The latter catches the case where a prior
 * update pulled new source but its restart never landed — the checkout is "up to date" with the remote,
 * yet the live process predates disk HEAD. `needsRestart` flags that so the caller restarts (no re-pull
 * needed) instead of no-oping on "up to date".
 */
export async function checkForUpdate(run: CommandRunner = runDefault): Promise<{ behind: number; output: string; needsRestart: boolean }> {
  const root = await repoRoot(run);
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
  // Running process vs on-disk HEAD (same `git log -1 --format=%h` version.ts used at startup).
  const head = (await run(["git", "log", "-1", "--format=%h"], root)).out.trim();
  const running = runningSha();
  const needsRestart = behind === 0 && !!running && !!head && !shaMatches(running, head);
  const output =
    behind > 0
      ? `${behind} commit(s) behind ${ref}.`
      : needsRestart
        ? `On-disk build (${head}) is newer than the running process (${running}) — restart to apply.`
        : `Up to date with ${ref}.`;
  return { behind, output, needsRestart };
}

/** Fast-forward the checkout, reinstall deps, and rebuild the web bundle. Throws on any failure
 *  (with the failing step's output) so the caller never restarts onto a broken tree. */
export async function applyUpdate(run: CommandRunner = runDefault): Promise<{ output: string }> {
  const root = await repoRoot(run);
  const log: string[] = [];

  const before = (await run(["git", "rev-parse", "HEAD"], root)).out.trim();
  const pull = await run(["git", "pull", "--ff-only"], root);
  log.push(`$ git pull --ff-only\n${pull.out}`);
  if (pull.code !== 0) throw new Error(`git pull failed (local changes / not fast-forward?):\n${pull.out}`);

  // Only reinstall when the pull actually touched dependencies — running `bun install` against the
  // live daemon's node_modules on every update is needless risk (it can briefly unlink modules the
  // running process lazy-imports). Empty `before` (no prior HEAD) falls through to install.
  const changed = before ? (await run(["git", "diff", "--name-only", `${before}..HEAD`], root)).out : "";
  const depsChanged = !before || /(^|\/)(package\.json|bun\.lockb?)$/m.test(changed);
  if (depsChanged) {
    const install = await run(["bun", "install"], anvildDir);
    log.push(`$ bun install\n${install.out}`);
    if (install.code !== 0) throw new Error(`bun install failed:\n${install.out}`);
  } else {
    log.push("(dependencies unchanged — skipping bun install)");
  }

  // build:web stages into dist.next and atomically swaps, so a build failure here leaves the live
  // bundle the daemon is serving untouched (see web/build.ts).
  let build = await run(["bun", "run", "build:web"], anvildDir);
  log.push(`$ bun run build:web\n${build.out}`);
  // Self-heal: the conditional install above can be fooled — if an earlier deploy left node_modules
  // missing a dependency, a later update whose diff doesn't touch package.json skips install and the
  // build fails to resolve that import ("Could not resolve …"). If we didn't already install this
  // run, do it now and retry the build once before giving up.
  if (build.code !== 0 && !depsChanged) {
    const install = await run(["bun", "install"], anvildDir);
    log.push(`(build failed — running bun install and retrying)\n$ bun install\n${install.out}`);
    if (install.code !== 0) throw new Error(`bun install failed:\n${install.out}`);
    build = await run(["bun", "run", "build:web"], anvildDir);
    log.push(`$ bun run build:web\n${build.out}`);
  }
  if (build.code !== 0) throw new Error(`web build failed:\n${build.out}`);

  // [CI-S5] The daemon runs from TS source, so a type error is a latent runtime crash. Verify the
  // pulled tree typechecks before the caller restarts onto it — build:web only covers the web bundle.
  // (We deliberately don't run the full `bun test` here: it spawns real git/PTY subprocesses and
  // would slow a live update; typecheck is the fast, side-effect-free safety gate.)
  const typecheck = await run(["bun", "run", "typecheck"], anvildDir);
  log.push(`$ bun run typecheck\n${typecheck.out}`);
  if (typecheck.code !== 0) throw new Error(`typecheck failed — refusing to restart onto a broken tree:\n${typecheck.out}`);

  return { output: log.join("\n\n") };
}

/** Restart via the host's service manager after a short delay (so the result event flushes first).
 *  The relaunch child is detached so it isn't torn down with us — by the time the kill lands, the
 *  manager has already queued the relaunch of a fresh instance that re-reads the updated source +
 *  serves the new bundle.
 *    • launchd  — `launchctl kickstart -k gui/<uid>/<label>`: KeepAlive does NOT respawn a clean
 *      SIGTERM exit, so we must ask launchd to relaunch; kickstart -k SIGKILLs (after the SIGTERM
 *      graceful flush) and starts fresh.
 *    • systemd  — `systemctl --user restart <label>.service`: deterministic stop + start.
 *  Falls back to a clean SIGTERM if the spawn throws (under systemd's Restart=always that alone
 *  respawns; under launchd it just stops — but the spawn only fails if the CLI is missing). */
export function scheduleRestart(): void {
  const mgr = serviceManager();
  const uid = process.getuid?.() ?? 0;
  const cmd =
    mgr === "systemd"
      ? ["systemctl", "--user", "restart", `${SERVICE_LABEL}.service`]
      : ["launchctl", "kickstart", "-k", `gui/${uid}/${SERVICE_LABEL}`];
  setTimeout(() => {
    try {
      Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    } catch {
      // Fallback: at least stop cleanly. (Should never happen — the manager's CLI is on PATH.)
      process.kill(process.pid, "SIGTERM");
    }
  }, 1000).unref?.();
}
