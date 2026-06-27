// ── Shared mutable UI state ───────────────────────────────────────────────────
// ES modules can't reassign an imported binding (`import { x }` is read-only), so scalars that are
// *reassigned* and read across more than one module live as fields on this single `ui` object. Code
// writes `ui.foo = …` / reads `ui.foo`. In-place containers (Maps/Sets/arrays) don't have this
// problem — they're mutated, never reassigned — so they're exported as plain `const`s from the
// module that owns them, not parked here.
//
// This module imports nothing from the rest of the app: it's the leaf that other modules funnel
// shared state through, which keeps import cycles from forming (see the load-order notes in main.ts).
export const ui = {
  // popstates from our own dismissOverlay() unwind — the teardown already ran, so the matching
  // popstate is swallowed. Written by overlays.dismissOverlay, read/decremented by the popstate
  // handler in main.ts.
  suppressPop: 0,
  // Whether the session sidebar is collapsed. Owned by layout.ts, but the conversation core also
  // sets it (selecting a session collapses the sidebar on a phone). Seeded at boot in main.ts.
  sidebarCollapsed: false,
};
