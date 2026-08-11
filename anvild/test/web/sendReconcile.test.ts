import { test, expect, beforeAll, afterAll } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";
import { reconcileOptimistic, isDaemonHandledCommand } from "../../web/src/sendReconcile";

beforeAll(() => installDom());
afterAll(() => uninstallDom());

function convo(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

// The normal offline→online reconcile: the authoritative echo retires the optimistic bubble (exactly one
// bubble remains once the caller renders the authoritative copy).
test("retires the matching optimistic bubble and reports 'new'", () => {
  const c = convo(`<div class="bubble user queued" data-cid="X"><div class="md">hi</div></div>`);
  expect(reconcileOptimistic(c, "X")).toBe("new");
  expect(c.querySelector(`.bubble.user.queued[data-cid="X"]`)).toBeNull(); // optimistic removed
});

// A second authoritative echo for the same cid (live broadcast + a redundant replay) is a true
// duplicate — the UI must drop it so exactly-once holds visually.
test("detects a duplicate authoritative echo for the same cid", () => {
  const c = convo(`<div class="bubble user" data-cid="X"><div class="md">hi</div></div>`);
  expect(reconcileOptimistic(c, "X")).toBe("duplicate");
});

test("an unrelated cid is 'new' and leaves other bubbles untouched", () => {
  const c = convo(`<div class="bubble user queued" data-cid="A"></div>`);
  expect(reconcileOptimistic(c, "B")).toBe("new");
  expect(c.querySelector(`.bubble.user.queued[data-cid="A"]`)).not.toBeNull(); // A untouched
});

// Regression for adversarial-review Finding 3: these commands emit no message.user, so an offline
// optimistic bubble for them would never be retired — the caller must skip it.
test("isDaemonHandledCommand flags /clear, /compact, /goal (and their arg forms), not ordinary prompts", () => {
  for (const t of ["/clear", "/compact", "/compact keep tests", "/goal", "/goal ship it", "  /goal x  "]) {
    expect(isDaemonHandledCommand(t)).toBe(true);
  }
  for (const t of ["hello", "/clearx", "/goalpost", "tell me about /clear", "/help"]) {
    expect(isDaemonHandledCommand(t)).toBe(false);
  }
});
