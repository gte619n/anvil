/**
 * [F0] The phase gate's pure parts (agent-cad-and-browser spec §8.4): manifest validation, JUnit
 * parsing and named-test matching. The fixture XML below is the exact shape Bun 1.3.14 writes
 * (`bun test --reporter=junit`): one <testsuite> per file, nested <testsuite>s per describe,
 * `assertions="N"` per <testcase>, `<skipped />` / `<failure />` children.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkNamedTests,
  classifyDirty,
  countCases,
  fullTestName,
  parseGateArgs,
  parseJUnit,
  phaseProblems,
  runStep,
  stepTimeoutMs,
  STEP_TIMEOUTS_MS,
  validateManifest,
  type PhaseManifest,
} from "../tools/phase-gate-lib";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="8" assertions="6" failures="1" skipped="2" time="0.011609">
  <testsuite name="test/unit/gate.test.ts" file="test/unit/gate.test.ts" tests="6" assertions="5" failures="1" skipped="2" time="0" hostname="h">
    <testsuite name="outer &lt;a&gt; &amp; &quot;q&quot;" file="test/unit/gate.test.ts" line="2" tests="5" assertions="4" failures="1" skipped="2" time="0" hostname="h">
      <testsuite name="inner" file="test/unit/gate.test.ts" line="2" tests="1" assertions="2" failures="0" skipped="0" time="0" hostname="h">
        <testcase name="deep one" classname="inner &amp;gt; outer &amp;lt;a&amp;gt; &amp;amp; &amp;quot;q&amp;quot;" time="0.00002" file="test/unit/gate.test.ts" line="2" assertions="2" />
      </testsuite>
      <testcase name="no asserts" classname="outer" time="0.000004" file="test/unit/gate.test.ts" line="3" assertions="0" />
      <testcase name="skipped one" classname="outer" time="0" file="test/unit/gate.test.ts" line="3" assertions="0">
        <skipped />
      </testcase>
      <testcase name="todo one" classname="outer" time="0" file="test/unit/gate.test.ts" line="3" assertions="0">
        <skipped message="TODO" />
      </testcase>
      <testcase name="fails" classname="outer" time="0.000128" file="test/unit/gate.test.ts" line="3" assertions="1">
        <failure type="AssertionError" />
      </testcase>
    </testsuite>
    <testcase name="top level" classname="" time="0.000006" file="test/unit/gate.test.ts" line="4" assertions="1" />
  </testsuite>
  <testsuite name="test/unit/other.test.ts" file="test/unit/other.test.ts" tests="2" assertions="2" failures="0" skipped="0" time="0" hostname="h">
    <testcase name="top level" classname="" time="0.000006" file="test/unit/other.test.ts" line="4" assertions="1" />
    <testcase name="plate volume" classname="" time="0.000006" file="test/unit/other.test.ts" line="9" assertions="1" />
  </testsuite>
</testsuites>
`;
const OUTER = 'outer <a> & "q"';
const cases = parseJUnit(XML);
/** Only the green file, for the all-good checks. */
const greenCases = cases.filter((c) => c.file === "test/unit/other.test.ts");

describe("parseJUnit", () => {
  test("[F0] reads every testcase with its file, full describe path, status and assertion count", () => {
    expect(cases).toEqual([
      { file: "test/unit/gate.test.ts", name: `${OUTER} > inner > deep one`, status: "passed", assertions: 2 },
      { file: "test/unit/gate.test.ts", name: `${OUTER} > no asserts`, status: "passed", assertions: 0 },
      { file: "test/unit/gate.test.ts", name: `${OUTER} > skipped one`, status: "skipped", assertions: 0 },
      { file: "test/unit/gate.test.ts", name: `${OUTER} > todo one`, status: "skipped", assertions: 0 },
      { file: "test/unit/gate.test.ts", name: `${OUTER} > fails`, status: "failed", assertions: 1 },
      { file: "test/unit/gate.test.ts", name: "top level", status: "passed", assertions: 1 },
      { file: "test/unit/other.test.ts", name: "top level", status: "passed", assertions: 1 },
      { file: "test/unit/other.test.ts", name: "plate volume", status: "passed", assertions: 1 },
    ]);
  });

  test("[F0] counts cases by status", () => {
    expect(countCases(cases)).toEqual({ total: 8, passed: 5, failed: 1, skipped: 2, assertions: 6 });
  });

  test("[F0] a report with no <testsuites> root is an error, never 'no tests ran'", () => {
    expect(() => parseJUnit("")).toThrow(/not a JUnit report/);
    expect(() => parseJUnit("error: Cannot find module")).toThrow(/not a JUnit report/);
  });

  test("[F0] the full name is describe titles outermost-first, then the title, joined by ' > '", () => {
    expect(fullTestName([], "plate volume")).toBe("plate volume");
    expect(fullTestName(["gate", "holes"], "fails on a missing hole")).toBe("gate > holes > fails on a missing hole");
  });
});

describe("checkNamedTests", () => {
  test("[F0] all named tests present, passed, with assertions → pass", () => {
    const r = checkNamedTests(greenCases, [{ file: "test/unit/other.test.ts", names: ["top level", "plate volume"] }]);
    expect(r).toEqual({ ok: true, problems: [], named: 2, namedOk: 2 });
  });

  test("[F0] a skipped named test → fail", () => {
    const only = cases.filter((c) => c.name.endsWith("skipped one"));
    const r = checkNamedTests(only, [{ file: "test/unit/gate.test.ts", names: [`${OUTER} > skipped one`] }]);
    expect(r.ok).toBe(false);
    expect(r.namedOk).toBe(0);
    expect(r.problems).toEqual([`skipped: test/unit/gate.test.ts › ${OUTER} > skipped one`]);
  });

  test("[F0] a zero-assertion named test → fail", () => {
    const only = cases.filter((c) => c.name.endsWith("no asserts"));
    const r = checkNamedTests(only, [{ file: "test/unit/gate.test.ts", names: [`${OUTER} > no asserts`] }]);
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toStartWith("no assertions: test/unit/gate.test.ts");
  });

  test("[F0] a missing named test → fail", () => {
    const r = checkNamedTests(greenCases, [{ file: "test/unit/other.test.ts", names: ["plate volume", "gate fails after removing the pattern"] }]);
    expect(r.ok).toBe(false);
    expect(r.named).toBe(2);
    expect(r.namedOk).toBe(1);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toStartWith("missing: test/unit/other.test.ts › gate fails after removing the pattern");
  });

  test("[F0] a failed named test → fail", () => {
    const only = cases.filter((c) => c.name.endsWith("fails"));
    const r = checkNamedTests(only, [{ file: "test/unit/gate.test.ts", names: [`${OUTER} > fails`] }]);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([`failed: test/unit/gate.test.ts › ${OUTER} > fails`]);
  });

  test("[F0] names match exactly and per file — no bare title, prefix or other-file match", () => {
    // "deep one" lives under two describes: its bare title is not its name.
    const bare = checkNamedTests(greenCases.concat(cases[0]!), [{ file: "test/unit/gate.test.ts", names: ["deep one"] }]);
    expect(bare.problems[0]).toStartWith("missing:");
    // "plate volume" exists, but in other.test.ts.
    const wrongFile = checkNamedTests(greenCases, [{ file: "test/unit/gate.test.ts", names: ["plate volume"] }]);
    expect(wrongFile.problems[0]).toStartWith("missing:");
    const prefix = checkNamedTests(greenCases, [{ file: "test/unit/other.test.ts", names: ["plate"] }]);
    expect(prefix.problems[0]).toStartWith("missing:");
    // A "./" prefix on the manifest path is the same file.
    expect(checkNamedTests(greenCases, [{ file: "./test/unit/other.test.ts", names: ["plate volume"] }]).ok).toBe(true);
  });

  test("[F0] an unnamed failing test in the phase's files still fails the check", () => {
    const r = checkNamedTests(cases, [{ file: "test/unit/gate.test.ts", names: ["top level"] }]);
    expect(r.namedOk).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([`failed: test/unit/gate.test.ts › ${OUTER} > fails`]);
  });

  test("[F0] unnamed skips are tolerated normally but fail a real-tool run (failOnAnySkip)", () => {
    const noFail = cases.filter((c) => c.status !== "failed");
    const refs = [{ file: "test/unit/gate.test.ts", names: ["top level"] }];
    expect(checkNamedTests(noFail, refs).ok).toBe(true);
    const real = checkNamedTests(noFail, refs, { failOnAnySkip: true });
    expect(real.ok).toBe(false);
    expect(real.problems).toEqual([
      `skipped: test/unit/gate.test.ts › ${OUTER} > skipped one`,
      `skipped: test/unit/gate.test.ts › ${OUTER} > todo one`,
    ]);
  });
});

describe("manifest", () => {
  const good = {
    phases: {
      A0: { title: "spike", tests: [], spike: true },
      A1: { title: "manager", tests: [{ file: "test/integration/cad-a1-manager.test.ts", names: ["builds the plate"] }], real: [{ file: "test/real/cad-a1.test.ts", names: ["plate end to end"] }], playwright: ["test/golden/x.pw.ts"] },
      A2: { title: "gate", tests: [] },
    },
  };

  test("[F0] a well-formed manifest validates", () => {
    const { manifest, errors } = validateManifest(good);
    expect(errors).toEqual([]);
    expect(Object.keys(manifest!.phases)).toEqual(["A0", "A1", "A2"]);
    expect(manifest!.phases.A0!.spike).toBe(true);
  });

  test("[F0] shape errors are all reported", () => {
    expect(validateManifest(null).errors).toHaveLength(1);
    expect(validateManifest({ phases: [] }).errors).toHaveLength(1);
    const { manifest, errors } = validateManifest({
      phases: {
        a1: { title: "x", tests: [] },
        B1: { title: "", tests: "nope" },
        B2: { title: "x", tests: [{ file: "/abs/x.test.ts", names: ["a"] }, { file: "test/../../x.test.ts", names: ["a"] }] },
        B3: { title: "x", tests: [{ file: "test/unit/x.test.ts", names: [] }, { file: "test/unit/y.test.ts", names: ["a", "a", ""] }] },
        C1: { title: "x", tests: [], real: [{ file: "test/unit/not-real.test.ts", names: ["a"] }], spike: "yes", extra: 1 },
        C2: { title: "x", tests: [{ file: "test/unit/z.test.ts", names: ["a"] }, { file: "./test/unit/z.test.ts", names: ["b"] }] },
      },
    });
    expect(manifest).toBeUndefined();
    const all = errors.join("\n");
    expect(all).toContain("phases.a1: phase id must look like A1");
    expect(all).toContain("phases.B1.title must be a non-empty string");
    expect(all).toContain("phases.B1.tests must be an array");
    expect(all).toContain("phases.B2.tests[0].file must be relative to anvild/");
    expect(all).toContain("phases.B2.tests[1].file must not contain '..'");
    expect(all).toContain("phases.B3.tests[0].names must be a non-empty array");
    expect(all).toContain('phases.B3.tests[1].names lists "a" twice');
    expect(all).toContain("phases.B3.tests[1].names contains an empty or non-string name");
    expect(all).toContain("phases.C1.real[0].file must be under test/real/");
    expect(all).toContain("phases.C1.spike must be a boolean");
    expect(all).toContain('phases.C1: unknown key "extra"');
    expect(all).toContain("phases.C2.tests[1].file test/unit/z.test.ts is listed twice");
  });

  test("[F0] a non-spike phase with zero named tests fails; a spike phase does not", () => {
    const m = validateManifest(good).manifest as PhaseManifest;
    expect(phaseProblems(m, "A2", () => true)).toEqual(["phase A2 names no tests — every Acceptance bullet needs a named test"]);
    expect(phaseProblems(m, "A0", () => false)).toEqual([]);
    expect(phaseProblems(m, "Z9", () => true)[0]).toContain('unknown phase "Z9"');
  });

  test("[F0] a listed test, real or Playwright file that does not exist fails", () => {
    const m = validateManifest(good).manifest as PhaseManifest;
    expect(phaseProblems(m, "A1", () => true)).toEqual([]);
    expect(phaseProblems(m, "A1", (f) => !f.includes("cad-a1"))).toEqual([
      "listed file does not exist: test/integration/cad-a1-manager.test.ts",
      "listed file does not exist: test/real/cad-a1.test.ts",
    ]);
    expect(phaseProblems(m, "A1", (f) => !f.endsWith(".pw.ts"))).toEqual(["listed file does not exist: test/golden/x.pw.ts"]);
  });

  test("[F0] the checked-in manifest is valid, lists every phase, and its F0 files exist", () => {
    const anvild = join(import.meta.dir, "..", "..");
    const raw = JSON.parse(readFileSync(join(anvild, "test", "phase-manifest.json"), "utf8"));
    const { manifest, errors } = validateManifest(raw);
    expect(errors).toEqual([]);
    expect(Object.keys(manifest!.phases).sort()).toEqual(
      ["A0", "A1", "A2", "A3", "A4", "A5", "B0", "B1", "B2", "B3", "C0", "C1", "C2", "C3", "C4", "C5", "F0"].sort(),
    );
    for (const id of ["A0", "B0", "C0"]) expect(manifest!.phases[id]!.spike).toBe(true);
    expect(phaseProblems(manifest!, "F0", (f) => existsSync(join(anvild, f)))).toEqual([]);
  });
});

describe("gate arguments and dirty-tree rule", () => {
  test("[F0] parses the phase and flags", () => {
    expect(parseGateArgs(["A1"]).args).toEqual({ phase: "A1", requireReal: false, allowDirty: false });
    expect(parseGateArgs(["--require-real", "A1", "--allow-dirty"]).args).toEqual({ phase: "A1", requireReal: true, allowDirty: true });
    expect(parseGateArgs(["A0", "--spike-evidence", "/tmp/e.md"]).args?.spikeEvidence).toBe("/tmp/e.md");
    expect(parseGateArgs([]).error).toBe("missing <phase>");
    expect(parseGateArgs(["A1", "--nope"]).error).toBe("unknown flag --nope");
    expect(parseGateArgs(["A1", "A2"]).error).toBe("unexpected argument A2");
    expect(parseGateArgs(["A0", "--spike-evidence"]).error).toContain("needs a file path");
  });

  test("[F0] tracked changes and untracked files under anvild/ are dirty; other untracked files are not", () => {
    const r = classifyDirty(
      [
        " M anvild/src/config.ts",
        "?? anvild/test/unit/new.test.ts",
        "?? docs/plans/notes.md",
        "D  README.md",
        " M docs/plans/anvil-protocol.ts",
        " M docs/plans/spec.md",
        "?? scratch/",
        "R  docs/a.md -> anvild/a.md",
        " M anvild/test/real/README.md",
        "",
      ].join("\n"),
    );
    expect(r.blocking).toEqual([
      " M anvild/src/config.ts",
      "?? anvild/test/unit/new.test.ts",
      "D  README.md",
      " M docs/plans/anvil-protocol.ts", // anvild/protocol.ts is a symlink to this file
      "R  docs/a.md -> anvild/a.md",
      " M anvild/test/real/README.md",
    ]);
    expect(r.ignored).toEqual(["?? docs/plans/notes.md", " M docs/plans/spec.md", "?? scratch/"]);
    expect(classifyDirty("")).toEqual({ blocking: [], ignored: [] });
  });
});

describe("step time limits", () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test("[F0] a step's limit: 45 min for the full suite, less for the rest, scaled by --timeout-scale (else ANVIL_GATE_TIMEOUT_SCALE), all set by ANVIL_GATE_TIMEOUT_MS", () => {
    expect(STEP_TIMEOUTS_MS["full suite"]).toBe(45 * 60_000);
    expect(stepTimeoutMs("full suite", undefined, {})).toBe(45 * 60_000);
    expect(stepTimeoutMs("typecheck", undefined, {})).toBe(10 * 60_000);
    expect(stepTimeoutMs("unknown step", undefined, {})).toBe(10 * 60_000);
    expect(stepTimeoutMs("full suite", 2, {})).toBe(90 * 60_000);
    expect(stepTimeoutMs("full suite", undefined, { ANVIL_GATE_TIMEOUT_SCALE: "0.5" })).toBe(22.5 * 60_000);
    expect(stepTimeoutMs("full suite", 2, { ANVIL_GATE_TIMEOUT_SCALE: "0.5" })).toBe(90 * 60_000); // the flag wins
    expect(stepTimeoutMs("full suite", undefined, { ANVIL_GATE_TIMEOUT_SCALE: "nope" })).toBe(45 * 60_000);
    expect(stepTimeoutMs("named tests", 3, { ANVIL_GATE_TIMEOUT_MS: "1234" })).toBe(1234);
    expect(parseGateArgs(["A4", "--timeout-scale", "1.5"]).args?.timeoutScale).toBe(1.5);
    expect(parseGateArgs(["A4", "--timeout-scale", "0"]).error).toContain("positive number");
    expect(parseGateArgs(["A4", "--timeout-scale"]).error).toContain("positive number");
  });

  test("[F0] runStep tees the output to its log and returns the exit code; a step over its limit has its whole process group killed (a grandchild too) and ends 'timed out' with code 124 and its output so far in the log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-gate-test-"));
    try {
      const ok = await runStep(["sh", "-c", "echo out; echo err >&2; exit 3"], { cwd: dir, env: process.env, timeoutMs: 10_000, log: join(dir, "ok.log") });
      expect(ok).toMatchObject({ code: 3, timedOut: false });
      expect(ok.out).toContain("out");
      expect(ok.out).toContain("err");
      expect(readFileSync(ok.log, "utf8")).toContain("out");
      // A hang: a grandchild in the background, the leader waiting on it.
      const pidFile = join(dir, "pid");
      const t0 = performance.now();
      const hung = await runStep(["sh", "-c", `echo started; sleep 60 & echo $! > ${pidFile}; wait`], { cwd: dir, env: process.env, timeoutMs: 500, log: join(dir, "hung.log"), graceMs: 500 });
      expect(performance.now() - t0).toBeLessThan(10_000);
      expect(hung).toMatchObject({ code: 124, timedOut: true });
      const log = readFileSync(hung.log, "utf8");
      expect(log).toContain("started");
      expect(log).toContain("timed out after 1s: killing process group");
      const grandchild = Number(readFileSync(pidFile, "utf8").trim());
      for (let i = 0; i < 40 && alive(grandchild); i++) await new Promise((r) => setTimeout(r, 50));
      expect(alive(grandchild)).toBe(false);
      // The leader exits but leaves something holding its output open: the step still ends, with the leader's code.
      const t1 = performance.now();
      const left = await runStep(["sh", "-c", "sleep 60 & exit 0"], { cwd: dir, env: process.env, timeoutMs: 30_000, log: join(dir, "left.log"), graceMs: 300 });
      expect(left).toMatchObject({ code: 0, timedOut: false });
      expect(performance.now() - t1).toBeLessThan(10_000);
      // A command that cannot start.
      expect((await runStep(["/nonexistent/phase-gate-cmd"], { cwd: dir, env: process.env, timeoutMs: 5_000, log: join(dir, "bad.log") })).code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
