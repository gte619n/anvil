# CAD Viewer (MCAD + ECAD) — Specification

- **Status:** **Draft — build-ready** (interview complete 2026-11-06) · **Owner:** Evan Ruff · **Branch:** `cad-viewer`
- **Created:** 2026-11-06 · **Last revised:** 2026-11-06
  - *Critique round 1:* GLB-writer gap, FCStd placement composition, Gerber sibling-scan, kicad-packages3D gate, secure-context snapshot fallback, versioned cache key.
  - *Interview round 2 (D19–D29):* conversion queue + concurrency cap, units/up-axis auto-normalization, debounce+validate+graceful-failure for partial/bad files, device ceiling + server decimation, shared daemon cache, subprocess isolation + path/arg sandboxing (Tailscale-only), front-loaded sequencing confirmed, uniform-fleet assumption, composited snapshots, **measurement split out to Phase 10 with snap-to-geometry**, auto size-adaptive quality.
- **Extends:** the web file-viewing surface (`anvild/web/src/panel.ts` Reader/lightbox), the daemon file route (`anvild/src/server/http.ts:1272` `FILES_RE`), and the agent deliverable/download-card path (`anvild/src/agent/file-offer.ts`).

> **One-line summary.** Add an in-app viewer so Evan can review mechanical (3D) and electronic (PCB) CAD
> files that agents produce or that come in as neutral exports — render meshes directly in the browser,
> tessellate B-rep (STEP/IGES/FreeCAD) to glTF **server-side on the daemon** via `occt-import-js`, and
> make every visual phase provably correct with a headless golden-image harness.

---

## 1. Objective & non-goals

**Objective.** Give Anvil a first-class CAD viewer for two domains, shipped in lockstep:

- **MCAD (3D):** rotate/inspect parts & assemblies — STEP, IGES, glTF/GLB, STL, OBJ, 3MF (incl. Bambu
  `.3mf`), PLY, and FreeCAD `.FCStd`.
- **ECAD (PCB):** Gerber/Excellon 2D fab stackup, KiCad native 2D (`.kicad_pcb` / `.kicad_sch`), and
  KiCad 3D board (via `kicad-cli pcb export glb` → the MCAD 3D viewer).

Two driving use cases: **(a)** reviewing CAD an agent just produced (notify-then-open loop), and
**(b)** lightweight **design review / sign-off**, where sign-off is satisfied by **snapshot export**.

**User-observable outcome.** Opening a supported CAD file (from the Files browser, or via a "View CAD"
affordance on an agent's output card) launches a full-screen viewer with touch gestures
(orbit/pan/pinch-zoom). 3D models show a model tree, measurement, and section planes; PCBs show
composited layers or the native KiCad render. A one-tap **Snapshot** captures the current view and can
be saved to the project, inserted into chat, downloaded/shared, or copied to the clipboard.

**Non-goals.**

- **NG1 — No proprietary-native MCAD parsing.** `.sldprt`/`.ipt`/`.CATPart`/`.prt`(Creo/NX)/Altium
  `.PcbDoc` are out. They have no open parser; viewing them requires a paid SDK (HOOPS/APS/CAD
  Exchanger) or cloud translation. Workflow is: **export to STEP / glTF / Gerber first.** Revisit only
  if a concrete need justifies the licensing/cost.
- **NG2 — No paid SDKs or cloud translation services.** Entire stack stays open-source (MIT/Apache +
  LGPL-via-WASM). No HOOPS, no Autodesk APS, no CAD Exchanger.
- **NG3 — Sign-off is snapshot-only in v1.** No in-model markup/annotations, no revision-diff overlay,
  no formal approve/request-changes verdict. (Explicitly deferred — see §12.)
- **NG4 — Not an editor.** Read-only viewing. No B-rep modeling, no mesh editing, no file writing other
  than snapshot PNGs. (`occt-import-js` is import-only by design.)
- **NG5 — No exact-geometry measurement.** Measurement operates on the **tessellated mesh**, so it is
  approximate (bounded by tessellation deflection), not exact B-rep measurement. Called out in-UI.
- **NG6 — No Altium/Eagle/IPC-2581/ODB++ in v1.** ECAD is Gerber + KiCad only. Others are future work.

---

## 2. Decisions (from the 2026-11-06 owner interview)

These are settled; the phases below implement them. Changing one is a spec revision, not a build call.

| # | Decision | Choice |
|---|----------|--------|
| D1 | Primary use cases | Review agent-produced CAD **+** design review / sign-off |
| D2 | Domain sequencing | **MCAD and ECAD in lockstep** (interleaved phases) |
| D3 | File-format posture | **Open/neutral only** — STEP/IGES/glTF/STL/OBJ/3MF/PLY, KiCad native, FreeCAD `.FCStd`. No proprietary native. |
| D4 | Bambu Lab files | Their `.3mf` is open; geometry renders via three.js `3MFLoader` directly. No special work beyond 3MF support. |
| D5 | B-rep tessellation site | **Server-side on the daemon** (keep the phone light; files already live on the daemon) |
| D6 | Daemon engine | **`occt-import-js` in Node/Bun** — pure npm dep, no system install, cross-platform |
| D7 | UX placement | **Full-screen overlay / lightbox** with full touch gestures (orbit/pan/pinch-zoom) |
| D8 | Image-viewer parity | **Also** retrofit pinch-zoom + pan onto the existing image viewer (own small phase) |
| D9 | 3D feature set | Orbit/pan/zoom + presets; model tree + part isolation; section/clipping + exploded — all phased. **Measurement deferred to its own later phase** (D28) so snapping is done right. |
| D10 | Sign-off surface | **Snapshot export only** → save-to-project **+** insert-into-chat **+** download/share **+** copy-clipboard |
| D11 | Agent loop | **Notify, open on click** — a "View CAD" affordance on the output card; no auto-open |
| D12 | ECAD depth (v1) | Gerber/Excellon 2D **+** KiCad native 2D **+** KiCad 3D board |
| D13 | Verification rigor | **Headless render + golden-image** regression (perceptual diff), over a pipeline-unit-test base |
| D14 | Conversion limits/cache | Cache keyed by content hash **+** progressive/streaming + Draco/meshopt + size/time caps |
| D15 | v1 platform target | **Desktop + Android in lockstep** — every phase must pass touch verification on the phone |
| D16 | Snapshot targets | All four: save-to-project, insert-into-chat, download/share-sheet, copy-clipboard |
| D17 | Test fixtures | **Curated verified-permissive samples + self-generated CC0 files** committed to the repo (§6 — B-rep fixtures must be self-generated; the circulating ones are GrabCAD-encumbered) |
| D18 | ECAD dependency risk | **Vendor/pin + wrap behind an adapter** (vendor frozen tracespace; pin KiCanvas; isolate both) |
| D19 | Conversion governance | **Serialized queue + concurrency cap** (bounded worker pool, FIFO, per-job timeout); client sees "queued, position N"; a big job can't starve chat/agent traffic |
| D20 | Units & up-axis | **Auto-normalize**: read units (STEP/glTF metadata; bbox-scale heuristic for unitless STL/OBJ), convert to a canonical internal unit, auto-rotate Z-up→Y-up, fit-to-view; **show detected units in HUD + allow axis override** |
| D21 | Partial / bad files | **Debounce until the write settles** (stable size/mtime) before offering/refreshing **+** cheap header-sniff **validate before** showing "View CAD" **+** graceful parse-failure card (reason + raw-download), never blank/hang. (No partial-assembly render in v1.) |
| D22 | Device ceiling | **Hard cap + server decimation fallback**: past a device-aware triangle/byte budget the daemon returns a decimated LOD, or the client refuses with "too large for this device — download / open on desktop". No silent WebView crash. |
| D23 | Cache location & scope | **Daemon-owned cache dir, outside any worktree**, keyed by content+converter hash → the same file converts once and is **shared/deduped across sessions**; LRU byte cap; never touches git |
| D24 | Hardening posture | **Subprocess isolation** (mem/time rlimit on occt + kicad-cli) **+ strict path/arg sandboxing** (`fsResolve`, fixed positional args — no shell interpolation, extension allowlist). **Network stays Tailscale-only — no app-layer auth** (honors [[tailscale-is-accepted-security-boundary]]). |
| D25 | Phase sequencing | **Front-loaded is intended**: prove the 3D pipeline first (phases 1–3), then ECAD (4–5). "Lockstep" = both first-class in the same release, not both in every phase. |
| D26 | Mixed-fleet capability | **Assume a uniform fleet** (the updater keeps daemons current); no capability negotiation in v1. Residual risk logged (R10) — a lagging host serving a CAD client degrades to the download card at worst. |
| D27 | Snapshot content | **Composited**: model **+** visible measurement/section/part-visibility overlays **+** a caption (file name, detected units, view angle) — so a snapshot stands alone as a review artifact |
| D28 | Measurement phase | **Own later phase** with **snap-to-geometry** (nearest vertex / edge-midpoint / face) so point-to-point hits real corners; still labeled "approximate (mesh)" (NG5). Not in Phase 3. |
| D29 | Tessellation quality | **Auto, size-adaptive** deflection (fine for small parts, coarser for huge assemblies, clamped to the device budget). No UI knob in v1; quality is derived from content so it adds no cache-key axis beyond the device LOD budget. |

---

## 3. Architecture

### 3.1 Data flow

```
Files browser / agent output card
        │  (user clicks "View CAD" / opens a .step/.3mf/.kicad_pcb/…)
        ▼
  web client: cad.ts classifies the file by extension → one of three pipelines
        │
        ├── MESH (stl/obj/3mf/ply/gltf/glb/dae) ──────────────┐
        │     fetch raw bytes from existing FILES_RE route     │
        │     /api/sessions/:id/files?path=…                   │
        │                                                      ▼
        ├── BREP (step/stp/iges/igs/fcstd) ──► NEW daemon   three.js scene
        │     route GET /api/sessions/:id/cad?path=…&lod=…  (full-screen
        │     queued convert (occt→gltf-transform GLB),      overlay +
        │     cached+deduped by content hash, streamed back ─► touch gestures)
        │                                                      ▲
        └── ECAD ──► Gerber: tracespace (client) → 2D SVG ─────┤
              KiCad 2D: KiCanvas web component (client) ───────┤
              KiCad 3D: daemon runs kicad-cli pcb export glb ──┘ (→ three.js)
```

### 3.2 Server side (daemon, `anvild/src/`)

- **New route:** `GET /api/sessions/:id/cad?path=<rel>&lod=<device-budget>` — sibling to `FILES_RE`
  (`http.ts:1272`). Resolves the path with `supervisor.fsResolve` (same sandbox as the file route),
  runs conversion, and streams back `model/gltf-binary`. Reuses the `Bun.file`/`Response` pattern. The
  daemon auto-derives tessellation deflection from model size (D29); `lod` is the **client's device
  triangle/byte budget** (D22) — the daemon decimates to fit it, or returns a 413-style "too large for
  this device" if even the decimated LOD won't fit. No client-supplied quality preset (D29).
- **Conversion governance (D19):** a bounded worker pool (default 2 concurrent, configurable) fronted by
  a FIFO queue; each job has a timeout and is killable. While queued the route streams a lightweight
  progress/"position N" signal (or the client polls) so a batch of big assemblies can't starve chat or
  agent traffic. Conversion never runs on the daemon event loop.
- **Conversion module:** `anvild/src/cad/convert.ts` — wraps `occt-import-js` (run under Bun/Node) to
  read STEP/IGES/BREP → **mesh JSON** (positions, normals, indices, plus the name/color node hierarchy
  from OCCT XCAF → drives the model tree). **occt-import-js does NOT emit GLB** — we build the GLB
  ourselves from that JSON with **`@gltf-transform/core` (MIT)**, preserving the node hierarchy as glTF
  nodes (the same library powers Phase-9 Draco/meshopt, so it's one dependency, not two).
  If the WASM module turns out to misbehave under Bun, fallback is running `convert` as a **Node
  subprocess** (Node stays on fleet hosts anyway) — the route contract doesn't change. Phase 0 spikes this.
- **`.FCStd` handling (not a single-file unzip):** an FCStd is a ZIP holding **one `.brp` per object**
  plus `Document.xml` (object tree + **placements**) and `GuiDocument.xml` (colors/visibility). The
  converter parses `Document.xml`, reads **each** `.brp` via `ReadBrepFile`, applies placements, and
  composes them into one glTF scene — skipping objects marked invisible. Feeding just one inner `.brep`
  would render a single shape at the origin and is explicitly wrong.
- **Cache (D23):** `anvild/src/cad/cache.ts` — converted GLBs stored under a **daemon-owned cache dir
  outside any worktree** (so derived artifacts never land in git), keyed by
  `sha256(fileBytes) + lodBudget + converterVersion` (the occt-import-js/gltf-transform/kicad-cli
  versions — else an engine upgrade serves stale meshes). Because the key is content-based and
  session-independent, the **same file converts once and is reused across sessions/users**. LRU eviction
  with a configurable byte cap. Cache hit → stream instantly.
- **KiCad 3D:** `convert.ts` shells `kicad-cli pcb export glb --subst-models …` **iff `kicad-cli` is on
  PATH *and* the kicad-packages3D model library is present** (else a bare-board render + "3D models
  library not installed" notice; no `kicad-cli` → "KiCad CLI not installed on this host"). Never a crash.
- **Hardening (D24):** conversion (occt-import-js **and** kicad-cli) runs in a **child process with
  memory + time rlimits**, so a malformed/malicious file that crashes or hangs the parser can't take down
  the daemon — and the timeout is a clean kill. Inputs go through `fsResolve` (no path traversal) and are
  passed to kicad-cli as **fixed positional args (no shell interpolation)**; extensions are allowlisted.
  Network boundary stays Tailscale-only — no app-layer auth added.
- **Caps/limits:** max input bytes + conversion timeout (both configurable); exceeding → structured
  error surfaced to the client as a clear message, never a hang.

### 3.3 Client side (web, `anvild/web/src/`)

- **New module `cad.ts`:** extension → pipeline classifier + the three.js viewer host. The classifier
  intercepts in `openFile` **before** `fs.read` fires (a 100 MB STEP must never round-trip as text
  through the Reader path). three.js and all loaders are **lazy-loaded via dynamic `import()`** (matches
  the existing xterm/mermaid code-split pattern in `build.ts`) so the base bundle — and the Android APK —
  don't grow until a CAD file is opened.
- **Multi-file formats (design requirement, not an edge case):**
  - **Gerber is a *set*, not a file.** Opening any `.gbr`/`.drl` triggers a sibling scan of its directory
    (`fs.list`, already in the protocol), layer identification via `whats-that-gerber` (part of the
    vendored tracespace), and fetches each layer through `FILES_RE` to composite the stackup. Opening one
    layer alone renders one layer with a "load full board" affordance.
  - **Relative-resource resolution:** `.gltf` (external `.bin`/textures), OBJ+MTL, and KiCad hierarchical
    sheets reference sibling files by relative path — but our file route is query-param based
    (`?path=…`), so native relative-URL resolution breaks. All three.js loaders get a
    `LoadingManager.setURLModifier` that rewrites relative refs to `?path=<dir>/<rel>`; the KiCanvas
    adapter feeds files via its virtual-filesystem API rather than letting it fetch.
- **Overlay host:** a new full-screen overlay (reuse the overlay back-stack in `overlays.ts`; sibling
  to `openImageLightbox`). Owns its own WebGL context, disposed on close.
- **Units & up-axis normalization (D20):** on load, read declared units (glTF `asset`/extensions; STEP
  units surfaced by the daemon in a small metadata sidecar alongside the GLB) and the up-axis; for
  unitless meshes (STL/OBJ) fall back to a bounding-box-scale heuristic. Convert to a canonical internal
  unit, auto-rotate Z-up→Y-up, fit-to-view. The HUD shows **detected units** and offers a manual
  **axis-override** toggle for when the guess is wrong.
- **Stability & validation (D21):** before showing/refreshing "View CAD", **debounce** on `fs.watch`
  until size+mtime are stable for a short window (never load a half-written file), and run a cheap
  **header/magic-byte sniff** so an unsupported variant or non-CAD file never presents a broken viewer.
  A parse/tessellation failure renders a **clear error card** (reason + raw-download fallback), never a
  blank canvas or hang.
- **Device ceiling (D22):** the client sends its device triangle/byte budget as `lod`; if even the
  decimated LOD exceeds what this device can hold, show "too large for this device — download / open on
  desktop" rather than attempting a render that crashes the WebView. Applies to **client-side mesh loads
  too** (a 400 MB STL gets the same guard before three.js parses it).
- **ECAD adapters** (`cad-ecad.ts`): thin interfaces wrapping **vendored** tracespace (Gerber→SVG) and
  **pinned** KiCanvas (web component), so upstream rot can't churn call sites (D18).
- **Snapshot (D27 — composited):** render the model **plus** currently-visible overlays (measurement
  dimensions, section state, part-visibility) and a caption strip (file name, detected units, view angle)
  into the raster, so the exported image stands alone as a review artifact. Mechanics: explicit
  `renderer.render()` immediately followed by `canvas.toBlob()` in the same task (a WebGL canvas is
  cleared after compositing unless `preserveDrawingBuffer` — render-then-capture, don't grab a stale
  buffer), drawing the HUD overlays onto a compositing 2D canvas; ECAD 2D serializes the SVG (with its
  labels) instead. Fan-out to the four targets (D16), reusing the existing attachment-insert and
  `file-offer`/download paths. **Secure-context caveat:**
  `navigator.clipboard.write(ClipboardItem)` and `navigator.share` require a secure context and have
  spotty Android-WebView support (and the fleet has known http/https origin drift) — so save-to-project
  and insert-into-chat (both via our own REST paths) are the **guaranteed** targets; clipboard and
  share-sheet are offered when the API is available and hidden (not broken) when it isn't.
- **Agent affordance:** `file-offer.ts` already emits download cards for deliverables
  (`file-offer.ts:73`); add CAD extensions to its deliverable set and render a **"View CAD"** button on
  the card that opens the overlay (D11 — notify, open on click; no auto-open).

### 3.4 Format → pipeline → renderability matrix

| Format | Ext | Kind | Pipeline | Lib | Notes |
|--------|-----|------|----------|-----|-------|
| glTF/GLB | `.gltf/.glb` | mesh | direct | three `GLTFLoader` | internal target format |
| STL | `.stl` | mesh | direct | three `STLLoader` | ASCII+binary |
| OBJ | `.obj` | mesh | direct | three `OBJLoader`(+MTL) | |
| 3MF (incl. Bambu) | `.3mf` | mesh | direct | three `3MFLoader` | open zip+xml; Bambu metadata ignored |
| PLY | `.ply` | mesh | direct | three `PLYLoader` | |
| Collada | `.dae` | mesh | direct | three `ColladaLoader` | legacy, inbound only |
| STEP | `.step/.stp` | B-rep | daemon→GLB | `occt-import-js` | XCAF → model tree/colors |
| IGES | `.iges/.igs` | B-rep | daemon→GLB | `occt-import-js` | lower fidelity than STEP |
| FreeCAD | `.FCStd` | B-rep | daemon→GLB | unzip→`occt-import-js` | inner `.brep` is open OCCT |
| Gerber/Excellon | `.gbr/.drl/…` | ECAD 2D | client | tracespace (vendored) | composited 2D stackup |
| KiCad board/sch | `.kicad_pcb/.kicad_sch` | ECAD 2D | client | KiCanvas (pinned) | KiCad 6+ only |
| KiCad 3D board | `.kicad_pcb` | ECAD 3D | daemon→GLB | `kicad-cli` | needs kicad-cli on host |

---

## 4. Dependencies & licenses

| Dep | Where | License | Posture |
|-----|-------|---------|---------|
| `three` (r18x) | web (lazy) | MIT | pin |
| three.js addon loaders | web (lazy) | MIT | pin |
| `occt-import-js` | **daemon** | **LGPL-2.1** | separately-fetched/replaceable artifact; keep OCCT acknowledgement + version visible (LGPL+OCCT exception) |
| `@gltf-transform/core` (+ functions) | **daemon** | MIT | GLB writer for converted meshes (Phase 2) + Draco/meshopt optimization (Phase 9) |
| tracespace (`pcb-stackup`/`gerber-to-svg` v4) | web (lazy) | MIT | **vendor** (frozen since 2021) behind adapter |
| KiCanvas | web (lazy) | MIT | **pin** exact version; wrap behind adapter (alpha) |
| `kicad-cli` | daemon (optional) | GPL (external binary, not linked) | invoked as a subprocess; optional feature-gate |

**Legal note (LGPL + OCCT exception).** `occt-import-js` carries OCCT's LGPL-2.1-with-exception. We ship
it **server-side** as a distinct npm artifact (not statically folded into proprietary code) and keep an
OCCT acknowledgement + version string reachable in the daemon's about/licenses surface. One-time
confirmation with counsel before first release (tracked as a Phase-0 gate).

---

## 5. Phases

Each phase is independently shippable and has an explicit **Definition of Done** with an
**agent-verifiable gate** (§7). Status legend per row: **Built** (code merged to branch), **Tested**
(automated tests green), **Verified** (DoD gate passed + evidence captured), **Pushed** (PR # / merged).

> **How the agent marks a phase done.** A phase is **Verified** only when the exact command(s) in its
> "Gate" row exit 0 **and** the captured evidence (test output, golden-diff report path, screenshot) is
> linked in the tracking table. No phase is marked done on code-read alone (honors the house rule that
> visual/functional work is proven by running it, not by inspection).

### Phase 0 — Foundations & spikes (no user-facing change)
- Add the daemon `cad/` module skeleton + the `GET …/cad` route (returns 501 until Phase 2).
- Prove `occt-import-js` runs under Bun/Node headless: convert a cube STEP → GLB in a unit test.
- Stand up the **golden-image harness** (headless browser, canvas screenshot, perceptual diff) and the
  committed fixture corpus (§6, D17). Harness renders a known GLB and diffs against a golden.
- LGPL/OCCT acknowledgement surface + counsel sign-off.
- **DoD:** `bun test anvild/src/cad` green (cube STEP → mesh JSON → GLB via gltf-transform yields >0
  triangles and expected bounds, **under Bun**; if Bun fails, the Node-subprocess fallback is proven
  instead and recorded as the mechanism); harness renders the reference GLB and the self-diff is ~0.
- **Gate:** `bun test anvild/src/cad && bun run cad:golden -- --self-check`

### Phase 1 — MCAD mesh viewer (direct formats) + full-screen overlay + touch
- `cad.ts` classifier; three.js overlay host (lazy-loaded); `GLTFLoader/STLLoader/OBJLoader/3MFLoader/
  PLYLoader/ColladaLoader`.
- Orbit/pan/zoom, **touch gestures incl. pinch-zoom** (D7/D15), fit-to-view, preset views
  (front/top/iso), shaded/wireframe toggle, background (D9 basics).
- **Units/axis auto-normalization + HUD** (D20) and the **client device-ceiling guard** (D22) land here —
  both apply to every format, so they belong in the first viewer phase.
- Open from Files browser when extension matches a mesh format; **debounce + header-sniff validation**
  (D21) before the viewer opens.
- **DoD:** each mesh fixture renders non-blank and matches its golden on **desktop and Android WebView**;
  pinch-zoom/orbit/pan work under synthetic touch events; a Z-up fixture renders upright (golden); an
  over-ceiling fixture shows the "too large" fallback, not a crash; a half-written then-settled file
  loads only after it settles.
- **Gate:** `bun test anvild/web/src/cad && bun run cad:golden -- --set mesh --platform desktop,android`

### Phase 2 — Server-side B-rep → glTF (STEP / IGES / FreeCAD)
- Implement `cad/convert.ts` (occt-import-js → mesh JSON → GLB via `@gltf-transform/core`), the live
  `…/cad` route, content+version-keyed **shared daemon cache** (`cad/cache.ts`, D23), size/time caps +
  structured errors (D5/D6/D14). `.FCStd` composition per §3.2 (multi-`.brp` + `Document.xml` placements).
- **Conversion governance + hardening** (D19/D24): bounded worker pool + FIFO queue + per-job
  timeout/kill; conversion runs in a **rlimited child process**; path via `fsResolve`, allowlisted
  extensions. Auto size-adaptive deflection (D29) clamped to the client's `lod` budget (D22), decimating
  when over.
- Client BREP pipeline: fetch GLB from `…/cad` (with device `lod`), render in the Phase-1 viewer; show
  the "queued, position N" state while waiting.
- **DoD:** STEP/IGES/FCStd fixtures convert server-side and render matching their goldens (the FCStd
  fixture has ≥2 placed objects — asserts placement composition, not just unzip); a **second session**
  requesting the same file hits the shared cache (no re-convert — assert via timing/log); an over-cap
  file returns a clean error, not a hang; a crafted file that kills the parser is contained to the child
  process (daemon stays up — assert); concurrent big conversions queue rather than starve (assert the
  cap).
- **Gate:** `bun test anvild/src/cad && bun run cad:golden -- --set brep --platform desktop,android`

### Phase 3 — Model tree, part isolation, section/clipping, exploded
- Model tree from XCAF (names/colors/hierarchy); show/hide/isolate parts; per-part transparency.
- Section/clipping plane(s) via three.js clipping; exploded-assembly view (D9).
- *(Measurement is NOT here — it moved to Phase 10 so snapping is done right, D28.)*
- **DoD:** tree lists the known parts of the assembly fixture; isolate hides others (golden); a section
  plane reveals interior (golden); exploded view separates parts (golden).
- **Gate:** `bun test anvild/src/cad && bun run cad:golden -- --set inspect --platform desktop,android`

### Phase 4 — ECAD 2D: Gerber stackup + KiCad native
- Vendor tracespace behind `cad-ecad.ts` adapter → composited 2D Gerber/Excellon stackup (top/bottom),
  including the **sibling-scan flow** (§3.3): open one `.gbr` → `fs.list` the directory →
  `whats-that-gerber` identifies layers → fetch + composite.
- Pin KiCanvas behind the adapter → render `.kicad_pcb` / `.kicad_sch` (D12/D18), feeding file bytes via
  its virtual-filesystem API (hierarchical sheets included).
- **DoD:** opening a *single* Gerber layer file assembles and renders the full fixture board matching its
  golden (asserts the sibling-scan, not just a pre-assembled set); a KiCad demo board + schematic render
  matching goldens; both work under touch (pan/pinch).
- **Gate:** `bun run cad:golden -- --set ecad2d --platform desktop,android`

### Phase 5 — ECAD 3D: KiCad board → GLB
- Daemon `kicad-cli pcb export glb --subst-models` path (feature-gated on `kicad-cli` presence);
  render resulting GLB in the Phase-1/2 3D viewer.
- **Populated boards need more than the CLI:** component bodies come from the **kicad-packages3D model
  library** — `--subst-models` has nothing to substitute without it. The feature gate therefore checks
  both `kicad-cli` on PATH **and** the 3D-model library path; a bare-board render with a "3D models
  library not installed" notice is the graceful degradation, not a failure.
- **DoD:** with a full KiCad install, the fixture board exports a **populated** GLB (component meshes
  present — assert mesh count > bare-board count) matching its golden; without the model library, a
  bare board + notice; without `kicad-cli`, a clear "not installed" message.
- **Gate:** `bun test anvild/src/cad && bun run cad:golden -- --set ecad3d --platform desktop,android` (explicit SKIP log if `kicad-cli`/packages3D unavailable in CI)

### Phase 6 — Snapshot / sign-off export
- Capture a **composited** image (D27): model + visible overlays (section/isolation state) + a caption
  (file name, detected units, view angle); 3D via render-then-`toBlob`, ECAD 2D via SVG serialize with
  labels → fan-out to all four targets (D10/D16): save-to-project, insert-into-chat, download/share-sheet,
  copy-clipboard.
- **DoD:** a snapshot produces a non-blank PNG **that contains the caption and any active overlay** (assert
  by rendering a sectioned/isolated fixture and golden-diffing the exported PNG, not just the live canvas).
  **Guaranteed targets** (save-to-project, insert-into-chat) round-trip on desktop **and** Android.
  **Conditional targets** (clipboard, share-sheet) round-trip where the API exists and are **hidden, not
  broken**, where it doesn't (§3.3) — the test asserts the hide behavior too.
- **Gate:** `bun test anvild/web/src/cad && bun run cad:golden -- --set snapshot --platform desktop,android`

### Phase 7 — Agent output loop ("View CAD" affordance)
- Extend `file-offer.ts` deliverable set with CAD extensions; render a "View CAD" button on the output
  card that opens the overlay (D11 — notify, open on click).
- **DoD:** when an agent writes a supported CAD file, its output card shows "View CAD"; clicking opens
  the correct pipeline/viewer. No auto-open.
- **Gate:** `bun test anvild/src/agent/file-offer && bun run cad:e2e -- --set agent-loop`

### Phase 8 — Image-viewer pinch-zoom/pan parity (D8)
- Retrofit pinch-zoom + pan onto the existing image lightbox (`panel.ts` / `openImageLightbox`), sharing
  the gesture code from the CAD overlay.
- **DoD:** existing image lightbox supports pinch-zoom and pan under synthetic touch on Android; no
  regression to current image rendering (golden).
- **Gate:** `bun run cad:golden -- --set image-gestures --platform android`

### Phase 9 — Big-assembly polish: progressive/streaming + compression (D14)
- Draco/meshopt compression on converted GLBs; progress UI + streaming for large models; tune the
  auto size-adaptive deflection curve (D29) and the device-ceiling decimation (D22).
- **DoD:** a large assembly fixture loads with a visible progress indicator and a compressed GLB
  materially smaller than uncompressed (assert ratio); render still matches golden within tolerance.
- **Gate:** `bun test anvild/src/cad && bun run cad:golden -- --set large --platform desktop,android`

### Phase 10 — Measurement with snap-to-geometry (D28)
- Point-to-point distance, edge length, angle, bounding-box dims, coordinate readout — with **hover
  snapping** to the nearest mesh vertex / edge-midpoint / face so measurements hit real corners, not
  arbitrary surface points. Labeled **"approximate (mesh)"** (NG5). Overlays are captured by the Phase-6
  composited snapshot.
- **DoD:** on the self-generated unit-cube fixture (known dimensions, §6.2), a snapped corner-to-corner
  distance is within tessellation tolerance of the exact value; snapping selects the vertex within a
  pixel radius (unit test on the picking math); the dimension overlay renders (golden) and appears in a
  snapshot (ties to Phase 6).
- **Gate:** `bun test anvild/src/cad && bun run cad:golden -- --set measure --platform desktop,android`

---

## 6. Test fixture corpus (committed — D17)

Under `anvild/test/fixtures/cad/`. Two provenance classes: **sourced** (verified permissive license,
vendored with its license/attribution file) and **self-generated** (built by a committed script → CC0,
fully ours, deterministic). The B-rep "cube" fixtures that circulate online — including the ones inside
`kovacsv/occt-import-js` — are **GrabCAD-sourced (NOT permissive)** despite living in LGPL repos, so we
**generate those ourselves**.

### 6.1 Sourced fixtures (verified permissive)

| Fixture | Source URL | License | Note |
|---------|-----------|---------|------|
| STL ASCII | `mrdoob/three.js …/examples/models/stl/ascii/slotted_disk.stl` | MIT | 80 KB |
| STL binary | `mrdoob/three.js …/examples/models/stl/binary/colored.stl` | MIT | 108 KB, color ext |
| 3MF generic | `mrdoob/three.js …/examples/models/3mf/pyramid.3mf` | **BSD-2-Clause** (via 3MFConsortium samples) | 4.8 KB; `vertexcolors.3mf` even smaller |
| PLY ASCII | `mrdoob/three.js …/examples/models/ply/ascii/dolphins.ply` | MIT | 44 KB |
| PLY binary (LE+BE) | `mrdoob/three.js …/examples/models/ply/binary/dolphins_{le,be}.ply` | MIT | ~32 KB each |
| Collada | `mrdoob/three.js …/examples/models/collada/test/polygons.dae` | MIT | 1.5 KB (smallest clean DAE) |
| Gerber + Excellon (synthetic) | `tracespace/tracespace …/packages/fixtures/gerbers` | **MIT** | hand-made primitives — **preferred** |
| Gerber + drill (real 2-layer) | `tracespace/tracespace …/packages/fixtures/boards/arduino-uno` | **CC-BY-SA** | attribution + share-alike; use only if a realistic board is needed |
| KiCad board | `theacodes/kicanvas …/debug/examples/starfish.kicad_pcb` | MIT (repo) | single demo board |

**Avoid:** three.js `gltf/DamagedHelmet` (**CC-BY-NC** — non-commercial, unusable), Khronos `Box.glb`
(CC-BY, attribution burden — we self-gen a CC0 box instead), KiCad upstream `demos/` (**GPL-3.0** — viral,
and not tiny), Stanford `Lucy100k.ply` (huge). three.js `truck.3mf` is undocumented → don't use.

### 6.2 Self-generated fixtures (CC0, deterministic — built by `anvild/test/fixtures/cad/gen.ts`)

For these, no verified-clean small source exists, so a committed script produces tiny, fully-owned,
reproducible files (a parametric unit cube + a 2-part assembly):

- **STEP** (`.step`) — cube + small assembly, generated via occt-import-js's sibling build / a CadQuery
  or FreeCAD-headless step, emitted with known dimensions (so measurement tests assert exact values).
- **IGES** (`.iges`) — same cube, IGES export.
- **FreeCAD** (`.FCStd`) — trivial cube authored in FreeCAD (documents we create aren't constrained by
  FreeCAD's LGPL).
- **OBJ + MTL** (`.obj`/`.mtl`) — tiny cube pair (three.js has no clean OBJ+MTL fixture).
- **GLB** (`.glb`) — cube exported to CC0 glTF-Binary (avoids the CC-BY attribution burden).
- **Bambu `.3mf`** — generated/exported trivial `.3mf` (MakerWorld models are generally **not** CC0;
  don't assume). Asserts the 3MF path handles Bambu's extra metadata without choking.

Known dimensions on the generated solids double as the **measurement-test oracle** (Phase 3): a measured
edge must fall within tessellation tolerance of the generated value.

### 6.3 Goldens
- **golden/** — approved reference PNGs per fixture **per platform profile** (desktop + Android-emulated),
  each with its perceptual-diff threshold recorded alongside. Goldens are regenerated only via an explicit
  reviewed `--update-golden` flow (never auto-written), inside the pinned CI Docker image.

Fixtures stay minimal so CI is fast and the repo small. Each sourced file ships with its upstream
license/attribution text in a sibling `LICENSE` file.

---

## 7. Testing approach

Three layers; a phase's gate (§5) names the exact command whose exit-0 + evidence marks it Verified.

1. **Pipeline unit tests** (`bun test anvild/src/cad`) — deterministic, no browser:
   conversion correctness (STEP/IGES/FCStd → GLB has expected triangle count/bounds/part names), cache
   hit/miss, cap/timeout error paths, extension classifier, `--subst-models` population, kicad-cli
   absence handling.
2. **Headless golden-image harness** (`bun run cad:golden`) — the core of D13. Loads each fixture in a
   headless browser (desktop profile **and** an Android-WebView-emulating profile per D15), renders,
   screenshots the canvas, and runs a **perceptual diff** against the committed golden. Fails on blank
   canvas, wrong geometry, or regression beyond threshold. Synthetic touch events exercise
   orbit/pan/pinch. Updating a golden is a deliberate, reviewed action (a `--update-golden` flag that
   shows the diff), never automatic.

   **Toolchain (pinned):**
   - **Driver:** Playwright, run under Bun via `bunx --bun playwright test` (the `--bun` flag is
     mandatory — plain `bunx` silently falls back to Node). Keep Node on PATH as a safety net. The
     three.js app code stays pure Bun; only the test runner drives the browser.
   - **Renderer — force software GL for determinism:** launch Chromium with
     `--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader --force-color-profile=srgb`
     (+ `--no-sandbox` in CI containers). **`--enable-unsafe-swiftshader` is now mandatory** on GPU-less
     CI — without it `getContext('webgl')` returns `null` and the canvas is silently blank. **Never pass
     `--disable-gpu`** under new headless — it removes WebGL entirely. Debian-based image, `--shm-size=2gb`.
   - **three.js determinism:** `antialias:false`, `renderer.setPixelRatio(1)`, fixed `setSize()`,
     `preserveDrawingBuffer:true`, seeded PRNG, drive frames explicitly and capture after a known frame.
     Context `deviceScaleFactor:1`, fixed viewport, `animations:'disabled'`.
   - **Diff:** Playwright's built-in `toHaveScreenshot` (wraps pixelmatch, two-stable-frame retry + anim
     freeze). Start at `{ threshold: 0.2, maxDiffPixelRatio: 0.01 }`; tighten `maxDiffPixelRatio` to
     `0.001` for strict-geometry fixtures. Reach for `odiff` only if diff throughput becomes a bottleneck.
   - **Pin the Chromium version** and generate goldens inside the same CI Docker image — SwiftShader
     output can shift between Chrome releases.
   - **Android profile:** Playwright device descriptor (e.g. `Pixel 7`) + a `wv`/`Version/4.0` WebView UA
     override, driving viewport/DPR/touch. **Load-bearing caveat:** emulation changes viewport/DPR/UA/touch
     only — the scene still renders on the host SwiftShader backend, so this validates **layout, gesture
     wiring, and geometry**, NOT real on-device GPU pixels. True device-GPU fidelity needs a real-device
     cloud (out of scope for CI; a manual spot-check item in each touch phase's DoD).
3. **Functional / e2e** (`bun run cad:e2e`) — the user-visible behaviors: open-from-Files, the agent
   "View CAD" card, the four snapshot targets round-tripping, the over-cap error surfacing as a message.

**Functional (not just technical) coverage.** The gates assert user outcomes — "an agent's STEP output
shows View CAD and it opens the model," "a snapshot lands in the chat," "a too-big file shows an error
not a hang" — not merely that a function returned a buffer.

---

## 8. Definition of Done

**Per phase:** its §5 **DoD** met **and** its **Gate** command exits 0 with evidence (test log /
golden-diff report path / screenshot) linked in §10.

**Global (feature complete):**
- All phases 0–8 Verified. **Phase 9 (big-assembly polish) and Phase 10 (measurement) may trail as
  follow-ons** — the feature is usable for review + sign-off without them, but measurement is required
  before the design-review use case is considered fully delivered.
- Every supported format in §3.4 renders matching its golden on **both desktop and Android** profiles.
- Base web bundle / APK size unchanged when no CAD file is opened (three.js stays lazy). Concretely: a
  CI check builds `web/dist` and asserts the **entry chunk** (`main-<hash>.js` + `app-<hash>.css`) byte
  size is within a committed budget; three.js/occt/tracespace/KiCanvas may appear only as lazy
  `chunk-*.js` files.
- Daemon has no new mandatory system dependency (occt-import-js is npm; kicad-cli is optional/gated).
- LGPL/OCCT acknowledgement present; counsel sign-off recorded.
- No regression to the existing image/reader viewers (their goldens still pass).
- `bun run cad:golden -- --all` and `bun test anvild/src/cad` both green in CI.

---

## 9. Risks & mitigations

- **R1 — occt-import-js is LGPL & last published 2024-12.** Mitigate: server-side separate artifact +
  acknowledgement (§4); it's import-only and stable; pin the version; harness catches conversion
  regressions on upgrade.
- **R2 — tracespace unmaintained, KiCanvas alpha.** Mitigate: vendor/pin behind adapters (D18) so we can
  patch locally and swap without touching call sites.
- **R3 — Android WebView WebGL perf / memory on big assemblies.** Mitigate: server-side tessellation
  (phone gets a ready GLB), Draco/meshopt + streaming (Phase 9), auto size-adaptive deflection, the
  hard device ceiling + decimation fallback (D22), per-platform goldens.
- **R4 — Large/slow STEP conversions block the daemon / starve other traffic.** Mitigate: rlimited
  child-process conversion off the event loop + size/time caps + **bounded worker pool & FIFO queue**
  (D19) + content-hash shared cache (D23).
- **R5 — kicad-cli not installed across the fleet.** Mitigate: feature-gate ECAD-3D on PATH presence;
  explicit "not installed" message; CI gate SKIPs loudly rather than failing.
- **R6 — Measurement read as exact.** Mitigate: label "approximate (mesh)" in-UI (NG5); fixtures assert
  values within tessellation tolerance only.
- **R7 — Bundle bloat reaching the APK.** Mitigate: strict lazy-load of three.js + loaders; a
  bundle-size DoD check that the base bundle is unchanged.
- **R8 — Secure-context APIs missing on Android/WebView.** `navigator.clipboard.write(ClipboardItem)` and
  `navigator.share` need a secure context; the fleet has known http/https origin drift. Mitigate:
  guaranteed snapshot targets go through our own REST paths; clipboard/share are capability-detected and
  hidden when absent (§3.3, Phase 6 DoD).
- **R9 — occt-import-js (Emscripten WASM) misbehaves under Bun.** Mitigate: Phase 0 spikes it; the
  committed fallback is running conversion as a Node subprocess behind the same `convert.ts` contract —
  no route or client change.
- **R10 — Mixed-fleet / lagging daemon (accepted, D26).** A CAD-capable client on a session hosted by an
  older daemon (no `/cad` route) would see a broken B-rep/ECAD-3D affordance. Accepted in v1: the updater
  keeps the fleet current, and mesh formats render client-side regardless. Residual exposure is a failed
  convert fetch → the graceful parse-failure card (D21) + raw-download. Revisit with a `cad` capability
  gate if lagging hosts prove common in practice.
- **R11 — Untrusted-file parser crash/DoS.** A malformed/crafted STEP/Gerber/kicad_pcb could crash or
  hang occt/kicad-cli. Mitigate: rlimited child process + timeout-kill + extension allowlist + no shell
  interpolation (D24); a crash is contained and surfaces as the parse-failure card.

---

## 10. Progress tracking

Update on every change. **Verified** requires the §5 gate passed + evidence linked.

| Phase | Built | Tested | Verified | Pushed (PR) | Evidence |
|-------|:-----:|:------:|:--------:|-------------|----------|
| 0 — Foundations & golden harness | ☐ | ☐ | ☐ | — | |
| 1 — Mesh viewer + overlay + touch | ☐ | ☐ | ☐ | — | |
| 2 — Server B-rep→glTF (STEP/IGES/FCStd) | ☐ | ☐ | ☐ | — | |
| 3 — Tree / isolate / section / exploded | ☐ | ☐ | ☐ | — | |
| 4 — ECAD 2D (Gerber + KiCad) | ☐ | ☐ | ☐ | — | |
| 5 — ECAD 3D (KiCad→GLB) | ☐ | ☐ | ☐ | — | |
| 6 — Snapshot / sign-off export | ☐ | ☐ | ☐ | — | |
| 7 — Agent "View CAD" loop | ☐ | ☐ | ☐ | — | |
| 8 — Image-viewer pinch/pan parity | ☐ | ☐ | ☐ | — | |
| 9 — Big-assembly streaming/compression | ☐ | ☐ | ☐ | — | |
| 10 — Measurement (snap-to-geometry) | ☐ | ☐ | ☐ | — | |

---

## 11. Key integration points (file references)

- Daemon file route to clone for `…/cad`: `anvild/src/server/http.ts:1272` (`FILES_RE`, `fsResolve`, `Bun.file`).
- Agent deliverable/download cards (add "View CAD"): `anvild/src/agent/file-offer.ts:13,73`.
- Client Reader/binary render + lightbox to sit beside: `anvild/web/src/panel.ts:588` (`renderReader`), `:621` (`binaryUrl`), `openImageLightbox`.
- Panel view enum (if a tab is ever wanted): `anvild/web/src/panel.ts:156` (`VIEWS`).
- Overlay back-stack: `anvild/web/src/overlays.ts`.
- Lazy-load / code-split precedent: `anvild/web/build.ts` (xterm/mermaid split) + dynamic `import()` in `panel.ts`/`conversation.ts`.
- Stateless-viewer precedent (SVG): `anvild/web/src/circuit.ts`.
- URL resolution for fleet routing: `anvild/web/src/fleet.ts` (`serverApiUrl`).

---

## 12. Deferred / future work

- Sign-off beyond snapshot: in-model markup/annotations, revision-diff overlay, formal
  approve/request-changes feeding the Loops/autopilot loop.
- Additional ECAD: Altium/Eagle (via KiCad import), IPC-2581, ODB++, Gerber→3D extrusion.
- Proprietary-native MCAD (would require a paid SDK / cloud translation — revisit only with justification).
- Exact B-rep measurement (would require keeping the OCCT B-rep handle, not just the mesh).
- Auto-open on agent output (deliberately not v1 — D11).
