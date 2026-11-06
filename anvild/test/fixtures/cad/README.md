# CAD test fixtures

All fixtures here are **self-generated and released CC0** (public domain). Nothing was scraped or
imported from a third party, so there are no provenance or licensing questions. The mesh and
`ecad2d/` fixtures are (re)produced deterministically by `gen.ts`:

```sh
cd anvild
bun run test/fixtures/cad/gen.ts        # writes mesh/* and ecad2d/*
```

## The canonical part

Every mesh fixture is the **same 10mm cube** spanning `(0,0,0)..(10,10,10)` — matching the brep
fixture (`brep/cube.step`, a 10mm cube solid) so the whole fixture family agrees on one part.
Formats that carry units (GLB, 3MF, COLLADA) declare **millimetres**; STL/OBJ/PLY are unitless by
format (the viewer treats them as such — see `web/src/cad.ts`, spec D20).

## Files

### `mesh/` — 3D mesh formats (12-triangle cube)

| file           | format                        | units        |
| -------------- | ----------------------------- | ------------ |
| `cube.stl`     | ASCII STL                     | unitless     |
| `cube-bin.stl` | binary STL (80B hdr + uint32 count + 50B/tri) | unitless |
| `cube.obj`     | Wavefront OBJ (+ `cube.mtl`)  | unitless     |
| `cube.mtl`     | companion material (`cube_mat`) | —          |
| `cube.ply`     | ASCII PLY                     | unitless     |
| `cube.glb`     | glTF binary (via `@gltf-transform/core`) | mm (`asset.extras.units`) |
| `cube.3mf`     | 3MF (ZIP via `fflate`)        | mm (`model unit="millimeter"`) |
| `cube.dae`     | COLLADA 1.4.1                 | mm (`<unit>`), Z-up |

### `ecad2d/` — synthetic 2-layer Gerber set + Excellon drill (RS-274X)

A tiny 10mm square board: two top-copper pads, one bottom-copper pad, a silk outline, and three
drilled holes. Minimal but valid enough that tracespace (`whats-that-gerber`) recognizes every
layer.

| file        | layer                 |
| ----------- | --------------------- |
| `board.gtl` | top copper            |
| `board.gbl` | bottom copper         |
| `board.gto` | top silkscreen        |
| `board.drl` | Excellon drill (all)  |

### `brep/` — owned elsewhere

`brep/cube.step` (the STEP B-rep fixture) is maintained by a separate track and is **not** produced
by `gen.ts`. Do not regenerate or edit it from here.

## Follow-ups (CI, not in this environment)

- **IGES** and **FreeCAD `.FCStd`** fixtures need a real CAD kernel to author a trustworthy file
  (OpenCASCADE / FreeCAD). They are a CI follow-up, not hand-authorable here.
