import { test, expect } from "bun:test";
import { runCheck, runChecks, combineVerdicts } from "../../src/loops/checks";
import type { CheckContext } from "../../src/loops/checks";

const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({
  judge: async () => ({ met: true }),
  runCommand: async () => ({ exit: 0, output: "" }),
  transcript: "…",
  cwd: "/tmp",
  ...over,
});

test("command check: exit matches expectExit → pass, else fail with the last output line", async () => {
  expect((await runCheck({ kind: "command", command: "bun test" }, ctx({ runCommand: async () => ({ exit: 0, output: "ok" }) }))).v).toBe("pass");
  const fail = await runCheck({ kind: "command", command: "bun test" }, ctx({ runCommand: async () => ({ exit: 1, output: "line1\n2 failed" }) }));
  expect(fail.v).toBe("fail");
  expect(fail.detail).toContain("2 failed");
});

test("command check respects a non-zero expectExit", async () => {
  const r = await runCheck({ kind: "command", command: "grep x", expectExit: 1 }, ctx({ runCommand: async () => ({ exit: 1, output: "" }) }));
  expect(r.v).toBe("pass");
});

test("judge check: met → pass, unmet → fail carrying the reason", async () => {
  expect((await runCheck({ kind: "judge", condition: "works" }, ctx({ judge: async () => ({ met: true }) }))).v).toBe("pass");
  const r = await runCheck({ kind: "judge", condition: "works" }, ctx({ judge: async () => ({ met: false, reason: "2 red" }) }));
  expect(r.v).toBe("fail");
  expect(r.detail).toBe("2 red");
});

test("a throwing/timed-out check yields check-error (never throws)", async () => {
  const r = await runCheck({ kind: "judge", condition: "x" }, ctx({ judge: async () => { throw new Error("unreachable"); } }));
  expect(r.v).toBe("check-error");
  expect(r.detail).toContain("unreachable");
});

test("metric/http checks are Phase-5 stubs (check-error)", async () => {
  expect((await runCheck({ kind: "metric", command: "cov", op: "gte", threshold: 80 }, ctx())).v).toBe("check-error");
  expect((await runCheck({ kind: "http", url: "http://x" }, ctx())).v).toBe("check-error");
});

test("combineVerdicts: all-mode passes only if every check passes", () => {
  expect(combineVerdicts([{ check: "a", v: "pass" }, { check: "b", v: "pass" }], "all").passed).toBe(true);
  expect(combineVerdicts([{ check: "a", v: "pass" }, { check: "b", v: "fail" }], "all").passed).toBe(false);
});

test("combineVerdicts: any-mode passes if at least one passes", () => {
  expect(combineVerdicts([{ check: "a", v: "fail" }, { check: "b", v: "pass" }], "any").passed).toBe(true);
  expect(combineVerdicts([{ check: "a", v: "fail" }, { check: "b", v: "check-error" }], "any").passed).toBe(false);
});

test("combineVerdicts: zero checks never passes (always gates for a human)", () => {
  expect(combineVerdicts([], "all").passed).toBe(false);
  expect(combineVerdicts([], "any").passed).toBe(false);
});

test("runChecks renders one row per check", async () => {
  const rows = await runChecks([{ kind: "command", command: "a" }, { kind: "judge", condition: "b" }], ctx());
  expect(rows.length).toBe(2);
});
