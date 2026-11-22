/**
 * Shared fixtures for the merge-guard suites (Phase A5): git in a temp repo, running `verify-cli.ts`
 * as a real subprocess, and the two-branch merge scenario of the A5 Acceptance — on the fake (the
 * functional suite) or the real binary (test/real/cad-a5.test.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { partRef } from "../../src/cadwork/partfolder";
import { buildPlate, tempDir, tempRepo } from "./cad-work";

export const VERIFY_CLI = join(import.meta.dir, "..", "..", "src", "cadwork", "verify-cli.ts");

/** git with a fixed identity; throws on failure. */
export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=Anvil Test", "-c", "user.email=test@anvil.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}${r.stdout.toString()}`);
  return r.stdout.toString().trim();
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  json?: any;
  ms: number;
}

/** Run `bun verify-cli.ts …` in `cwd`, as an agent's shell would. Nothing of the test's environment leaks in but PATH/HOME/TMPDIR and `env`. */
export async function runVerifyCli(cwd: string, args: string[], env: Record<string, string | undefined>): Promise<CliRun> {
  const t0 = performance.now();
  const clean: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", TMPDIR: process.env.TMPDIR ?? "/tmp" };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const proc = Bun.spawn(["bun", VERIFY_CLI, ...args], { cwd, env: clean, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let json: any;
  if (args.includes("--json")) {
    try {
      json = JSON.parse(stdout);
    } catch {
      /* not JSON: the test will say so */
    }
  }
  return { code, stdout, stderr, json, ms: performance.now() - t0 };
}

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

/**
 * The A5 Acceptance scenario up to the merge. The plate is built and passing on `main` and committed.
 * Two linked worktrees of the repo branch off: on `a` the OWNER sets L = 120 in the panel, on `b` the
 * owner sets T = 6.5 (each through the real service, so the shared lock store accepts each number as
 * it does in the product). Branch `a` commits design.json and part.json; branch `b` commits only
 * design.json — two committed measurements of one part always conflict as text, and the guard is
 * about the merge git CAN do cleanly. `main` then merges `a` (fast-forward) and `b`: a clean text
 * merge of design.json whose script neither branch measured.
 */
export async function twoBranchMerge(cli: string) {
  const repo = tempRepo("anvil-cad-a5-");
  git(repo, "checkout", "-q", "-b", "main");
  const x = await buildPlate(repo, { cli });
  if (x.gate.state !== "pass") throw new Error(`the plate does not pass: ${JSON.stringify(x.gate.failing)}`);
  git(repo, "add", "cad");
  git(repo, "commit", "-q", "-m", "plate");
  const base = git(repo, "rev-parse", "HEAD");
  const trees = tempDir("anvil-cad-a5-trees-");
  const wtA = join(trees, "a");
  const wtB = join(trees, "b");
  git(repo, "worktree", "add", "-q", "-b", "a", wtA);
  git(repo, "worktree", "add", "-q", "-b", "b", wtB);
  const refA = partRef(wtA, "plate");
  const refB = partRef(wtB, "plate");
  const a = await x.service.setParamAsOwner(refA, "L", "120 mm");
  if (!a.ok) throw new Error(`owner L=120 on a: ${a.error}`);
  const gateA = a.gate;
  git(wtA, "add", "cad/plate/design.json", "cad/plate/part.json");
  git(wtA, "commit", "-q", "-m", "L = 120");
  const b = await x.service.setParamAsOwner(refB, "T", "6.5 mm");
  if (!b.ok) throw new Error(`owner T=6.5 on b: ${b.error}`);
  git(wtB, "add", "cad/plate/design.json");
  git(wtB, "commit", "-q", "-m", "T = 6.5");
  git(repo, "merge", "-q", "--ff-only", "a");
  git(repo, "merge", "-q", "--no-edit", "b"); // throws on a conflict: the merge must be clean
  return {
    ...x,
    repo,
    base,
    wtA,
    wtB,
    refA,
    refB,
    gateA,
    stateDir: x.service.locks.file.replace(/\/cadwork\/locks\.json$/, ""),
    designDoc: () => read(join(repo, "cad", "plate", "design.json")),
    partDoc: () => read(join(repo, "cad", "plate", "part.json")),
  };
}
