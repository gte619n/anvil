/**
 * [P6] Completion-verification web UI (spec Phase 6) — DOM harness over the PURE render + command-map
 * functions extracted from the plan reader. Asserts the "Likely complete" badge + evidence + Confirm/Dismiss,
 * the mismatch warning + Acknowledge/Keep-as-work, the partial advisory, and that each action button
 * dispatches the correct command WITH the unit id (asserted separately from any DOM removal — R2).
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";
import type { AutopilotPlanInfo, AutopilotVerificationInfo } from "../../protocol";

let ap: typeof import("../../web/src/autopilot");

beforeAll(async () => {
  installDom();
  ap = await import("../../web/src/autopilot");
});
afterAll(() => uninstallDom());

const md = (html: string) => ({ source: html, html });
const plan = (verification?: Partial<AutopilotVerificationInfo>): AutopilotPlanInfo =>
  ({
    id: "wu1",
    environmentId: "e1",
    todoistProjectId: "p1",
    title: "Add the thing",
    status: "planned",
    taskCount: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...(verification
      ? { verification: { verdict: "done", evidence: md("<p>src/a.ts:1</p>"), baseRef: "origin/main", baseSha: "sha1", at: "2026-01-01T00:00:00Z", ...verification } as AutopilotVerificationInfo }
      : {}),
  }) as AutopilotPlanInfo;

function render(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

test("[P6] a done-overlay renders the Likely-complete badge + evidence + Confirm/Dismiss", () => {
  const el = render(ap.verifyOverlayHtml(plan({ verdict: "done" })));
  expect(el.querySelector(".verify-likely")).not.toBeNull();
  expect(el.textContent).toContain("Likely complete");
  expect(el.querySelector(".verify-evidence")?.innerHTML).toContain("src/a.ts:1");
  const confirm = el.querySelector<HTMLElement>('[data-verify-act="confirm"]');
  const dismiss = el.querySelector<HTMLElement>('[data-verify-act="dismiss"]');
  expect(confirm).not.toBeNull();
  expect(dismiss).not.toBeNull();
  // The button carries the unit id the handler will dispatch with.
  expect(confirm!.dataset.id).toBe("wu1");
});

test("[P6] Confirm/Dismiss dispatch the right command with the unit id (payload, not DOM)", () => {
  expect(ap.verifyCommand("confirm", "wu1")).toEqual({ type: "autopilot.verify.confirm", workUnitId: "wu1" });
  expect(ap.verifyCommand("dismiss", "wu1")).toEqual({ type: "autopilot.verify.dismiss", workUnitId: "wu1" });
});

test("[P6] a mismatch renders the warning + Acknowledge + Keep-as-work, dispatching ack/keep", () => {
  const el = render(ap.verifyOverlayHtml(plan({ verdict: "not-done", mismatch: true })));
  expect(el.querySelector(".verify-mismatch")).not.toBeNull();
  expect(el.querySelector<HTMLElement>('[data-verify-act="ack"]')).not.toBeNull();
  expect(el.querySelector<HTMLElement>('[data-verify-act="keep"]')).not.toBeNull();
  expect(ap.verifyCommand("ack", "wu1")).toEqual({ type: "autopilot.verify.ack", workUnitId: "wu1" });
  expect(ap.verifyCommand("keep", "wu1")).toEqual({ type: "autopilot.verify.keep", workUnitId: "wu1" });
});

test("[P6] a partial verdict renders the 'N/M appear done' advisory (no action buttons)", () => {
  const el = render(
    ap.verifyOverlayHtml(
      plan({
        verdict: "partial",
        perTask: [
          { taskId: "t1", verdict: "done", cited: true },
          { taskId: "t2", verdict: "not-done", cited: false },
          { taskId: "t3", verdict: "not-done", cited: false },
        ],
      }),
    ),
  );
  expect(el.querySelector(".verify-partial")).not.toBeNull();
  expect(el.textContent).toContain("1/3");
  expect(el.querySelector("[data-verify-act]")).toBeNull();
});

test("[P6] a dismissed done-overlay and a unit with no verification render nothing (re-render stays gone)", () => {
  expect(ap.verifyOverlayHtml(plan({ verdict: "done", dismissedAt: "2026-01-02T00:00:00Z" }))).toBe("");
  expect(ap.verifyOverlayHtml(plan())).toBe("");
  // a not-done verdict with no mismatch is also silent
  expect(ap.verifyOverlayHtml(plan({ verdict: "not-done" }))).toBe("");
});

test("[P6] verifyCommand returns undefined for an unknown action", () => {
  expect(ap.verifyCommand("bogus", "wu1")).toBeUndefined();
});
