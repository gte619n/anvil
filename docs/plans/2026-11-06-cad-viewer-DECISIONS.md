# CAD Viewer — Implementation Decision Log

Companion to `2026-11-06-cad-viewer.md`. Records decisions made during the autonomous
implementation pass (the owner asked: "make the best decision you can… write it to a decision
log… we will review"). Each entry: **what was decided, why, and any spec deviation / follow-up.**

Legend: ✅ aligns with spec · ⚠️ deviation or scope call to review · 🔬 verification note

---

## Strategy

- **DL-1 (⚠️ review).** **Scope realism in one environment.** The spec is 11 phases spanning a WASM
  conversion kernel, a three.js viewer, vendored ECAD libs, and a headless-WebGL golden harness. In
  this sandboxed worktree I can install npm deps and run `bun test` / `typecheck` / `typecheck:web`
  / `build:web`, and attempt the occt-import-js conversion spike. **Browser-GL golden *baselines*
  cannot be captured here** (no GPU/display; Playwright+SwiftShader is a CI concern). Plan: build all
  code + the harness + fixtures; verify via unit tests + typecheck + bundle build + the conversion
  spike; mark golden-baseline capture as a CI follow-up, logged honestly rather than faked.
- **DL-2.** **Decision-log file** = this file, following the repo's `-DECISIONS.md` companion
  convention (just documented in CLAUDE.md).
- **DL-3.** **Dependency-order build, subagents for disjoint modules.** I own shared-file edits
  (`http.ts`, `panel.ts`, `main.ts`, `build.ts`, `package.json`) to avoid parallel-edit conflicts;
  subagents build the new self-contained modules (`src/cad/*`, `web/src/cad*`, fixtures, harness)
  against fixed contracts, then I integrate + verify.
- **DL-4 (🔬).** node_modules is a **real dir** in this worktree (not the usual symlink), so
  `bun add` is isolated and won't mutate the canonical checkout. bun.lock will update (expected;
  CI uses frozen-lockfile, so the lock must be committed).

---

## Module build results (4 parallel agents, disjoint files)

- **DL-14 (🔬).** **Daemon pipeline — 21/21 unit tests pass.** `src/cad/{types,formats,occt-run,occt-worker,
  glb,convert,cache,queue,kicad}.ts`. Worker-thread isolation (`new Worker(...occt-worker.ts)`) works under
  Bun (crash containment + `terminate()` on timeout), with an in-process fallback if worker spawn fails.
- **DL-15 (⚠️ review).** **STEP cube fixture hand-authored** (`test/fixtures/cad/brep/cube.step`, CC0, a
  real closed-shell `manifold_solid_brep`, loads in occt: bbox [0,0,0]→[10,10,10]). **IGES + FCStd
  committed fixtures remain CI follow-ups** (no clean kernel to generate them here) — code paths are
  unit-tested, end-to-end golden deferred.
- **DL-16 (⚠️ review).** **`.txt` is deliberately NOT classified as Gerber** (web `cad-types.ts` AND
  `cad-ecad.ts`): whats-that-gerber treats every `.txt` as an Excellon drill, which would hijack ordinary
  text files. Consequence: a `.txt`-named drill file won't auto-render as Gerber (rare; needs an explicit
  "open as Gerber" path — not built in v1).
- **DL-17 (⚠️ review).** **KiCanvas fed via `<kicanvas-source src=fileUrl>`** (REST URL preserves the real
  extension for KiCanvas's type detection). Hierarchical multi-sheet schematics that reference siblings by
  relative path may not fully resolve through the `?path=` URL — accepted v1 limitation (spec §3.3).
- **DL-18 (⚠️ review — matches DL-1).** **Golden baselines are CI-deferred.** No Playwright browser / no
  GPU/display here. Built: `test/golden/{playwright.config.ts,harness.html,harness-entry.ts,server.ts,
  cad.spec.ts,README.md}` with SwiftShader determinism flags + desktop/android projects. The **non-browser**
  `fixtures.test.ts` passes (15/15); browser baselines must be captured in CI via `--update-snapshots`.
- **DL-19 (🔬).** tracespace v4 is CJS (`export =`): consumed via `(mod).default ?? mod` interop;
  `pcbStackup<string>(...)` pins the SVG type under strict mode. Fixtures = 10mm cube in every mesh format
  (matches the STEP cube) + a synthetic CC0 2-layer Gerber set.
- **DL-20 (🔬).** Imports are **extensionless** (`from "./types"`) to match the repo tsconfig (no
  `allowImportingTsExtensions`); a `src/cad/occt-import-js.d.ts` ambient decl confines the untyped-WASM
  `any` to one file.

## Integration (orchestrator-owned shared-file edits)

- **DL-21.** **New glue modules:** `web/src/cad-io.ts` (`makeCadIo` — builds `CadIo` over fleet REST +
  injected `listDir`) and `src/cad/service.ts` (singleton `ConvertQueue(2)` + `CadCache(512 MiB)`
  fronting `convertCad` and the kicad-cli 3D path). Keeps shared-file edits tiny.
- **DL-22.** **Daemon `/cad` route** added to `http.ts` beside `FILES_RE` (same `fsResolve` sandbox);
  streams `model/gltf-binary`, `lod` query = device budget, errors → 413 (too-large) / 422 (parse).
  Response bytes normalized via `new Uint8Array(glb)` to satisfy TS 7's strict `BodyInit` generic.
- **DL-23.** **panel.ts `openFile` intercepts CAD by extension BEFORE `fs.read`** → `openCadViewer`;
  `listDir` threaded through `initPanel` deps (main implements it with the existing cid-correlated
  `sendAwait` + `fs.list`, matching panel's raw-activeId convention).
- **DL-24.** **conversation.ts:** "View CAD" button on CAD file-offer cards (Phase 7, path parsed from
  the offer's `downloadUrl`); image lightbox gets `enablePinchPan` (Phase 8). `file-offer.ts`
  DELIVERABLE_EXTS extended with the CAD extensions so agent outputs surface a card.
- **DL-25 (🔬 integration fix).** **ECAD Gerber dir-threading bug fixed.** The adapter fetched sibling
  layers by bare name (broke in subdirectories). Threaded the opened file's `dir` into the stackup/
  single-layer renderers so `io.fetchText(dir + name)` resolves worktree-relative paths correctly.
- **DL-26 (⚠️ review — scope call).** **Snapshot fan-out is download + (capability-gated) clipboard in
  v1**, plus the exported `captureSnapshot(): Promise<Blob>`. The spec's save-to-project and
  insert-into-chat targets (D16) need composer/attachment plumbing and are a wire-up follow-up — the
  capture primitive exists; only the fan-out destinations are partial. Logged, not hidden.

## Verification (this environment — the four CI gates + CAD tests)

- **DL-27 (🔬 PASS).** `bun run typecheck` (daemon) — **clean**. `bun run typecheck:web` — **clean**.
- **DL-28 (🔬 PASS).** `bun run build:web` — builds; **three.js confirmed lazy**: the entry chunk
  (`main-*.js`, 398 KB) has only the 1 `await import("three")` call site per identifier; the 749 KB
  three implementation is a separate `chunk-*.js` loaded on demand (DL-7 / bundle DoD satisfied).
  tracespace + KiCanvas likewise lazy (dynamic-imported inside the lazy `cad-ecad` chunk).
- **DL-29 (🔬 PASS).** CAD tests: **45/45 pass** across daemon unit (formats/cache/queue/glb/convert),
  web classifier, ECAD layer-select, and golden fixtures. The STEP→GLB convert test runs end-to-end on
  the hand-authored CC0 cube. (A cosmetic OCCT stderr line appears during the deliberate
  garbage-input rejection test — that test asserts the rejection.)
- **DL-30 (🔬).** Full `bun test` suite run to confirm the integration edits (http/panel/main/
  conversation/file-offer) caused no regressions — result recorded below.

- **DL-30 (🔬 PASS).** **Full `bun test` — 1302 pass / 0 fail** (1304 tests, 196 files) after fixing one
  issue: Bun's test glob was picking up the Playwright golden spec. Renamed `test/golden/cad.spec.ts` →
  `cad.pw.ts` and set Playwright `testMatch=/cad\.pw\.ts$/` so Bun skips it and Playwright still finds
  it. No pre-existing test regressed from the integration edits.

## Final status & remaining work (for review)

**Verified green in this environment (all four CI gates):** `typecheck` ✅, `typecheck:web` ✅,
`build:web` ✅ (three.js + KiCanvas confirmed lazy chunks, entry bundle unbloated), `bun test` ✅ 1302/0.

**Built + in-env-verified:** Phases **0, 1, 2, 4, 5, 7, 8** — the daemon conversion pipeline (occt→GLB,
queue, cache, hardening, kicad path), the `/cad` route, the full-screen 3D mesh+B-rep viewer
(loaders, OrbitControls+touch, fit/presets/wireframe, units auto-normalize, device-ceiling guard,
composited snapshot), both ECAD paths (Gerber stackup + KiCanvas), the agent "View CAD" loop, and
image-viewer pinch/pan parity. All wired end-to-end; browser golden baselines are the only CI-deferred
verification.

**Remaining / partial (NOT done — explicit follow-ups, not hidden):**
- **Phase 3 — model tree / part isolation / section-clipping / exploded:** NOT built. The GLB already
  carries the XCAF name/color hierarchy in `asset.extras.tree`, so the data is there; the inspection UI
  is the remaining work.
- **Phase 6 — snapshot fan-out:** partial. Composited capture + download + capability-gated clipboard
  are built; **save-to-project** and **insert-into-chat** (D16) need composer/attachment plumbing (DL-26).
- **Phase 9 — big-assembly streaming/compression:** NOT built. Convert enforces the triangle budget
  (throws over-cap) but Draco/meshopt + progressive streaming + server-side decimation are follow-ups.
- **Phase 10 — measurement (snap-to-geometry):** NOT built (deferred by design, D28).
- **Golden baselines + IGES/FCStd + kicad-3D e2e:** require CI (GPU/display, a CAD kernel for IGES/FCStd
  fixtures, a kicad-cli host). Harness + config + the non-browser fixtures test are in place.
- **External gate:** counsel sign-off on the LGPL/OCCT acknowledgement (spec Phase 0) — not a code item.

Net: **7 of 11 phases implemented and verified green**; the 4 remaining are the deeper-inspection
features + full snapshot fan-out, all logged above with their exact state.

## Decisions (chronological)

- **DL-5 (⚠️ review — good news).** **No protocol change / no `PROTOCOL_VERSION` bump.** CAD works
  entirely over REST (`/files` for bytes, new `/cad` for converted GLB) with **client-side extension
  classification** intercepting in `panel.ts:openFile` before `fs.read`. CLAUDE.md flags protocol
  bumps as expensive (additive-or-bump, update all 4 clients + contract tests). Avoiding it keeps the
  blast radius to new files + a couple of local edits. No change to `FileContent`.
- **DL-6.** **Full-screen viewer uses the existing `showModal`/`closeModal` modal mechanism** (exactly
  as `openImageLightbox` does), not a new `OverlayName`. Gets the history/Escape back-stack for free,
  zero edit to `overlays.ts`. Spec §3.3 said "sibling to openImageLightbox" → this is literal.
- **DL-7.** **three.js stays lazy via dynamic `import()` INSIDE `cad.ts`.** `build.ts` already has
  `splitting:true`; `panel.ts` may statically import the small `cad.ts`, but `cad.ts` must
  `await import("three")` (and loaders) internally so three lands in a `chunk-*.js`, never the entry
  chunk. No `build.ts` edit needed. (Verified mechanism: panel.ts already lazy-loads xterm this way.)
- **DL-8.** **Daemon conversion runs in a child process** (`Bun.spawn` → `convert-worker.ts`) with a
  **timeout-kill** + output-size guard (D24 isolation). ⚠️ Hard memory *rlimit* is OS-specific; v1
  ships timeout+size-guard and documents rlimit as a follow-up rather than shelling `ulimit`
  nondeterministically across the fleet.
- **DL-9 (⚠️ review).** **ECAD libs pinned via npm + wrapped behind an adapter**, not source-vendored
  in this pass (D18 allowed "vendor **or** pin + wrap"). Pin+adapter gives the isolation benefit now;
  copy-vendoring tracespace is a mechanical follow-up if upstream ever needs patching.
- **DL-10 (🔬).** **All deps installed up-front, serially, by the orchestrator** so parallel builder
  agents never corrupt `bun.lock`. Agents write code only. Installed: `three`+`@types/three`,
  `@gltf-transform/core`+`functions`, `occt-import-js`, `pcb-stackup`+`gerber-to-svg`+`whats-that-gerber`
  (tracespace v4), `fflate` (FCStd/zip); dev `@playwright/test`, `pixelmatch`, `pngjs`+`@types/pngjs`.
- **DL-11 (🔬 KEY SPIKE — PASSED).** **occt-import-js works under Bun — no Node-subprocess fallback
  needed for the engine.** Instantiates and exposes `ReadStepFile`/`ReadIgesFile`/`ReadBrepFile`; a real
  STEP cube converted to positions(72)+indices(36)+normals+6 `brep_faces`+color+a named node tree
  (`{name:"Cube",meshes:[0]}`). So XCAF names/colors/hierarchy are all available for the model tree.
  R9 retired. (Child-process isolation per DL-8 is still used for *crash containment*, not Bun-compat.)
- **DL-12.** **KiCanvas vendored** (not on npm): fetched the released single-file ES module (477 KB) to
  `anvild/web/src/vendor/kicanvas.js`. Satisfies the "vendor + pin" half of D18 literally for KiCanvas.
- **DL-13 (⚠️ review).** **Fixture reality.** The occt package's STEP/IGES test files are
  GrabCAD-encumbered (confirmed) — used only for throwaway spikes, never committed. For committed
  fixtures: mesh formats are generated programmatically (CC0 cube); **STEP** = a hand-authored minimal
  AP203 cube verified to load in occt (CC0). **IGES** and **FCStd** have no clean generator without
  FreeCAD/CadQuery (not installable here) → their *code paths* are unit-tested (classifier routing +
  occt `ReadIgesFile`/FCStd `Document.xml`-placement parsing against a synthetic zip), but **end-to-end
  golden render for IGES/FCStd is deferred to CI** with a real generator. Logged, not faked.
