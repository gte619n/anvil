/**
 * Hardened git/gh subprocess spawn (arch §8). The daemon is single-threaded, so a *synchronous* git
 * op that hangs freezes the ENTIRE event loop: the socket still accepts TCP connections but no HTTP/WS
 * request is ever serviced, so every client silently queues its messages forever. The classic trigger
 * is `git fetch` → `ssh … git-upload-pack` over a TCP connection that dies mid-stream: with no SSH
 * keepalive the ssh child waits on a dead socket indefinitely, and the blocking `Bun.spawnSync` above
 * it never returns. (This is exactly what wedged a daemon in the field — a 17-minute-and-counting
 * `git fetch origin main` for one repo took down every session on the box.)
 *
 * Two independent guards make an unbounded hang impossible:
 *   • a network-safe environment (`GIT_ENV`) — SSH `ServerAlive*` keepalives + `ConnectTimeout` tear
 *     down a dead/stalled connection in ~30s, and `BatchMode=yes` / `GIT_TERMINAL_PROMPT=0` turn any
 *     credential or passphrase prompt (which would otherwise block on stdin forever) into an instant
 *     failure instead of a hang;
 *   • a hard `timeout` + `SIGKILL` — the final backstop. It bounds ANY op regardless of transport,
 *     including `gh`'s HTTPS API calls that the SSH env doesn't touch, so nothing can hold the event
 *     loop past the cap.
 *
 * A killed (timed-out) process reports `exitCode === null`; we surface that as a non-zero code plus a
 * clear stderr note so every caller's existing `code !== 0` path runs — and the daemon's git ops are
 * all best-effort (a failed fetch falls back to the base ref, a failed push/merge is reported to the
 * UI), so a timeout degrades gracefully instead of corrupting state.
 *
 * The same contract covers a MISSING binary. `Bun.spawnSync` throws on ENOENT rather than returning a
 * code, which would escape every `code !== 0` caller as an opaque exception — so it's caught and
 * reported as 127. This is not hypothetical: `gh` is optional and simply absent on a plain Linux
 * member, and without this the UI's Merge/PR actions throw instead of saying `gh` isn't installed.
 */

// Network git ops shell out to ssh; without these a broken TCP connection hangs forever. ConnectTimeout
// bounds the initial dial (15s); ServerAlive (10s interval × 3 missed = ~30s) reaps a mid-transfer
// stall; BatchMode never blocks on an interactive passphrase/host-key prompt.
const GIT_SSH_COMMAND =
  "ssh -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o BatchMode=yes";

/** The env every git/gh spawn inherits: the host environment plus network-safety overrides. Spreading
 *  `process.env` is required because passing `env` to Bun.spawn REPLACES the environment wholesale —
 *  git/gh must still see the host's PATH, SSH agent, gh token, credential helpers, etc. */
export const GIT_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  GIT_SSH_COMMAND,
  GIT_TERMINAL_PROMPT: "0", // git never prompts for HTTPS credentials on stdin (would hang the daemon)
};

/** Backstop for a *local* git op (status/rev-parse/worktree add): huge headroom — these finish in
 *  milliseconds, so it only ever fires on a genuinely wedged process, never on a slow-but-fine one. */
export const LOCAL_TIMEOUT_MS = 120_000;
/** Backstop for a *network* op (fetch/push/pr/delete): the SSH keepalive already reaps a dead
 *  connection in ~30s, so this mainly bounds non-SSH transports (gh over HTTPS). */
export const NET_TIMEOUT_MS = 60_000;
/** Network backstop for `git clone`: more generous than NET_TIMEOUT_MS because a first clone of a
 *  large repo legitimately transfers for a while, but still bounded so a stalled clone can't wedge. */
export const CLONE_TIMEOUT_MS = 300_000;

export interface GitSpawn {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `cmd` in `cwd` synchronously with the network-safe env and a hard timeout. On timeout the
 * child is SIGKILLed and the result carries a non-zero `code` (124, the conventional timeout code)
 * plus a stderr note, so callers take their normal failure path.
 */
export function gitSpawn(cmd: string[], cwd: string, timeoutMs: number = LOCAL_TIMEOUT_MS): GitSpawn {
  let r: ReturnType<typeof Bun.spawnSync>;
  try {
    r = Bun.spawnSync(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: GIT_ENV,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
  } catch (e) {
    // The binary isn't on PATH (or cwd is gone): Bun.spawnSync THROWS here rather than returning a
    // non-zero code. Every caller in git/ops.ts is written against `code !== 0`, so an uncaught throw
    // escapes as an opaque 500 / unhandled rejection instead of the "gh isn't installed" message the
    // UI should show. `gh` in particular is optional and absent on a plain Linux member, so the PR /
    // merge actions must degrade to a reported failure — the same contract the timeout path above
    // already honours. 127 is the conventional "command not found" code.
    const msg = e instanceof Error ? e.message : String(e);
    return { code: 127, stdout: "", stderr: `[anvil] couldn't run \`${cmd[0]}\`: ${msg}` };
  }
  const stdout = r.stdout?.toString() ?? "";
  const stderrText = r.stderr?.toString() ?? "";
  if (r.exitCode == null) {
    // Killed by the timeout (or another signal) — no exit code. Report it as a failure with a note so
    // the reason is visible in the UI / logs instead of an opaque empty error.
    const note = `[anvil] \`${cmd.join(" ")}\` exceeded ${timeoutMs}ms and was killed`;
    return { code: 124, stdout, stderr: stderrText ? `${stderrText}\n${note}` : note };
  }
  return { code: r.exitCode, stdout, stderr: stderrText };
}
