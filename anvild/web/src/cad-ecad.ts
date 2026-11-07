// ── cad-ecad.ts — ECAD (PCB) rendering adapters for the CAD viewer (spec §3.3) ─────────────────────
// Two 2D pipelines:
//   • Gerber → the daemon composites the board SVG (pcb-stackup is built on Node streams and can't run
//     in a browser bundle; see src/cad/gerber.ts) and the client just displays it, with pinch/pan.
//   • KiCad  → the vendored KiCanvas custom elements (`<kicanvas-embed>`), KiCad 6+ only, alpha.

import type { CadIo, CadKind } from "./cad-types";
import { enablePinchPan } from "./cad-gestures";

// ── Entry point cad.ts calls ───────────────────────────────────────────────────────────────────────

export async function renderEcad(
  path: string,
  kind: CadKind,
  host: HTMLElement,
  io: CadIo,
): Promise<void> {
  // Tear down any previous adapter mounted on this host (SVG pinch/pan listeners, etc.).
  disposeHost(host);
  host.replaceChildren();

  if (kind === "gerber") {
    await renderGerber(path, host, io);
  } else {
    await renderKicad(path, kind, host, io);
  }
}

/** Dispose whatever the last `renderEcad` attached (gesture listeners). Safe to call repeatedly. */
function disposeHost(host: HTMLElement): void {
  const prev = (host as unknown as { __cadCleanup?: () => void }).__cadCleanup;
  if (typeof prev === "function") {
    try {
      prev();
    } catch {
      // A failed teardown must not block re-rendering.
    }
  }
  (host as unknown as { __cadCleanup?: () => void }).__cadCleanup = undefined;
}

// ── Gerber pipeline (daemon-rendered SVG) ────────────────────────────────────────────────────────────

/**
 * Display the composited board. The daemon scans the opened file's directory, runs pcb-stackup, and
 * returns the top/bottom SVG; the client fetches the requested side and shows it with a top/bottom
 * toggle. Both sides are cached after first fetch.
 */
async function renderGerber(path: string, host: HTMLElement, io: CadIo): Promise<void> {
  const toolbar = document.createElement("div");
  toolbar.className = "cad-ecad-toolbar";
  const topBtn = sideButton("Top");
  const bottomBtn = sideButton("Bottom");
  toolbar.append(topBtn, bottomBtn);
  host.append(toolbar);

  const { setSvg } = makeSvgViewport(host);
  const cache: Partial<Record<"top" | "bottom", string>> = {};

  const show = async (side: "top" | "bottom"): Promise<void> => {
    try {
      if (cache[side] === undefined) {
        const res = await fetch(io.gerberUrl(path, side));
        if (!res.ok) {
          host.append(errorCard("Could not render the Gerber board.", await res.text(), io.fileUrl(path)));
          return;
        }
        cache[side] = await res.text();
      }
      setSvg(cache[side]!);
      topBtn.setAttribute("aria-pressed", String(side === "top"));
      bottomBtn.setAttribute("aria-pressed", String(side === "bottom"));
    } catch (err) {
      host.append(errorCard("Could not render the Gerber board.", String(err), io.fileUrl(path)));
    }
  };

  topBtn.addEventListener("click", () => void show("top"));
  bottomBtn.addEventListener("click", () => void show("bottom"));
  await show("top");
}

// ── KiCad pipeline (vendored KiCanvas) ───────────────────────────────────────────────────────────────

async function renderKicad(
  path: string,
  kind: CadKind,
  host: HTMLElement,
  io: CadIo,
): Promise<void> {
  try {
    // Importing the vendored bundle self-registers <kicanvas-embed>/<kicanvas-source> (KiCad 6+ only,
    // self-described alpha). Dynamic so the ~MB module stays in its own lazy chunk. The vendored JS
    // has no type declarations and is imported purely for its side effect, so silence implicit-any.
    // @ts-expect-error — untyped vendored module, imported for custom-element registration only.
    await import("./vendor/kicanvas.js");

    // Feed approach: `src` (NOT inline). KiCanvas's <kicanvas-source> fetches the URL itself and keeps
    // the real filename, so its file-type detection sees the .kicad_pcb/.kicad_sch extension for free.
    //
    // Limitation (v1, per spec): hierarchical multi-sheet .kicad_sch designs reference sibling sheets
    // by relative path; those won't resolve through the single `?path=`-style REST URL. The root sheet
    // renders; sub-sheets may be blank. Accepted for v1.
    const embed = document.createElement("kicanvas-embed");
    embed.setAttribute("controls", "full");
    embed.style.width = "100%";
    embed.style.height = "100%";

    const source = document.createElement("kicanvas-source");
    source.setAttribute("src", io.fileUrl(path));
    source.setAttribute("type", kind === "kicad-pcb" ? "board" : "schematic");
    embed.append(source);

    host.append(embed);
  } catch (err) {
    host.append(
      errorCard(
        "Couldn't load the KiCad viewer (KiCanvas is alpha and KiCad 6+ only).",
        String(err),
        io.fileUrl(path),
      ),
    );
  }
}

// ── Small DOM helpers ───────────────────────────────────────────────────────────────────────────────

/**
 * Mount an overflow-clipped viewport into `host`, give it pinch/pan, and return a `setSvg` that swaps
 * the inner SVG markup. The gesture cleanup is stored on `host.__cadCleanup` so `renderEcad`/the caller
 * can dispose it. The pan/zoom transform lives on an inner layer so swapping SVGs keeps the gesture.
 */
function makeSvgViewport(host: HTMLElement): {
  viewport: HTMLElement;
  setSvg: (svg: string) => void;
} {
  const viewport = document.createElement("div");
  viewport.className = "cad-ecad-viewport";
  viewport.style.position = "relative";
  viewport.style.overflow = "hidden";
  viewport.style.width = "100%";
  viewport.style.height = "100%";

  const layer = document.createElement("div");
  layer.className = "cad-ecad-layer";
  layer.style.transformOrigin = "0 0";
  viewport.append(layer);
  host.append(viewport);

  const cleanup = enablePinchPan(layer);
  (host as unknown as { __cadCleanup?: () => void }).__cadCleanup = cleanup;

  const setSvg = (svg: string): void => {
    layer.innerHTML = svg;
  };
  return { viewport, setSvg };
}

function sideButton(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cad-ecad-side-btn";
  b.textContent = label;
  b.setAttribute("aria-pressed", "false");
  return b;
}

function errorCard(message: string, detail?: string, rawUrl?: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "cad-ecad-error";

  const msg = document.createElement("p");
  msg.className = "cad-ecad-error-msg";
  msg.textContent = message;
  card.append(msg);

  if (detail) {
    const pre = document.createElement("pre");
    pre.className = "cad-ecad-error-detail";
    pre.textContent = detail;
    card.append(pre);
  }

  if (rawUrl) {
    const link = document.createElement("a");
    link.href = rawUrl;
    link.textContent = "Download the raw file";
    link.setAttribute("download", "");
    card.append(link);
  }
  return card;
}
