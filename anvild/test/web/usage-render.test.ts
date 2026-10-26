import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Budget } from "../../protocol";
import { installDom, uninstallDom } from "./dom-env";
import { renderUsage } from "../../web/src/usage";

// renderUsage paints the merged gauges. The DOM-free merge/format half is covered in usage.test.ts;
// this exercises the label-visibility rule that needs a real element to inspect.

const NOW = Date.parse("2026-10-25T10:01:00Z");
const g = (label: string, week: number): Budget => ({
  available: true,
  warn: false,
  accountLabel: label,
  updatedAt: "2026-10-25T10:00:00Z", // 1m old → fresh, so no "ago" head sneaks in
  session: { utilization: 10 },
  week: { utilization: week },
});

let el: HTMLElement;
beforeAll(() => {
  installDom();
  el = document.createElement("div");
});
afterAll(() => uninstallDom());

test("single account: no label, just the two bars", () => {
  renderUsage(el, [g("default", 6)], NOW, true);
  expect(el.querySelector(".usage-label")).toBeNull();
  expect(el.querySelector(".usage-head")).toBeNull();
  expect(el.querySelectorAll(".usage-row").length).toBe(2); // 5h + Week
});

test("multiple accounts: each row is labelled", () => {
  renderUsage(el, [g("work", 6), g("personal", 3)], NOW, true);
  expect([...el.querySelectorAll(".usage-label")].map((n) => n.textContent)).toEqual(["work", "personal"]);
});
