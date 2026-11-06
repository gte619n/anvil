// ── cad-ecad.ts — ECAD (PCB) rendering adapters for the CAD viewer (spec §3.3) ─────────────────────
// Two client-side 2D pipelines, both lazy so the heavy libs land in their own chunks:
//   • Gerber  → tracespace v4 (`whats-that-gerber` + `pcb-stackup`/`gerber-to-svg`) → a composited SVG.
//   • KiCad   → the vendored KiCanvas custom elements (`<kicanvas-embed>`), KiCad 6+ only, alpha.
// `renderEcad` is kept thin around the pure `selectGerberLayers` helper, which is the only
// browser-free unit worth testing.

import type { CadIo, CadKind } from "./cad-types";
import { enablePinchPan } from "./cad-gestures";

// ── Pure, testable: which siblings are real Gerber/drill layers ───────────────────────────────────

/**
 * Run whats-that-gerber over a directory listing and return only the filenames it recognises as a
 * Gerber copper/mask/silk/paste/outline layer or an Excellon drill file. Unrecognised files
 * (readme.txt, images, project files, …) come back with `{type: null}` and are dropped.
 *
 * Synchronous + DOM-free on purpose so `cad-ecad.test.ts` can exercise the layer-selection logic
 * without a browser or the SVG stack.
 */
export function selectGerberLayers(siblingNames: string[]): string[] {
  if (siblingNames.length === 0) return [];
  // whats-that-gerber ships as CJS with `export =`; under esModuleInterop the default import is the
  // callable. Static import here (not dynamic) keeps the helper synchronous for the unit test; it's a
  // tiny pure-string module, so bundling it eagerly costs nothing meaningful.
  // (The heavy SVG renderers below stay dynamic.)
  const classified = whatsThatGerber(siblingNames);
  return siblingNames.filter((name) => {
    // whats-that-gerber tags any `.txt` as an Excellon drill, but `.txt` is too ambiguous to auto-pull
    // into a board (a readme is also `.txt`). cad-types.ts deliberately keeps `.txt` OUT of the Gerber
    // set for the same reason — mirror that here so a sibling scan never hijacks plain text files.
    if (name.toLowerCase().endsWith(".txt")) return false;
    return classified[name]?.type != null;
  });
}

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

// ── Gerber pipeline ─────────────────────────────────────────────────────────────────────────────────

async function renderGerber(path: string, host: HTMLElement, io: CadIo): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  const opened = path.slice(dir.length);

  let siblings: string[];
  try {
    siblings = await io.listSiblings(path);
  } catch {
    // If the dir can't be listed, degrade to the single opened file.
    siblings = [opened];
  }
  // Always consider the opened file even if listSiblings omits it.
  if (!siblings.includes(opened)) siblings.push(opened);

  const layerNames = selectGerberLayers(siblings);

  // Nothing recognised at all (not even the opened file) — bail with a note rather than a blank pane.
  if (layerNames.length === 0) {
    host.append(noteCard(`Not a recognised Gerber/Excellon file: ${opened}`));
    return;
  }

  // Single recognised layer → render just that one via gerber-to-svg with the "open the folder" hint.
  if (layerNames.length === 1) {
    await renderSingleGerberLayer(layerNames[0]!, dir, host, io);
    return;
  }

  await renderGerberStackup(layerNames, dir, host, io);
}

/** Full board: feed every recognised layer to pcb-stackup and show the top view with a side toggle.
 *  `dir` is the opened file's directory (with trailing slash, or ""); layer names are bare, so the
 *  fetch re-joins them to resolve worktree-relative paths in subdirectories. */
async function renderGerberStackup(
  layerNames: string[],
  dir: string,
  host: HTMLElement,
  io: CadIo,
): Promise<void> {
  // Vendored tracespace bundle (owner verdict V3) — the abandoned upstream can't disappear from the
  // shipped web path. Dynamic-imported so it stays a lazy chunk.
  const { pcbStackup } = await import("./vendor/tracespace");

  const sources = await Promise.all(
    layerNames.map(async (filename) => ({
      filename,
      gerber: await io.fetchText(dir + filename),
    })),
  );

  // Pin the result to the string-SVG form. The overload otherwise leaves `NodeType` as `unknown`
  // (nothing in the empty options fixes it), so `.top.svg` would be `unknown` under strict mode.
  let stackup: import("pcb-stackup").Stackup<string>;
  try {
    // v4 promise form: pcbStackup(layers, options?) → { top: {svg}, bottom: {svg}, … }.
    stackup = await pcbStackup<string>(sources);
  } catch (err) {
    host.append(errorCard("Could not composite the Gerber board.", String(err)));
    return;
  }

  const views: Record<"top" | "bottom", string> = {
    top: stackup.top.svg,
    bottom: stackup.bottom.svg,
  };

  const toolbar = document.createElement("div");
  toolbar.className = "cad-ecad-toolbar";
  const topBtn = sideButton("Top");
  const bottomBtn = sideButton("Bottom");
  toolbar.append(topBtn, bottomBtn);

  const { setSvg } = makeSvgViewport(host);
  host.prepend(toolbar);

  const show = (side: "top" | "bottom"): void => {
    setSvg(views[side]);
    topBtn.setAttribute("aria-pressed", String(side === "top"));
    bottomBtn.setAttribute("aria-pressed", String(side === "bottom"));
  };
  topBtn.addEventListener("click", () => show("top"));
  bottomBtn.addEventListener("click", () => show("bottom"));
  show("top");
}

/** Single opened layer, no siblings — gerber-to-svg + a hint to open the folder for the full board. */
async function renderSingleGerberLayer(
  filename: string,
  dir: string,
  host: HTMLElement,
  io: CadIo,
): Promise<void> {
  // Vendored tracespace bundle (owner verdict V3), same as the stackup path above.
  const { gerberToSvg } = await import("./vendor/tracespace");

  const gerber = await io.fetchText(dir + filename);
  let svg: string;
  try {
    // gerber-to-svg v4 promise form returns the SVG string when no callback is supplied.
    svg = (await gerberToSvg(gerber, {})) as unknown as string;
  } catch (err) {
    host.append(errorCard(`Could not render ${filename}.`, String(err)));
    return;
  }

  host.append(
    noteCard("Single layer — open the folder for the full board."),
  );
  const { setSvg } = makeSvgViewport(host);
  setSvg(svg);
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
    // io.fileUrl() yields a fleet-routed REST URL KiCanvas can GET. (Inline text is only needed when a
    // URL fetch is unavailable — not the case here.)
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
    // Hint the file type so detection never has to guess from a partial fetch.
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

function noteCard(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "cad-ecad-note";
  el.textContent = text;
  return el;
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

// ── whats-that-gerber import (CJS `export =`) ─────────────────────────────────────────────────────────
// Imported statically so `selectGerberLayers` stays sync for the unit test. esModuleInterop makes the
// default import the callable.
import whatsThatGerber from "whats-that-gerber";
