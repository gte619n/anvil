/**
 * Server for the live-viewer spec (live.pw.ts), launched by Playwright's `webServer`
 * (live.playwright.config.ts). Unlike ./server.ts — whose page bundles its own render entry and never
 * loads the product's viewer — this one serves THE PRODUCT:
 *
 *   GET /…                 the real web bundle, built at boot by the real build script
 *                          (`bun run web/build.ts`, redirected into a temp folder with ANVIL_BUILD_OUT
 *                          so the worktree's web/dist is not touched)
 *   GET /api/cad/preview   the route the live viewer fetches a part's preview from. `path` is
 *                          `cad/<part>/.cache/preview-<rev>.glb`; an odd rev is fixture A (one box,
 *                          80 × 50 × 6 mm), an even rev fixture B (two boxes, 120 × 50 × 6 mm overall)
 *   anything else /api/*   404 — the app's socket is stubbed in the page (see live.pw.ts)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { boxesGlb } from "./live-glb";

const HERE = dirname(fileURLToPath(import.meta.url));
const ANVILD = join(HERE, "..", "..");
const PORT = Number(process.env.HARNESS_PORT || process.env.PORT || 4322);

const out = mkdtempSync(join(tmpdir(), "anvil-live-pw-"));
process.on("exit", () => rmSync(out, { recursive: true, force: true }));
const build = Bun.spawnSync(["bun", "run", "web/build.ts"], { cwd: ANVILD, env: { ...process.env, ANVIL_BUILD_OUT: out }, stdout: "pipe", stderr: "pipe" });
if (build.exitCode !== 0) throw new Error(`web build failed:\n${build.stdout.toString()}\n${build.stderr.toString()}`);
const DIST = join(out, "dist");

export const FIXTURE_A = boxesGlb([{ size: [80, 50, 6] }]);
export const FIXTURE_B = boxesGlb([{ size: [60, 50, 6] }, { size: [60, 50, 6], at: [60, 0, 0] }]);

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".woff2": "font/woff2" };

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/cad/preview") {
      const m = /^cad\/[a-z0-9-]+\/\.cache\/preview-(\d+)\.glb$/.exec(url.searchParams.get("path") ?? "");
      if (!m || !url.searchParams.get("cwd")) return new Response("not found", { status: 404 });
      return new Response(new Blob([(Number(m[1]) % 2 === 1 ? FIXTURE_A : FIXTURE_B) as unknown as BlobPart]), { headers: { "content-type": "model/gltf-binary" } });
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return new Response("not found", { status: 404 });
    const rel = normalize(url.pathname === "/" ? "index.html" : url.pathname.slice(1));
    const file = join(DIST, rel);
    if (!file.startsWith(DIST)) return new Response("forbidden", { status: 403 });
    const f = Bun.file(file);
    if (!(await f.exists())) return new Response("not found", { status: 404 });
    return new Response(f, { headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" } });
  },
});
console.log(`[live] serving the built web bundle from ${DIST} on http://127.0.0.1:${server.port}`);
