# CAD golden-image harness

Perceptual screenshot regression for the CAD viewer's mesh render path (spec §7). A Playwright
spec drives a tiny standalone three.js harness page, renders each fixture to a `<canvas>`, and
diffs it against a committed baseline PNG.

## Files

| file                   | role                                                              |
| ---------------------- | ----------------------------------------------------------------- |
| `playwright.config.ts` | determinism flags + `desktop`/`android` projects + webServer      |
| `server.ts`            | Bun static server (bundles `harness-entry.ts`, serves fixtures)   |
| `harness.html`         | standalone page with a 512×512 `#stage`                           |
| `harness-entry.ts`     | minimal three.js loader mirroring `web/src/cad.ts`'s mesh path    |
| `cad.pw.ts`          | the golden spec (STL ascii/binary + GLB — the first golden set)   |
| `fixtures.test.ts`     | **non-browser** parse-test (bun:test) — run with `bun test`       |

## Running (CI)

```sh
cd anvild
bunx --bun playwright install chromium                          # one-time per runner
bunx --bun playwright test -c test/golden/playwright.config.ts
```

Playwright boots `server.ts` itself (via the `webServer` block), waits for it on port 4321, then
runs the spec across both projects.

### Generating / updating baselines

Baselines do **not** exist yet and MUST be generated in CI — this repo's dev box has no Playwright
browser installed and no display/GPU, so any baseline produced here would be untrustworthy. In CI:

```sh
bunx --bun playwright test -c test/golden/playwright.config.ts --update-snapshots
```

This writes `cad.pw.ts-snapshots/<fixture>-<project>-<platform>.png`. Commit those PNGs; later
runs diff against them with `maxDiffPixelRatio: 0.01` (tighten once stable).

## Determinism

Chromium is forced onto ANGLE's **SwiftShader** software WebGL so the render never depends on a
host GPU:

```
--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader
--force-color-profile=srgb --no-sandbox
```

plus a pinned 512×512 viewport, `deviceScaleFactor: 1`, disabled animations, a single synchronous
frame (no rAF loop, no OrbitControls damping), and a fixed camera. Single worker, serial, to avoid
software-renderer contention.

## Caveat: the `android` project

The `android` project spreads `devices['Pixel 7']` and overrides the UA to a WebView-ish string
(`Version/4.0 … wv`). It validates **mobile layout + geometry only** — the GPU is still the host's
SwiftShader, NOT a real Android device, so it does not certify on-device rendering fidelity.
