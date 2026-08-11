/**
 * [BE2-2/3/5] Fake-slow-git responsiveness probe. Run by
 * test/integration/slow-git-responsiveness.test.ts in a CHILD bun process whose PATH already has a
 * fake `git` (sleeps, prints a marker, exits non-zero) prepended — the PATH is doctored BEFORE this
 * module (and therefore before src/git/spawn.ts, whose GIT_ENV snapshots process.env at import
 * time) ever loads. A fresh process is the only reliable way to do that: under `bun test` the git
 * module may already be cached with the real PATH by an earlier test file.
 *
 * While two git-backed daemon ops run against the slow fake, a 20ms ticker measures event-loop
 * stalls. With the async (Bun.spawn) git twins the loop keeps ticking and the two ops overlap; the
 * old sync spawns would freeze the loop for the full sleep(s) and serialize the ops — exactly the
 * daemon-wide freeze BE2-2/3/5 removed. Prints one JSON line for the parent test to assert on.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitStatusAsync } from "../../src/session/worktree";
import { mergeBranchAsync } from "../../src/git/ops";

const dir = mkdtempSync(join(tmpdir(), "anvil-slowgit-")); // NOT a repo — the fake git "fails" anyway

// Event-loop latency ticker: any synchronous spawn would show up as a gap >= the fake git's sleep.
let maxGapMs = 0;
let ticks = 0;
let last = performance.now();
const ticker = setInterval(() => {
  const n = performance.now();
  maxGapMs = Math.max(maxGapMs, n - last);
  last = n;
  ticks++;
}, 20);

const t0 = performance.now();
// Two representative converted paths, run CONCURRENTLY:
//  - gitStatusAsync — the BE2-5 per-turn refresh projection (1 fake-git spawn, then undefined);
//  - mergeBranchAsync — the BE2-3 integration merge (2 sequential fake-git spawns: merge + ls-files).
const statusP = gitStatusAsync(dir).then((status) => ({ elapsedMs: performance.now() - t0, status }));
const mergeP = mergeBranchAsync(dir, "feature-x").then((merge) => ({ elapsedMs: performance.now() - t0, merge }));
const [st, mg] = await Promise.all([statusP, mergeP]);
const totalMs = performance.now() - t0;
clearInterval(ticker);
rmSync(dir, { recursive: true, force: true });

console.log(
  JSON.stringify({
    totalMs,
    statusElapsedMs: st.elapsedMs,
    mergeElapsedMs: mg.elapsedMs,
    statusUndefined: st.status === undefined, // the normal "not a repo" failure surface survived
    mergeOk: mg.merge.ok,
    mergeOutput: mg.merge.output, // carries the fake git's marker → proves the fake was exercised
    maxGapMs,
    ticks,
  }),
);
