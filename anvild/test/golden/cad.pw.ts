/**
 * CAD golden-image spec (Playwright). For each mesh fixture in the first golden set (STL + GLB),
 * navigate to the harness page, wait for the single-frame render to signal `window.__cadReady`,
 * then assert the canvas matches its committed baseline.
 *
 * Baselines live next to this file as `cad.spec.ts-snapshots/<name>-<project>-<platform>.png` and
 * MUST be generated in CI with `--update-snapshots` (this repo's dev box has no browser/GPU — see
 * README.md). Run: bunx --bun playwright test -c test/golden/playwright.config.ts
 */
import { expect, test } from "@playwright/test";

// The first golden set: the formats the harness-entry loader supports today (STL ascii/binary, GLB).
const FIXTURES: Array<{ fixture: string; ext: "stl" | "glb" }> = [
  { fixture: "cube.stl", ext: "stl" },
  { fixture: "cube-bin.stl", ext: "stl" },
  { fixture: "cube.glb", ext: "glb" },
];

for (const { fixture, ext } of FIXTURES) {
  test(`golden: ${fixture}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await page.goto(`/harness.html?fixture=${encodeURIComponent(fixture)}&ext=${ext}`);

    // Fail fast with the harness's own error rather than a blind render-wait timeout.
    await page.waitForFunction(() => window.__cadReady === true || typeof window.__cadError === "string", null, {
      timeout: 30_000,
    });
    const err = await page.evaluate(() => window.__cadError);
    expect(err, `harness error for ${fixture}: ${err ?? ""}\nconsole: ${errors.join(" | ")}`).toBeUndefined();

    const canvas = page.locator("#stage canvas");
    await expect(canvas).toBeVisible();
    // Snapshot name includes the project (desktop/android) so each viewport gets its own baseline.
    await expect(canvas).toHaveScreenshot(`${fixture}-${testInfo.project.name}.png`);
  });
}
