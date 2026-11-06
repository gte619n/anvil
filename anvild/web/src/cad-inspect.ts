// ── cad-inspect.ts — model tree + part isolation / section / exploded view (Phase 3) ───────────────
// A side drawer that lists the loaded assembly's parts and lets you show/hide/isolate them, toggle
// per-part transparency, and frame a part. Also owns the section (clipping-plane) and exploded-view
// state since those are per-part scene manipulations that live alongside the tree.
//
// three.js is NEVER imported at runtime here — only `import type`. cad.ts passes in the already-loaded
// `THREE` namespace + scene objects so this module keeps the lazy-chunk property of the viewer.
//
// Spec: docs/plans/2026-11-06-cad-viewer.md §Phase 3.
import { esc, icon } from "./dom";
import type { Object3D, Mesh, Material, Box3, Vector3, PerspectiveCamera } from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/** The hierarchy the daemon stamps into glTF `asset.extras.tree` (names + mesh index lists). */
export interface CadNode {
  name: string;
  meshIndices: number[];
  children: CadNode[];
}

/** One logical part: a label + the set of scene meshes it maps to. */
interface Part {
  id: number;
  name: string;
  meshes: Mesh[];
  depth: number;
  row?: HTMLElement;
  home: Vector3; // original local position of the part's first mesh's top-level group, for explode restore.
}

type THREE = typeof import("three");

export interface InspectHandle {
  panel: HTMLElement;
  /** Tear down listeners and restore materials/positions/clipping. Called from cad.ts closeViewer. */
  dispose(): void;
  /** Section-plane control surface (null until enabled). cad.ts wires the toolbar to these. */
  toggleSection(): void;
  setSectionAxis(axis: "x" | "y" | "z"): void;
  setSectionPos(norm: number): void;
  /** Exploded view control. */
  toggleExplode(): void;
  setExplode(norm: number): void;
  isSectionOn(): boolean;
  isExplodeOn(): boolean;
}

interface InspectDeps {
  THREE: THREE;
  model: Object3D;
  box: Box3;
  renderer: { localClippingEnabled: boolean; clippingPlanes: unknown[] };
  camera: PerspectiveCamera;
  controls: OrbitControls;
  extrasTree?: CadNode | null;
  /** Re-frame the whole model (cad.ts fitToView). */
  fit(): void;
}

/** Collect the meshes a CadNode (and its descendants) reference, from the ordered mesh list. */
function meshesForNode(node: CadNode, allMeshes: Mesh[]): Mesh[] {
  const out: Mesh[] = [];
  const walk = (n: CadNode): void => {
    for (const mi of n.meshIndices) {
      const m = allMeshes[mi];
      if (m) out.push(m);
    }
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}

/** Ordered list of every Mesh in the graph (index order matches the GLB mesh order used by extras). */
function collectMeshes(THREE: THREE, root: Object3D): Mesh[] {
  const meshes: Mesh[] = [];
  root.traverse((o: Object3D) => {
    const m = o as Mesh;
    if ((m as unknown as { isMesh?: boolean }).isMesh) meshes.push(m);
  });
  void THREE;
  return meshes;
}

/**
 * Build the flat part list. Prefer the extras tree (real part names + hierarchy); otherwise fall back
 * to walking the scene graph, treating each named Object3D (or each top-level child) as a part.
 */
function buildParts(deps: InspectDeps): Part[] {
  const { THREE, model, extrasTree } = deps;
  const allMeshes = collectMeshes(THREE, model);
  const parts: Part[] = [];
  let id = 0;

  if (extrasTree && Array.isArray(extrasTree.children)) {
    // Flatten the CadNode hierarchy; keep depth for indentation. The synthetic root is skipped if it
    // only wraps children (common for assemblies).
    const walk = (n: CadNode, depth: number): void => {
      const meshes = meshesForNode(n, allMeshes);
      const name = n.name || `part ${id + 1}`;
      // A node with its own meshes OR with a meaningful name becomes a row.
      parts.push({
        id: id++,
        name,
        meshes,
        depth,
        home: new THREE.Vector3(),
      });
      for (const c of n.children) walk(c, depth + 1);
    };
    // If the root is an unnamed wrapper with children, enter its children at depth 0.
    if (!extrasTree.name && extrasTree.meshIndices.length === 0) {
      for (const c of extrasTree.children) walk(c, 0);
    } else {
      walk(extrasTree, 0);
    }
  } else {
    // Scene-graph fallback: top-level children of the model are parts; name them from the Object3D.
    const children = model.children.length ? model.children : [model];
    children.forEach((child, i) => {
      const meshes: Mesh[] = [];
      child.traverse((o: Object3D) => {
        const m = o as Mesh;
        if ((m as unknown as { isMesh?: boolean }).isMesh) meshes.push(m);
      });
      if (!meshes.length) return;
      parts.push({
        id: id++,
        name: child.name || `part ${i + 1}`,
        meshes,
        depth: 0,
        home: new THREE.Vector3(),
      });
    });
  }
  // Record each part's explode home = centroid of its meshes (world), used for radial translation.
  for (const p of parts) {
    const c = new THREE.Vector3();
    const b = new THREE.Box3();
    for (const m of p.meshes) b.expandByObject(m);
    if (!b.isEmpty()) b.getCenter(c);
    p.home.copy(c);
  }
  return parts;
}

/** Set every material on a mesh list to a transparent/opaque state (toggled per part). */
function setPartTransparent(meshes: Mesh[], on: boolean): void {
  for (const m of meshes) {
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      const mm = mat as Material & { transparent?: boolean; opacity?: number };
      mm.transparent = on;
      mm.opacity = on ? 0.3 : 1;
      mm.needsUpdate = true;
    }
  }
}

export function buildInspector(deps: InspectDeps): InspectHandle {
  const { THREE, box, renderer, camera, controls } = deps;
  const parts = buildParts(deps);

  // ── side drawer ─────────────────────────────────────────────────────────────────────────────
  const panel = document.createElement("div");
  panel.className = "cad-tree";
  const rows = parts
    .map(
      (p) =>
        `<div class="cad-tree-row" data-part="${p.id}" style="padding-left:${8 + p.depth * 14}px">` +
        `<button type="button" class="cad-tree-vis" data-op="vis" data-part="${p.id}" title="Show / hide">${icon("visibility")}</button>` +
        `<span class="cad-tree-name" data-op="frame" data-part="${p.id}" title="Frame this part">${esc(p.name)}</span>` +
        `<button type="button" class="cad-tree-iso" data-op="iso" data-part="${p.id}" title="Isolate">${icon("filter_center_focus")}</button>` +
        `<button type="button" class="cad-tree-xray" data-op="xray" data-part="${p.id}" title="Transparent">${icon("opacity")}</button>` +
        `</div>`,
    )
    .join("");
  panel.innerHTML =
    `<div class="cad-tree-head">${icon("account_tree")} Model tree <button type="button" class="cad-tree-all" data-op="all" title="Show all">${icon("select_all")}</button></div>` +
    `<div class="cad-tree-body">${rows || '<div class="cad-tree-empty">No named parts.</div>'}</div>`;

  for (const p of parts) p.row = panel.querySelector<HTMLElement>(`.cad-tree-row[data-part="${p.id}"]`) ?? undefined;

  const visible = new Map<number, boolean>(parts.map((p) => [p.id, true]));
  const xray = new Map<number, boolean>(parts.map((p) => [p.id, false]));

  const applyVisible = (p: Part, on: boolean): void => {
    visible.set(p.id, on);
    for (const m of p.meshes) m.visible = on;
    p.row?.classList.toggle("cad-hidden-part", !on);
  };

  const framePart = (p: Part): void => {
    const b = new THREE.Box3();
    for (const m of p.meshes) b.expandByObject(m);
    if (b.isEmpty()) return;
    const center = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const fov = (camera.fov * Math.PI) / 180;
    const dist = (maxDim / 2 / Math.tan(fov / 2)) * 1.8;
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
    if (dir.lengthSq() === 0) dir.set(1, 1, 1);
    dir.normalize().multiplyScalar(dist);
    controls.target.copy(center);
    camera.position.copy(center).add(dir);
    camera.updateProjectionMatrix();
    controls.update();
  };

  const onClick = (e: Event): void => {
    const t = e.target as HTMLElement;
    const btn = t.closest<HTMLElement>("[data-op]");
    if (!btn) return;
    const op = btn.dataset.op!;
    if (op === "all") {
      for (const p of parts) applyVisible(p, true);
      return;
    }
    const pid = Number(btn.dataset.part);
    const part = parts.find((p) => p.id === pid);
    if (!part) return;
    switch (op) {
      case "vis":
        applyVisible(part, !(visible.get(pid) ?? true));
        break;
      case "iso":
        for (const p of parts) applyVisible(p, p.id === pid);
        framePart(part);
        break;
      case "xray": {
        const on = !(xray.get(pid) ?? false);
        xray.set(pid, on);
        setPartTransparent(part.meshes, on);
        btn.classList.toggle("on", on);
        break;
      }
      case "frame":
        framePart(part);
        break;
    }
  };
  panel.addEventListener("click", onClick);

  // ── section / clipping plane ────────────────────────────────────────────────────────────────
  let sectionOn = false;
  let sectionAxis: "x" | "y" | "z" = "x";
  let sectionNorm = 0.5; // 0..1 across the axis extent
  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  const clippedMats = new Set<Material>();

  const axisVec = (): Vector3 =>
    sectionAxis === "x"
      ? new THREE.Vector3(-1, 0, 0)
      : sectionAxis === "y"
        ? new THREE.Vector3(0, -1, 0)
        : new THREE.Vector3(0, 0, -1);

  const applyPlane = (): void => {
    const min = sectionAxis === "x" ? box.min.x : sectionAxis === "y" ? box.min.y : box.min.z;
    const max = sectionAxis === "x" ? box.max.x : sectionAxis === "y" ? box.max.y : box.max.z;
    const coord = min + (max - min) * sectionNorm;
    const n = axisVec();
    // Plane: n·p + constant = 0, keeping the half where n·p + constant >= 0. n is axis-aligned, so
    // n·p at the cut point = nAxis * coord; constant = -that.
    const nAxis = sectionAxis === "x" ? n.x : sectionAxis === "y" ? n.y : n.z;
    plane.set(n, -coord * nAxis);
  };

  const enableClipOnMaterials = (on: boolean): void => {
    clippedMats.clear();
    deps.model.traverse((o: Object3D) => {
      const m = o as Mesh;
      if (!(m as unknown as { isMesh?: boolean }).isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        const mm = mat as Material;
        mm.clippingPlanes = on ? [plane] : [];
        mm.needsUpdate = true;
        if (on) clippedMats.add(mm);
      }
    });
  };

  const toggleSection = (): void => {
    sectionOn = !sectionOn;
    renderer.localClippingEnabled = sectionOn;
    if (sectionOn) {
      applyPlane();
      enableClipOnMaterials(true);
    } else {
      enableClipOnMaterials(false);
    }
  };
  const setSectionAxis = (axis: "x" | "y" | "z"): void => {
    sectionAxis = axis;
    if (sectionOn) applyPlane();
  };
  const setSectionPos = (norm: number): void => {
    sectionNorm = Math.max(0, Math.min(1, norm));
    if (sectionOn) applyPlane();
  };

  // ── exploded view ───────────────────────────────────────────────────────────────────────────
  let explodeOn = false;
  let explodeNorm = 0;
  const assemblyCenter = box.getCenter(new THREE.Vector3());
  // Capture each part's original world-anchored offset via its meshes' local positions.
  const originals = new Map<number, { mesh: Mesh; pos: Vector3 }[]>();
  for (const p of parts) {
    originals.set(
      p.id,
      p.meshes.map((m) => ({ mesh: m, pos: m.position.clone() })),
    );
  }

  const applyExplode = (): void => {
    const maxDim = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) || 1;
    for (const p of parts) {
      const saved = originals.get(p.id)!;
      // Radial direction from assembly centre to the part centroid, in world space.
      const dir = new THREE.Vector3().subVectors(p.home, assemblyCenter);
      if (dir.lengthSq() === 0) dir.set(0, 0, 0);
      else dir.normalize();
      const shift = dir.multiplyScalar(explodeNorm * maxDim * 0.6);
      for (const s of saved) {
        // Convert the world-space shift into the mesh's parent space so nested transforms hold.
        s.mesh.position.copy(s.pos).add(worldShiftToLocal(THREE, s.mesh, shift));
      }
    }
  };

  const toggleExplode = (): void => {
    explodeOn = !explodeOn;
    if (!explodeOn) {
      // Restore originals exactly.
      for (const p of parts) for (const s of originals.get(p.id)!) s.mesh.position.copy(s.pos);
      explodeNorm = 0;
    } else {
      applyExplode();
    }
  };
  const setExplode = (norm: number): void => {
    explodeNorm = Math.max(0, Math.min(1, norm));
    if (explodeOn) applyExplode();
  };

  const dispose = (): void => {
    panel.removeEventListener("click", onClick);
    // Restore materials (transparency + clipping) and positions.
    for (const p of parts) {
      setPartTransparent(p.meshes, false);
      for (const m of p.meshes) m.visible = true;
      for (const s of originals.get(p.id)!) s.mesh.position.copy(s.pos);
    }
    for (const mm of clippedMats) {
      mm.clippingPlanes = [];
      mm.needsUpdate = true;
    }
    clippedMats.clear();
    renderer.localClippingEnabled = false;
    panel.remove();
  };

  return {
    panel,
    dispose,
    toggleSection,
    setSectionAxis,
    setSectionPos,
    toggleExplode,
    setExplode,
    isSectionOn: () => sectionOn,
    isExplodeOn: () => explodeOn,
  };
}

/** Translate a world-space delta into a mesh's parent-local delta (so nested transforms are respected). */
function worldShiftToLocal(THREE: THREE, mesh: Mesh, worldShift: Vector3): Vector3 {
  if (!mesh.parent) return worldShift.clone();
  const a = mesh.getWorldPosition(new THREE.Vector3());
  const b = a.clone().add(worldShift);
  const la = mesh.parent.worldToLocal(a.clone());
  const lb = mesh.parent.worldToLocal(b.clone());
  return lb.sub(la);
}
