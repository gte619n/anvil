/**
 * [P2] Completion-verification fixture generator (spec §4.2 / A7 / OD8).
 *
 * Builds a throwaway git repo at test time (bare origin + clone, mirroring worktree.test.ts:51-71) whose
 * source either DOES or DOES NOT implement a set of tasks. Each implemented task carries a UNIQUE SENTINEL
 * SYMBOL — a random-ish identifier the advisory real-model eval asserts the verifier actually CITES (a path
 * alone is echoable from the task text; a sentinel buried in the body is not — R2-T6).
 *
 * Four kinds, covering the verdict enum plus the known tier-1 limitation:
 *  - "done"               — every task implemented (sentinel symbol wired into real code)
 *  - "not-done"           — tasks described in a TODO.md, zero implementing code
 *  - "partial"            — first task implemented, the rest not
 *  - "present-but-broken" — the sentinel symbol exists but is dead/unwired (NG7: tier-1 may read this as
 *                           `done`; documented, not a bug — the human Confirm is the backstop)
 *
 * Deterministic: no Math.random (unavailable in some harnesses) — sentinels derive from the kind + index.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
}

export type FixtureKind = "done" | "not-done" | "partial" | "present-but-broken";

export interface VerifyFixture {
  /** The clone a verifier reads (has origin/main fetched). */
  repo: string;
  /** The bare origin (so a test can push a new commit to move origin/main and prove fetch-first). */
  origin: string;
  kind: FixtureKind;
  tasks: { id: string; content: string }[];
  /** One unique symbol per task that IS implemented in this fixture (empty slots for not-done tasks). */
  sentinels: string[];
  cleanup: () => void;
}

/** The sentinel symbol for task `i` of a given kind — unique across the suite, greppable, stable. */
function sentinel(kind: FixtureKind, i: number): string {
  return `anvilVerify_${kind.replace(/-/g, "_")}_${i}_zq${(i + 1) * 7}`;
}

const TASKS: Record<FixtureKind, { id: string; content: string }[]> = {
  done: [
    { id: "t1", content: "Add a greeting helper that returns a hello string" },
    { id: "t2", content: "Add a farewell helper that returns a goodbye string" },
  ],
  "not-done": [{ id: "t1", content: "Add a currency formatter for USD amounts" }],
  partial: [
    { id: "t1", content: "Add a slugify helper" },
    { id: "t2", content: "Add a debounce helper" },
  ],
  "present-but-broken": [{ id: "t1", content: "Add a retry wrapper around fetch" }],
};

/** Write the implementing source for task `i`, embedding its sentinel. `broken` makes it dead code. */
function implement(dir: string, kind: FixtureKind, i: number, broken = false): void {
  const sym = sentinel(kind, i);
  const body = broken
    ? `// NOTE: defined but never exported or wired up (present-but-broken fixture).\nfunction ${sym}() { throw new Error("not implemented"); }\n`
    : `export function ${sym}(): string { return "impl-${i}"; }\n`;
  writeFileSync(join(dir, `feature_${i}.ts`), body);
}

/**
 * Generate a fixture repo of the given kind. Returns the clone path (with origin/main fetched), the bare
 * origin, the tasks, and the sentinels. Call `cleanup()` to remove all temp dirs.
 */
export function generateFixture(kind: FixtureKind): VerifyFixture {
  const origin = mkdtempSync(join(tmpdir(), "anvil-verifix-origin-"));
  git(["init", "-q", "--bare", "-b", "main"], origin);

  const repo = mkdtempSync(join(tmpdir(), "anvil-verifix-repo-"));
  git(["clone", "-q", origin, repo], tmpdir());
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);

  const src = join(repo, "src");
  mkdirSync(src, { recursive: true });
  const tasks = TASKS[kind];
  const sentinels: string[] = [];
  tasks.forEach((_, i) => {
    const doImpl =
      kind === "done" ||
      (kind === "partial" && i === 0) ||
      kind === "present-but-broken";
    if (doImpl) {
      implement(src, kind, i, kind === "present-but-broken");
      sentinels[i] = sentinel(kind, i);
    } else {
      sentinels[i] = "";
    }
  });
  // not-done / the unimplemented half of partial: leave only a TODO describing the ask (no code).
  const todos = tasks.filter((_, i) => !sentinels[i]).map((t) => `- [ ] ${t.content}`);
  if (todos.length) writeFileSync(join(repo, "TODO.md"), `# Outstanding\n${todos.join("\n")}\n`);
  writeFileSync(join(repo, "README.md"), `# ${kind} fixture\n`);

  git(["add", "."], repo);
  git(["commit", "-q", "-m", `${kind} fixture`], repo);
  git(["push", "-q", "origin", "main"], repo);

  return {
    repo,
    origin,
    kind,
    tasks,
    sentinels,
    cleanup: () => {
      for (const d of [origin, repo]) rmSync(d, { recursive: true, force: true });
    },
  };
}
