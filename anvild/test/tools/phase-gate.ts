/**
 * Phase gate (agent-cad-and-browser spec §8.4) — how an agent proves a phase before ticking it.
 *
 *   cd anvild && bun test/tools/phase-gate.ts <phase> [--require-real] [--allow-dirty] [--spike-evidence <file>]
 *
 * Reads test/phase-manifest.json and, for the phase:
 *   1. refuses a dirty git tree (lists the files) unless --allow-dirty. Dirty = any change under
 *      anvild/, or a tracked change elsewhere other than docs/ Markdown (see classifyDirty — untracked
 *      files outside anvild/ and edited docs/ Markdown are listed but do not block);
 *   2. fails if a non-spike phase names no tests, or a listed file is missing;
 *   3. runs `bun test --reporter=junit` on the phase's files and reads the report: every named test
 *      must be present, passed, not skipped, with at least one assertion; any failed test in those
 *      files fails the step;
 *   4. runs the whole suite (`bun test`), `bun run typecheck`, `bun run typecheck:web`, `bun run build:web`;
 *   5. runs the phase's Playwright specs, if any (`bunx --bun playwright test -c <config> <specs>`;
 *      config = the phase's `playwrightConfig`, default test/golden/playwright.config.ts);
 *   6. with --require-real, runs the phase's `real` files with ANVIL_REAL_TOOLS=1 through the same
 *      JUnit check and fails on ANY skip; without it they are reported as "not run";
 *   7. prints a summary block ending in exactly `PHASE <id>: PASS` or `PHASE <id>: FAIL`. Exit 0/1.
 *
 * TIME LIMITS: steps 3–6 each run in their own process group with a time limit (`STEP_TIMEOUTS_MS`:
 * 45 min for the full suite and the real tools, less for the rest; `--timeout-scale <x>` or
 * `ANVIL_GATE_TIMEOUT_SCALE` scales them, `ANVIL_GATE_TIMEOUT_MS` sets them all). A step over its
 * limit has its whole group killed and fails "timed out". Every step's output is teed as it runs to
 * `<os tmp>/phase-gate-logs-XXXXXX/<step>.log`; the summary prints the folder and each step's file.
 *
 * Every step runs even after an earlier one fails, so one run reports everything that is wrong.
 *
 * NAME MATCHING: a manifest name is the test's full path inside its file — the enclosing describe
 * titles, outermost first, then the test title, joined by " > " (a top-level test is just its
 * title). Exact, case-sensitive match within the listed file. See `fullTestName` in phase-gate-lib.ts.
 *
 * SPIKE PHASES (A0/B0/C0, `"spike": true`) ship no product code. The gate prints "spike phase:
 * evidence lives in the spec §11" and passes only if `--spike-evidence <file>` names a non-empty file.
 *
 * Manifest shape (validated by validateManifest):
 *   { "phases": { "<id>": { "title": string,
 *                           "tests": [{ "file": "test/…", "names": ["full test name", …] }],
 *                           "playwright"?: ["path/to/spec.pw.ts", …], "playwrightConfig"?: "path",
 *                           "real"?: [{ "file": "test/real/…", "names": […] }],
 *                           "spike"?: true } } }
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SOLIDCRAFT_CLI, hasSolidcraft } from "../helpers/real-tools";
import {
  USAGE,
  checkNamedTests,
  classifyDirty,
  countCases,
  parseGateArgs,
  parseJUnit,
  phaseProblems,
  runStep,
  stepTimeoutMs,
  validateManifest,
  type JUnitCase,
  type PhaseTestRef,
} from "./phase-gate-lib";

const ANVILD = resolve(import.meta.dir, "..", "..");
const MANIFEST = join(ANVILD, "test", "phase-manifest.json");
const DEFAULT_PW_CONFIG = "test/golden/playwright.config.ts";

interface Step {
  name: string;
  status: "pass" | "fail" | "not run";
  detail: string;
  ms?: number;
  /** The file the step's output was teed to. */
  log?: string;
}

/** This run's step logs (created on first use, kept after the run). */
let logDir: string | undefined;
let timeoutScale: number | undefined;
const logFor = (step: string): string => join((logDir ??= mkdtempSync(join(tmpdir(), "phase-gate-logs-"))), `${step.replace(/[^A-Za-z0-9_-]+/g, "-")}.log`);

/** A step's command, in its own process group, with its time limit; output teed to its log. */
async function stepRun(step: string, cmd: string[], env: Record<string, string> = {}) {
  const timeoutMs = stepTimeoutMs(step, timeoutScale);
  const r = await runStep(cmd, { cwd: ANVILD, env: { ...process.env, ...env }, timeoutMs, log: logFor(step) });
  if (r.timedOut) console.log(`\n[${step}] TIMED OUT after ${(timeoutMs / 1000).toFixed(0)}s — process group killed; output: ${r.log}`);
  return { ...r, timeoutMs };
}
const timedOutDetail = (r: { timedOut: boolean; timeoutMs: number }) => (r.timedOut ? `timed out after ${(r.timeoutMs / 1000).toFixed(0)}s; ` : "");

function run(cmd: string[], env: Record<string, string> = {}): { code: number; out: string; ms: number } {
  const t0 = performance.now();
  const p = Bun.spawnSync(cmd, { cwd: ANVILD, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString(), ms: performance.now() - t0 };
}

const git = (...args: string[]) => run(["git", ...args]).out.trim();
const secs = (ms?: number) => (ms === undefined ? "" : ` (${(ms / 1000).toFixed(1)}s)`);
/** The last lines of a failed command's output — enough to see why without the whole log. */
const tail = (out: string, n = 40) => out.trimEnd().split("\n").slice(-n).join("\n");

/** Run `bun test` with the JUnit reporter on `files` (all tests when empty) and parse the report. */
async function bunTestJUnit(step: string, files: string[], env: Record<string, string> = {}): Promise<{ cases: JUnitCase[]; code: number; out: string; ms: number; timedOut: boolean; timeoutMs: number; log: string; error?: string }> {
  const dir = mkdtempSync(join(tmpdir(), "phase-gate-"));
  const report = join(dir, "junit.xml");
  try {
    // "./"-prefixed so bun treats each as that exact file, not as a name filter.
    const r = await stepRun(step, ["bun", "test", "--reporter=junit", `--reporter-outfile=${report}`, ...files.map((f) => `./${f}`)], env);
    if (r.timedOut) return { cases: [], ...r, error: `timed out after ${(r.timeoutMs / 1000).toFixed(0)}s (process group killed); output: ${r.log}` };
    if (!existsSync(report)) return { cases: [], ...r, error: "bun test wrote no JUnit report" };
    try {
      return { cases: parseJUnit(readFileSync(report, "utf8")), ...r };
    } catch (e) {
      return { cases: [], ...r, error: e instanceof Error ? e.message : String(e) };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Steps 3 and 6: run the files, then hold the report to the named tests. */
async function namedStep(name: string, refs: PhaseTestRef[], opts: { real?: boolean } = {}): Promise<Step> {
  const r = await bunTestJUnit(
    name,
    refs.map((t) => t.file),
    opts.real ? { ANVIL_REAL_TOOLS: "1" } : {},
  );
  const counts = countCases(r.cases);
  const check = checkNamedTests(r.cases, refs, { failOnAnySkip: opts.real });
  const problems = [...check.problems];
  if (r.error) problems.push(r.error);
  if (r.code !== 0 && problems.length === 0) problems.push(`bun test exited ${r.code}`);
  const detail = `${timedOutDetail(r)}${check.namedOk}/${check.named} named tests ok; ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.assertions} assertions in ${refs.length} file(s)`;
  if (problems.length) {
    console.log(`\n[${name}] FAILED:\n  ${problems.join("\n  ")}`);
    if (r.code !== 0) console.log(`--- bun test output (tail) ---\n${tail(r.out)}`);
  }
  return { name, status: problems.length ? "fail" : "pass", detail, ms: r.ms, log: r.log };
}

async function cmdStep(name: string, cmd: string[]): Promise<Step> {
  const r = await stepRun(name, cmd);
  if (r.code !== 0) console.log(`\n[${name}] FAILED (exit ${r.code}):\n${tail(r.out)}`);
  return { name, status: r.code === 0 ? "pass" : "fail", detail: `${timedOutDetail(r)}${cmd.join(" ")}`, ms: r.ms, log: r.log };
}

function solidcraftVersion(): string {
  if (!hasSolidcraft()) return "absent";
  const r = run([SOLIDCRAFT_CLI, "--version"]);
  return r.code === 0 ? r.out.trim().split("\n")[0]! : `present, but --version exited ${r.code}`;
}

async function main(): Promise<number> {
  const parsed = parseGateArgs(process.argv.slice(2));
  if (!parsed.args) {
    console.error(`${parsed.error}\n${USAGE}`);
    return 1;
  }
  const { phase: id, requireReal, allowDirty, spikeEvidence } = parsed.args;
  timeoutScale = parsed.args.timeoutScale;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch (e) {
    console.error(`cannot read ${MANIFEST}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const { manifest, errors } = validateManifest(raw);
  if (!manifest) {
    console.error(`phase-manifest.json is invalid:\n  ${errors.join("\n  ")}`);
    return 1;
  }
  const phase = manifest.phases[id];
  if (!phase) {
    console.error(`unknown phase ${JSON.stringify(id)} (known: ${Object.keys(manifest.phases).join(", ")})\n${USAGE}`);
    return 1;
  }

  const steps: Step[] = [];
  const t0 = performance.now();
  // Read BEFORE anything runs: this is the commit the steps below test. (A commit landing while the
  // suite runs must not be the sha the summary vouches for — see the end-of-run check.)
  const sha = git("rev-parse", "HEAD");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");

  // 1. Dirty tree.
  const dirty = classifyDirty(run(["git", "status", "--porcelain"]).out);
  const isDirty = dirty.blocking.length > 0;
  if (dirty.ignored.length) console.log(`note: changes outside anvild/ that cannot affect the gate (not blocking):\n  ${dirty.ignored.join("\n  ")}`);
  if (isDirty && !allowDirty) {
    console.log(`\n[clean tree] FAILED: the working tree is dirty — commit first, or pass --allow-dirty:\n  ${dirty.blocking.join("\n  ")}`);
  }
  steps.push({
    name: "clean tree",
    status: isDirty && !allowDirty ? "fail" : "pass",
    detail: isDirty ? `${dirty.blocking.length} dirty path(s)${allowDirty ? " (--allow-dirty)" : ""}` : "clean",
  });
  const refused = isDirty && !allowDirty;

  if (phase.spike) {
    console.log("spike phase: evidence lives in the spec §11");
    const ok = !!spikeEvidence && existsSync(spikeEvidence) && statSync(spikeEvidence).isFile() && statSync(spikeEvidence).size > 0;
    steps.push({
      name: "spike evidence",
      status: ok ? "pass" : "fail",
      detail: spikeEvidence ? (ok ? spikeEvidence : `${spikeEvidence} is missing or empty`) : "no --spike-evidence <file> given",
    });
  } else if (refused) {
    // A refusal means nothing else runs: results from a dirty tree would not describe the sha.
    for (const name of ["manifest", "named tests", "full suite", "typecheck", "typecheck:web", "build:web", "playwright", "real tools"]) {
      steps.push({ name, status: "not run", detail: "refused: dirty tree" });
    }
  } else {
    // 2. Manifest: tests named, files present.
    const problems = phaseProblems(manifest, id, (f) => existsSync(join(ANVILD, f)));
    if (problems.length) console.log(`\n[manifest] FAILED:\n  ${problems.join("\n  ")}`);
    const namedCount = phase.tests.reduce((n, t) => n + t.names.length, 0);
    steps.push({
      name: "manifest",
      status: problems.length ? "fail" : "pass",
      detail: `${namedCount} named test(s) in ${phase.tests.length} file(s)`,
    });

    // 3. The phase's files, held to the named tests.
    const present = phase.tests.filter((t) => existsSync(join(ANVILD, t.file)));
    if (present.length === 0) steps.push({ name: "named tests", status: "fail", detail: "no test files to run" });
    else steps.push(await namedStep("named tests", present));

    // 4. Whole suite + typechecks + web build.
    const full = await bunTestJUnit("full suite", []);
    const fc = countCases(full.cases);
    const fullOk = full.code === 0 && !full.error && fc.failed === 0 && fc.total > 0;
    if (!fullOk) console.log(`\n[full suite] FAILED (exit ${full.code})${full.error ? `: ${full.error}` : ""}\n${tail(full.out, 60)}`);
    steps.push({
      name: "full suite",
      status: fullOk ? "pass" : "fail",
      detail: `${timedOutDetail(full)}${fc.passed} passed, ${fc.failed} failed, ${fc.skipped} skipped, ${fc.assertions} assertions`,
      ms: full.ms,
      log: full.log,
    });
    steps.push(await cmdStep("typecheck", ["bun", "run", "typecheck"]));
    steps.push(await cmdStep("typecheck:web", ["bun", "run", "typecheck:web"]));
    steps.push(await cmdStep("build:web", ["bun", "run", "build:web"]));

    // 5. Playwright — the only place these specs gate (bun test and CI do not run them).
    if (phase.playwright?.length) {
      const config = phase.playwrightConfig ?? DEFAULT_PW_CONFIG;
      const s = await cmdStep("playwright", ["bunx", "--bun", "playwright", "test", "-c", config, ...phase.playwright]);
      steps.push({ ...s, detail: `${/^timed out[^;]*; /.exec(s.detail)?.[0] ?? ""}${phase.playwright.length} spec(s), config ${config}` });
    } else steps.push({ name: "playwright", status: "not run", detail: "none listed" });

    // 6. Real tools.
    const real = phase.real ?? [];
    if (!requireReal) {
      steps.push({ name: "real tools", status: "not run", detail: real.length ? `${real.length} file(s) listed; pass --require-real` : "none listed" });
    } else if (real.length === 0) {
      steps.push({ name: "real tools", status: "not run", detail: "none listed (--require-real had nothing to run)" });
    } else {
      steps.push(await namedStep("real tools", real.filter((t) => existsSync(join(ANVILD, t.file))), { real: true }));
    }
  }

  // HEAD must not have moved under the run, or the results describe a mix of two commits.
  const shaNow = git("rev-parse", "HEAD");
  if (shaNow !== sha) {
    console.log(`\n[stable HEAD] FAILED: HEAD moved during the run (${sha.slice(0, 7)} → ${shaNow.slice(0, 7)}) — run the gate again`);
    steps.push({ name: "stable HEAD", status: "fail", detail: `HEAD moved to ${shaNow.slice(0, 7)} during the run` });
  }

  // 7. Summary.
  const ok = steps.every((s) => s.status !== "fail");
  const width = Math.max(...steps.map((s) => s.name.length));
  console.log(`\n================ PHASE GATE ${id}: ${phase.title} ================`);
  console.log(`git sha:     ${sha}`);
  console.log(`branch:      ${branch}`);
  console.log(`dirty:       ${isDirty ? "yes" : "no"}${dirty.ignored.length ? ` (${dirty.ignored.length} non-blocking path(s) outside anvild/, listed above)` : ""}`);
  console.log(`bun:         ${Bun.version}`);
  console.log(`solidcraft:  ${solidcraftVersion()}`);
  console.log(`real tools:  ${requireReal ? "required" : "not required"}`);
  console.log(`total time:  ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  if (logDir) console.log(`step logs:   ${logDir}`);
  for (const s of steps) console.log(`  ${s.name.padEnd(width)}  ${s.status.toUpperCase().padEnd(7)}  ${s.detail}${secs(s.ms)}${s.log ? `  log: ${s.log}` : ""}`);
  console.log(`PHASE ${id}: ${ok ? "PASS" : "FAIL"}`);
  return ok ? 0 : 1;
}

process.exit(await main());
