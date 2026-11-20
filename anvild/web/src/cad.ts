// ── cad.ts — the CAD viewer host (web client) ───────────────────────────────────────────────────
// Builds a full-screen modal with a WebGL canvas + HUD + toolbar, classifies the file, and either
// renders 3D here (mesh / brep) or delegates 2D ECAD rendering to ./cad-ecad. three.js is loaded via
// DYNAMIC import() INSIDE functions so the bundler keeps it in a lazy chunk out of the entry bundle.
//
// Spec refs: D20 (units + up-axis normalization), D22 (device ceiling guard), D27 (composited
// snapshot). See docs/plans/2026-11-06-cad-viewer.md.
import { esc, icon } from "./dom";
import { showModal, closeModal } from "./dialogs";
import { isAndroidApp } from "./platform";
import type { CadIo, CadKind, LodBudget } from "./cad-types";
import { classifyCad, extOf, PHONE_LOD, DESKTOP_LOD } from "./cad-types";

// Re-export for panel.ts convenience (it classifies before deciding whether to open the viewer).
export { classifyCad } from "./cad-types";

// `three` and its example modules are only ever referenced through dynamic import(), so we pull in
// TYPE-ONLY symbols here (erased at compile time, no runtime bundle cost). `verbatimModuleSyntax`
// requires the `import type` form.
import type {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  Object3D,
  Box3,
  Mesh,
  BufferGeometry,
  Material,
  Vector3,
  Line,
  Sprite,
} from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { InspectHandle, InspectState, CadNode } from "./cad-inspect";
import type { CadDesignEvent } from "../../protocol";
import { createCadLive } from "./cad-live";
import { createCadParams } from "./cad-params";
import type { Pt3 } from "./cad-measure";
import {
  distance3,
  snapToVertex,
  edgeMidpoints,
  snapToEdgeMidpoint,
  formatLength,
} from "./cad-measure";

/**
 * The 2D ECAD adapter (built by another agent). Expected signature — cad.ts only calls it:
 *   export function renderEcad(path: string, kind: CadKind, host: HTMLElement, io: CadIo): Promise<void> | void;
 * It takes over the `host` element (the canvas container) for gerber / kicad-pcb / kicad-sch.
 */

// ── live state for the currently-open viewer (one modal at a time) ──────────────────────────────
interface Viewer {
  renderer?: WebGLRenderer;
  scene?: Scene;
  camera?: PerspectiveCamera;
  controls?: OrbitControls;
  model?: Object3D;
  raf?: number;
  box?: Box3;
  units: string;
  zUp: boolean;
  view: string; // human label of the current preset, for the snapshot caption
  wireframe: boolean;
  fileName: string;
  path: string;
  io: CadIo;
  tree?: CadNode | null; // glTF asset.extras.tree, when present (B-rep/converted GLBs).
  inspector?: InspectHandle | null; // model-tree drawer + section/explode state.
  measure?: MeasureState | null; // Phase 10 measurement overlay.
  chrome?: Chrome;
  /** Set while the viewer follows a part (live mode): torn down with the viewer. */
  live?: { dispose(): void } | null;
}
let active: Viewer | null = null;
/** Bumped by every `replaceModel`: a swap that finds a newer one started steps aside. */
let swapSeq = 0;

// ── Phase 10 measurement overlay state ────────────────────────────────────────────────────────────
interface MeasureState {
  on: boolean;
  group: Object3D; // holds snap marker + dimension lines/labels, added to the scene.
  marker: Object3D; // the snap cursor (a small sphere).
  pending: Pt3 | null; // first clicked point, awaiting the second.
  // Per-mesh cached geometry buffers (world-space positions + edge midpoints) for snapping.
  cache: SnapCache;
  onMove: (e: PointerEvent) => void;
  onClick: (e: PointerEvent) => void;
  hoverPt: Pt3 | null;
  objects: Object3D[]; // created lines/labels/markers to dispose.
}

type SnapCache = { mesh: Mesh; positions: Float32Array; mids: Pt3[] }[];

const budgetForDevice = (): LodBudget => {
  // D22: phones get a conservative triangle/byte ceiling. Reuse the repo's native-shell detection;
  // fall back to a small-screen / WebView-UA heuristic if that ever becomes unavailable.
  const smallOrWv =
    /\bwv\b/i.test(navigator.userAgent) || Math.min(window.screen.width, window.screen.height) <= 820;
  return isAndroidApp || smallOrWv ? PHONE_LOD : DESKTOP_LOD;
};

const fileNameOf = (path: string): string => path.split("/").pop() || path;

// ── modal chrome ────────────────────────────────────────────────────────────────────────────────
interface Chrome {
  wrap: HTMLElement;
  stage: HTMLElement; // the canvas container (100% w/h)
  unitsBadge: HTMLElement;
  statusArea: HTMLElement; // loading / error card lives here
  axisBtn: HTMLButtonElement;
  sectionRail: HTMLElement;
  sectionPos: HTMLInputElement;
  explodeRail: HTMLElement;
  explodePos: HTMLInputElement;
  readout: HTMLElement;
}

function buildChrome(path: string): Chrome {
  const name = fileNameOf(path);
  const wrap = document.createElement("div");
  wrap.className = "modal cad-modal";
  wrap.innerHTML =
    `<div class="cad-shell">` +
    `<div class="cad-hud">` +
    `<span class="cad-name" title="${esc(path)}">${esc(name)}</span>` +
    `<span class="cad-units" data-role="units">—</span>` +
    `<button type="button" class="cad-btn" data-act="axis" title="Flip up-axis (Z-up ↔ Y-up)">${icon("sync_alt")}</button>` +
    `</div>` +
    `<div class="cad-stage" data-role="stage"></div>` +
    `<div class="cad-status" data-role="status" hidden></div>` +
    `<div class="cad-tools">` +
    `<button type="button" class="cad-btn" data-act="fit" title="Fit to view">${icon("fit_screen")}</button>` +
    `<button type="button" class="cad-btn" data-act="front" title="Front view">${icon("crop_square")}</button>` +
    `<button type="button" class="cad-btn" data-act="top" title="Top view">${icon("vertical_align_top")}</button>` +
    `<button type="button" class="cad-btn" data-act="iso" title="Isometric view">${icon("deployed_code")}</button>` +
    `<button type="button" class="cad-btn" data-act="shaded" title="Shaded / wireframe">${icon("gradient")}</button>` +
    `<button type="button" class="cad-btn" data-act="tree" title="Model tree">${icon("account_tree")}</button>` +
    `<button type="button" class="cad-btn" data-act="section" title="Section / clipping plane">${icon("content_cut")}</button>` +
    `<button type="button" class="cad-btn" data-act="explode" title="Exploded view">${icon("open_in_full")}</button>` +
    `<button type="button" class="cad-btn" data-act="measure" title="Measure (approximate / mesh)">${icon("straighten")}</button>` +
    `<button type="button" class="cad-btn" data-act="ecad3d" title="3D board" hidden>${icon("view_in_ar")}</button>` +
    `<button type="button" class="cad-btn" data-act="params" title="Parameters" hidden>${icon("tune")}</button>` +
    `<button type="button" class="cad-btn" data-act="snapshot" title="Snapshot (PNG)">${icon("photo_camera")}</button>` +
    `<button type="button" class="cad-btn" data-act="close" title="Close">${icon("close")}</button>` +
    `</div>` +
    // Section + explode slider rails (hidden until their tool is toggled on).
    `<div class="cad-slider" data-role="section-rail" hidden>` +
    `<div class="cad-slider-axes">` +
    `<button type="button" class="cad-mini on" data-saxis="x">X</button>` +
    `<button type="button" class="cad-mini" data-saxis="y">Y</button>` +
    `<button type="button" class="cad-mini" data-saxis="z">Z</button>` +
    `</div>` +
    `<input type="range" min="0" max="1" step="0.005" value="0.5" data-role="section-pos" />` +
    `</div>` +
    `<div class="cad-slider" data-role="explode-rail" hidden>` +
    `<span class="cad-slider-label">${icon("open_in_full")}</span>` +
    `<input type="range" min="0" max="1" step="0.01" value="0" data-role="explode-pos" />` +
    `</div>` +
    // Measurement readout (hovered coords + bbox dims), hidden until measure mode is on.
    `<div class="cad-readout" data-role="readout" hidden></div>` +
    `</div>`;

  const stage = wrap.querySelector<HTMLElement>('[data-role="stage"]')!;
  const unitsBadge = wrap.querySelector<HTMLElement>('[data-role="units"]')!;
  const statusArea = wrap.querySelector<HTMLElement>('[data-role="status"]')!;
  const axisBtn = wrap.querySelector<HTMLButtonElement>('[data-act="axis"]')!;
  const sectionRail = wrap.querySelector<HTMLElement>('[data-role="section-rail"]')!;
  const sectionPos = wrap.querySelector<HTMLInputElement>('[data-role="section-pos"]')!;
  const explodeRail = wrap.querySelector<HTMLElement>('[data-role="explode-rail"]')!;
  const explodePos = wrap.querySelector<HTMLInputElement>('[data-role="explode-pos"]')!;
  const readout = wrap.querySelector<HTMLElement>('[data-role="readout"]')!;
  return { wrap, stage, unitsBadge, statusArea, axisBtn, sectionRail, sectionPos, explodeRail, explodePos, readout };
}

function showStatus(area: HTMLElement, html: string): void {
  area.innerHTML = html;
  area.hidden = false;
}
function hideStatus(area: HTMLElement): void {
  area.hidden = true;
  area.innerHTML = "";
}

/** Error card with a raw-download link — never a blank canvas or a hang. */
function showError(area: HTMLElement, reason: string, downloadUrl: string, name: string): void {
  showStatus(
    area,
    `<div class="cad-card cad-error">` +
      `<div class="cad-card-title">${icon("error")} Couldn't open this file</div>` +
      `<div class="cad-card-body">${esc(reason)}</div>` +
      `<a class="cad-btn cad-dl" href="${esc(downloadUrl)}" download="${esc(name)}">${icon("download")} Download original</a>` +
      `</div>`,
  );
}

/** Toolbar + HUD wiring. All buttons are delegated off the wrap so we add one listener. */
function wireChrome(chrome: Chrome): void {
  chrome.wrap.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    // Section-axis mini buttons (X/Y/Z) live inside the wrap but drive the inspector, not an action.
    const saxis = t.closest<HTMLElement>("[data-saxis]");
    if (saxis) {
      const axis = saxis.dataset.saxis as "x" | "y" | "z";
      active?.inspector?.setSectionAxis(axis);
      for (const b of chrome.sectionRail.querySelectorAll(".cad-mini")) b.classList.toggle("on", b === saxis);
      return;
    }
    const btn = t.closest<HTMLElement>("[data-act]");
    if (btn) {
      void handleAction(btn.dataset.act!, chrome);
      return;
    }
    // A click on the bare backdrop (outside the shell) dismisses, like the image lightbox.
    if (t === chrome.wrap) closeViewer();
  });

  // Section + explode sliders.
  chrome.sectionPos.addEventListener("input", () => {
    active?.inspector?.setSectionPos(Number(chrome.sectionPos.value));
  });
  chrome.explodePos.addEventListener("input", () => {
    active?.inspector?.setExplode(Number(chrome.explodePos.value));
  });

}

// ── public entry ────────────────────────────────────────────────────────────────────────────────
export function openCadViewer(path: string, io: CadIo): void {
  const kind = classifyCad(path);
  const chrome = buildChrome(path);
  const name = fileNameOf(path);

  // Release any viewer still open before replacing `active`. Opening file-after-file via the chat
  // chips otherwise orphans the previous WebGLRenderer (its context is never forceContextLoss'd), and
  // Android WebView's small live-context cap then fails EVERY later open with "Error creating WebGL
  // context" — the viewer stops working for anything until the page reloads.
  releaseActiveViewer();

  active = {
    units: "—",
    zUp: false,
    view: "iso",
    wireframe: false,
    fileName: name,
    path,
    io,
    chrome,
  };

  wireChrome(chrome);

  showModal(chrome.wrap);

  if (!kind) {
    showError(chrome.statusArea, `Unrecognised CAD format (.${extOf(path) || "?"}).`, io.fileUrl(path), name);
    return;
  }

  // Resolve the path to ONE concrete worktree file before loading, so the loader, the server-side
  // conversion, and the "Download original" link all target the same file. A bare-basename chip (e.g.
  // "mirror_riser_v3_preview.stl" living in two dirs) would otherwise 404 on every serve route; now it
  // shows a picker (like the reader) and re-opens with the chosen path. locate failing → load as-is so
  // the real reason still surfaces in the error card.
  showStatus(chrome.statusArea, `<div class="cad-card">${icon("hourglass_empty")} Loading…</div>`);
  void io
    .locate(path)
    .then((res) => {
      if (res.kind === "choices") showChoices(chrome.statusArea, res.paths, io);
      else loadResolved(res.path, kind, chrome, io);
    })
    .catch(() => loadResolved(path, kind, chrome, io));
}

/** Dispatch a now-concrete path down the right pipeline (ECAD 2D/3D vs mesh/brep 3D). Updates the live
 *  viewer's path so snapshot names + "Download original" track the resolved file, not the typed basename. */
function loadResolved(path: string, kind: CadKind, chrome: Chrome, io: CadIo): void {
  if (active) {
    active.path = path;
    active.fileName = fileNameOf(path);
  }
  if (kind === "gerber" || kind === "kicad-pcb" || kind === "kicad-sch") {
    // KiCad boards get a 2D (KiCanvas) ↔ 3D (daemon kicad-cli GLB) toggle; schematics/Gerber stay 2D.
    if (kind === "kicad-pcb") {
      kicadToggle = { path, chrome, io, is3d: false };
      const b3d = chrome.wrap.querySelector<HTMLButtonElement>('[data-act="ecad3d"]');
      if (b3d) b3d.hidden = false;
    }
    void delegateEcad(path, kind, chrome, io);
    return;
  }
  // 3D pipeline (mesh | brep).
  showStatus(chrome.statusArea, `<div class="cad-card">${icon("hourglass_empty")} Loading…</div>`);
  void init3d(path, kind, chrome, io).catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    showError(chrome.statusArea, reason, io.fileUrl(path), fileNameOf(path));
  });
}

/** A bare basename matched several files — let the user pick which to open (mirrors the reader's
 *  disambiguation). Picking re-enters openCadViewer with the concrete path, which resolves cleanly. */
function showChoices(area: HTMLElement, paths: string[], io: CadIo): void {
  const items = paths.map((p) => `<li><a href="#" class="cad-choice" data-path="${esc(p)}">${esc(p)}</a></li>`).join("");
  showStatus(
    area,
    `<div class="cad-card">` +
      `<div class="cad-card-title">${icon("help")} Which file?</div>` +
      `<div class="cad-card-body">That name matches several files — pick one:</div>` +
      `<ul class="cad-choices">${items}</ul>` +
      `</div>`,
  );
  for (const a of area.querySelectorAll<HTMLElement>(".cad-choice")) {
    a.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation(); // don't let the wrap's delegated click dismiss the viewer
      const p = a.dataset.path;
      if (p) openCadViewer(p, io);
    };
  }
}

async function delegateEcad(path: string, kind: CadKind, chrome: Chrome, io: CadIo): Promise<void> {
  try {
    // ./cad-ecad is built by a sibling agent and may not exist yet at typecheck time; the dynamic
    // import resolves at runtime. `@ts-ignore` (not `@ts-expect-error`) so it stays silent once the
    // module lands rather than flipping to an unused-directive error.
    // @ts-ignore — sibling module ./cad-ecad resolved at runtime (see comment above).
    const mod = (await import("./cad-ecad")) as {
      renderEcad(path: string, kind: CadKind, host: HTMLElement, io: CadIo): Promise<void> | void;
    };
    hideStatus(chrome.statusArea);
    await mod.renderEcad(path, kind, chrome.stage, io);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    showError(chrome.statusArea, reason, io.fileUrl(path), fileNameOf(path));
  }
}

// ── toolbar actions ─────────────────────────────────────────────────────────────────────────────
async function handleAction(act: string, chrome: Chrome): Promise<void> {
  switch (act) {
    case "close":
      closeViewer();
      break;
    case "fit":
      fitToView();
      break;
    case "front":
      setPresetView("front");
      break;
    case "top":
      setPresetView("top");
      break;
    case "iso":
      setPresetView("iso");
      break;
    case "shaded":
      toggleWireframe();
      break;
    case "axis":
      await flipAxis();
      break;
    case "tree":
      toggleTree(chrome);
      break;
    case "section":
      toggleSection(chrome);
      break;
    case "explode":
      toggleExplode(chrome);
      break;
    case "ecad3d":
      await toggleKicad3d(chrome);
      break;
    case "measure":
      await toggleMeasure(chrome);
      break;
    case "snapshot":
      openSnapshotMenu(chrome);
      break;
    case "params": {
      // Live mode: the parameters sheet (a bottom sheet on a phone, a side panel on a wide screen).
      const open = chrome.wrap.querySelector(".cad-shell")?.classList.toggle("cad-params-open");
      chrome.wrap.querySelector<HTMLElement>('.cad-tools [data-act="params"]')?.classList.toggle("on", !!open);
      break;
    }
  }
}

// ── Phase 3 toolbar wiring (tree drawer / section / explode) ────────────────────────────────────
function toggleTree(chrome: Chrome): void {
  const v = active;
  const insp = v?.inspector;
  if (!insp) return;
  const open = chrome.stage.parentElement?.classList.toggle("cad-tree-open");
  const btn = chrome.wrap.querySelector<HTMLElement>('[data-act="tree"]');
  btn?.classList.toggle("on", !!open);
}

function toggleSection(chrome: Chrome): void {
  const insp = active?.inspector;
  if (!insp) return;
  insp.toggleSection();
  const on = insp.isSectionOn();
  chrome.sectionRail.hidden = !on;
  chrome.wrap.querySelector<HTMLElement>('[data-act="section"]')?.classList.toggle("on", on);
  if (on) insp.setSectionPos(Number(chrome.sectionPos.value));
}

function toggleExplode(chrome: Chrome): void {
  const insp = active?.inspector;
  if (!insp) return;
  insp.toggleExplode();
  const on = insp.isExplodeOn();
  chrome.explodeRail.hidden = !on;
  chrome.wrap.querySelector<HTMLElement>('[data-act="explode"]')?.classList.toggle("on", on);
  if (on) insp.setExplode(Number(chrome.explodePos.value));
}

// ── 3D setup + load ─────────────────────────────────────────────────────────────────────────────
async function init3d(path: string, kind: CadKind, chrome: Chrome, io: CadIo): Promise<void> {
  const THREE = await import("three");
  const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");

  const stage = chrome.stage;
  const width = stage.clientWidth || window.innerWidth;
  const height = stage.clientHeight || window.innerHeight;

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  renderer.setClearColor(0x1a1c20, 1);
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 100000);
  camera.position.set(1, 1, 1);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(1, 1, 1);
  scene.add(dir);
  const dir2 = new THREE.DirectionalLight(0xffffff, 0.4);
  dir2.position.set(-1, -0.5, -1);
  scene.add(dir2);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // OrbitControls handles pinch/orbit/pan on touch natively once enabled (default), nothing to wire.

  active!.renderer = renderer;
  active!.scene = scene;
  active!.camera = camera;
  active!.controls = controls;

  // Keep the canvas sized to the stage (the modal is full-screen but can change on rotate).
  const ro = new ResizeObserver(() => {
    const w = stage.clientWidth || window.innerWidth;
    const h = stage.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  ro.observe(stage);
  // Stash the observer on the renderer's userData so closeViewer can disconnect it.
  (renderer as unknown as { __ro?: ResizeObserver }).__ro = ro;

  const budget = budgetForDevice();

  // Load the model (per kind) → an Object3D plus detected units/up-axis.
  const loaded = await loadModel(THREE, path, kind, io, budget, chrome.statusArea);

  if (loaded.tooLarge) {
    // D22: refuse to add it; offer a download instead.
    showError(
      chrome.statusArea,
      `Too large to view on this device (${loaded.triangles.toLocaleString()} triangles exceeds the ` +
        `${budget.maxTriangles.toLocaleString()} limit) — download instead.`,
      io.fileUrl(path),
      fileNameOf(path),
    );
    return;
  }

  const model = loaded.object;
  scene.add(model);
  adoptModel(THREE, active!, loaded);
  fitToView();

  hideStatus(chrome.statusArea);

  // Phase 3: build the model-tree drawer + section/explode controller now that the model + box exist.
  await attachInspector(THREE, active!);

  // Render loop (damped controls need continuous frames).
  const tick = (): void => {
    active!.raf = requestAnimationFrame(tick);
    controls.update();
    renderer.render(scene, camera);
  };
  tick();
  publishProbe();
}

/** Take a freshly loaded model as THE model of the viewer: units, up-axis, wireframe, bounding box.
 *  Shared by the first load and by `replaceModel`, and it never touches the camera. */
function adoptModel(THREE: typeof import("three"), v: Viewer, loaded: LoadResult, keepAxis = false): void {
  const model = loaded.object;
  v.model = model;
  v.tree = loaded.tree ?? null;
  if (v.live) {
    // A part's preview is SolidCraft's GLB: metres, Y up. Parts are dimensioned in millimetres, so
    // show it at 1000× and call the unit mm — a 120 mm plate measures 120, not 0.12.
    model.scale.setScalar(1000);
    v.units = "mm";
    v.zUp = false;
  } else {
    v.units = loaded.units;
    if (!keepAxis) v.zUp = loaded.zUp;
  }
  if (v.chrome) v.chrome.unitsBadge.textContent = v.units;
  // D20: normalize up-axis if the model reads Z-up.
  applyUpAxis(THREE, model);
  if (v.wireframe) setWireframe(model, true);
  recomputeBox(THREE, model);
}

/** Build the model-tree drawer + section/explode controller for the viewer's current model. With
 *  `restore`, the previous model's state (section, hidden parts, explode) is re-applied to this one. */
async function attachInspector(THREE: typeof import("three"), v: Viewer, restore?: InspectState): Promise<void> {
  if (!v.model || !v.box || !v.renderer || !v.camera || !v.controls || !v.chrome) return;
  try {
    const { buildInspector } = await import("./cad-inspect");
    if (active !== v) return;
    const insp = buildInspector({
      THREE,
      model: v.model,
      box: v.box,
      renderer: v.renderer as unknown as { localClippingEnabled: boolean; clippingPlanes: unknown[] },
      camera: v.camera,
      controls: v.controls,
      extrasTree: v.tree,
      fit: fitToView,
      restore,
    });
    v.inspector = insp;
    // The drawer lives inside the shell so it composites over the canvas but under the toolbar.
    v.chrome.wrap.querySelector<HTMLElement>(".cad-shell")?.appendChild(insp.panel);
    if (restore) v.chrome.sectionPos.value = String(insp.sectionPos());
  } catch {
    // Inspector is an enhancement; a failure must never block the core viewer.
  }
}

/** Free a model's GPU resources (geometry, materials and their textures). The WebGL context stays. */
function disposeModel(model: Object3D): void {
  model.traverse((o: Object3D) => {
    const m = o as Mesh;
    (m.geometry as BufferGeometry | undefined)?.dispose?.();
    if (!m.material) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      for (const val of Object.values(mat as unknown as Record<string, unknown>)) {
        const tex = val as { isTexture?: boolean; dispose?: () => void } | null;
        if (tex && typeof tex === "object" && tex.isTexture) tex.dispose?.();
      }
      mat.dispose();
    }
  });
}

/**
 * Swap the scene's model IN PLACE (agent-cad-and-browser spec §4.9, D12). The renderer and its WebGL
 * context, the camera (position, target, zoom, projection), the section plane, hidden / isolated
 * parts, the explode amount and the measurements are all left as they are; only the geometry changes.
 * The old model's GPU resources are freed. Never opens a second WebGL context — a part revises many
 * times a minute, and Android WebView allows only a handful of live contexts.
 *
 * Throws when no 3D viewer is open, when the file cannot be loaded, or when it is over the device's
 * triangle budget (the model on screen is kept in every case). A swap overtaken by a newer one
 * resolves without touching the scene.
 */
export async function replaceModel(path: string): Promise<{ triangles: number; replaced: boolean }> {
  const v = active;
  if (!v?.renderer || !v.scene || !v.camera || !v.controls) throw new Error("No 3D viewer is open to swap a model into.");
  const kind = classifyCad(path);
  if (kind !== "mesh" && kind !== "brep") throw new Error(`Cannot swap in a .${extOf(path) || "?"} file.`);
  const seq = ++swapSeq;
  const THREE = await import("three");
  const budget = budgetForDevice();
  // The status area is not used: a swap must not flash a loading card over the model.
  const loaded = await loadModel(THREE, path, kind, v.io, budget, document.createElement("div"));
  if (active !== v || seq !== swapSeq || !v.scene) {
    disposeModel(loaded.object); // the viewer closed, or a newer revision is already on its way
    return { triangles: loaded.triangles, replaced: false };
  }
  if (loaded.tooLarge) {
    disposeModel(loaded.object);
    throw new Error(`Too large to view on this device (${loaded.triangles.toLocaleString()} triangles exceeds the ${budget.maxTriangles.toLocaleString()} limit).`);
  }

  // State that belongs to the old model's objects is read off before they go.
  const restore = v.inspector?.getState();
  v.inspector?.dispose();
  v.inspector = null;
  const old = v.model;
  if (old) {
    v.scene.remove(old);
    disposeModel(old);
  }
  v.scene.add(loaded.object);
  v.path = path;
  if (!v.live) v.fileName = fileNameOf(path);
  adoptModel(THREE, v, loaded, true); // keeps the up-axis the user chose; NO fitToView — the camera stays
  await attachInspector(THREE, v, restore);
  // Measurements already drawn stay; snapping now follows the new geometry.
  if (v.measure?.on && v.model) {
    v.measure.cache.length = 0;
    v.measure.cache.push(...buildSnapCache(THREE, v.model));
    v.measure.hoverPt = null;
    v.measure.marker.visible = false;
  }
  return { triangles: loaded.triangles, replaced: true };
}

// ── live mode: the viewer follows a part (spec §4.9, Phase A3) ─────────────────────────────────────
/** Where a live viewer gets a part's state from and sends the owner's actions to. Wired by main.ts. */
export interface CadPartSource {
  part: string;
  /** The newest `cad.design` known for the part, if any. */
  current(): CadDesignEvent | undefined;
  /** Hear every later `cad.design` of the part. Returns unsubscribe. */
  subscribe(fn: (ev: CadDesignEvent) => void): () => void;
  /** Send `cad.param.set` and wait for its result. */
  setParam(name: string, expression: string): Promise<{ ok: boolean; error?: string }>;
  /** Send `cad.design.refresh` (Rebuild). */
  rebuild(): void;
  /** The parts of the same worktree (`cad.parts.list`), for the part switcher. */
  parts?(): Promise<string[]>;
  /** Open another part of the worktree. */
  openPart?(part: string): void;
}

const NO_GEOMETRY = `<div class="cad-card" data-role="no-geometry">${icon("deployed_code")} Nothing to show yet — this part has no geometry.</div>`;

/**
 * Open the viewer on a PART in live mode: Follow / Paused with an "N behind" badge, Reload, Rebuild,
 * a busy line, and the parameters panel with the gate strip. `io.fetchBytes(path)` must serve the
 * `preview` path a `cad.design` names (see `makeCadPartIo`). Each new revision is swapped in place
 * with `replaceModel`; the renderer is created once, for the first revision that has geometry.
 */
export function openCadPart(src: CadPartSource, io: CadIo): void {
  const chrome = buildChrome(`cad/${src.part}`);
  releaseActiveViewer();
  const v: Viewer = { units: "mm", zUp: false, view: "iso", wireframe: false, fileName: src.part, path: "", io, chrome };
  active = v;
  wireChrome(chrome);
  const shell = chrome.wrap.querySelector<HTMLElement>(".cad-shell")!;
  shell.classList.add("cad-live-mode");
  shell.dataset.part = src.part;
  chrome.axisBtn.hidden = true; // a preview is always Y-up
  const paramsBtn = chrome.wrap.querySelector<HTMLElement>('.cad-tools [data-act="params"]');
  if (paramsBtn) paramsBtn.hidden = false;
  showModal(chrome.wrap);

  const show = async (ev: CadDesignEvent): Promise<void> => {
    if (active !== v || !ev.preview) return;
    if (v.renderer) {
      await replaceModel(ev.preview);
      hideStatus(chrome.statusArea);
      return;
    }
    showStatus(chrome.statusArea, `<div class="cad-card">${icon("hourglass_empty")} Loading…</div>`);
    try {
      await init3d(ev.preview, "mesh", chrome, io);
    } catch (e) {
      if (active === v) {
        dropRenderer(v); // a half-built scene must not be mistaken for a live one by the next revision
        showStatus(chrome.statusArea, `<div class="cad-card cad-error">${icon("error")} ${esc(e instanceof Error ? e.message : String(e))}</div>`);
      }
      throw e;
    }
  };
  const clear = (): void => {
    if (active !== v) return;
    if (v.model && v.scene) {
      v.inspector?.dispose();
      v.inspector = null;
      v.scene.remove(v.model);
      disposeModel(v.model);
      v.model = undefined;
    }
    showStatus(chrome.statusArea, NO_GEOMETRY);
  };

  const params = createCadParams({ setParam: src.setParam });
  // The panel and the gate strip describe the model ON SCREEN: while Paused behind newer revisions
  // they keep the displayed revision's values and say a newer one exists (A3 review, item 6).
  const live = createCadLive({
    part: src.part,
    show,
    clear,
    rebuild: src.rebuild,
    onShown: (ev) => {
      params.onDesign(ev);
      params.setNewer(live.behind() > 0);
    },
  });
  shell.append(live.el, params.el);
  if (window.innerWidth >= 900) {
    shell.classList.add("cad-params-open"); // room for both on a wide screen; a phone opens it from the toolbar
    paramsBtn?.classList.add("on");
  }

  const feed = (ev: CadDesignEvent): void => {
    const shownRev = live.shownRev();
    // The displayed revision (a busy update of it, say), or Follow on (the mesh is on its way): the
    // panel takes the event. Paused behind: it keeps what is on screen and says a newer one exists.
    if (live.following() || shownRev === 0 || ev.rev <= shownRev) params.onDesign(ev);
    live.onDesign(ev);
    params.setNewer(!live.following() && live.behind() > 0);
  };
  const off = src.subscribe(feed);
  v.live = {
    dispose() {
      off();
      live.dispose();
      params.dispose();
    },
  };
  const cur = src.current();
  if (cur) feed(cur);
  if (!cur?.preview) showStatus(chrome.statusArea, NO_GEOMETRY);

  // The parts list: the other parts of this worktree, one tap away.
  void src
    .parts?.()
    .then((names) => {
      if (active !== v || names.length < 2 || !src.openPart) return;
      const pick = document.createElement("select");
      pick.className = "cad-live-parts";
      pick.dataset.live = "parts";
      pick.setAttribute("aria-label", "Part");
      for (const n of names) {
        const o = document.createElement("option");
        o.value = n;
        o.textContent = n;
        o.selected = n === src.part;
        pick.append(o);
      }
      pick.onchange = () => src.openPart!(pick.value);
      live.el.prepend(pick);
    })
    .catch(() => undefined);
}

/** Test probe (the real-bundle Playwright spec, test/golden/live.pw.ts). Published ONLY when the page
 *  set `window.__ANVIL_CAD_TEST__` before the app loaded; production pages never do. Read-only. */
function publishProbe(): void {
  const w = window as unknown as { __ANVIL_CAD_TEST__?: boolean; __anvilCadProbe?: () => unknown };
  if (!w.__ANVIL_CAD_TEST__) return;
  w.__anvilCadProbe = () => {
    const v = active;
    if (!v?.camera || !v.renderer) return null;
    let triangles = 0;
    let vertices = 0;
    v.model?.traverse((o: Object3D) => {
      const g = (o as Mesh).geometry as BufferGeometry | undefined;
      const pos = g?.getAttribute?.("position");
      if (!g || !pos) return;
      vertices += pos.count;
      triangles += (g.getIndex()?.count ?? pos.count) / 3;
    });
    v.camera.updateMatrixWorld();
    const b = v.box;
    return {
      camera: [...v.camera.matrixWorld.elements],
      projection: [...v.camera.projectionMatrix.elements],
      target: v.controls ? v.controls.target.toArray() : null,
      zoom: v.camera.zoom,
      triangles,
      vertices,
      modelId: v.model?.uuid ?? null,
      size: b ? [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z] : null,
      units: v.units,
      sectionOn: v.inspector?.isSectionOn() ?? false,
      sectionPos: v.inspector?.sectionPos() ?? null,
      gpuGeometries: v.renderer.info.memory.geometries,
      canvases: document.querySelectorAll(".cad-stage canvas").length,
      screenBox: screenBoxOf(v),
    };
  };
}

/** The model's bounding box projected to page pixels {left, top, right, bottom} (the probe's). */
function screenBoxOf(v: Viewer): { left: number; top: number; right: number; bottom: number } | null {
  const b = v.box;
  const cam = v.camera;
  const canvas = v.renderer?.domElement;
  if (!b || !cam || !canvas) return null;
  const r = canvas.getBoundingClientRect();
  const xs: number[] = [];
  const ys: number[] = [];
  for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
    const p = b.min.clone().set(x, y, z).project(cam);
    xs.push(r.left + ((p.x + 1) / 2) * r.width);
    ys.push(r.top + ((1 - p.y) / 2) * r.height);
  }
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

interface LoadResult {
  object: Object3D;
  units: string;
  zUp: boolean;
  triangles: number;
  tooLarge: boolean;
  tree?: CadNode | null; // glTF asset.extras.tree hierarchy, when the converter stamped one.
}

/**
 * Fetch an ArrayBuffer while reporting download progress into the status area (Phase 9, D14). Uses a
 * ReadableStream reader so large converted GLBs show "N MB" ticking up instead of a dead spinner. Falls
 * back to a plain arrayBuffer() if the body isn't streamable (older runtimes / opaque responses).
 */
async function fetchWithProgress(url: string, status: HTMLElement): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Conversion failed (HTTP ${res.status}). The server couldn't tessellate this B-rep.`);
  const total = Number(res.headers.get("content-length") || 0);
  const body = res.body;
  const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (!body || !body.getReader) return await res.arrayBuffer();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      const pct = total ? ` (${Math.round((received / total) * 100)}%)` : "";
      showStatus(status, `<div class="cad-card">${icon("hourglass_empty")} Downloading ${mb(received)}${total ? ` / ${mb(total)}` : ""}${pct}</div>`);
    }
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out.buffer;
}

/**
 * Attach the meshopt decoder (and DRACO, if ever used) to a GLTFLoader so EXT_meshopt_compression +
 * KHR_mesh_quantization GLBs (Phase 9) decode. meshopt needs no external decoder files.
 */
async function wireGltfDecoders(loader: { setMeshoptDecoder(d: unknown): unknown; setDRACOLoader?(d: unknown): unknown }): Promise<void> {
  try {
    const { MeshoptDecoder } = await import("three/examples/jsm/libs/meshopt_decoder.module.js");
    loader.setMeshoptDecoder(MeshoptDecoder);
  } catch {
    // If the decoder module can't load, uncompressed GLBs still parse — degrade quietly.
  }
  // Draco is what real glTF exporters (Blender, gltf-transform, …) emit by default, so a user's `.glb`
  // is as likely compressed as not. Without a DRACOLoader, GLTFLoader throws "No DRACOLoader instance
  // provided" on those (the one format that'd fail while STL/OBJ/server-STEP open). The decoder ships
  // with three and is copied to `/draco/` at build time (web/build.ts; also bundled into the apps).
  try {
    const { DRACOLoader } = await import("three/examples/jsm/loaders/DRACOLoader.js");
    const draco = new DRACOLoader();
    draco.setDecoderPath("/draco/"); // static asset on the UI origin (same place as /katex, /xterm.css)
    loader.setDRACOLoader?.(draco);
  } catch {
    // Draco GLBs won't parse, but uncompressed / meshopt ones still will.
  }
}

/** Count triangles across every mesh in an object graph (indexed or not). */
function countTriangles(THREE: typeof import("three"), root: Object3D): number {
  let tris = 0;
  root.traverse((o: Object3D) => {
    const m = o as Mesh;
    const geom = m.geometry as BufferGeometry | undefined;
    if (geom && (geom as BufferGeometry).isBufferGeometry) {
      const index = geom.getIndex();
      const pos = geom.getAttribute("position");
      if (index) tris += index.count / 3;
      else if (pos) tris += pos.count / 3;
    }
  });
  return Math.round(tris);
}

async function loadModel(
  THREE: typeof import("three"),
  path: string,
  kind: CadKind,
  io: CadIo,
  budget: LodBudget,
  status: HTMLElement,
): Promise<LoadResult> {
  const ext = extOf(path);

  if (kind === "brep") {
    // Server tessellates the B-rep to GLB at our requested LOD; we stream the bytes (Phase 9 progress)
    // and parse locally. The GLB may be meshopt-compressed, so wire the decoder first.
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const url = io.cadUrl(path, budget.maxTriangles);
    const buf = await fetchWithProgress(url, status);
    const loader = new GLTFLoader();
    await wireGltfDecoders(loader);
    const gltf = await loader.parseAsync(buf, "");
    const extras = (gltf.asset?.extras ?? {}) as { units?: string; zUp?: boolean; tree?: CadNode };
    const object = gltf.scene as unknown as Object3D;
    const triangles = countTriangles(THREE, object);
    const units = typeof extras.units === "string" ? extras.units : "mm";
    const zUp = extras.zUp === true;
    const tree = extras.tree && typeof extras.tree === "object" ? extras.tree : null;
    return { object, units, zUp, triangles, tooLarge: triangles > budget.maxTriangles, tree };
  }

  // Mesh formats: load client-side by extension.
  const shadedMat = (): Material =>
    new THREE.MeshStandardMaterial({ color: 0xb8c0cc, roughness: 0.65, metalness: 0.1, side: THREE.DoubleSide });

  let object: Object3D;
  let units = "unitless"; // STL/OBJ/PLY carry no unit; GLTF is metres by spec.
  let tree: CadNode | null = null; // only GLB/converted assets carry a named part hierarchy.

  switch (ext) {
    case "stl": {
      const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
      const buf = (await io.fetchBytes(path)).buffer as ArrayBuffer;
      const geom = new STLLoader().parse(buf);
      geom.computeVertexNormals();
      object = new THREE.Mesh(geom, shadedMat());
      break;
    }
    case "ply": {
      const { PLYLoader } = await import("three/examples/jsm/loaders/PLYLoader.js");
      const buf = (await io.fetchBytes(path)).buffer as ArrayBuffer;
      const geom = new PLYLoader().parse(buf);
      geom.computeVertexNormals();
      object = new THREE.Mesh(geom, shadedMat());
      break;
    }
    case "obj": {
      const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
      const text = await io.fetchText(path);
      const loader = new OBJLoader();
      // Best-effort sibling .mtl: if one sits next to the .obj, parse + attach its materials.
      try {
        const base = path.replace(/[^/]+$/, "");
        const siblings = await io.listSiblings(path);
        const mtlName = siblings.find((s) => s.toLowerCase().endsWith(".mtl"));
        if (mtlName) {
          const { MTLLoader } = await import("three/examples/jsm/loaders/MTLLoader.js");
          const mtlText = await io.fetchText(base + mtlName);
          const mats = new MTLLoader().parse(mtlText, base);
          mats.preload();
          loader.setMaterials(mats);
        }
      } catch {
        // No/unreadable .mtl — fall back to the loader's default material. Non-fatal.
      }
      object = loader.parse(text);
      break;
    }
    case "3mf": {
      const { ThreeMFLoader } = await import("three/examples/jsm/loaders/3MFLoader.js");
      const buf = (await io.fetchBytes(path)).buffer as ArrayBuffer;
      object = new ThreeMFLoader().parse(buf);
      break;
    }
    case "dae": {
      const { ColladaLoader } = await import("three/examples/jsm/loaders/ColladaLoader.js");
      const text = await io.fetchText(path);
      const collada = new ColladaLoader().parse(text, path.replace(/[^/]+$/, ""));
      if (!collada) throw new Error("Collada (.dae) file could not be parsed.");
      object = collada.scene as unknown as Object3D;
      break;
    }
    case "gltf":
    case "glb": {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const buf = (await io.fetchBytes(path)).buffer as ArrayBuffer;
      const gltfLoader = new GLTFLoader();
      await wireGltfDecoders(gltfLoader);
      const gltf = await gltfLoader.parseAsync(buf, path.replace(/[^/]+$/, ""));
      object = gltf.scene as unknown as Object3D;
      // glTF geometry is defined in metres by spec, but an authored asset may declare its real unit
      // in asset.extras.units (our GLB/assembly fixtures + the server B-rep path both do) — honour it.
      const gextras = (gltf.asset?.extras ?? {}) as { tree?: CadNode; units?: string };
      units = typeof gextras.units === "string" ? gextras.units : "m";
      tree = gextras.tree && typeof gextras.tree === "object" ? gextras.tree : null;
      break;
    }
    default:
      throw new Error(`No loader for .${ext} meshes.`);
  }

  const triangles = countTriangles(THREE, object);
  return { object, units, zUp: false, triangles, tooLarge: triangles > budget.maxTriangles, tree };
}

// ── units / up-axis (D20) ───────────────────────────────────────────────────────────────────────
/** Rotate the model to Y-up if `active.zUp` is set. Idempotent per call (operates on a flag). */
function applyUpAxis(THREE: typeof import("three"), model: Object3D): void {
  // Reset any prior rotation, then apply from the current flag so flipAxis() can toggle cleanly.
  model.rotation.set(0, 0, 0);
  if (active?.zUp) {
    // Z-up → Y-up: rotate -90° about X so the model's +Z points to the viewer's +Y.
    model.rotation.x = -Math.PI / 2;
  }
  model.updateMatrixWorld(true);
  void THREE;
}

function recomputeBox(THREE: typeof import("three"), model: Object3D): void {
  const box = new THREE.Box3().setFromObject(model);
  if (active) active.box = box;
}

/** Heuristic auto-detect: if the raw (Y-up-assumed) box is noticeably taller in Z than Y, it's Z-up. */
function looksZUp(box: Box3): boolean {
  const sizeY = box.max.y - box.min.y;
  const sizeZ = box.max.z - box.min.z;
  return sizeZ > sizeY * 1.25;
}

async function flipAxis(): Promise<void> {
  if (!active?.model) return;
  const THREE = await import("three");
  active.zUp = !active.zUp;
  applyUpAxis(THREE, active.model);
  recomputeBox(THREE, active.model);
  fitToView();
}

// ── camera framing + presets ────────────────────────────────────────────────────────────────────
function fitToView(): void {
  const v = active;
  if (!v?.camera || !v.controls || !v.box || !v.model) return;
  void (async () => {
    const THREE = await import("three");
    // (Re)derive the box each fit so it tracks axis flips / view changes.
    const box = new THREE.Box3().setFromObject(v.model!);
    v.box = box;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const fov = (v.camera!.fov * Math.PI) / 180;
    let dist = (maxDim / 2 / Math.tan(fov / 2)) * 1.6;

    v.controls!.target.copy(center);
    // Keep the current view direction; just back the camera off to the fit distance.
    const dirv = new THREE.Vector3().subVectors(v.camera!.position, v.controls!.target);
    if (dirv.lengthSq() === 0) dirv.set(1, 1, 1);
    dirv.normalize();
    const place = (): void => {
      v.camera!.position.copy(center).addScaledVector(dirv, dist);
      v.camera!.near = dist / 100;
      v.camera!.far = dist * 100;
      v.camera!.updateProjectionMatrix();
      v.camera!.lookAt(center);
      v.camera!.updateMatrixWorld();
    };
    place();
    // Then refine the distance so the projected box fits the VISIBLE part of the canvas, both ways
    // (a phone's narrow canvas is width-bound) and clear of the toolbar, HUD, live bar and sheet.
    const room = visibleRoom(v);
    if (room) {
      const corner = new THREE.Vector3();
      for (let i = 0; i < 6; i++) {
        let ex = 0;
        let ey = 0;
        for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
          corner.set(x, y, z).project(v.camera!);
          ex = Math.max(ex, Math.abs(corner.x));
          ey = Math.max(ey, Math.abs(corner.y));
        }
        const k = Math.max(ex / room.x, ey / room.y);
        if (!Number.isFinite(k) || k <= 0 || Math.abs(k - 1) < 0.01) break;
        dist *= k > 1 ? k * 1.02 : k; // projected size goes ~1/dist; overshoot a hair when growing
        place();
      }
    }
    v.controls!.update();
  })();
}

/**
 * How much of the canvas, as NDC half-extents around its centre, the model may fill: the canvas less
 * the chrome floating over it (toolbar at the bottom, HUD and live bar at the top, the phone's sheet
 * when open), kept symmetric so the orbit target stays the canvas centre, less a small margin.
 */
function visibleRoom(v: Viewer): { x: number; y: number } | null {
  const canvas = v.renderer?.domElement;
  const shell = v.chrome?.wrap.querySelector<HTMLElement>(".cad-shell");
  if (!canvas || !shell) return null;
  const c = canvas.getBoundingClientRect();
  if (c.width < 2 || c.height < 2) return null;
  let top = 0;
  let bottom = 0;
  for (const el of shell.querySelectorAll<HTMLElement>(":scope > .cad-tools, :scope > .cad-hud, :scope > .cad-live, :scope > .cad-params")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue; // hidden
    if (r.right <= c.left || r.left >= c.right || r.bottom <= c.top || r.top >= c.bottom) continue; // beside the canvas
    if (r.top + r.height / 2 < c.top + c.height / 2) top = Math.max(top, r.bottom - c.top);
    else bottom = Math.max(bottom, c.bottom - r.top);
  }
  const margin = 12;
  const halfH = c.height / 2 - Math.max(top, bottom) - margin;
  const halfW = c.width / 2 - margin;
  if (halfH < 20 || halfW < 20) return null; // nothing sensible left: fall back to the plain fit
  return { x: halfW / (c.width / 2), y: halfH / (c.height / 2) };
}

function setPresetView(view: "front" | "top" | "iso"): void {
  const v = active;
  if (!v?.camera || !v.controls || !v.box) return;
  v.view = view;
  void (async () => {
    const THREE = await import("three");
    const box = v.box!;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const fov = (v.camera!.fov * Math.PI) / 180;
    const dist = (maxDim / 2 / Math.tan(fov / 2)) * 1.8;

    const unit =
      view === "front"
        ? new THREE.Vector3(0, 0, 1)
        : view === "top"
          ? new THREE.Vector3(0, 1, 0.0001) // tiny z so "up" isn't parallel to the view dir
          : new THREE.Vector3(1, 0.8, 1).normalize();
    v.controls!.target.copy(center);
    v.camera!.position.copy(center).add(unit.multiplyScalar(dist));
    v.camera!.updateProjectionMatrix();
    v.controls!.update();
  })();
}

// ── shaded / wireframe ──────────────────────────────────────────────────────────────────────────
function toggleWireframe(): void {
  const v = active;
  if (!v?.model) return;
  v.wireframe = !v.wireframe;
  setWireframe(v.model, v.wireframe);
}

function setWireframe(model: Object3D, on: boolean): void {
  model.traverse((o: Object3D) => {
    const m = o as Mesh;
    const mat = m.material;
    if (!mat) return;
    const mats = Array.isArray(mat) ? mat : [mat];
    for (const one of mats) {
      const w = one as Material & { wireframe?: boolean };
      if ("wireframe" in w) w.wireframe = on;
    }
  });
}

// ── Phase 10: measurement with snap-to-geometry (D28) ───────────────────────────────────────────
// Snap priority on hover: nearest VERTEX → nearest EDGE-MIDPOINT → raw FACE raycast hit, each within a
// small pixel radius (projected to a world radius at the hit depth). Click two snapped points → draw a
// dimension line + distance label. Pure math lives in cad-measure.ts; raycasting + DOM stay here.
const SNAP_PX = 14; // pixel radius for vertex/edge snapping.

/** Build a label sprite showing `text` at world `pos`. Returns the Sprite (added by caller). */
function makeLabel(THREE: typeof import("three"), text: string): Sprite {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const fontPx = 48;
  ctx.font = `${fontPx}px system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 24;
  canvas.width = w;
  canvas.height = fontPx + 20;
  ctx.font = `${fontPx}px system-ui, sans-serif`;
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffe9a8";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 12, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(canvas.width, canvas.height, 1);
  return sprite;
}

/** World-space vertex positions + edge midpoints per mesh, for snapping (built on entering measure
 *  mode, and again when the model is swapped under it). */
function buildSnapCache(THREE: typeof import("three"), model: Object3D): SnapCache {
  const cache: SnapCache = [];
  model.traverse((o: Object3D) => {
    const m = o as Mesh;
    if (!(m as unknown as { isMesh?: boolean }).isMesh) return;
    const geom = m.geometry as BufferGeometry | undefined;
    const posAttr = geom?.getAttribute("position");
    if (!geom || !posAttr) return;
    m.updateWorldMatrix(true, false);
    // World-space positions for snapping (so snap distances are in world/model units).
    const world = new Float32Array(posAttr.count * 3);
    const tmp = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      tmp.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(m.matrixWorld);
      world[i * 3] = tmp.x;
      world[i * 3 + 1] = tmp.y;
      world[i * 3 + 2] = tmp.z;
    }
    const idx = geom.getIndex();
    const indices = idx ? (idx.array as Uint32Array | Uint16Array) : null;
    const mids = edgeMidpoints(world, indices);
    cache.push({ mesh: m, positions: world, mids });
  });
  return cache;
}

async function toggleMeasure(chrome: Chrome): Promise<void> {
  const v = active;
  if (!v?.renderer || !v.scene || !v.camera || !v.model) return;
  const THREE = await import("three");

  if (v.measure?.on) {
    teardownMeasure();
    chrome.readout.hidden = true;
    chrome.wrap.querySelector<HTMLElement>('[data-act="measure"]')?.classList.remove("on");
    return;
  }

  // Build per-mesh world-space position + edge-midpoint caches once on entry.
  const raycaster = new THREE.Raycaster();
  (raycaster.params as unknown as { Line?: { threshold: number } }).Line = { threshold: 0 };
  const cache = buildSnapCache(THREE, v.model);

  const group = new THREE.Group();
  v.scene.add(group);
  const markerGeo = new THREE.SphereGeometry(1, 16, 12);
  const markerMat = new THREE.MeshBasicMaterial({ color: 0xffcc33, depthTest: false });
  const marker = new THREE.Mesh(markerGeo, markerMat);
  marker.visible = false;
  group.add(marker);

  const canvas = v.renderer.domElement;

  // Project the SNAP_PX pixel radius to a world radius at a given depth point.
  const worldRadiusAt = (pt: Pt3): number => {
    const p = new THREE.Vector3(pt.x, pt.y, pt.z);
    const dist = v.camera!.position.distanceTo(p);
    const fov = (v.camera!.fov * Math.PI) / 180;
    const worldPerPx = (2 * Math.tan(fov / 2) * dist) / canvas.height;
    return SNAP_PX * worldPerPx;
  };

  const ndcFromEvent = (e: PointerEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
  };

  // Snap a pointer event to the best geometry point, or null if the ray misses the model.
  const snapAt = (e: PointerEvent): Pt3 | null => {
    const ndc = ndcFromEvent(e);
    raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), v.camera!);
    const hits = raycaster.intersectObject(v.model!, true);
    if (!hits.length) return null;
    const hit = hits[0]!;
    const face: Pt3 = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
    const r = worldRadiusAt(face);
    const r2 = r * r;
    // Look at the mesh we actually hit first, then fall back to all caches.
    const ordered = [...cache].sort((a) => (a.mesh === hit.object ? -1 : 0));
    for (const c of ordered) {
      const vsnap = snapToVertex(c.positions, face, r2);
      if (vsnap) return vsnap;
    }
    for (const c of ordered) {
      const esnap = snapToEdgeMidpoint(c.mids, face, r2);
      if (esnap) return esnap;
    }
    return face; // face hit point as last resort.
  };

  const units = v.units;
  const readout = chrome.readout;
  // Read when used, not once: in live mode the model (and so its box) changes under the overlay.
  const bboxDims = (): string => {
    const bbox = v.box;
    return bbox ? `bbox ${formatLength(bbox.max.x - bbox.min.x, units)} × ${formatLength(bbox.max.y - bbox.min.y, units)} × ${formatLength(bbox.max.z - bbox.min.z, units)}` : "";
  };

  const addDimension = (a: Pt3, b: Pt3): void => {
    const st = active?.measure;
    if (!st) return;
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a.x, a.y, a.z), new THREE.Vector3(b.x, b.y, b.z)]);
    const mat = new THREE.LineBasicMaterial({ color: 0xffcc33, depthTest: false });
    const line: Line = new THREE.Line(geo, mat);
    group.add(line);
    const d = distance3(a, b);
    const label = makeLabel(THREE, `~ ${formatLength(d, units)} (mesh)`);
    label.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    // Scale the sprite down to a reasonable world size relative to the measured span.
    const s = (d || 1) * 0.04 + worldRadiusAt(a) * 2;
    label.scale.multiplyScalar(s / Math.max(label.scale.x, 1));
    group.add(label);
    st.objects.push(line, label);
  };

  const onMove = (e: PointerEvent): void => {
    const st = active?.measure;
    if (!st) return;
    const pt = snapAt(e);
    st.hoverPt = pt;
    if (pt) {
      marker.visible = true;
      marker.position.set(pt.x, pt.y, pt.z);
      marker.scale.setScalar(worldRadiusAt(pt) * 0.45);
      const coord = `x ${formatLength(pt.x, units)}  y ${formatLength(pt.y, units)}  z ${formatLength(pt.z, units)}`;
      const live = st.pending ? `  ·  dragging from first point: ~ ${formatLength(distance3(st.pending, pt), units)} (mesh)` : "";
      readout.textContent = `${coord}${live}   |   ${bboxDims()}`;
    } else {
      marker.visible = false;
      readout.textContent = bboxDims();
    }
  };

  const onClick = (): void => {
    const st = active?.measure;
    if (!st || !st.hoverPt) return;
    if (!st.pending) {
      st.pending = { ...st.hoverPt };
    } else {
      addDimension(st.pending, st.hoverPt);
      st.pending = null;
    }
  };

  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerdown", onClick);

  v.measure = { on: true, group, marker, pending: null, cache, onMove, onClick, hoverPt: null, objects: [] };
  readout.hidden = false;
  readout.textContent = bboxDims();
  chrome.wrap.querySelector<HTMLElement>('[data-act="measure"]')?.classList.add("on");
}

/** Remove measurement listeners + dispose lines/labels/marker. Safe to call when not active. */
function teardownMeasure(): void {
  const v = active;
  const st = v?.measure;
  if (!st) return;
  const canvas = v?.renderer?.domElement;
  canvas?.removeEventListener("pointermove", st.onMove);
  canvas?.removeEventListener("pointerdown", st.onClick);
  // Dispose created objects + marker, then drop the group from the scene.
  const disposeObj = (o: Object3D): void => {
    const m = o as Mesh & { material?: Material | Material[]; geometry?: BufferGeometry };
    m.geometry?.dispose?.();
    if (m.material) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mm of mats) {
        const map = (mm as unknown as { map?: { dispose?: () => void } }).map;
        map?.dispose?.();
        mm.dispose();
      }
    }
  };
  for (const o of st.objects) disposeObj(o);
  disposeObj(st.marker);
  v?.scene?.remove(st.group);
  if (v) v.measure = null;
}

// ── snapshot (D27 composited) ─────────────────────────────────────────────────────────────────────
/**
 * Render the current frame, composite the HUD caption (file name, units, view) over it, and return a
 * PNG blob. Exported so the snapshot fan-out orchestrator can reuse it.
 */
export async function captureSnapshot(): Promise<Blob> {
  const v = active;
  if (!v?.renderer || !v.scene || !v.camera) throw new Error("No active 3D viewer to snapshot.");
  // Force a fresh frame — preserveDrawingBuffer keeps it readable by toBlob/drawImage.
  v.renderer.render(v.scene, v.camera);

  const gl = v.renderer.domElement;
  const canvas = document.createElement("canvas");
  canvas.width = gl.width;
  canvas.height = gl.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable for snapshot compositing.");

  ctx.drawImage(gl, 0, 0);

  // Caption bar across the bottom.
  const caption = `${v.fileName}   ·   ${v.units}   ·   ${v.view}`;
  const pad = 12;
  const fontPx = Math.max(14, Math.round(canvas.width / 90));
  ctx.font = `${fontPx}px system-ui, sans-serif`;
  const barH = fontPx + pad * 2;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, canvas.height - barH, canvas.width, barH);
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(caption, pad, canvas.height - barH / 2);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Snapshot encoding failed."))), "image/png");
  });
}

// ── snapshot fan-out (D16 / Phase 6) ──────────────────────────────────────────────────────────────
/** A short-lived toast for save/insert feedback (e.g. the written project path). */
function toast(chrome: Chrome, msg: string): void {
  const el = document.createElement("div");
  el.className = "cad-toast";
  el.textContent = msg;
  chrome.wrap.querySelector(".cad-shell")?.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

const snapshotName = (v: Viewer): string => `${v.fileName.replace(/\.[^.]+$/, "")}-${v.view}.png`;

async function snapshotDownload(): Promise<void> {
  const v = active;
  if (!v) return;
  const blob = await captureSnapshot();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = snapshotName(v);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function snapshotCopy(): Promise<void> {
  const blob = await captureSnapshot();
  // Capability already gated by the menu; ClipboardItem write is the only cross-browser path.
  const item = new ClipboardItem({ "image/png": blob });
  await navigator.clipboard.write([item]);
}

/** Clipboard image write is only usable in a secure context with navigator.clipboard.write + ClipboardItem. */
function canCopyImage(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    typeof navigator !== "undefined" &&
    !!navigator.clipboard?.write &&
    typeof ClipboardItem !== "undefined"
  );
}

/**
 * Open a popover off the snapshot button offering every AVAILABLE target: download always; copy only in
 * a secure context with the clipboard API; save-to-project / insert-into-chat only when the io sink is
 * wired. Targets whose capability/sink is absent are never rendered (never a broken button).
 */
function openSnapshotMenu(chrome: Chrome): void {
  const v = active;
  if (!v) return;
  // Toggle off if already open.
  const existing = chrome.wrap.querySelector(".cad-snap-menu");
  if (existing) {
    existing.remove();
    return;
  }

  interface Target {
    key: string;
    label: string;
    ic: string;
  }
  const targets: Target[] = [{ key: "download", label: "Download", ic: "download" }];
  if (canCopyImage()) targets.push({ key: "copy", label: "Copy to clipboard", ic: "content_copy" });
  if (v.io.saveSnapshot) targets.push({ key: "save", label: "Save to project", ic: "save" });
  if (v.io.insertSnapshot) targets.push({ key: "insert", label: "Insert into chat", ic: "forum" });

  const menu = document.createElement("div");
  menu.className = "cad-snap-menu";
  menu.innerHTML = targets
    .map((t) => `<button type="button" class="cad-snap-item" data-snap="${t.key}">${icon(t.ic)} ${esc(t.label)}</button>`)
    .join("");

  menu.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-snap]");
    if (!btn) return;
    menu.remove();
    void runSnapshotTarget(btn.dataset.snap!, chrome);
  });

  const tools = chrome.wrap.querySelector(".cad-tools");
  (tools ?? chrome.wrap.querySelector(".cad-shell"))?.appendChild(menu);

  // Dismiss on the next outside click.
  const off = (ev: MouseEvent): void => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener("click", off, true);
    }
  };
  setTimeout(() => document.addEventListener("click", off, true), 0);
}

async function runSnapshotTarget(key: string, chrome: Chrome): Promise<void> {
  const v = active;
  if (!v) return;
  try {
    switch (key) {
      case "download":
        await snapshotDownload();
        break;
      case "copy":
        await snapshotCopy();
        toast(chrome, "Copied snapshot to clipboard");
        break;
      case "save": {
        if (!v.io.saveSnapshot) return;
        const blob = await captureSnapshot();
        const written = await v.io.saveSnapshot(snapshotName(v), blob);
        toast(chrome, `Saved ${written}`);
        break;
      }
      case "insert": {
        if (!v.io.insertSnapshot) return;
        const blob = await captureSnapshot();
        await v.io.insertSnapshot(snapshotName(v), blob);
        toast(chrome, "Inserted snapshot into chat");
        break;
      }
    }
  } catch (err: unknown) {
    toast(chrome, `Snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── teardown (release the WebGL context) ──────────────────────────────────────────────────────────
/** Dispose the active 3D viewer (renderer/geometry/controls/inspector/measure) without closing the
 *  modal — shared by closeViewer and the KiCad 2D↔3D toggle. */
function teardownActive(): void {
  const v = active;
  // Tear down measurement + inspector BEFORE nulling `active` (both read it).
  teardownMeasure();
  v?.inspector?.dispose();
  active = null;
  if (!v) return;

  v.live?.dispose();
  v.live = null;
  dropRenderer(v);
}

/** Stop the render loop and release the renderer, its WebGL context and the model. `v` itself stays
 *  usable (live mode builds a new renderer for the next revision after a failed first load). */
function dropRenderer(v: Viewer): void {
  if (v.raf) cancelAnimationFrame(v.raf);
  v.raf = undefined;
  v.controls?.dispose();

  // Dispose geometries + materials across the model graph.
  if (v.model) disposeModel(v.model);

  const r = v.renderer;
  if (r) {
    (r as unknown as { __ro?: ResizeObserver }).__ro?.disconnect();
    r.dispose();
    // Force the context to drop so the browser reclaims the WebGL resource promptly.
    r.forceContextLoss?.();
    r.domElement.remove();
  }
  v.renderer = undefined;
  v.scene = undefined;
  v.camera = undefined;
  v.controls = undefined;
  v.model = undefined;
}

/** Fully release the active viewer (3D renderer/context + ECAD cleanup) WITHOUT touching the modal.
 *  Shared by closeViewer and openCadViewer so neither path leaks a WebGL context. */
function releaseActiveViewer(): void {
  const prev = active;
  if (!prev) return;
  kicadToggle = null;
  teardownActive(); // disposes the 3D renderer + forceContextLoss; nulls `active`
  // Gerber / KiCad 2D stash their own teardown on the stage element (no renderer to drop).
  const cleanup = (prev.chrome?.stage as unknown as { __cadCleanup?: () => void } | undefined)?.__cadCleanup;
  if (typeof cleanup === "function") {
    try {
      cleanup();
    } catch {
      /* a failed ECAD teardown must not block the next open */
    }
  }
}

function closeViewer(): void {
  releaseActiveViewer();
  closeModal();
}

// ── KiCad 2D (KiCanvas) ↔ 3D (daemon kicad-cli GLB) toggle (Phase 5) ────────────────────────────
let kicadToggle: { path: string; chrome: Chrome; io: CadIo; is3d: boolean } | null = null;

async function toggleKicad3d(chrome: Chrome): Promise<void> {
  if (!kicadToggle) return;
  const { path, io } = kicadToggle;
  const to3d = !kicadToggle.is3d;

  teardownActive(); // drop the 3D viewer if it was up
  const prevCleanup = (chrome.stage as unknown as { __cadCleanup?: () => void }).__cadCleanup;
  if (typeof prevCleanup === "function") {
    try {
      prevCleanup();
    } catch {
      /* a failed ECAD teardown must not block the switch */
    }
  }
  chrome.stage.replaceChildren();
  kicadToggle.is3d = to3d;

  const btn = chrome.wrap.querySelector<HTMLButtonElement>('[data-act="ecad3d"]');
  if (btn) {
    btn.classList.toggle("active", to3d);
    btn.title = to3d ? "2D view (KiCanvas)" : "3D board";
  }

  if (to3d) {
    // The .kicad_pcb's cadUrl routes to the daemon, which runs `kicad-cli pcb export glb` with the
    // component 3D models and streams the GLB back — rendered by the same brep 3D pipeline.
    // Recreate the viewer skeleton teardownActive() cleared; init3d populates renderer/scene/model.
    active = { units: "—", zUp: false, view: "iso", wireframe: false, fileName: fileNameOf(path), path, io, chrome };
    showStatus(chrome.statusArea, `<div class="cad-card">${icon("hourglass_empty")} Building 3D board…</div>`);
    try {
      await init3d(path, "brep", chrome, io);
    } catch (err) {
      showError(chrome.statusArea, err instanceof Error ? err.message : String(err), io.fileUrl(path), fileNameOf(path));
    }
  } else {
    await delegateEcad(path, "kicad-pcb", chrome, io);
  }
}
