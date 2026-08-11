/**
 * The Loop circuit renderer (web/src/circuit.ts) is a pure (view) → SVG string module, ported from the
 * validated mock. These pin the station geometry, the gate lock's presence-by-rung, the runner, the lap
 * caption, the scope line, and the projection→circuit defaulting (loopToCircuit) so a daemon that omits
 * the display fields still draws a sensible circuit.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";

let circuit: typeof import("../../web/src/circuit");
beforeAll(async () => {
  installDom();
  circuit = await import("../../web/src/circuit");
});
afterAll(() => uninstallDom());

test("circuitSvg draws all four stations + the return loop", () => {
  const svg = circuit.circuitSvg({ trigger: "Manual", act: "Fix it", check: "tests green", rung: "pr", status: "running" });
  for (const label of ["Trigger", "Act", "Check", "Ship"]) expect(svg).toContain(`>${label}</text>`);
  expect(svg).toContain("lc-return"); // Act ⇄ Check return path
});

test("a gated rung (not ship) draws the lock diamond; ship omits it", () => {
  const pr = circuit.circuitSvg({ trigger: "t", act: "a", check: "c", rung: "pr", status: "running" });
  expect(pr).toContain("lc-gate-d");
  expect(pr).toContain(">lock</text>");
  const ship = circuit.circuitSvg({ trigger: "t", act: "a", check: "c", rung: "ship", status: "running" });
  expect(ship).not.toContain("lc-gate-d");
});

test("the runner appears only when runnerAt is set, at that station", () => {
  const withRunner = circuit.circuitSvg({ trigger: "t", act: "a", check: "c", rung: "pr", runnerAt: "check", status: "running" });
  expect(withRunner).toContain('id="runner"');
  expect(withRunner).toContain("translate(410,74)"); // Check station coords
  const noRunner = circuit.circuitSvg({ trigger: "t", act: "a", check: "c", rung: "pr", runnerAt: null, status: "paused" });
  expect(noRunner).not.toContain('id="runner"');
});

test("laps drive the return-loop caption; scope draws the shield line", () => {
  const svg = circuit.circuitSvg({ trigger: "t", act: "a", check: "c", rung: "pr", laps: { current: 3, max: 10 }, scope: "src/upload/ only", status: "running" });
  expect(svg).toContain("lap 3 of 10");
  expect(svg).toContain("lc-scope");
  expect(svg).toContain("src/upload/ only");
});

test("miniSvg colours the runner dot by status and shows the gate lock unless ship", () => {
  const running = circuit.miniSvg({ trigger: "t", act: "a", check: "c", rung: "pr", runnerAt: "act", status: "running" });
  expect(running).toContain("#f2c037"); // running = amber
  const gated = circuit.miniSvg({ trigger: "t", act: "a", check: "c", rung: "pr", runnerAt: "gate", status: "gated" });
  expect(gated).toContain("#b07cc3"); // gated = purple
  const ship = circuit.miniSvg({ trigger: "t", act: "a", check: "c", rung: "ship", status: "running" });
  expect(ship).not.toContain('transform="rotate(45 89 14)"'); // no gate lock on ship
});

test("loopToCircuit fills defaults from kind/status when the daemon omits display fields", () => {
  const goal = circuit.loopToCircuit({ kind: "goal", id: "s1", title: "Fix", trigger: "Every stop", stopCondition: "tests pass", status: "running", iteration: { current: 2, max: 10 } });
  expect(goal.rung).toBe("pr"); // goal/pipeline default to PR
  expect(goal.runnerAt).toBe("act"); // running with no explicit runnerAt → Act
  expect(goal.laps).toEqual({ current: 2, max: 10 });

  const proposal = circuit.loopToCircuit({ kind: "trigger", id: "wu1", title: "Approve", trigger: "CI", stopCondition: "await", status: "gated" });
  expect(proposal.rung).toBe("suggest"); // non-goal default
  expect(proposal.runnerAt).toBe("gate"); // gated → the gate

  const explicit = circuit.loopToCircuit({ kind: "goal", id: "x", title: "t", trigger: "m", stopCondition: "c", status: "running", rung: "draft", runnerAt: "check", scope: "src/" });
  expect(explicit.rung).toBe("draft"); // explicit fields win
  expect(explicit.runnerAt).toBe("check");
  expect(explicit.scope).toBe("src/");
});
