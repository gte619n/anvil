/**
 * Golden-image harness render entry. A deliberately minimal three.js loader that mirrors the SHAPE
 * of `web/src/cad.ts`'s mesh path — same renderer flags (antialias + preserveDrawingBuffer), same
 * clear color, same lights, same MeshStandardMaterial — so the goldens track the real viewer, but
 * without the viewer's chrome/HUD/OrbitControls (determinism: a FIXED camera, no animation loop,
 * a single synchronous render).
 *
 * Bundled + served by `server.ts`. Reads `?fixture=<name>&ext=<stl|glb>` from the URL, loads the
 * fixture from `/fixtures/mesh/<name>`, frames it, renders ONE frame, then sets `window.__cadReady`.
 * On any failure it sets `window.__cadError` (the spec surfaces it instead of timing out blindly).
 */
import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  AmbientLight,
  DirectionalLight,
  MeshStandardMaterial,
  Mesh,
  Box3,
  Vector3,
  DoubleSide,
  type Object3D,
  type BufferGeometry,
} from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

declare global {
  interface Window {
    __cadReady?: boolean;
    __cadError?: string;
  }
}

const SIZE = 512; // fixed, matches the viewport in playwright.config.ts

function params(): { fixture: string; ext: string } {
  const q = new URLSearchParams(location.search);
  return { fixture: q.get("fixture") || "cube.stl", ext: (q.get("ext") || "stl").toLowerCase() };
}

async function loadMesh(url: string, ext: string): Promise<Object3D> {
  const mat = () =>
    new MeshStandardMaterial({ color: 0xb8c0cc, roughness: 0.65, metalness: 0.1, side: DoubleSide });
  if (ext === "stl") {
    const geom: BufferGeometry = await new STLLoader().loadAsync(url);
    geom.computeVertexNormals();
    return new Mesh(geom, mat());
  }
  if (ext === "glb" || ext === "gltf") {
    const gltf = await new GLTFLoader().loadAsync(url);
    gltf.scene.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) m.material = mat();
    });
    return gltf.scene;
  }
  throw new Error(`harness supports stl/glb only, got: ${ext}`);
}

/** Frame the object dead-center with a fixed 3/4 view so the shot is deterministic. */
function frame(camera: PerspectiveCamera, root: Object3D): void {
  const box = new Box3().setFromObject(root);
  const center = box.getCenter(new Vector3());
  const radius = box.getSize(new Vector3()).length() / 2 || 1;
  const dist = radius / Math.sin((45 * Math.PI) / 180 / 2);
  // Fixed 3/4 isometric-ish direction.
  const dir = new Vector3(1, 0.8, 1).normalize();
  camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

async function main(): Promise<void> {
  const { fixture, ext } = params();
  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1); // determinism: never scale by device pixel ratio
  renderer.setSize(SIZE, SIZE);
  renderer.setClearColor(0x1a1c20, 1);
  document.getElementById("stage")!.appendChild(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 0.01, 100000);

  scene.add(new AmbientLight(0xffffff, 0.6));
  const d1 = new DirectionalLight(0xffffff, 0.9);
  d1.position.set(1, 1, 1);
  scene.add(d1);
  const d2 = new DirectionalLight(0xffffff, 0.4);
  d2.position.set(-1, -0.5, -1);
  scene.add(d2);

  const object = await loadMesh(`/fixtures/mesh/${fixture}`, ext);
  scene.add(object);
  frame(camera, object);

  // A single synchronous frame — no rAF loop, no OrbitControls damping — so the pixels are stable.
  renderer.render(scene, camera);
  window.__cadReady = true;
}

main().catch((err: unknown) => {
  window.__cadError = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error("[harness]", err);
});
