// ── Layout: sidebar collapse + resizable panes ────────────────────────────────
// The collapsed sidebar and the two draggable pane resizers (left sidebar, right side panel). The
// collapsed flag is shared with the conversation core (selecting a session collapses the sidebar on
// a phone), so it lives on the `ui` state object; everything else here is self-contained DOM wiring.
// Depends only on already-extracted leaf modules (dom, overlays) plus `ui` — no cycle with main.ts.
import { $, clampN } from "./dom";
import { dismissOverlay, openOverlay, overlayOpen } from "./overlays";
import { ui } from "./state";

// 700px keeps the phone-only layout off the iPad Mini (744px) and the unfolded Galaxy Z Fold
// (~755px) while still catching every real phone. Must stay in sync with the @media query in app.css.
export const isNarrow = (): boolean => matchMedia("(max-width: 700px)").matches;

export function applySidebar(): void {
  $("#sidebar").classList.toggle("collapsed", ui.sidebarCollapsed);
}
export function toggleSidebar(): void {
  ui.sidebarCollapsed = !ui.sidebarCollapsed;
  localStorage.setItem("anvil.sidebar", ui.sidebarCollapsed ? "collapsed" : "open");
  applySidebar();
  // On a phone the open sidebar overlays the conversation — make Back close it.
  if (isNarrow()) {
    if (!ui.sidebarCollapsed) openOverlay("sidebar", () => { ui.sidebarCollapsed = true; applySidebar(); });
    else dismissOverlay("sidebar");
  }
}

// ── Resizable panes (left sidebar + right side panel) ────────────────────────────
// Each pane's width is a CSS variable on :root, persisted per device. A thin handle straddling the
// pane's border drives it via pointer events (touch-safe, capture so the drag survives leaving the
// strip). Disabled on narrow screens, where the sidebar overlays and the panel is near full-bleed.
export function initResizers(): void {
  const root = document.documentElement;
  const stored = (k: string): number => Number(localStorage.getItem(k)) || 0;
  const sw = stored("anvil.sidebarW");
  if (sw) root.style.setProperty("--sidebar-w", `${sw}px`);
  const pw = stored("anvil.panelW");
  if (pw) root.style.setProperty("--panel-w", `${pw}px`);

  const wire = (
    handle: HTMLElement | null,
    cfg: { cssVar: string; key: string; min: number; maxFn: () => number; width: (clientX: number) => number },
  ): void => {
    if (!handle) return;
    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      if (isNarrow()) return; // resizing is desktop-only
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("dragging");
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      let latest = 0;
      const move = (ev: PointerEvent): void => {
        latest = clampN(cfg.width(ev.clientX), cfg.min, cfg.maxFn());
        root.style.setProperty(cfg.cssVar, `${latest}px`);
      };
      const up = (): void => {
        handle.releasePointerCapture(e.pointerId);
        handle.classList.remove("dragging");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        if (latest) localStorage.setItem(cfg.key, String(Math.round(latest)));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  };

  const sidebar = document.getElementById("sidebar");
  wire(document.getElementById("sidebar-resizer"), {
    cssVar: "--sidebar-w",
    key: "anvil.sidebarW",
    min: 200,
    maxFn: () => Math.min(620, window.innerWidth - 360), // always leave the conversation room
    width: (x) => x - (sidebar?.getBoundingClientRect().left ?? 0), // pointer X minus the sidebar's left edge
  });
  const sidePanel = document.getElementById("side-panel");
  wire(document.getElementById("panel-resizer"), {
    cssVar: "--panel-w",
    key: "anvil.panelW",
    min: 320,
    maxFn: () => Math.min(window.innerWidth * 0.92, 1000),
    width: (x) => (sidePanel?.getBoundingClientRect().right ?? window.innerWidth) - x, // panel is pinned right, grows leftward
  });
}

// On a phone there isn't room for both panes, so when focus moves to the chat (a tap or the
// composer gaining focus) we collapse the overlaid session list — never a half-covered chat.
export function collapseSidebarForChat(): void {
  if (!isNarrow() || ui.sidebarCollapsed) return;
  if (overlayOpen("sidebar")) dismissOverlay("sidebar"); // also unwinds the Back-stack entry
  else { ui.sidebarCollapsed = true; applySidebar(); } // open without an overlay entry (e.g. after a resize)
}
