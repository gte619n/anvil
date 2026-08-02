import { test, expect } from "bun:test";
import { webCacheControl } from "../../src/server/http";

// The mutable app shell lives at STABLE, unhashed URLs (/index.html, /sw.js, vendored css, …). If the
// daemon serves them without a revalidation directive, a browser (and the network-first service worker
// that reads through the HTTP cache) keeps serving the OLD bundle across git pull / restart / hard
// refresh — the "I pulled the new code but the UI won't update" bug. These assert the shell always
// revalidates while genuinely-immutable content-hashed names (Bun's split chunks and, since WEB2-3,
// the main-<hash>.js entry + app-<hash>.css stylesheet) and fonts/images still cache hard.

test("the mutable app shell is served no-cache (always revalidate)", () => {
  // main.js/app.css are the PRE-WEB2-3 unhashed names — kept to assert an unhashed name can never
  // be treated as immutable even if one reappears in dist.
  for (const rel of ["index.html", "main.js", "main.js.map", "app.css", "sw.js", "manifest.json", "xterm.css"]) {
    expect(webCacheControl(rel)).toBe("no-cache");
  }
});

test("content-hashed chunks, entry, and stylesheet are immutable", () => {
  expect(webCacheControl("chunk-bgq2swxf.js")).toBe("public, max-age=31536000, immutable");
  expect(webCacheControl("main-0cs6ftry.js")).toBe("public, max-age=31536000, immutable");
  expect(webCacheControl("app-1a2b3c4d5e.css")).toBe("public, max-age=31536000, immutable");
  // a sourcemap for a hashed file is NOT the file itself — it must still revalidate
  expect(webCacheControl("chunk-bgq2swxf.js.map")).toBe("no-cache");
  expect(webCacheControl("main-0cs6ftry.js.map")).toBe("no-cache");
});

test("binary font/image assets cache for a week, including nested paths", () => {
  expect(webCacheControl("anvil.svg")).toBe("public, max-age=604800");
  expect(webCacheControl("katex/fonts/KaTeX_Main-Regular.woff2")).toBe("public, max-age=604800");
});
