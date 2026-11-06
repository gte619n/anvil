/**
 * One-off: screenshot the REAL cad.ts viewer chrome (toolbar + HUD + overlay) rendering a fixture,
 * to show the actual web UI (not just the bare render pipeline). Serves the built app CSS + a bundle
 * that calls openCadViewer with a stub CadIo pointing at the committed fixtures. Not part of CI.
 *   bun run test/golden/shot-app.ts
 */
import { chromium } from "playwright-core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FIX = join(HERE, "..", "fixtures", "cad");

// Entry that mounts the real viewer against fixture URLs.
const tmp = mkdtempSync(join(tmpdir(), "anvil-shotapp-"));
const entryPath = join(tmp, "entry.ts");
writeFileSync(
  entryPath,
  `import { openCadViewer } from ${JSON.stringify(join(ROOT, "web/src/cad.ts"))};
const base = location.origin;
const mesh = (p) => base + "/fixtures/mesh/" + p.split("/").pop();
const io = {
  fileUrl: mesh,
  cadUrl: mesh,
  fetchBytes: async (p) => new Uint8Array(await (await fetch(mesh(p))).arrayBuffer()),
  fetchText: async (p) => (await fetch(mesh(p))).text(),
  listSiblings: async () => [],
};
try { openCadViewer(${JSON.stringify("cube.glb")}, io); }
catch (e) { document.body.innerHTML = "<pre style='color:red'>" + (e && e.stack || e) + "</pre>"; }
setTimeout(() => { window.__shot = true; }, 2500);
`,
);

const built = await Bun.build({ entrypoints: [entryPath], target: "browser", minify: false });
if (!built.success) { for (const l of built.logs) console.error(l); process.exit(1); }
const entryJs = await built.outputs[0]!.text();
const css = await Bun.file(join(ROOT, "web/styles/app.css")).text();
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style>
<style>html,body{margin:0;height:100%;background:#0e0f12}</style></head>
<body><div id="modal-root"></div><script type="module" src="/entry.js"></script></body></html>`;

const server = Bun.serve({
  port: 4330,
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/" ) return new Response(html, { headers: { "content-type": "text/html" } });
    if (p === "/entry.js") return new Response(entryJs, { headers: { "content-type": "text/javascript" } });
    if (p.startsWith("/fixtures/")) {
      const f = Bun.file(join(FIX, p.slice("/fixtures/".length)));
      return (await f.exists()) ? new Response(f) : new Response("404", { status: 404 });
    }
    return new Response("404", { status: 404 });
  },
});

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 900, height: 640 }, deviceScaleFactor: 1 });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto("http://127.0.0.1:4330/");
await page.waitForFunction("window.__shot === true", { timeout: 8000 }).catch(() => {});
const out = join(HERE, "app-shot.png");
await page.screenshot({ path: out });
await browser.close();
server.stop();
console.log("errors:", errors.length ? errors.join("\n") : "(none)");
console.log("wrote", out);
