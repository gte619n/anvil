/**
 * Playwright config for the specs that drive THE REAL BUILT WEB BUNDLE (agent-cad-and-browser spec
 * §5 Phase A3, §8.2). Separate from ./playwright.config.ts (the golden-image harness, whose page does
 * not load the product's viewer) so neither can break the other.
 *
 *   bunx --bun playwright install chromium                     # once
 *   bunx --bun playwright test -c test/golden/live.playwright.config.ts
 *
 * Same deterministic software WebGL as the golden config (ANGLE SwiftShader, fixed colour profile),
 * one worker. Two projects: a desktop viewport and a phone-width one (the repo is mobile-first).
 *
 * ADDING A SPEC: name it `<something>.live.pw.ts` or add it to `testMatch` below, load the app with
 * `bootApp(page)` from ./live-app.ts (it stubs the socket and hands back a driver for it), and list
 * the file under the phase's `playwright` key in test/phase-manifest.json with
 * `"playwrightConfig": "test/golden/live.playwright.config.ts"`.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4322;

const SWIFTSHADER_ARGS = ["--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader", "--force-color-profile=srgb", "--no-sandbox"];

export default defineConfig({
  testDir: ".",
  testMatch: /(^|\/)(live|[a-z0-9-]+\.live)\.pw\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    serviceWorkers: "block", // the app's offline shell would cache the bundle across runs
    launchOptions: { args: SWIFTSHADER_ARGS },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1100, height: 720 }, deviceScaleFactor: 1, launchOptions: { args: SWIFTSHADER_ARGS } } },
    {
      // Phone width. Host SwiftShader, not a device: this checks the mobile layout and touch wiring.
      name: "phone",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 780 }, deviceScaleFactor: 1, launchOptions: { args: SWIFTSHADER_ARGS } },
    },
  ],
  webServer: {
    command: "bun run live-server.ts",
    cwd: HERE,
    env: { HARNESS_PORT: String(PORT) },
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false, // always the bundle built from THIS tree
    timeout: 120_000,
  },
});
