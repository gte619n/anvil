/**
 * One-off: screenshot the REAL cad.ts viewer across several paths — server-converted STEP→GLB, the
 * Gerber 2D stackup, and the section/explode overlays in action — to visually verify the UI (not just
 * the bare render pipeline). Serves the committed fixtures + a live `/cad` endpoint that runs the real
 * daemon serveCad(). Loads Material Symbols from Google's CDN so toolbar icons render. Not part of CI.
 *   bun run test/golden/shot-app.ts
 */
import { chromium, devices } from "playwright-core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { serveCad } from "../../src/cad/service";
import { renderGerberFromDir } from "../../src/cad/gerber";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FIX = join(HERE, "..", "fixtures", "cad");
const SUBDIRS = ["mesh", "ecad2d", "brep", "kicad"];
const STATE = mkdtempSync(join(tmpdir(), "anvil-shot-state-"));

// Locate a fixture by bare name across the fixture subdirs.
function fixturePath(name: string): string | null {
  for (const d of SUBDIRS) {
    const p = join(FIX, d, name);
    if (existsSync(p)) return p;
  }
  return null;
}
const gerberSiblings = readdirSync(join(FIX, "ecad2d"));

// Bundle a page entry that mounts the real viewer against the served fixtures.
const tmp = mkdtempSync(join(tmpdir(), "anvil-shotapp-"));
const entryPath = join(tmp, "entry.ts");
writeFileSync(
  entryPath,
  `import { openCadViewer } from ${JSON.stringify(join(ROOT, "web/src/cad.ts"))};
const base = location.origin, nameOf = (p) => p.split("/").pop();
const io = {
  fileUrl: (p) => base + "/fixtures/" + nameOf(p),
  cadUrl: (p, lod) => base + "/cad?path=" + encodeURIComponent(nameOf(p)) + "&lod=" + lod,
  gerberUrl: (p, side) => base + "/cad-gerber?path=" + encodeURIComponent(nameOf(p)) + "&side=" + side,
  fetchBytes: async (p) => new Uint8Array(await (await fetch(base + "/fixtures/" + nameOf(p))).arrayBuffer()),
  fetchText: async (p) => (await fetch(base + "/fixtures/" + nameOf(p))).text(),
  listSiblings: async () => (await (await fetch(base + "/siblings")).json()),
};
const scene = new URLSearchParams(location.search).get("scene");
const target = scene === "step" ? "cube.step" : scene === "gerber" ? "board.gtl" : scene === "kicad" ? "board.kicad_pcb" : scene === "assembly" ? "assembly.glb" : scene === "draco" ? "assembly-draco.glb" : "cube.glb";
try { openCadViewer(target, io); }
catch (e) { document.body.innerHTML = "<pre style='color:red'>" + (e && e.stack || e) + "</pre>"; }
`,
);
const built = await Bun.build({ entrypoints: [entryPath], target: "browser", minify: false });
if (!built.success) { for (const l of built.logs) console.error(l); process.exit(1); }
const entryJs = await built.outputs[0]!.text();
const css = await Bun.file(join(ROOT, "web/styles/app.css")).text();
const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" />
<style>${css}</style><style>html,body{margin:0;height:100%;background:#0e0f12}.msym{font-family:'Material Symbols Outlined'}</style>
</head><body><div id="modal-root"></div><script type="module" src="/entry.js"></script></body></html>`;

const server = Bun.serve({
  port: 4330,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    if (p === "/entry.js") return new Response(entryJs, { headers: { "content-type": "text/javascript" } });
    if (p === "/siblings") return Response.json(gerberSiblings);
    if (p === "/cad") {
      const name = url.searchParams.get("path") || "";
      const lod = Number(url.searchParams.get("lod")) || 1_500_000;
      const fp = fixturePath(name);
      if (!fp) return new Response("not found", { status: 404 });
      const bytes = new Uint8Array(await Bun.file(fp).arrayBuffer());
      const res = await serveCad(STATE, bytes, name, lod); // the REAL daemon conversion
      if (res.glb) return new Response(new Uint8Array(res.glb), { headers: { "content-type": "model/gltf-binary" } });
      return new Response(res.error ?? "convert failed", { status: res.status });
    }
    if (p === "/cad-gerber") {
      const name = url.searchParams.get("path") || "";
      const side = url.searchParams.get("side") === "bottom" ? "bottom" : "top";
      const fp = fixturePath(name);
      if (!fp) return new Response("not found", { status: 404 });
      try {
        const stackup = await renderGerberFromDir(fp); // the REAL daemon gerber render
        return new Response(stackup[side], { headers: { "content-type": "image/svg+xml" } });
      } catch (e) {
        return new Response(e instanceof Error ? e.message : "gerber failed", { status: 422 });
      }
    }
    if (p.startsWith("/draco/")) {
      // Serve three's Draco decoder (draco_decoder.wasm / draco_wasm_wrapper.js) like the daemon does.
      const dp = join(ROOT, "node_modules/three/examples/jsm/libs/draco/gltf", p.slice("/draco/".length));
      return (await Bun.file(dp).exists()) ? new Response(Bun.file(dp)) : new Response("404", { status: 404 });
    }
    if (p.startsWith("/fixtures/")) {
      const fp = fixturePath(p.slice("/fixtures/".length));
      if (!fp) return new Response("404", { status: 404 });
      return new Response(Bun.file(fp));
    }
    return new Response("404", { status: 404 });
  },
});

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader", "--no-sandbox"],
});

// SHOT_ANDROID=1 → emulate a Pixel 7 (mobile viewport + touch + mobile UA). Honest caveat: this still
// renders on the host SwiftShader GPU, so it validates mobile layout / touch-wiring, NOT a real device.
const ANDROID = process.env.SHOT_ANDROID === "1";
const profile = ANDROID ? { ...devices["Pixel 7"] } : { viewport: { width: 960, height: 680 }, deviceScaleFactor: 1 };
const prefix = ANDROID ? "android-" : "";

async function shot(scene: string, file: string, drive?: (page: import("playwright-core").Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext(profile);
  const page = await context.newPage();
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:4330/?scene=${scene}`);
  // Wait for the viewer to paint something (3D canvas or ECAD svg) then settle.
  await page.waitForSelector("#modal-root canvas, #modal-root svg", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);
  if (drive) await drive(page);
  await page.screenshot({ path: join(HERE, prefix + file) });
  await page.close();
  await context.close();
  console.log(`${prefix}${file}: ${errs.length ? "ERRORS " + errs.join(" | ") : "ok"}`);
}

const setRange = async (page: import("playwright-core").Page, role: string, v: number): Promise<void> => {
  await page.$eval(
    `[data-role="${role}"]`,
    (el, val) => { (el as HTMLInputElement).value = String(val); el.dispatchEvent(new Event("input", { bubbles: true })); },
    v,
  );
};

await shot("step", "shot-step.png");
await shot("draco", "shot-draco.png"); // Draco-compressed GLB — the format real exporters emit
await shot("gerber", "shot-gerber.png");
await shot("kicad", "shot-kicad.png", async (page) => { await page.waitForTimeout(4000); }); // KiCanvas parse + WebGL
await shot("kicad", "shot-kicad3d.png", async (page) => {
  await page.waitForTimeout(4000); // let the 2D board settle first
  await page.click('[data-act="ecad3d"]'); // switch to the 3D board (daemon kicad-cli → GLB)
  await page.waitForTimeout(7000); // kicad-cli export + GLB stream + render
});
await shot("assembly", "shot-section.png", async (page) => {
  await page.click('[data-act="section"]');
  await setRange(page, "section-pos", 0.5);
  await page.waitForTimeout(500);
});
await shot("assembly", "shot-explode.png", async (page) => {
  await page.click('[data-act="explode"]');
  await setRange(page, "explode-pos", 0.65);
  await page.waitForTimeout(500);
});
await shot("assembly", "shot-tree.png", async (page) => {
  await page.click('[data-act="tree"]');
  await page.waitForTimeout(500);
});
await shot("assembly", "shot-measure.png", async (page) => {
  await page.click('[data-act="measure"]');
  const canvas = await page.$("#modal-root canvas");
  const b = await canvas!.boundingBox();
  if (b) {
    // Click the base plate's two front corners → snap to nearest vertices → a width dimension.
    await page.mouse.move(b.x + b.width * 0.30, b.y + b.height * 0.64);
    await page.mouse.click(b.x + b.width * 0.30, b.y + b.height * 0.64);
    await page.mouse.move(b.x + b.width * 0.77, b.y + b.height * 0.58);
    await page.mouse.click(b.x + b.width * 0.77, b.y + b.height * 0.58);
  }
  await page.waitForTimeout(700);
});

await browser.close();
server.stop();
console.log("done");
