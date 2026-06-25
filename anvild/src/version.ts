/** The running daemon's version. Single source of truth — re-exported by http.ts and surfaced
 *  in /api/health and on connect.
 *
 *  Derived from git at startup, so it tracks what's actually running with no manual bumps: the
 *  daemon self-updates via `git pull` + restart, so HEAD's short SHA *is* the deployed build.
 *  `package.json`'s version supplies the human release line (bump it only for a meaningful
 *  release — never required); the SHA distinguishes every build under it. Falls back to the bare
 *  package version when git isn't reachable (e.g. a compiled-binary install outside a checkout). */
import pkg from "../package.json";

function gitShortSha(): string {
  try {
    const r = Bun.spawnSync(["git", "log", "-1", "--format=%h"], {
      cwd: import.meta.dir, // src/ — git searches upward to the daemon's own checkout
      stdout: "pipe",
      stderr: "ignore",
    });
    return r.success ? r.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}

const sha = gitShortSha();
export const VERSION = sha ? `${pkg.version}+${sha}` : pkg.version;
