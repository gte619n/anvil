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
      if (cmd.type === "loop.intake") return { type: "loop.intake.result", suggestion } as never;
      if (cmd.type === "loop.save") return { type: "loop.updated", loop: { id: "loop_new", ...(cmd as unknown as { loop: LoopInput }).loop } } as never;
      if (cmd.type === "loop.arm") return (failArm ? { type: "command.error", message: "this loop is disabled" } : { type: "ack" }) as never;
      if (cmd.type === "loop.dryrun") return { type: "loop.run", run: { id: "run_dry", dryRun: true } } as never;
      return { type: "ack" } as never;
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
