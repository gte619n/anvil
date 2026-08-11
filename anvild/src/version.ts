/** The running daemon's version. Single source of truth — re-exported by http.ts and surfaced
 *  in /api/health and on connect.
 *
 *  Derived from git at startup, so it tracks what's actually running with no manual bumps: the
 *  daemon self-updates via `git pull` + restart, so HEAD's short SHA *is* the deployed build.
 *  [CI2-9] The human release line is MAJOR.MINOR from the repo-root `VERSION` file — the ONE source of
 *  truth every other artifact (Android/iOS/macOS/server, and web/build.ts) already derives from — as
 *  MAJOR.MINOR.0. `anvild/package.json` was frozen at 0.2.0 while the release train is 3.0.x, so reading
 *  it here made every daemon surface (health, badge, fleet views, watchdog logs) report a version 3
 *  majors stale. Falls back to package.json only when the VERSION file isn't reachable (a compiled-binary
 *  install outside the checkout). The SHA distinguishes every build under the line. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/** MAJOR.MINOR.0 from the repo-root VERSION file; the package.json version when it's unreadable. */
export function humanVersion(): string {
  try {
    const mm = readFileSync(join(import.meta.dir, "../../VERSION"), "utf8").trim();
    if (/^\d+\.\d+$/.test(mm)) return `${mm}.0`;
  } catch {
    /* fall back to the package version below */
  }
  return pkg.version;
}

const sha = gitShortSha();
export const VERSION = sha ? `${humanVersion()}+${sha}` : humanVersion();
