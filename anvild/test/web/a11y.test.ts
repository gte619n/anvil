/**
 * [Phase 4 / WEB-4] Accessibility regressions guard on the shipped markup. Transient feedback
 * (toasts, the offline/sync banner — including error states like "upload failed" / "queued change
 * failed") must be announced to assistive tech via an aria-live region; previously they were silent.
 * Loads the real index.html into jsdom and asserts the live regions exist.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const doc = new JSDOM(readFileSync(join(import.meta.dir, "..", "..", "web", "index.html"), "utf8")).window.document;

test("transient-feedback regions are announced (role=status + aria-live=polite)", () => {
  for (const id of ["toast", "offline-banner"]) {
    const el = doc.getElementById(id);
    expect(el).not.toBeNull();
    expect(el!.getAttribute("role")).toBe("status");
    expect(el!.getAttribute("aria-live")).toBe("polite");
  }
});
