import { spawn, type ChildProcess } from "node:child_process";

/**
 * Process-group spawn + reap (arch §5, discipline from commit da870d5).
 *
 * The agent (and the tool subprocesses it spawns) run in their OWN process group, so a
 * single signal to the group reaps the whole tree — no orphaned grandchildren (the bug
 * that fuelled the old duplicate-server storm). `detached: true` makes the child a group
 * leader on POSIX, so `pgid === pid` and `process.kill(-pgid, …)` signals the group.
 */
export interface Group {
  pid: number;
  pgid: number;
  child: ChildProcess;
  exited: Promise<number | null>;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export function spawnInGroup(cmd: string, args: string[], opts: SpawnOptions = {}): Group {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true, // new process group; child is the leader
    stdio: "ignore",
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error(`failed to spawn '${cmd}'`);
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { pid, pgid: pid, child, exited };
}

/** True iff any process remains in the group. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM the group, wait up to `graceMs`, then SIGKILL.
 *
 * [BE-10] Takes the whole `Group` (not a bare pgid) so it can refuse to signal once OUR tracked
 * leader has exited: at that point the leader's pid (== pgid) can be recycled by an unrelated
 * process that becomes a new group leader, and `process.kill(-pgid, …)` would SIGKILL that foreign
 * group — the exact orphaned/duplicate-storm class this module exists to prevent. If our child is
 * already gone there is nothing of ours left to reap.
 */
export async function killGroup(group: Group, graceMs = 2000): Promise<void> {
  if (group.child.exitCode !== null || group.child.signalCode !== null) return;
  const pgid = group.pgid;
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    return; // already gone
  }
  const start = Date.now();
  while (Date.now() - start < graceMs) {
    if (!groupAlive(pgid)) return;
    await delay(50);
  }
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    /* raced to exit between the check and the signal */
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
