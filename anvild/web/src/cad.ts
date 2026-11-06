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
} from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

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
}
let active: Viewer | null = null;

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
    `<button type="button" class="cad-btn" data-act="snapshot" title="Snapshot (PNG)">${icon("photo_camera")}</button>` +
    `<button type="button" class="cad-btn" data-act="close" title="Close">${icon("close")}</button>` +
    `</div>` +
    `</div>`;

  const stage = wrap.querySelector<HTMLElement>('[data-role="stage"]')!;
  const unitsBadge = wrap.querySelector<HTMLElement>('[data-role="units"]')!;
  const statusArea = wrap.querySelector<HTMLElement>('[data-role="status"]')!;
  const axisBtn = wrap.querySelector<HTMLButtonElement>('[data-act="axis"]')!;
  return { wrap, stage, unitsBadge, statusArea, axisBtn };
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

// ── public entry ────────────────────────────────────────────────────────────────────────────────
export function openCadViewer(path: string, io: CadIo): void {
  const kind = classifyCad(path);
  const chrome = buildChrome(path);
  const name = fileNameOf(path);

  active = {
    units: "—",
    zUp: false,
    view: "iso",
    wireframe: false,
    fileName: name,
    path,
    io,
  };

  // Toolbar + HUD wiring. All buttons are delegated off the wrap so we add one listener.
  chrome.wrap.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const btn = t.closest<HTMLElement>("[data-act]");
    if (btn) {
      void handleAction(btn.dataset.act!, chrome);
      return;
    }
    // A click on the bare backdrop (outside the shell) dismisses, like the image lightbox.
    if (t === chrome.wrap) closeViewer();
  });

  showModal(chrome.wrap);

  if (!kind) {
    showError(chrome.statusArea, `Unrecognised CAD format (.${extOf(path) || "?"}).`, io.fileUrl(path), name);
    return;
  }

  if (kind === "gerber" || kind === "kicad-pcb" || kind === "kicad-sch") {
    void delegateEcad(path, kind, chrome, io);
    return;
  }

  // 3D pipeline (mesh | brep).
  showStatus(chrome.statusArea, `<div class="cad-card">${icon("hourglass_empty")} Loading…</div>`);
  void init3d(path, kind, chrome, io).catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    showError(chrome.statusArea, reason, io.fileUrl(path), name);
  });
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
    case "snapshot":
      await downloadSnapshot();
      break;
  }
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
  const loaded = await loadModel(THREE, path, kind, io, budget);

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
  active!.model = model;
  active!.units = loaded.units;
  active!.zUp = loaded.zUp;
  chrome.unitsBadge.textContent = loaded.units;

  // D20: normalize up-axis if the model reads Z-up, then frame it.
  applyUpAxis(THREE, model);
  recomputeBox(THREE, model);
  fitToView();

  hideStatus(chrome.statusArea);

  // Render loop (damped controls need continuous frames).
  const tick = (): void => {
    active!.raf = requestAnimationFrame(tick);
    controls.update();
    renderer.render(scene, camera);
  };
  tick();
}

interface LoadResult {
  object: Object3D;
  units: string;
  zUp: boolean;
  triangles: number;
  tooLarge: boolean;
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
): Promise<LoadResult> {
  const ext = extOf(path);

  if (kind === "brep") {
    // Server tessellates the B-rep to GLB at our requested LOD; we parse the bytes locally.
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const url = io.cadUrl(path, budget.maxTriangles);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Conversion failed (HTTP ${res.status}). The server couldn't tessellate this B-rep.`);
    const buf = await res.arrayBuffer();
    const loader = new GLTFLoader();
    const gltf = await loader.parseAsync(buf, "");
    const extras = (gltf.asset?.extras ?? {}) as { units?: string; zUp?: boolean };
    const object = gltf.scene as unknown as Object3D;
    const triangles = countTriangles(THREE, object);
    const units = typeof extras.units === "string" ? extras.units : "mm";
    const zUp = extras.zUp === true;
    return { object, units, zUp, triangles, tooLarge: triangles > budget.maxTriangles };
  }

  // Mesh formats: load client-side by extension.
  const shadedMat = (): Material =>
    new THREE.MeshStandardMaterial({ color: 0xb8c0cc, roughness: 0.65, metalness: 0.1, side: THREE.DoubleSide });

  let object: Object3D;
  let units = "unitless"; // STL/OBJ/PLY carry no unit; GLTF is metres by spec.

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
      const gltf = await new GLTFLoader().parseAsync(buf, path.replace(/[^/]+$/, ""));
      object = gltf.scene as unknown as Object3D;
      units = "m"; // glTF is defined in metres.
      break;
    }
    default:
      throw new Error(`No loader for .${ext} meshes.`);
  }

  const triangles = countTriangles(THREE, object);
  return { object, units, zUp: false, triangles, tooLarge: triangles > budget.maxTriangles };
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
    const dist = (maxDim / 2 / Math.tan(fov / 2)) * 1.6;

    v.controls!.target.copy(center);
    // Keep the current view direction; just back the camera off to the fit distance.
    const dirv = new THREE.Vector3().subVectors(v.camera!.position, v.controls!.target);
    if (dirv.lengthSq() === 0) dirv.set(1, 1, 1);
    dirv.normalize().multiplyScalar(dist);
    v.camera!.position.copy(center).add(dirv);
    v.camera!.near = dist / 100;
    v.camera!.far = dist * 100;
    v.camera!.updateProjectionMatrix();
    v.controls!.update();
  })();
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
  v.model.traverse((o: Object3D) => {
    const m = o as Mesh;
    const mat = m.material;
    if (!mat) return;
    const mats = Array.isArray(mat) ? mat : [mat];
    for (const one of mats) {
      const w = one as Material & { wireframe?: boolean };
      if ("wireframe" in w) w.wireframe = v.wireframe;
    }
  });
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

async function downloadSnapshot(): Promise<void> {
  const v = active;
  if (!v) return;
  try {
    const blob = await captureSnapshot();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${v.fileName.replace(/\.[^.]+$/, "")}-${v.view}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke after the click has had a chance to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch {
    // Snapshot is a convenience; swallow so a failure never breaks the viewer.
  }
}

// ── teardown (release the WebGL context) ──────────────────────────────────────────────────────────
function disposeMaterial(mat: Material | Material[]): void {
  const mats = Array.isArray(mat) ? mat : [mat];
  for (const m of mats) m.dispose();
}

function closeViewer(): void {
  const v = active;
  active = null;
  closeModal();
  if (!v) return;

  if (v.raf) cancelAnimationFrame(v.raf);
  v.controls?.dispose();

  // Dispose geometries + materials across the model graph.
  v.model?.traverse((o: Object3D) => {
    const m = o as Mesh;
    (m.geometry as BufferGeometry | undefined)?.dispose?.();
    if (m.material) disposeMaterial(m.material);
  });

  const r = v.renderer;
  if (r) {
    (r as unknown as { __ro?: ResizeObserver }).__ro?.disconnect();
    r.dispose();
    // Force the context to drop so the browser reclaims the WebGL resource promptly.
    r.forceContextLoss?.();
    r.domElement.remove();
  }
}
