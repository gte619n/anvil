/**
 * Playwright config for the CAD golden-image harness (spec §7). Run under Bun:
 *   bunx --bun playwright install chromium          # one-time, in CI
 *   bunx --bun playwright test -c test/golden/playwright.config.ts
 *
 * Determinism strategy: Chromium is forced onto ANGLE's SwiftShader software WebGL (no host GPU
 * dependency), a fixed sRGB color profile, a pinned 512x512 viewport at deviceScaleFactor 1, and
 * all CSS/web animations disabled. These are the exact flags the spec calls for so a byte-stable
 * render is reproducible across machines (dev/CI/laptop).
 *
 * NOTE: baselines must be generated IN CI (`--update-snapshots`) — this environment has no browser
 * installed and no display/GPU, so goldens produced here would not be trustworthy. See README.md.
 */
import { defineConfig, devices } from "@playwright/test";

const SWIFTSHADER_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader-webgl",
  "--enable-unsafe-swiftshader",
  "--force-color-profile=srgb",
  "--no-sandbox",
];

const VIEWPORT = { width: 512, height: 512 };

export default defineConfig({
  testDir: ".",
  // `.pw.ts` (not `.spec.ts`/`.test.ts`) so Bun's own test runner skips this Playwright spec; only
  // Playwright (via this config) picks it up.
  testMatch: /cad\.pw\.ts$/,
  // Serial + single worker keeps the software renderer deterministic (no GPU contention).
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  // Perceptual diff: allow ≤1% of pixels to differ (tightenable as goldens stabilize).
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      animations: "disabled",
    },
  },

  use: {
    baseURL: "http://127.0.0.1:4321",
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    launchOptions: { args: SWIFTSHADER_ARGS },
  },

  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        launchOptions: { args: SWIFTSHADER_ARGS },
      },
    },
    {
      // Android layout/geometry validation. The GPU is still host SwiftShader (NOT a real device),
      // so this exercises the mobile viewport + a WebView-ish UA, not device rendering fidelity.
      name: "android",
      use: {
        ...devices["Pixel 7"],
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 wv",
        launchOptions: { args: SWIFTSHADER_ARGS },
      },
    },
  ],

  // Playwright boots the Bun static harness server and waits for it before the first test.
  webServer: {
    command: "bun run test/golden/server.ts",
    env: { HARNESS_PORT: "4321" },
    url: "http://127.0.0.1:4321/",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
