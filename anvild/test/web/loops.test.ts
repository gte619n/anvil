/**
 * Phase 1 acceptance (loops-circuit spec §5): with an armed schedule, one armed /goal, and one pending
 * proposal, #loops lists 3 circuit rows with correct runner/lock/lap state; the goal detail shows the
 * live lap count (and re-renders when a new snapshot bumps it); the proposal is approvable from its
 * detail page. Driven over jsdom with a seeded serverLoops cache + a fake hub socket.
 */
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";
import type { LoopSummary } from "../../protocol";

let loops: typeof import("../../web/src/loops");
let fleet: typeof import("../../web/src/fleet");
let overlays: typeof import("../../web/src/overlays");
const sent: { type: string }[] = [];
const approved: string[] = [];

beforeAll(async () => {
  installDom({ html: `<!doctype html><html><body><div id="loops-root"></div><span id="loops-badge" hidden></span><div id="toast"></div></body></html>` });
  fleet = await import("../../web/src/fleet");
  overlays = await import("../../web/src/overlays");
  loops = await import("../../web/src/loops");
  // A fake hub server whose socket is open and records sends (openLoops pulls loops.get).
  const fakeSock = { isOpen: () => true, send: (m: { type: string }) => sent.push(m) };
  fleet.servers.set(fleet.HUB_URL, { url: fleet.HUB_URL, id: "hub", name: "hub", sock: fakeSock as never, status: "connected" });
  loops.initLoops({
    environments: new Map(),
    sendAwait: async (_s, cmd) => {
      if (cmd.type === "autopilot.approve") approved.push(String(cmd.workUnitId));
      return { type: "autopilot.approved" } as never;
    },
    subscribeIntakeProgress: () => () => {},
    selectSession: () => {},
  });
});
afterAll(() => {
  fleet.servers.delete(fleet.HUB_URL);
  uninstallDom();
});
beforeEach(() => {
  overlays.overlays.length = 0;
  sent.length = 0;
  approved.length = 0;
  fleet.serverLoops.clear(); // module Maps are shared across test files — clear all loop caches
  fleet.serverLoopEntities.clear();
  fleet.loopRuns.clear();
  history.replaceState(null, "", "https://appassets.androidplatform.net/");
});

const SNAPSHOT: LoopSummary[] = [
  { kind: "schedule", id: "schedule", title: "Nightly autopilot", trigger: "Daily at 02:00", act: "Re-plan projects", stopCondition: "Plans, holds for review", status: "armed", rung: "suggest" },
  { kind: "goal", id: "s1", title: "Fix flaky test", trigger: "Every stop attempt", act: "Drive the session", stopCondition: "suite passes 10x", status: "running", rung: "pr", runnerAt: "check", iteration: { current: 2, max: 10 }, sessionId: "s1" },
  { kind: "trigger", id: "wu1", title: "CI build broke", trigger: "CI #1421", act: "Approve to plan & build", stopCondition: "Awaiting your approval", status: "gated", rung: "suggest", runnerAt: "gate" },
];

test("the home lists 3 circuit rows with the right status chips", () => {
  fleet.serverLoops.set(fleet.HUB_URL, SNAPSHOT);
  loops.openLoops();
  const rows = document.querySelectorAll("#loops-root .lc-row");
  expect(rows.length).toBe(3);
  // schedule armed, goal lap 2/10, proposal at your gate
  expect(document.querySelector("#loops-root")!.innerHTML).toContain("lap 2/10");
  expect(document.querySelector("#loops-root")!.innerHTML).toContain("at your gate");
  expect(sent.some((m) => m.type === "loops.get")).toBe(true); // pulled fresh on open
});

test("the badge counts loops waiting at the gate", () => {
  fleet.serverLoops.set(fleet.HUB_URL, SNAPSHOT);
  loops.openLoops();
  expect(document.getElementById("loops-badge")!.textContent).toBe("1"); // one gated proposal
});

test("tapping the goal row opens a detail with the live lap count that a new snapshot bumps", () => {
  fleet.serverLoops.set(fleet.HUB_URL, SNAPSHOT);
  loops.openLoops();
  const goalRow = [...document.querySelectorAll<HTMLElement>("#loops-root .lc-row")].find((r) => r.dataset.id === "s1")!;
  goalRow.click();
  expect(document.querySelector("#loops-root")!.innerHTML).toContain("Lap 2 / 10");
  // A new snapshot (unmet stop bumped iterations 2→3) arrives; onLoopsHome re-renders the open detail.
  fleet.serverLoops.set(fleet.HUB_URL, SNAPSHOT.map((l) => (l.id === "s1" ? { ...l, iteration: { current: 3, max: 10 } } : l)));
  loops.onLoopsHome();
  expect(document.querySelector("#loops-root")!.innerHTML).toContain("Lap 3 / 10");
});

test("the proposal is approvable from its detail page", async () => {
  fleet.serverLoops.set(fleet.HUB_URL, SNAPSHOT);
  loops.openLoops();
  const propRow = [...document.querySelectorAll<HTMLElement>("#loops-root .lc-row")].find((r) => r.dataset.id === "wu1")!;
  propRow.click();
  const approveBtn = document.getElementById("lc-approve") as HTMLButtonElement;
  expect(approveBtn).toBeTruthy();
  approveBtn.click();
  await new Promise((r) => setTimeout(r, 0));
  expect(approved).toEqual(["wu1"]);
});
