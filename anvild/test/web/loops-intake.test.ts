/**
 * Phase 3 acceptance (loops-circuit spec §5): typing an outcome yields a ≤5-question conversation that
 * ends in an armed loop whose check / scope / stops / rung / ≥1 logged assumption match the answers, and
 * the first lap is a dry-run (loop.dryrun) leaving no branch/PR. Driven over jsdom with a fake server
 * that answers loop.intake / loop.save / loop.arm / loop.dryrun.
 */
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";
import type { LoopInput, LoopIntakeSuggestion } from "../../protocol";

let intake: typeof import("../../web/src/loops-intake");
let fleet: typeof import("../../web/src/fleet");
const sent: { type: string; loop?: LoopInput; loopId?: string }[] = [];
let armedId: string | null = null;
let failArm = false;
// When set, loop.intake blocks until releaseIntake() is called — simulates the live model call that
// makes the real daemon's suggestion take seconds (the reason the shell must paint before it resolves).
let hangIntake = false;
let releaseIntake: (() => void) | null = null;
// The streamed-progress subscriber openIntake registers for the current run (mirrors main.ts's cid map).
let progressListener: ((line: string) => void) | null = null;

const suggestion: LoopIntakeSuggestion = {
  isFeature: false,
  name: "Fix the flaky upload test",
  checkCommand: "bun test upload",
  checkLocks: [],
  scopeAllow: ["src/upload/"],
  maxLaps: 10,
  tokenBudget: 300_000,
  rung: "pr",
  assumptions: ["The failure is timing-related, not environment-specific"],
};

beforeAll(async () => {
  installDom({ html: `<!doctype html><html><body><div id="lc-root"></div><div id="toast"></div></body></html>` });
  fleet = await import("../../web/src/fleet");
  intake = await import("../../web/src/loops-intake");
  const sock = { isOpen: () => true, send: () => {} };
  fleet.servers.set(fleet.HUB_URL, { url: fleet.HUB_URL, id: "hub", name: "hub", sock: sock as never, status: "connected", capabilities: ["loops"] });
  const envs = new Map([["env_1", { id: "env_1", name: "anvil-web" } as never]]);
  intake.initIntake({
    environments: envs,
    sendAwait: async (_s, cmd) => {
      sent.push(cmd as never);
      if (cmd.type === "loop.intake") {
        if (hangIntake) await new Promise<void>((r) => (releaseIntake = r));
        return { type: "loop.intake.result", suggestion } as never;
      }
      if (cmd.type === "loop.save") return { type: "loop.updated", loop: { id: "loop_new", ...(cmd as unknown as { loop: LoopInput }).loop } } as never;
      if (cmd.type === "loop.arm") return (failArm ? { type: "command.error", message: "this loop is disabled" } : { type: "ack" }) as never;
      if (cmd.type === "loop.dryrun") return { type: "loop.run", run: { id: "run_dry", dryRun: true } } as never;
      return { type: "ack" } as never;
    },
    subscribeIntakeProgress: (_cid, onLine) => {
      progressListener = onLine;
      return () => { progressListener = null; };
    },
    rootId: "lc-root",
    onArmed: (id) => (armedId = id),
    onCancel: () => {},
  });
});
afterAll(() => {
  fleet.servers.delete(fleet.HUB_URL);
  uninstallDom();
});
beforeEach(() => {
  sent.length = 0;
  armedId = null;
  failArm = false;
  hangIntake = false;
  releaseIntake = null;
  progressListener = null;
});

/** Click the first suggested-answer chip; returns after the DOM settles. */
async function clickFirstChip(): Promise<void> {
  const chip = document.querySelector<HTMLButtonElement>("#lc-chat .lc-chips button");
  chip?.click();
  await new Promise((r) => setTimeout(r, 0));
}

test("an outcome yields a ≤5-question conversation ending in an armed loop that dry-runs first", async () => {
  await intake.openIntake("Fix the flaky upload test");
  // The circuit + first question render.
  expect(document.getElementById("lc-live-circuit")).toBeTruthy();
  expect(sent.some((c) => c.type === "loop.intake")).toBe(true);
  // Walk the conversation: check → scope/stops → gate → assumptions → arm. Count the questions.
  let questions = 0;
  for (let i = 0; i < 6; i++) {
    const hasChips = document.querySelector("#lc-chat .lc-chips button");
    if (!hasChips) break;
    questions++;
    await clickFirstChip();
    if (sent.some((c) => c.type === "loop.save")) break; // the final "Arm it" fired
  }
  expect(questions).toBeLessThanOrEqual(5);

  // The armed loop's input matches the answers.
  const saveCmd = sent.find((c) => c.type === "loop.save");
  expect(saveCmd).toBeTruthy();
  const input = saveCmd!.loop!;
  expect((input.checks[0] as { command: string }).command).toBe("bun test upload");
  expect(input.scope?.allow).toEqual(["src/upload/"]);
  expect(input.hardStops?.maxLaps).toBe(10);
  expect(input.rung).toBe("pr");
  expect(input.assumptions?.length).toBeGreaterThanOrEqual(1);

  // Armed + dry-run first lap (no branch/PR).
  expect(sent.some((c) => c.type === "loop.arm")).toBe(true);
  expect(sent.some((c) => c.type === "loop.dryrun")).toBe(true);
  expect(armedId).toBe("loop_new");
});

test("if arm fails, the dry-run is NOT fired (no false 'armed' side effects)", async () => {
  failArm = true;
  await intake.openIntake("Fix the flaky upload test");
  for (let i = 0; i < 6; i++) {
    if (!document.querySelector("#lc-chat .lc-chips button")) break;
    await clickFirstChip();
    if (sent.some((c) => c.type === "loop.arm")) break;
  }
  await new Promise((r) => setTimeout(r, 0));
  expect(sent.some((c) => c.type === "loop.arm")).toBe(true);
  expect(sent.some((c) => c.type === "loop.dryrun")).toBe(false); // arm failed → no dry-run
});

test("the intake shell paints immediately — before the (slow) repo suggestion resolves", async () => {
  hangIntake = true;
  const done = intake.openIntake("Fix the flaky upload test"); // do NOT await — the suggestion is blocked
  await Promise.resolve(); // flush the synchronous prefix / microtasks
  // The circuit + a live "studying your codebase" panel are on screen even though loop.intake hasn't returned.
  expect(document.getElementById("lc-live-circuit")).toBeTruthy();
  expect(document.querySelector("#lc-chat .activity.live")).toBeTruthy();
  expect(sent.some((c) => c.type === "loop.intake")).toBe(true);
  // The conversation itself waits for the suggestion — no question chips yet.
  expect(document.querySelector("#lc-chat .lc-chips button")).toBeFalsy();
  // Once the suggestion lands, the first question renders.
  releaseIntake?.();
  await done;
  expect(document.querySelector("#lc-chat .lc-chips button")).toBeTruthy();
});

test("streamed repo-analysis steps render live before the suggestion resolves, then the flow runs", async () => {
  hangIntake = true;
  const done = intake.openIntake("Fix the flaky upload test"); // suggestion blocked (simulating the repo read)
  await Promise.resolve();
  // The daemon streams analysis lines while we wait — they land in the live activity panel.
  progressListener?.("Reading CLAUDE.md");
  progressListener?.("Searching for “upload”");
  const steps = document.querySelectorAll("#lc-chat .activity .lc-step");
  expect(steps.length).toBe(2);
  expect(steps[0]?.textContent).toBe("Reading CLAUDE.md");
  // No questions yet — the conversation still waits for the terminal result.
  expect(document.querySelector("#lc-chat .lc-chips button")).toBeFalsy();
  // Release: the panel settles and the 5-step flow begins.
  releaseIntake?.();
  await done;
  expect(document.querySelector("#lc-chat .activity.live")).toBeFalsy(); // finalized (no longer "live")
  expect(document.querySelector("#lc-chat .lc-chips button")).toBeTruthy();
});

test("a Todoist draft converts through the same flow, linking the work unit", async () => {
  await intake.openIntake("(from Todoist) Add retry logic to the S3 uploader", { workUnitId: "wu99" });
  for (let i = 0; i < 6; i++) {
    if (!document.querySelector("#lc-chat .lc-chips button")) break;
    await clickFirstChip();
    if (sent.some((c) => c.type === "loop.save")) break;
  }
  const saveCmd = sent.find((c) => c.type === "loop.save");
  expect(saveCmd!.loop!.workUnitId).toBe("wu99"); // links the draft
});
