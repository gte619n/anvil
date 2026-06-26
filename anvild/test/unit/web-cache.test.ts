import { test, expect } from "bun:test";
import { webCacheControl } from "../../src/server/http";

// The web app shell lives at STABLE, unhashed URLs (/main.js, /app.css, /sw.js, …). If the daemon
// serves them without a revalidation directive, a browser (and the network-first service worker that
// reads through the HTTP cache) keeps serving the OLD bundle across git pull / restart / hard refresh —
// the "I pulled the new code but the UI won't update" bug. These assert the shell always revalidates
// while genuinely-immutable assets (Bun's content-hashed chunks, fonts/images) still cache hard.

test("the mutable app shell is served no-cache (always revalidate)", () => {
  for (const rel of ["index.html", "main.js", "main.js.map", "app.css", "sw.js", "manifest.json", "xterm.css"]) {
    expect(webCacheControl(rel)).toBe("no-cache");
  }
});

test("content-hashed chunks are immutable", () => {
  expect(webCacheControl("chunk-bgq2swxf.js")).toBe("public, max-age=31536000, immutable");
  // a sourcemap for a chunk is NOT the chunk itself — it must still revalidate
  expect(webCacheControl("chunk-bgq2swxf.js.map")).toBe("no-cache");
});

test("binary font/image assets cache for a week, including nested paths", () => {
  expect(webCacheControl("anvil.svg")).toBe("public, max-age=604800");
  expect(webCacheControl("katex/fonts/KaTeX_Main-Regular.woff2")).toBe("public, max-age=604800");
});
