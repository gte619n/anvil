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

// ── A3 review, phone/desktop layout ─────────────────────────────────────────────────────────────

/** What the chrome floating over the canvas leaves visible: the stage less the toolbar, HUD and live bar. */
async function visibleArea(page: Page) {
  return page.evaluate(() => {
    const c = document.querySelector(".cad-stage canvas")!.getBoundingClientRect();
    let top = c.top;
    let bottom = c.bottom;
    for (const sel of [".cad-tools", ".cad-hud", ".cad-live", ".cad-params"]) {
      const el = document.querySelector(`.cad-shell > ${sel}`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.right <= c.left || r.left >= c.right || r.bottom <= c.top || r.top >= c.bottom) continue;
      if (r.top + r.height / 2 < c.top + c.height / 2) top = Math.max(top, r.bottom);
      else bottom = Math.min(bottom, r.top);
    }
    return { left: Math.max(c.left, 0), right: Math.min(c.right, window.innerWidth), top, bottom };
  });
}

test("[A3] phone: the opening fit puts the whole model in the visible area clear of the toolbar and the top bars", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "the phone layout");
  const app = await openPlate(page);
  const p = await app.settled();
  expect(p.screenBox).not.toBeNull();
  const b = p.screenBox!;
  const vis = await visibleArea(page);
  expect(b.left).toBeGreaterThanOrEqual(vis.left - 0.5);
  expect(b.right).toBeLessThanOrEqual(vis.right + 0.5);
  expect(b.top).toBeGreaterThanOrEqual(vis.top - 0.5);
  expect(b.bottom).toBeLessThanOrEqual(vis.bottom + 0.5);
  // …and it is a fit, not a speck: the model spans a fair part of the visible width.
  expect(b.right - b.left).toBeGreaterThan((vis.right - vis.left) * 0.5);
  await page.screenshot({ path: info.outputPath("phone-fit.png") });
  expect(app.errors).toEqual([]);
});

test("[A3] every toolbar button can be reached: scrolled into view, its centre is on screen and hits the button", async ({ page }, info) => {
  const app = await openPlate(page);
  await app.settled();
  const acts = await page.locator(".cad-tools .cad-btn:visible").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.act!));
  expect(acts.length).toBeGreaterThan(8);
  const vw = page.viewportSize()!;
  for (const act of acts) {
    const r = await page.evaluate((a) => {
      const btn = document.querySelector<HTMLElement>(`.cad-tools [data-act="${a}"]`)!;
      btn.scrollIntoView({ block: "nearest", inline: "nearest" }); // only the toolbar scrolls
      const b = btn.getBoundingClientRect();
      const x = b.left + b.width / 2;
      const y = b.top + b.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, hit: !!hit && (hit === btn || btn.contains(hit)) };
    }, act);
    expect(r.x, act).toBeGreaterThanOrEqual(0);
    expect(r.x, act).toBeLessThanOrEqual(vw.width);
    expect(r.y, act).toBeGreaterThanOrEqual(0);
    expect(r.y, act).toBeLessThanOrEqual(vw.height);
    expect(r.hit, act).toBe(true);
  }
  await page.locator(".cad-tools").evaluate((e) => (e.scrollLeft = 0));
  await page.screenshot({ path: info.outputPath(`toolbar-${info.project.name}.png`) });
  expect(app.errors).toEqual([]);
});

test("[A3] a part card whose numbers are the agent's has exactly one Open (Confirm numbers is not a second .cad-part-open)", async ({ page }) => {
  const app = await bootApp(page);
  await app.push(design({ rev: 1 }, { approvedBy: "agent-initial" }));
  const cards = page.locator("#conversation .cad-part");
  await expect(cards.first()).toBeVisible();
  await expect(cards.first().locator('[data-role="unconfirmed"]')).toBeVisible();
  await expect(cards.first().getByRole("button", { name: "Confirm numbers" })).toBeVisible();
  const n = await cards.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) await expect(cards.nth(i).locator(".cad-part-open")).toHaveCount(1);
  expect(app.errors).toEqual([]);
});

test("[A3] the release card never breaks a number mid-digit", async ({ page }, info) => {
  const app = await bootApp(page);
  const rows = [
    { label: "Volume", old: "23335.1673 mm³", new: "23335.1673 mm³" },
    { label: "Bounding box", old: "80 × 50 × 6", new: "80.0002 × 50.0001 × 6.0000 mm" },
    { label: "Surface area", old: "9123456.789012 mm²", new: "9123456.789013 mm²" },
    { label: "Mass at the stated density", old: "62.9049 g", new: "62.9050 g" },
  ];
  await app.push({ type: "cad.expectations.request", requestId: "req_release", sessionId: "sess_live", cwd: CWD, part: "plate", kind: "release", rows, note: "Every hard check passes." });
  const card = page.locator('.cad-expect[data-cad-kind="release"]');
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  // No number is ever split across lines: every number in every cell lies on ONE line box (a cell
  // may wrap between the parts of "80 × 50 × 6", never inside one of them).
  const split = await card.locator(".cad-row-old, .cad-row-new, th").evaluateAll((els) =>
    els.flatMap((e) => {
      const node = e.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) return [];
      const out: string[] = [];
      for (const m of node.textContent!.matchAll(/[-+]?\d[\d.,]*(?:e[-+]?\d+)?/gi)) {
        const range = document.createRange();
        range.setStart(node, m.index!);
        range.setEnd(node, m.index! + m[0].length);
        if (new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size !== 1) out.push(m[0]);
      }
      return out;
    }),
  );
  expect(split).toEqual([]);
  // …and on this card every value is fully visible: the table fits the card without scrolling.
  expect(await card.locator(".cad-expect-rows").evaluate((t) => t.scrollWidth <= t.clientWidth + 1)).toBe(true);
  // The card stays inside the screen: a wide table scrolls inside it rather than widening the page.
  const cardBox = (await card.boundingBox())!;
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`release-card-${info.project.name}.png`) });
  expect(app.errors).toEqual([]);
});

test("[A3] review: a card that would also approve a parameter the agent moved shows it as its own highlighted row, and its numbers stay whole", async ({ page }, info) => {
  const app = await bootApp(page);
  const rows = [
    { label: "Process", old: "fdm-0.4", new: "fdm-0.4" },
    { label: "Parameter L", old: "80", new: "120 (changed by the agent, not approved)", unapproved: true },
    { label: "Bounding box (mm)", old: "L × W × T  (= 6 × 50 × 80)", new: "L × W × T  (= 6 × 50 × 120)" },
    { label: "Volume (mm³)", old: "L*W*T - (4 - pi)*5^2*T  (= 23335.167)", new: "L*W*T - (4 - pi)*5^2*T  (= 35335.167)" },
    { label: "Tolerance", old: "0.1 mm, 1% volume", new: "0.05 mm, 1% volume" },
  ];
  await app.push({ type: "cad.expectations.request", requestId: "req_propose", sessionId: "sess_live", cwd: CWD, part: "plate", kind: "propose", reason: "tighter length tolerance", rows });
  const card = page.locator('.cad-expect[data-cad-kind="propose"]');
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  const moved = card.locator('tr[data-role="unapproved"]');
  await expect(moved).toHaveCount(1);
  await expect(moved.locator(".cad-row-label")).toHaveText("Parameter L");
  await expect(moved.locator(".cad-row-old")).toHaveText("80");
  await expect(moved.locator(".cad-row-new")).toHaveText("120 (changed by the agent, not approved)");
  const bg = await moved.locator("td").first().evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(bg).not.toBe("rgba(0, 0, 0, 0)"); // highlighted, not a plain row
  expect(await card.locator(".cad-expect-rows").evaluate((t) => t.scrollWidth <= t.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`propose-moved-${info.project.name}.png`) });
  expect(app.errors).toEqual([]);
});

test("[A4] re-review: a long formula with no spaces wraps at its operators — on a phone the red new value stays on screen and no number is split", async ({ page }, info) => {
  const app = await bootApp(page);
  const longOld = "L*W*T-(4-pi)*5^2*T-2*pi*(D/2)^2*T+Lslot*Wslot*T-12.5*W*T  (= 23335.1673)";
  const longNew = "L*W*T-(4-pi)*5^2*T-2*pi*(D/2)^2*T+Lslot*Wslot*T-12.5*W*T+0.0001*Lchamfer^2  (= 35335.1673)";
  const rows = [
    { label: "Process", old: "fdm-0.4", new: "fdm-0.4" },
    { label: "Parameter Lchamfer", old: "1.5e-3", new: "2.25e-3*Lscale+(-5) (changed by the agent, not approved)", unapproved: true },
    { label: "Volume (mm³)", old: longOld, new: longNew },
  ];
  await app.push({ type: "cad.expectations.request", requestId: "req_long", sessionId: "sess_live", cwd: CWD, part: "plate", kind: "propose", reason: "a longer formula", rows });
  const card = page.locator('.cad-expect[data-cad-kind="propose"]');
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  // Every cell's text, across the wrap points: no number is ever on two lines.
  const split = await card.locator(".cad-row-old, .cad-row-new").evaluateAll((els) =>
    els.flatMap((e) => {
      const nodes: Text[] = [];
      const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
      const at: [Text, number][] = [];
      for (const n of nodes) for (let i = 0; i < n.length; i++) at.push([n, i]);
      const text = nodes.map((n) => n.data).join("");
      const out: string[] = [];
      for (const m of text.matchAll(/[-+]?\d[\d.,]*(?:e[-+]?\d+)?/gi)) {
        const range = document.createRange();
        const [sn, so] = at[m.index!]!;
        const [en, eo] = at[m.index! + m[0].length - 1]!;
        range.setStart(sn, so);
        range.setEnd(en, eo + 1);
        if (new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size !== 1) out.push(m[0]);
      }
      return out;
    }),
  );
  expect(split).toEqual([]);
  // The long values wrap instead of widening the table: every new value is fully on screen.
  const width = page.viewportSize()!.width;
  for (const cell of await card.locator(".cad-row-new").all()) {
    const box = (await cell.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
  }
  const volNew = card.locator("tr", { hasText: "Volume (mm³)" }).locator(".cad-row-new");
  if (info.project.name === "phone") expect(((await volNew.boundingBox())!.height)).toBeGreaterThan(30); // it really wrapped
  const moved = card.locator('tr[data-role="unapproved"] .cad-row-new');
  expect(await moved.evaluate((e) => getComputedStyle(e).color)).not.toBe(await card.locator(".cad-row-label").first().evaluate((e) => getComputedStyle(e).color));
  expect(await card.locator(".cad-expect-rows").evaluate((t) => t.scrollWidth <= t.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`long-formula-${info.project.name}.png`) });
  expect(app.errors).toEqual([]);
});
