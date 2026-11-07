# Draco-compressed GLB support — RESOLVED (re-applied; the "Bun bundler bug" was a misdiagnosis)

- **Status:** ✅ Implemented on branch `cad-viewer_followup_followup` · **Area:** CAD viewer · **Was:** reverted from PR #236
- **Priority:** Low — only affects Blender-style *compressed* GLBs; see "Priority" below.

## Resolution (2026-11-07) — the real root cause was NOT a Bun two-build cache bug

The ~23 red boot/mirror/subagent web tests were **not** caused by two in-process `Bun.build`s poisoning
each other's resolution cache (the theory below). That theory was wrong — and verifiably so: with the
Draco wiring re-applied, `boot-init.test.ts` fails *in isolation* too (a single build), and bundling
`main.ts` twice in one process both succeed.

**Actual cause:** three's `DRACOLoader.js` contains
`new URL("../libs/draco/draco_decoder.wasm", import.meta.url)`. The boot tests bundle `main.ts` as an
**IIFE** (`test/web/boot-bundle.ts`) and jsdom runs that bundle as a **classic `<script>`**, where any
surviving `import.meta` is a **parse-time `SyntaxError`** — it aborts the entire bundle *before* the
harness's boot `try/catch`, so every boot test sees `theme`/`initErr` both null. Production was never
affected: that build is ESM + splitting (where `import.meta` is legal), and the viewer overrides the
decoder location with `setDecoderPath("/draco/")` anyway.

**The infra fix:** `test/web/boot-bundle.ts` now passes `define: { "import.meta.url": "\"file:///boot-bundle\"" }`
to `Bun.build`, stripping every `import.meta` from the IIFE test bundle. This is test-harness-only; no
product code changed for it. (The stale "subprocess every client-graph build" plan below was unneeded —
`bundle-hash.test.ts` already subprocesses, and subprocessing never removes the `import.meta` token.)

**Verified:** full `bun test` 1332 pass / 0 fail (199 files); web suite 193/0; CAD fixtures 17/0;
typecheck clean; `build:web` clean (decoder copied to `dist/draco/`); and a headless-chromium check
decodes the real `assembly-draco.glb` → 3 meshes / 36 triangles, no page errors.

---

_Original deferral note (root-cause theory below is superseded by the Resolution above):_

## What it is

Most real-world `.glb` exports (Blender's glTF exporter, gltf-transform, many pipelines) use **Draco**
geometry compression. three's `GLTFLoader` throws **`THREE.GLTFLoader: No DRACOLoader instance
provided.`** on those unless a `DRACOLoader` is wired. The viewer's `wireGltfDecoders` (`web/src/cad.ts`)
only wires the **meshopt** decoder, so a Draco `.glb` fails to open — the one format that fails while
STL/OBJ and server-converted STEP (none Draco) open fine.

Symptom, reproduced in the headless harness: the viewer opens, then shows the error card
*"Couldn't open this file — THREE.GLTFLoader: No DRACOLoader instance provided."*

## The fix (written, verified, then reverted)

Original commit **`669362b`** — "fix(cad): render Draco-compressed GLBs (wire DRACOLoader)":

- `web/src/cad.ts` `wireGltfDecoders`: also attach a `DRACOLoader` with `setDecoderPath("/draco/")`.
- `web/build.ts`: `cpSync` three's `node_modules/three/examples/jsm/libs/draco/gltf` → `dist/draco/`
  (served at `/draco/`; rides into the native apps via `bundle-native.ts`'s recursive `dist/` copy —
  see the "runtime web assets ship via build.ts" note in CLAUDE.md).
- Added a committed Draco fixture `test/fixtures/cad/mesh/assembly-draco.glb` + a regression test in
  `test/golden/fixtures.test.ts`.

It **worked**: reproduced the exact error card in the shot harness, then confirmed the *same* Draco GLB
rendered after the fix (the harness already serves `/draco/`).

## Why it was deferred

Importing three's `DRACOLoader` **anywhere in the graph** trips a **Bun bundler bug**: running
`Bun.build` twice in one `bun test` process over the (now larger) `web/src/main.ts` dependency graph
corrupts the bundler's **shared resolution cache** — dynamic chunk imports get misattributed and the
later build fails to resolve (documented in `test/web/boot-bundle.ts`). This turned **~23** boot / mirror
/ subagent web tests red in CI (and locally); every one of them builds+boots the client via
`buildBootBundle`.

### Evidence it's the Bun bug, not product code
- Clean `main` (`bf3c632`) → full web suite **0 fail**, CI green — with the whole CAD viewer present.
- Reverting **only** `web/src/cad.ts` (the `DRACOLoader` import) → **0 fail** (the clickable-chips change
  was kept and is innocent).
- `boot-init.test.ts` **passes in isolation** but **fails in the full suite** — the classic two-build
  corruption signature.
- All 23 failing files consume `buildBootBundle`; the *other* in-process build in the suite is
  `bundle-hash.test.ts`'s `buildWeb()`.

### What was tried and did NOT clear it
1. Run `buildBootBundle`'s `Bun.build` in a **subprocess** (fresh cache) — still 23 fail.
2. **Consolidate** `GLTFLoader` + `MeshoptDecoder` + `DRACOLoader` into one lazy module (fewer dynamic
   chunks than `main` had) — still 23 fail.

The trigger is specifically the `DRACOLoader` module (it sets up a worker / dynamic decoder load),
not merely the chunk count.

## How to resume

1. **Fix the test infra first.** Make two in-process `Bun.build`s of the client graph unable to corrupt
   each other — e.g. run *every* client-graph `Bun.build` in the `test/web` suite in its own subprocess
   (both `test/web/boot-bundle.ts` and `test/web/bundle-hash.test.ts`), or otherwise guarantee one
   `Bun.build` per process. **Regression-proof it:** add a throwaway extra dynamic `import()` to the
   graph and confirm the full `bun test` stays green (that reproduces the tipping condition without
   Draco).
2. **Re-apply the Draco change** — cherry-pick commit `669362b` (DRACOLoader wiring + `/draco/` asset
   copy in `build.ts` + the `assembly-draco.glb` fixture/test). The revert commit is `76e7219`.
3. **Verify:** `assembly-draco.glb` renders in the shot harness, and the full `bun test` stays green.

## Priority

**Low.** It only affects Blender-style *compressed* GLBs. The common cases work today on v5.3.86+:
`kicad-cli pcb export glb` and `gmsh` STL exports are **uncompressed**, as are gltf-transform exports
without the Draco pass; STL/OBJ/3MF/PLY/STEP/IGES/FreeCAD and the server-converted paths are unaffected.
