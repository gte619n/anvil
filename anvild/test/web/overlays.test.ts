/**
 * [Phase 4] First real DOM-dependent web test — proves the jsdom harness works and pins the overlay
 * back-stack (open/dismiss/dismissTop + hash parsing + history depth), the logic behind
 * device/browser Back dismissing the top UI layer. Previously untested.
 */
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";

let overlaysMod: typeof import("../../web/src/overlays");
let ui: typeof import("../../web/src/state").ui;

beforeAll(async () => {
  installDom({ url: "https://appassets.androidplatform.net/app/" });
  overlaysMod = await import("../../web/src/overlays");
  ui = (await import("../../web/src/state")).ui;
});
afterAll(() => uninstallDom());

beforeEach(() => {
  overlaysMod.overlays.length = 0; // reset the shared back-stack
  ui.suppressPop = 0;
  history.replaceState(null, "", "https://appassets.androidplatform.net/app/");
});

test("sessionFromHash / planFromHash parse deep-link hashes", () => {
  history.replaceState(null, "", "#s/sess_abc");
  expect(overlaysMod.sessionFromHash()).toBe("sess_abc");
  expect(overlaysMod.planFromHash()).toBeNull();
  history.replaceState(null, "", "#p/unit_1");
  expect(overlaysMod.planFromHash()).toBe("unit_1");
  history.replaceState(null, "", "#s/a%2Fb"); // url-encoded
  expect(overlaysMod.sessionFromHash()).toBe("a/b");
});

test("openOverlay stacks a layer once (dedup) and tracks it", () => {
  const { openOverlay, overlayOpen, overlays } = overlaysMod;
  openOverlay("settings", () => {}, "#settings");
  openOverlay("settings", () => {}, "#settings"); // already open → no-op
  expect(overlays.map((o) => o.name)).toEqual(["settings"]);
  expect(overlayOpen("settings")).toBe(true);
  expect(overlayOpen("modal")).toBe(false);
});

test("dismissOverlay closes the named layer AND everything stacked above it, top-down", () => {
  const { openOverlay, dismissOverlay, overlays } = overlaysMod;
  const closed: string[] = [];
  openOverlay("settings", () => closed.push("settings"), "#settings");
  openOverlay("modal", () => closed.push("modal")); // stacked above settings
  openOverlay("reader", () => closed.push("reader"));

  dismissOverlay("settings"); // drops settings + modal + reader
  expect(closed).toEqual(["reader", "modal", "settings"]); // unwound top-down
  expect(overlays.length).toBe(0);
  expect(ui.suppressPop).toBe(1); // one history.go(-n) to swallow
});

test("dismissOverlay on a layer that isn't open is a harmless no-op", () => {
  const { dismissOverlay, overlays } = overlaysMod;
  dismissOverlay("panel");
  expect(overlays.length).toBe(0);
  expect(ui.suppressPop).toBe(0);
});

test("dismissTopOverlay closes only the topmost layer and reports whether it did anything", () => {
  const { openOverlay, dismissTopOverlay, overlays } = overlaysMod;
  const closed: string[] = [];
  openOverlay("settings", () => closed.push("settings"), "#settings");
  openOverlay("modal", () => closed.push("modal"));

  expect(dismissTopOverlay()).toBe(true);
  expect(closed).toEqual(["modal"]);
  expect(overlays.map((o) => o.name)).toEqual(["settings"]);

  overlays.length = 0;
  expect(dismissTopOverlay()).toBe(false); // nothing open
});

test("setSessionHash pushes or replaces the session URL", () => {
  const { setSessionHash, sessionFromHash } = overlaysMod;
  setSessionHash("sess_1", true);
  expect(sessionFromHash()).toBe("sess_1");
  setSessionHash(null, false); // clear
  expect(sessionFromHash()).toBeNull();
});
