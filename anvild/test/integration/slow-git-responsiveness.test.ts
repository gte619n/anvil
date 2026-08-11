/**
 * [BE2-2/3/5] Fake-slow-git responsiveness harness. The daemon is single-threaded: before the
 * async-git conversion, ONE slow/hung git subprocess (worktree-create fetch, team-integration
 * merges, the per-turn refreshGit) froze the entire event loop — no HTTP/WS request was serviced
 * until git returned. This harness pins the fix at the mechanism level:
 *
 *   1. a fake `git` (sleeps SLEEP_MS, prints a marker, exits 1) is put FIRST on PATH,
 *   2. BEFORE the git module is imported — a child bun process runs test/tools/slow-git-probe.ts,
 *      so src/git/spawn.ts's import-time GIT_ENV snapshot carries the doctored PATH (in-process the
 *      module may already be cached with the real PATH by earlier test files),
 *   3. the probe runs two converted ops (gitStatusAsync + mergeBranchAsync) CONCURRENTLY while a
 *      20ms ticker watches for event-loop stalls.
 *
 * Asserted: the loop keeps ticking (no sync-spawn-sized gap), the two ops overlap instead of
 * serializing, the slow git was really the one exercised (elapsed >= its sleep, marker in the
 * output), and the ops still resolve through their normal failure surfaces (status -> undefined,
 * merge -> ok:false with git's output) rather than hanging or throwing.
 */
import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SLEEP_MS = 1_000;

test(
  "[BE2-2/3/5] a slow git binary parks promises — the event loop stays responsive and ops overlap",
  async () => {
    // A fake `git` that behaves like the field incident's hung fetch (bounded here so the test ends).
    const fakeBin = mkdtempSync(join(tmpdir(), "anvil-fakegit-"));
    const fakeGit = join(fakeBin, "git");
    writeFileSync(fakeGit, `#!/bin/sh\nsleep ${SLEEP_MS / 1000}\necho "[fake-git] $*" >&2\nexit 1\n`);
    chmodSync(fakeGit, 0o755);

    try {
      const anvildRoot = join(import.meta.dir, "..", "..");
      const proc = Bun.spawn([process.execPath, join(anvildRoot, "test", "tools", "slow-git-probe.ts")], {
        cwd: anvildRoot,
        // Pre-doctor PATH for the WHOLE child process — before any import runs in it.
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const code = await proc.exited;
      if (code !== 0) console.error(`[slow-git-probe] exit ${code}:\n${err}`);
      expect(code).toBe(0);

      const r = JSON.parse(out.trim().split("\n").pop()!) as {
        totalMs: number;
        statusElapsedMs: number;
        mergeElapsedMs: number;
        statusUndefined: boolean;
        mergeOk: boolean;
        mergeOutput: string;
        maxGapMs: number;
        ticks: number;
      };

      // The fake slow git was REALLY the binary exercised (not a cached real-PATH env): each op took
      // at least its sleep, and the merge (merge + ls-files probe = 2 spawns) took two of them.
      expect(r.statusElapsedMs).toBeGreaterThanOrEqual(SLEEP_MS * 0.9);
      expect(r.mergeElapsedMs).toBeGreaterThanOrEqual(SLEEP_MS * 1.8);
      expect(r.mergeOutput).toContain("[fake-git]");

      // Responsiveness: the event loop kept ticking while git slept. A sync spawn would stall the
      // ticker for >= SLEEP_MS; generous CI margin, still far below the sleep.
      expect(r.ticks).toBeGreaterThan(20);
      expect(r.maxGapMs).toBeLessThan(SLEEP_MS / 2);

      // Concurrency: the two ops overlapped. Freezing sync spawns would serialize them
      // (>= 3 * SLEEP_MS total); concurrent async spawns finish in ~2 * SLEEP_MS (the merge's two
      // sequential spawns dominate).
      expect(r.totalMs).toBeLessThan(SLEEP_MS * 2.9);

      // The operations still RESOLVE through their normal failure surfaces — no hang, no throw.
      expect(r.statusUndefined).toBe(true); // gitStatusAsync -> undefined ("not a git repo")
      expect(r.mergeOk).toBe(false); // mergeBranchAsync -> reported failure carrying git's output
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  },
  30_000,
);
