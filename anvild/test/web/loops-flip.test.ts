/**
 * Phase 4 migration flip (loops-circuit spec §5): the sidebar shows only Loops (the Autopilot entry is
 * retired), and #autopilot deep-links redirect to #loops. This pins the static markup + the router intent.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync(join(import.meta.dir, "..", "..", "web", "index.html"), "utf8");
const main = readFileSync(join(import.meta.dir, "..", "..", "web", "src", "main.ts"), "utf8");

test("the sidebar has a Loops entry and no standalone Autopilot entry", () => {
  expect(html).toContain('id="open-loops"');
  expect(html).not.toContain('id="open-autopilot"'); // retired at the flip
});

test("#autopilot deep links redirect to the Loops home (both cold-load and warm hashchange)", () => {
  // Warm hashchange: the autopilotFromHash branch now opens the Loops home, not the grid.
  expect(main).toMatch(/if \(autopilotFromHash\(\)\) \{\s*\/\/[^\n]*\n\s*openLoopsDeepLink\(\)/);
  // Cold load: deepLinkedAutopilot → openLoopsDeepLink.
  expect(main).toMatch(/deepLinkedAutopilot\).*openLoopsDeepLink/);
});

test("the service worker carries a loop deep-link hash on the notification and follows it on click", () => {
  const sw = readFileSync(join(import.meta.dir, "..", "..", "web", "sw.js"), "utf8");
  // The push handler must put `hash` on the notification data (else the click can't deep-link).
  expect(sw).toMatch(/data:\s*\{\s*sessionId:[^}]*hash:\s*data\.hash/);
  // The click handler follows the hash into #loops/<id>.
  expect(sw).toContain("data.hash");
  expect(sw).toMatch(/openWindow\(hash \?/);
});
