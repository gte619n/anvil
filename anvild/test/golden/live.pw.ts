/**
 * [A3] Viewer live mode against THE REAL BUILT WEB BUNDLE with a stubbed socket (agent-cad-and-browser
 * spec §5 Phase A3 acceptance, §7 "preview refresh implemented as reopening the viewer").
 *
 * The page is the product: `web/build.ts`'s output, booted through `main.ts`, the part card's "Open",
 * `cad.ts` and its `replaceModel`, `cad-live.ts`, `cad-params.ts`. Only the socket and the preview
 * route are stand-ins (live-app.ts, live-server.ts). Odd revisions are one 80 mm box (12 triangles),
 * even revisions two boxes spanning 120 mm (24 triangles).
 *
 *   bunx --bun playwright test -c test/golden/live.playwright.config.ts
 */
import { expect, test, type Page } from "@playwright/test";
import { BAD_EXPRESSION, bootApp, CWD, design } from "./live-app";

/** Open the plate from its part card in the chat, in live mode, and wait for revision 1 on screen. */
async function openPlate(page: Page) {
  const app = await bootApp(page);
  await app.push(design({ rev: 1 }));
  const card = page.locator('#conversation .cad-part[data-cad-part="plate"]');
  await expect(card).toBeVisible();
  await card.locator(".cad-part-open").click();
  await expect(page.locator(".cad-shell.cad-live-mode")).toBeVisible();
  const first = await app.model(12);
  expect(first.units).toBe("mm");
  expect(first.size![0]).toBeCloseTo(80, 3); // metres in the file, shown as millimetres
  return app;
}

/**
 * Put the camera somewhere the opening fit never would: the Top preset, then the Front preset (which
 * keeps Top's distance). Presets, not a drag: orbit damping keeps a dragged camera drifting for
 * seconds under software rendering, and this spec compares matrices exactly.
 */
async function moveCamera(page: Page) {
  await page.locator('.cad-tools [data-act="top"]').click();
  await page.locator('.cad-tools [data-act="front"]').click();
}

test("[A3] Follow: a new rev swaps the mesh in place and the camera matrix is unchanged", async ({ page }) => {
  const app = await openPlate(page);
  const fitted = await app.settled();
  await moveCamera(page);
  const before = await app.settled();
  expect(before.camera).not.toEqual(fitted.camera); // the camera really is the user's now, not the fit's
  // A section plane is set up too: it must survive the swap.
  await page.locator('.cad-tools [data-act="section"]').click();
  expect((await app.probe())!.sectionOn).toBe(true);

  await app.push(design({ rev: 2 }));
  const after = await app.model(24);
  expect(after.modelId).not.toBe(before.modelId); // a different mesh…
  expect(after.vertices).toBe(48);
  expect(after.size![0]).toBeCloseTo(120, 3);
  expect(after.camera).toEqual(before.camera); // …seen from exactly the same place
  expect(after.projection).toEqual(before.projection);
  expect(after.target).toEqual(before.target);
  expect(after.zoom).toBe(before.zoom);
  expect(after.sectionOn).toBe(true);
  expect(after.canvases).toBe(1);
  expect(await app.glContexts()).toBe(1);
  await expect(page.locator('[data-live="follow"]')).toHaveAttribute("aria-checked", "true");
  await expect(page.locator('[data-live="behind"]')).toBeHidden();
  expect(app.errors).toEqual([]);
});

test('[A3] Paused: the mesh is unchanged and the badge reads "1 behind"; Reload swaps it', async ({ page }) => {
  const app = await openPlate(page);
  const shown = await app.settled();
  await page.locator('[data-live="follow"]').click();
  await expect(page.locator('[data-live="follow"]')).toHaveAttribute("aria-checked", "false");
  await expect(page.locator('[data-live="follow"]')).toHaveText("Paused");

  await app.push(design({ rev: 2 }));
  await expect(page.locator('[data-live="behind"]')).toHaveText("1 behind");
  await page.waitForTimeout(600); // long enough for a swap to have happened, had one been started
  const paused = (await app.probe())!;
  expect(paused.modelId).toBe(shown.modelId);
  expect(paused.triangles).toBe(12);
  await app.push(design({ rev: 3 }));
  await expect(page.locator('[data-live="behind"]')).toHaveText("2 behind");

  await page.locator('[data-live="reload"]').click();
  await page.waitForFunction((id) => (window as any).__anvilCadProbe?.()?.modelId !== id, shown.modelId);
  const reloaded = (await app.probe())!;
  expect(reloaded.triangles).toBe(12); // rev 3, the newest — rev 2 was skipped, never fetched late
  await expect(page.locator(".cad-live")).toHaveAttribute("data-rev", "3");
  await expect(page.locator('[data-live="behind"]')).toBeHidden();
  await expect(page.locator('[data-live="follow"]')).toHaveText("Paused"); // Reload does not un-pause
  expect(reloaded.camera).toEqual(shown.camera);
  expect(await app.glContexts()).toBe(1);

  // A fourth revision while still paused is one behind again, and Reload brings its mesh.
  await app.push(design({ rev: 4 }));
  await expect(page.locator('[data-live="behind"]')).toHaveText("1 behind");
  expect((await app.probe())!.triangles).toBe(12);
  await page.locator('[data-live="reload"]').click();
  expect((await app.model(24)).camera).toEqual(shown.camera);
  expect(app.errors).toEqual([]);
});

test("[A3] ten swaps keep one WebGL context, one canvas, and free the old geometry", async ({ page }) => {
  const app = await openPlate(page);
  await moveCamera(page);
  const start = await app.settled();
  for (let rev = 2; rev <= 11; rev++) {
    await app.push(design({ rev }));
    const p = await app.model(rev % 2 === 1 ? 12 : 24);
    expect(p.camera).toEqual(start.camera);
  }
  const end = (await app.probe())!;
  expect(await app.glContexts()).toBe(1);
  expect(end.canvases).toBe(1);
  expect(end.gpuGeometries).toBeLessThanOrEqual(2); // only the model on screen: nothing leaked per revision
  await expect(page.locator(".cad-live")).toHaveAttribute("data-rev", "11");
  expect(app.errors).toEqual([]);
});

test("[A3] the parameters panel edits through cad.param.set, shows SolidCraft's error and keeps the old value; the gate strip, busy line and Rebuild follow the socket", async ({ page }, info) => {
  const app = await openPlate(page);
  if (info.project.name === "phone") {
    await expect(page.locator(".cad-params")).toBeHidden(); // a phone opens the sheet from the toolbar
    await page.locator('.cad-tools [data-act="params"]').click();
  }
  const panel = page.locator(".cad-params");
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5); // fits the screen it is on
  const input = panel.locator('.cad-param[data-param="L"] input');
  await expect(input).toHaveValue("80 mm");
  await expect(panel.locator('[data-role="gate"]')).toHaveAttribute("data-state", "pass");

  // A bad expression: SolidCraft's error is shown, the old value is back, nothing else changed.
  await input.fill("bogus(");
  await input.press("Enter");
  await expect(panel.locator('.cad-param[data-param="L"] .cad-param-error')).toHaveText(BAD_EXPRESSION);
  await expect(input).toHaveValue("80 mm");
  expect(await app.sent("cad.param.set")).toMatchObject([{ cwd: CWD, part: "plate", name: "L", expression: "bogus(" }]);

  // A good one: sent as typed; the daemon's next cad.design (by the panel) redraws rows and gate.
  await input.fill("120");
  await input.press("Enter");
  await expect.poll(async () => (await app.sent("cad.param.set")).length).toBe(2);
  expect((await app.sent("cad.param.set"))[1]).toMatchObject({ name: "L", expression: "120" });
  await expect(panel.locator('.cad-param[data-param="L"] .cad-param-error')).toBeHidden();
  await app.push(design({ rev: 2, by: "panel" }, { state: "fail", checks: [{ id: "volume", expected: 23335.167, measured: 35335.167, ok: false, hard: true }] }));
  await expect(input).toHaveValue("120 mm");
  await expect(panel.locator('[data-role="gate"]')).toHaveAttribute("data-state", "fail");
  await expect(panel.locator('[data-role="gate"] .cad-check-fail')).toContainText("volume");
  await app.model(24); // …and the viewer followed the same event

  // Busy, and waiting for a slot.
  await app.push(design({ rev: 2, busy: true }));
  await expect(page.locator('[data-live="busy"]')).toHaveText("working…");
  await app.push(design({ rev: 2, busy: true, waiting: true }));
  await expect(page.locator('[data-live="busy"]')).toHaveText("waiting for a CAD slot");
  await app.push(design({ rev: 2 }));
  await expect(page.locator('[data-live="busy"]')).toBeHidden();

  // Rebuild.
  if (info.project.name === "phone") await panel.locator(".cad-params-close").click();
  await page.locator('[data-live="rebuild"]').click();
  await expect.poll(async () => (await app.sent("cad.design.refresh")).length).toBe(1);
  expect((await app.sent("cad.design.refresh"))[0]).toMatchObject({ cwd: CWD, part: "plate" });
  expect(app.errors).toEqual([]);
});

test("[A3] without the cad-work capability there is no part card, no viewer and no panel", async ({ page }) => {
  const app = await bootApp(page, { capabilities: ["autopilot"] });
  await app.push(design({ rev: 1 }));
  await page.waitForTimeout(300);
  await expect(page.locator("#conversation .cad-part")).toHaveCount(0);
  await page.evaluate((cwd) => window.dispatchEvent(new CustomEvent("anvil:cad-open", { detail: { url: location.origin, cwd, part: "plate", rev: 1 } })), CWD);
  await page.waitForTimeout(300);
  await expect(page.locator(".cad-shell")).toHaveCount(0);
  await expect(page.locator(".cad-params")).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

// ── A3 review, item 6 ───────────────────────────────────────────────────────────────────────────

test("[A3] Paused: the parameters panel and the gate strip show the DISPLAYED revision and say a newer one exists; Reload brings both up to date", async ({ page }, info) => {
  const app = await openPlate(page);
  if (info.project.name === "phone") await page.locator('.cad-tools [data-act="params"]').click();
  const panel = page.locator(".cad-params");
  const input = panel.locator('.cad-param[data-param="L"] input');
  await expect(input).toHaveValue("80 mm");
  await page.locator('[data-live="follow"]').click(); // pause
  await app.push(design({ rev: 2 }, { state: "fail", checks: [{ id: "volume", expected: 23335.167, measured: 35335.167, ok: false, hard: true }] }));
  await expect(page.locator('[data-live="behind"]')).toHaveText("1 behind");
  await expect(input).toHaveValue("80 mm"); // the model on screen is rev 1: so are the values
  await expect(panel.locator('[data-role="gate"]')).toHaveAttribute("data-state", "pass");
  await expect(panel.locator('[data-role="newer"]')).toBeVisible();
  await page.screenshot({ path: info.outputPath(`paused-${info.project.name}.png`) });
  await page.locator('[data-live="reload"]').click();
  await app.model(24);
  await expect(input).toHaveValue("120 mm");
  await expect(panel.locator('[data-role="gate"]')).toHaveAttribute("data-state", "fail");
  await expect(panel.locator('[data-role="newer"]')).toBeHidden();
  expect(app.errors).toEqual([]);
});

test("[A3] desktop: the opening fit puts the whole model in the visible area beside the parameters panel", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "the side panel is a desktop layout");
  const app = await openPlate(page);
  const p = await app.settled();
  const panel = (await page.locator(".cad-params").boundingBox())!;
  const stage = (await page.locator(".cad-stage").boundingBox())!;
  expect(p.screenBox).not.toBeNull();
  const b = p.screenBox!;
  expect(b.left).toBeGreaterThanOrEqual(panel.x + panel.width - 0.5); // nothing of the model under the panel
  expect(b.right).toBeLessThanOrEqual(stage.x + stage.width + 0.5);
  expect(b.top).toBeGreaterThanOrEqual(stage.y - 0.5);
  expect(b.bottom).toBeLessThanOrEqual(stage.y + stage.height + 0.5);
  await page.screenshot({ path: info.outputPath("desktop-fit.png") });
  expect(app.errors).toEqual([]);
});

test("[A3] phone: with the parameters sheet open the toolbar is still on top and reachable", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "the bottom sheet is the phone layout");
  const app = await openPlate(page);
  await expect(page.locator(".cad-params")).toBeHidden(); // collapsed by default
  await page.locator('.cad-tools [data-act="params"]').click();
  await expect(page.locator(".cad-params")).toBeVisible();
  const tools = (await page.locator(".cad-tools").boundingBox())!;
  const hit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest(".cad-tools"), [tools.x + tools.width / 2, tools.y + tools.height / 2]);
  expect(hit).toBe(true);
  await page.screenshot({ path: info.outputPath("phone-sheet.png") });
  // The toolbar closes the sheet again.
  await page.locator('.cad-tools [data-act="params"]').click();
  await expect(page.locator(".cad-params")).toBeHidden();
  expect(app.errors).toEqual([]);
});

test("[A3] the units badge is readable in both themes", async ({ page }, info) => {
  const app = await openPlate(page);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const c = await page.locator('.cad-units[data-role="units"]').evaluate((e) => {
      const parse = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
      };
      const fg = parse(getComputedStyle(e).color);
      const own = parse(getComputedStyle(e).backgroundColor);
      if (!(own.length >= 3 && (own.length < 4 || own[3]! > 0.5))) return 0; // must not show through to whatever is behind
      let bgEl: Element | null = e;
      let bg = [255, 255, 255];
      while (bgEl) {
        const v = parse(getComputedStyle(bgEl).backgroundColor);
        if (v.length >= 3 && (v.length < 4 || v[3]! > 0.5)) {
          bg = v;
          break;
        }
        bgEl = bgEl.parentElement;
      }
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      return (a! + 0.05) / (b! + 0.05);
    });
    expect(c).toBeGreaterThanOrEqual(3); // WCAG large/UI text
    await page.screenshot({ path: info.outputPath(`units-${scheme}-${info.project.name}.png`) });
  }
  expect(app.errors).toEqual([]);
});
