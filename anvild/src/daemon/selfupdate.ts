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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GIT_ENV } from "../git/spawn";
import { VERSION } from "../version";
import { shaMatches } from "./sha";

/** Service label — must match LABEL in scripts/service.sh (launchd) / the systemd unit name. */
const SERVICE_LABEL = "com.anvil.anvild";

/** The short SHA the RUNNING process was built from — captured once at startup in version.ts (the part
 *  after `+` in VERSION). Empty when git wasn't reachable at startup. */
export function runningSha(): string {
  const i = VERSION.indexOf("+");
  return i >= 0 ? VERSION.slice(i + 1) : "";
}

// [BE2-33] shaMatches is shared (min-length-guarded) — see ./sha.ts.

/** The anvild package dir (where package.json + build:web live): .../anvild */
const anvildDir = join(import.meta.dir, "..", "..");

/** The dependency install every update/rollback path runs. `--frozen-lockfile` installs EXACTLY what
 *  bun.lock pins and refuses to rewrite it. Without it, a deploy's `bun install` normalizes the tracked
 *  lockfile in place, leaving the tree dirty *after an otherwise successful update* — which then trips
 *  the next update's dirty-tree guard (a self-poisoning loop that permanently bricks auto-update on a
 *  host that never touched a file itself). A release whose package.json and lockfile genuinely disagree
 *  now fails loudly here instead of silently mutating the daemon's checkout. */
const INSTALL_CMD = ["bun", "install", "--frozen-lockfile"];

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
  // GIT_ENV adds SSH keepalives + no-prompt so a self-update `git fetch`/`git pull` over a dead
  // connection fails fast instead of stalling the update flow forever. (These steps are async, so a
  // hang wouldn't freeze the event loop — but it would leave the update wedged with no signal.) The
  // env is harmless for the non-git steps (bun install / build:web) this runner also drives.
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: GIT_ENV });
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

/** The remote-tracking ref the daemon should update toward, e.g. "origin/main". Prefers the checkout's
 *  configured upstream (@{u}); when none is set — a detached HEAD or a local-only branch, common on a
 *  dev-box checkout that's been moved between branches/worktrees — falls back to the remote's default
 *  branch, which is the release track the daemon should follow regardless of what the local checkout is
 *  pointed at. Throws a human-actionable message (surfaced verbatim in the client's "Update failed:"
 *  line) only when neither can be resolved. */
async function resolveUpdateRef(run: CommandRunner, root: string): Promise<string> {
  const upstream = await run(["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root);
  if (upstream.code === 0 && upstream.out.trim()) return upstream.out.trim();
  // No tracking branch — resolve the remote's default branch (origin/HEAD → e.g. "origin/main").
  let head = await run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
  if (head.code !== 0 || !head.out.trim()) {
    // origin/HEAD isn't recorded locally (a fresh `git clone` records it, but re-inits / partial setups
    // may not) — ask the remote to record it and retry once.
    await run(["git", "remote", "set-head", "origin", "--auto"], root);
    head = await run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
  }
  if (head.code === 0 && head.out.trim()) return head.out.trim();
  throw new Error(
    "no upstream branch configured for the daemon's checkout, and origin's default branch couldn't be resolved — " +
      "can't check for updates. On the host, run `git remote set-head origin --auto` (or " +
      "`git branch --set-upstream-to=origin/main`) in the daemon's checkout.",
  );
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
  const ref = await resolveUpdateRef(run, root);
  const counted = await run(["git", "rev-list", "--count", `HEAD..${ref}`], root);
  if (counted.code !== 0) throw new Error(`git rev-list failed: ${counted.out || `exit ${counted.code}`}`);
  const behind = Number.parseInt(counted.out.trim(), 10) || 0;
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

  // Pull the resolved ref by name (remote + branch) rather than relying on branch tracking — the
  // checkout may be in detached HEAD or on a local-only branch (see resolveUpdateRef). --ff-only still
  // refuses anything that isn't a clean fast-forward, so local commits fail loudly, never clobbered.
  const ref = await resolveUpdateRef(run, root);
  const slash = ref.indexOf("/");
  const [remote, branch] = slash > 0 ? [ref.slice(0, slash), ref.slice(slash + 1)] : ["origin", ref];

  const before = (await run(["git", "rev-parse", "HEAD"], root)).out.trim();
  const pull = await run(["git", "pull", "--ff-only", remote, branch], root);
  log.push(`$ git pull --ff-only ${remote} ${branch}\n${pull.out}`);
  if (pull.code !== 0) throw new Error(`git pull failed (local changes / not fast-forward?):\n${pull.out}`);

  // Only reinstall when the pull actually touched dependencies — running `bun install` against the
  // live daemon's node_modules on every update is needless risk (it can briefly unlink modules the
  // running process lazy-imports). Empty `before` (no prior HEAD) falls through to install.
  const changed = before ? (await run(["git", "diff", "--name-only", `${before}..HEAD`], root)).out : "";
  const depsChanged = !before || /(^|\/)(package\.json|bun\.lockb?)$/m.test(changed);
  if (depsChanged) {
    const install = await run(INSTALL_CMD, anvildDir);
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
    const install = await run(INSTALL_CMD, anvildDir);
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

// ── Frozen update API v1 building blocks (stable-update-service spec §4.3) ─────────────────────────
// These are the pinned-target + rollback primitives the frozen `/api/update/v1/*` surface and the
// watchdog are built from. They reuse the same injectable CommandRunner as the flow above so they're
// unit-testable without spawning real git.

/** The current on-disk HEAD short SHA (what a fresh boot would report as its running SHA). */
export async function headSha(run: CommandRunner = runDefault): Promise<string> {
  const root = await repoRoot(run);
  return (await run(["git", "log", "-1", "--format=%h"], root)).out.trim();
}

/** Resolve the SHA the daemon should converge to: the commit the upstream ref (@{u} → origin/HEAD)
 *  currently points at. This is what a hub pins ONCE and hands to every member so the whole fleet lands
 *  on the identical build even if new commits arrive mid-rollout (spec D13). */
export async function resolveTargetSha(run: CommandRunner = runDefault): Promise<string> {
  const root = await repoRoot(run);
  await run(["git", "fetch", "--quiet"], root);
  const ref = await resolveUpdateRef(run, root);
  const r = await run(["git", "rev-parse", "--short", ref], root);
  if (r.code !== 0) throw new Error(`could not resolve target ${ref}: ${r.out || `exit ${r.code}`}`);
  return r.out.trim();
}

/**
 * [CI2-7] Provenance gate for the ROLLBACK paths: true when `sha` is already part of this checkout's
 * trusted history — an ancestor of (or equal to) the trusted upstream tip, or reachable from the
 * current HEAD. A legit rollback target (a prePullSha we recorded ourselves) always satisfies one of
 * the two: it was HEAD on the release track before the update moved us. What this refuses is a
 * "rollback" to an arbitrary side-branch/attacker SHA — the hole SEC2-1's forward gate left open,
 * since `allowNonFastForward`/`rollbackTo` previously reset the tree with NO check at all.
 *
 * The HEAD rule exists because a pinned forward target may legitimately be BEHIND the pre-update HEAD
 * (any ancestor of the upstream tip is a valid pin), in which case the prePullSha is not an ancestor
 * of the new HEAD but IS an ancestor of the upstream tip — and conversely, when the upstream ref can't
 * be resolved at rollback time (e.g. origin/HEAD unrecorded on a re-init'd checkout), a target inside
 * our own history is still provably ours. Both checks are local-only (remote-tracking refs), so a
 * watchdog rollback works with the network down.
 *
 * Why not `git verify-tag`/`verify-commit` against pinned allowed signers: nothing in CI signs today —
 * release.yml mints its `v*` tags UNSIGNED via `gh release create` (a plain API tag), and commits land
 * unsigned — so signature verification would check a property the pipeline doesn't produce and brick
 * every update. Ancestry against the trusted remote is the strongest provenance that is real today;
 * revisit if CI ever grows a signing step.
 */
async function inTrustedHistory(run: CommandRunner, root: string, sha: string): Promise<boolean> {
  try {
    const ref = await resolveUpdateRef(run, root);
    if ((await run(["git", "merge-base", "--is-ancestor", sha, ref], root)).code === 0) return true;
  } catch {
    // Upstream unresolvable — fall through to the local-history rule below.
  }
  return (await run(["git", "merge-base", "--is-ancestor", sha, "HEAD"], root)).code === 0;
}

/**
 * Update the checkout to an EXPLICIT target SHA (spec D13), capturing the pre-pull SHA first so a
 * failed boot can be rolled back (spec D8). Mirrors {@link applyUpdate}'s pull→install→build→typecheck
 * safety, but checks out a pinned commit rather than fast-forwarding to a moving branch tip — so every
 * member a hub fans out to lands on the same build. `recordPrePull(sha)` is invoked with the captured
 * HEAD before anything mutates the tree; the caller persists it (UpdateStateStore).
 *
 * [SEC2-1] Supply-chain integrity: before checkout we require the target to be an ancestor of the
 * trusted upstream tip (`git merge-base --is-ancestor <target> <resolvedUpstreamRef>`), so a
 * fleet-update route can only pin the checkout to a commit actually reachable from origin's release
 * track — never an arbitrary side-branch/attacker commit. `allowNonFastForward` relaxes (but does not
 * remove — [CI2-7]) the gate for the rollback path, which deliberately resets backwards to a
 * known-good prePullSha: the target must still be in {@link inTrustedHistory} (upstream track or our
 * own history). Local commits / a dirty tree make `git checkout` fail loudly and are never clobbered.
 */
export async function applyUpdateToTarget(
  targetSha: string,
  opts: { run?: CommandRunner; recordPrePull?: (sha: string) => void; allowNonFastForward?: boolean } = {},
): Promise<{ output: string; prePullSha: string; targetSha: string }> {
  const run = opts.run ?? runDefault;
  const root = await repoRoot(run);
  const log: string[] = [];

  const before = (await run(["git", "rev-parse", "--short", "HEAD"], root)).out.trim();
  opts.recordPrePull?.(before);

  await run(["git", "fetch", "--quiet"], root);

  // [SEC2-1] Ancestry gate. Skipped only for rollback (allowNonFastForward), which moves backwards to a
  // known-good SHA that is by construction behind the upstream tip. For a forward update, reject any
  // target not reachable from the trusted upstream ref — the integrity check the doc-comment above used
  // to (falsely) claim existed. `--is-ancestor` exits 0 when target IS an ancestor, non-zero when not.
  if (!opts.allowNonFastForward) {
    const upstreamRef = await resolveUpdateRef(run, root);
    const anc = await run(["git", "merge-base", "--is-ancestor", targetSha, upstreamRef], root);
    if (anc.code !== 0) {
      throw new Error(
        `refusing to update to ${targetSha}: it is not an ancestor of the trusted upstream tip ` +
          `(${upstreamRef}) — only commits reachable from the release track can be applied.`,
      );
    }
  } else if (!(await inTrustedHistory(run, root, targetSha))) {
    // [CI2-7] Rollback path: relaxed, not open. The target may be behind the tip, but it must still be
    // provably ours (upstream track or our own history) — never an arbitrary out-of-tree commit.
    throw new Error(
      `refusing to roll back to ${targetSha}: it is neither an ancestor of the trusted upstream tip ` +
        `nor reachable from the current checkout's history.`,
    );
  }

  // Pre-flight guard: refuse to check out over the user's own uncommitted work. Only TRACKED changes
  // (modified/staged/deleted — anything git would carry into or conflict with the checkout) block. We
  // deliberately do NOT block on untracked files (`git status --porcelain` marks them `??`): `git
  // checkout --detach` never silently clobbers them — it preserves them, or aborts loudly if the target
  // introduces a file at that exact path (still safe). Blocking on untracked was too broad and bricked
  // auto-update on otherwise-clean hosts: e.g. leftover build artifacts under a subtree the release
  // deleted (anvil-server/ after #179, once its .gitignore went with it) or a stray *.bak beside
  // package.json — files the daemon never touched, yet which failed every future update.
  const status = (await run(["git", "status", "--porcelain"], root)).out.trim();
  const dirty = status
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("??"))
    .join("\n");
  if (dirty) throw new Error(`refusing to update onto a dirty working tree:\n${dirty}`);
  const checkout = await run(["git", "checkout", "--detach", targetSha], root);
  log.push(`$ git checkout --detach ${targetSha}\n${checkout.out}`);
  if (checkout.code !== 0) throw new Error(`git checkout ${targetSha} failed:\n${checkout.out}`);

  // Past this point HEAD has MOVED to the target. Unlike applyUpdate's `pull --ff-only` (which fails
  // atomically before moving HEAD), a failed install/build/typecheck here would otherwise leave the
  // broken target checked out on disk with nothing armed to roll it back — a later restart would then
  // boot the broken build. So restore the pre-pull SHA on ANY post-checkout failure before rethrowing.
  try {
    const after = (await run(["git", "rev-parse", "--short", "HEAD"], root)).out.trim();
    const changed = before ? (await run(["git", "diff", "--name-only", `${before}..${after}`], root)).out : "";
    const depsChanged = !before || /(^|\/)(package\.json|bun\.lockb?)$/m.test(changed);
    if (depsChanged) {
      const install = await run(INSTALL_CMD, anvildDir);
      log.push(`$ bun install\n${install.out}`);
      if (install.code !== 0) throw new Error(`bun install failed:\n${install.out}`);
    } else {
      log.push("(dependencies unchanged — skipping bun install)");
    }

    let build = await run(["bun", "run", "build:web"], anvildDir);
    log.push(`$ bun run build:web\n${build.out}`);
    if (build.code !== 0 && !depsChanged) {
      const install = await run(INSTALL_CMD, anvildDir);
      log.push(`(build failed — running bun install and retrying)\n$ bun install\n${install.out}`);
      if (install.code !== 0) throw new Error(`bun install failed:\n${install.out}`);
      build = await run(["bun", "run", "build:web"], anvildDir);
      log.push(`$ bun run build:web\n${build.out}`);
    }
    if (build.code !== 0) throw new Error(`web build failed:\n${build.out}`);

    const typecheck = await run(["bun", "run", "typecheck"], anvildDir);
    log.push(`$ bun run typecheck\n${typecheck.out}`);
    if (typecheck.code !== 0) throw new Error(`typecheck failed — refusing to restart onto a broken tree:\n${typecheck.out}`);
  } catch (e) {
    if (before) await run(["git", "reset", "--hard", before], root); // leave disk on the known-good SHA
    throw e;
  }

  return { output: log.join("\n\n"), prePullSha: before, targetSha };
}

/** Roll the checkout back to a known-good SHA and rebuild (spec D4/D8). Used by the watchdog when a
 *  freshly-updated daemon fails its health/smoke gate. Best-effort rebuild: even if the rebuild fails
 *  we've at least restored the good SOURCE, which the next boot re-reads; the caller restarts after.
 *  [CI2-7] Gated by {@link inTrustedHistory}: a rollback target must be on the upstream track or in
 *  our own history — `git reset --hard` to an arbitrary SHA was the last unchecked way to move the
 *  daemon's tree (the persisted prePullSha this is fed from always passes; tampered state does not). */
export async function rollbackTo(sha: string, run: CommandRunner = runDefault): Promise<{ output: string }> {
  const root = await repoRoot(run);
  const log: string[] = [];
  if (!(await inTrustedHistory(run, root, sha))) {
    throw new Error(
      `refusing to roll back to ${sha}: it is neither an ancestor of the trusted upstream tip ` +
        `nor reachable from the current checkout's history.`,
    );
  }
  const reset = await run(["git", "reset", "--hard", sha], root);
  log.push(`$ git reset --hard ${sha}\n${reset.out}`);
  if (reset.code !== 0) throw new Error(`rollback git reset --hard ${sha} failed:\n${reset.out}`);
  const install = await run(INSTALL_CMD, anvildDir);
  log.push(`$ bun install\n${install.out}`);
  const build = await run(["bun", "run", "build:web"], anvildDir);
  log.push(`$ bun run build:web\n${build.out}`);
  return { output: log.join("\n\n") };
}

/** Boot smoke (spec D14): is the built web bundle present and servable? A daemon that's up but can't
 *  serve the app is NOT healthy and must be rolled back. `webDir` defaults to the packaged/dev location
 *  the http server serves from. */
export function webBundleOk(webDir: string = process.env.ANVIL_WEB_DIR || join(anvildDir, "web", "dist")): boolean {
  return existsSync(join(webDir, "index.html"));
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
