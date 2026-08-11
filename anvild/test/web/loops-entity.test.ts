/**
 * Phase 2 web: the Loops home renders real Loop entities (loops.list) with their circuit + lap history,
 * and the detail page's gate verbs (Open the gate / Send back a lap) route to the owning server. Driven
 * over jsdom with seeded entity + run caches and a fake hub socket.
 */
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";
import type { Loop, LoopRun } from "../../protocol";

let loops: typeof import("../../web/src/loops");
let fleet: typeof import("../../web/src/fleet");
let overlays: typeof import("../../web/src/overlays");
const sent: { type: string; runId?: string; loopId?: string }[] = [];

beforeAll(async () => {
  installDom({ html: `<!doctype html><html><body><div id="loops-root"></div><span id="loops-badge" hidden></span><div id="toast"></div><div id="modal-root"></div></body></html>` });
  fleet = await import("../../web/src/fleet");
  overlays = await import("../../web/src/overlays");
  loops = await import("../../web/src/loops");
  const sock = { isOpen: () => true, send: () => {} };
  fleet.servers.set(fleet.HUB_URL, { url: fleet.HUB_URL, id: "hub", name: "hub", sock: sock as never, status: "connected", capabilities: ["loops"] });
  loops.initLoops({
    environments: new Map(),
    sendAwait: async (_s, cmd) => {
      sent.push(cmd as never);
      return { type: "loop.run", run: gateRun } as never;
    },
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
  fleet.serverLoops.clear(); // module Maps are shared across test files — clear all loop caches
  fleet.serverLoopEntities.clear();
  fleet.loopRuns.clear();
  history.replaceState(null, "", "https://appassets.androidplatform.net/");
});

const loop: Loop = {
  id: "loop_1",
  name: "Fix flaky upload",
  status: "armed",
  trigger: { kind: "manual" },
  act: { kind: "session-prompt", prompt: "fix it" },
  checks: [{ kind: "command", command: "bun test upload" }],
  checksMode: "all",
  scope: { allow: ["src/upload/"] },
  rung: "pr",
  hardStops: { maxLaps: 5, tokenBudget: 300_000, noProgressLaps: 2 },
  assumptions: ["Flake is timing-related"],
  notify: { onGate: true, onFailure: true, onSuccess: false, dailyDigest: false },
  cleanGatedLaps: 0,
  configRevision: 1,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
};
const gateRun: LoopRun = {
  id: "run_1",
  loopId: "loop_1",
  configRevision: 1,
  trigger: { kind: "manual", at: "2026-08-11T00:00:00.000Z" },
  status: "at-gate",
  laps: [
    { n: 1, summary: "reproduced the flake", verdicts: [{ check: "$ bun test upload", v: "fail", detail: "2 red" }], tokens: 1000, at: "2026-08-11T00:01:00.000Z" },
    { n: 2, summary: "pinned the retry timer", verdicts: [{ check: "$ bun test upload", v: "pass" }], tokens: 1000, at: "2026-08-11T00:02:00.000Z" },
  ],
  startedAt: "2026-08-11T00:00:00.000Z",
};

test("a real loop renders as a circuit row and the badge counts it at the gate", () => {
  fleet.serverLoopEntities.set(fleet.HUB_URL, [loop]);
  fleet.loopRuns.set("loop_1", [gateRun]);
  loops.openLoops();
  const rows = document.querySelectorAll("#loops-root .lc-row[data-entity='1']");
  expect(rows.length).toBe(1);
  expect(document.querySelector("#loops-root")!.innerHTML).toContain("at your gate");
  expect(document.getElementById("loops-badge")!.textContent).toBe("1");
});

test("the detail shows lap history + hard stops + gate verbs; Open the gate routes loop.gate.open", () => {
  fleet.serverLoopEntities.set(fleet.HUB_URL, [loop]);
  fleet.loopRuns.set("loop_1", [gateRun]);
  loops.openLoops();
  (document.querySelector("#loops-root .lc-row[data-entity='1']") as HTMLElement).click();
  const html = document.querySelector("#loops-root")!.innerHTML;
  expect(html).toContain("Lap 1");
  expect(html).toContain("pinned the retry timer");
  expect(html).toContain("Laps 2 / 5"); // hard-stop bar
  expect(html).toContain("Flake is timing-related"); // assumptions card
  (document.getElementById("lc-open") as HTMLButtonElement).click();
  expect(sent.find((c) => c.type === "loop.gate.open")?.runId).toBe("run_1");
});

test("Send back a lap opens a note dialog and routes loop.gate.sendback", async () => {
  fleet.serverLoopEntities.set(fleet.HUB_URL, [loop]);
  fleet.loopRuns.set("loop_1", [gateRun]);
  loops.openLoops();
  (document.querySelector("#loops-root .lc-row[data-entity='1']") as HTMLElement).click();
  (document.getElementById("lc-sendback") as HTMLButtonElement).click();
  // The promptDialog is now in the DOM — fill it and confirm.
  await new Promise((r) => setTimeout(r, 0));
  const input = document.getElementById("pd-input") as HTMLTextAreaElement;
  expect(input).toBeTruthy();
  input.value = "handle retries too";
  (document.getElementById("pd-ok") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 0));
  const cmd = sent.find((c) => c.type === "loop.gate.sendback");
  expect(cmd?.runId).toBe("run_1");
});

test("live loop.run updates the cache and re-renders the open detail", () => {
  fleet.serverLoopEntities.set(fleet.HUB_URL, [loop]);
  fleet.loopRuns.set("loop_1", [{ ...gateRun, status: "running", laps: [gateRun.laps[0]!] }]);
  loops.openLoops();
  (document.querySelector("#loops-root .lc-row[data-entity='1']") as HTMLElement).click();
  expect(document.querySelector("#loops-root")!.innerHTML).toContain("Laps 1 / 5");
  // A new snapshot with lap 2 lands.
  loops.onLoopRun(gateRun);
  expect(document.querySelector("#loops-root")!.innerHTML).toContain("Laps 2 / 5");
});
