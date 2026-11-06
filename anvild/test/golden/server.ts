/**
 * Static harness server for the golden-image spec, launched by Playwright's `webServer` (see
 * playwright.config.ts). Bun-native so it runs under `bunx --bun playwright test` with no extra
 * toolchain. Serves three things:
 *   GET /                  → harness.html
 *   GET /harness-entry.js  → a Bun bundle of harness-entry.ts (+ three.js), built once at boot
 *   GET /fixtures/...      → the generated mesh/ecad fixtures
 *
 * Serves the committed fixtures (anvild/test/fixtures/cad) — it does NOT regenerate them, so the
 * harness never mutates tracked files (the 3MF zip is non-deterministic; see gen.ts / fixtures.test).
 * PORT is read from the env (Playwright sets it via the webServer url/port); defaults to 4321.
 */
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "..", "fixtures", "cad");
const PORT = Number(process.env.HARNESS_PORT || process.env.PORT || 4321);

// Bundle the render entry (three.js resolved from node_modules) once at boot.
const built = await Bun.build({
  entrypoints: [join(HERE, "harness-entry.ts")],
  target: "browser",
  minify: false,
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  throw new Error("harness-entry bundle failed");
}
const entryJs = await built.outputs[0]!.text();

const html = await Bun.file(join(HERE, "harness.html")).text();

const CONTENT_TYPE: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".stl": "model/stl",
  ".obj": "text/plain",
  ".ply": "text/plain",
  ".3mf": "model/3mf",
  ".dae": "model/vnd.collada+xml",
};

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/" || path === "/harness.html") {
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (path === "/harness-entry.js") {
      return new Response(entryJs, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    }
    if (path.startsWith("/fixtures/")) {
      // Prevent path traversal: resolve under FIX and reject escapes.
      const rel = normalize(path.slice("/fixtures/".length)).replace(/^(\.\.(\/|\\|$))+/, "");
      const file = join(FIX, rel);
      if (!file.startsWith(FIX)) return new Response("forbidden", { status: 403 });
      const f = Bun.file(file);
      if (!(await f.exists())) return new Response("not found", { status: 404 });
      const ext = path.slice(path.lastIndexOf("."));
      const ct = CONTENT_TYPE[ext] || "application/octet-stream";
      return new Response(f, { headers: { "content-type": ct } });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`[harness] serving on http://127.0.0.1:${server.port}`);
