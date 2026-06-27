// ── URL routing + back-stack: device/browser Back dismisses the top UI layer ──────────────
// The active session lives in the URL hash (#s/<id>) so Back/Forward works and a session is
// deep-linkable. Modals/dialogs, the settings view, the side panel and the (mobile) expanded
// sidebar are all "soft" layers: each pushes a history entry when it opens, so Back has somewhere
// to go instead of exiting the app. A `popstate` (Android device button via web.goBack(), macOS
// swipe, browser/PWA Back) closes the topmost layer; each entry records how many layers were open
// (`anvilDepth`) so a single popstate can unwind to exactly the right place.
//
// This module owns only the back-stack itself (history/location + the `overlays` array). The
// popstate handler and session-navigation wiring stay in main.ts because they touch app state; the
// one scalar they share with dismissOverlay (`suppressPop`) lives on the shared `ui` object.
import { ui } from "./state";

// A session in the URL means we were opened via a deep link / notification tap.
export const sessionFromHash = (): string | null => {
  const m = location.hash.match(/^#s\/(.+)$/);
  return m ? decodeURIComponent(m[1]!) : null;
};
// A plan deep link (#p/<workUnitId>) opens the Autopilot view straight to that plan's reader — the
// URL the autopilot posts in its Todoist comment. Used on cold load and on warm hashchange.
export const planFromHash = (): string | null => {
  const m = location.hash.match(/^#p\/(.+)$/);
  return m ? decodeURIComponent(m[1]!) : null;
};

type OverlayName = "modal" | "settings" | "autopilot" | "plan" | "sidebar" | "panel" | "reader";
interface Overlay {
  name: OverlayName;
  close: () => void; // pure DOM/state teardown — must NOT touch history itself
}
export const overlays: Overlay[] = [];
export const overlayOpen = (name: OverlayName): boolean => overlays.some((o) => o.name === name);
export function openOverlay(name: OverlayName, close: () => void, hash?: string): void {
  if (overlayOpen(name)) return; // already open (e.g. swapping a modal's contents in place)
  overlays.push({ name, close });
  // `hash` (e.g. "#autopilot") gives the overlay its own URL so it's a real history entry — Back
  // reverts the URL and pops the layer. Omit it to keep the current URL (the session hash).
  const url = hash ? `${location.pathname}${hash}` : undefined;
  history.pushState({ anvilDepth: overlays.length }, "", url);
}
/** Programmatically dismiss `name` and anything stacked above it (Cancel / X / backdrop). Tears
 *  down synchronously, then unwinds our own history entries (the resulting popstate is swallowed
 *  by the guard). Closing layers via the device/browser Back goes through popstate directly. */
export function dismissOverlay(name: OverlayName): void {
  const idx = overlays.map((o) => o.name).lastIndexOf(name);
  if (idx < 0) return; // already gone — keeps redundant/double closes harmless
  const n = overlays.length - idx;
  for (let i = 0; i < n; i++) overlays.pop()!.close();
  ui.suppressPop++;
  history.go(-n); // drop our history entries; the one popstate this fires is suppressed below
}
/** Dismiss just the topmost soft layer (used by the Escape key) — same teardown as a single Back. */
export function dismissTopOverlay(): boolean {
  const top = overlays[overlays.length - 1];
  if (!top) return false;
  dismissOverlay(top.name);
  return true;
}

export const sessionHref = (id: string): string => `${location.pathname}#s/${encodeURIComponent(id)}`;
export function setSessionHash(id: string | null, push: boolean): void {
  const url = id ? sessionHref(id) : location.pathname;
  const state = { anvilDepth: overlays.length };
  if (push) history.pushState(state, "", url);
  else history.replaceState(state, "", url);
}
