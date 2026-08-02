/** Build the web client into web/dist. Run: bun run build:web
 *
 * Atomic: we build into a sibling `dist.next` and only swap it over `dist` once the build AND all
 * asset copies have succeeded. The live `dist` (which the daemon serves from) is therefore never
 * deleted unless a complete replacement is ready — so a failed/interrupted build can't leave the
 * running daemon with no bundle to serve (which is exactly how a self-update once took down the UI).
 *
 * [WEB2-3] The entry (main.js) and app stylesheet are content-hashed (main-<hash>.js /
 * app-<hash>.css) and index.html is rewritten at build time to reference them, so the daemon can
 * serve them immutable (see `webCacheControl`) and a deploy can never leave a browser pinned to a
 * stale bundle. Split chunks were already hashed by Bun (chunk-<hash>.js).
 *
 * [WEB2-17] The copied sw.js is stamped with `self.__ANVIL_BUILD` — the precache manifest (every
 * servable dist asset) + a version hashed from their contents — see the stamping step below.
 *
 * Exported as `buildWeb()` so the guard tests (test/web/bundle-hash.test.ts) can run the REAL build
 * into a temp dir and assert the hashing/sourcemap/manifest contract.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface WebBuildOptions {
  /** Directory that owns dist/ (default: anvild/web — the tree the daemon serves). Tests point this
   *  at a temp dir so a test build never swaps the live bundle out from under a dev daemon. */
  outBase?: string;
  /** Release build (RELEASE=1 in CI): no sourcemaps — .map files are pure bloat in shipped
   *  artifacts (bundle-native already strips them for the native shells; this keeps them out of the
   *  daemon-served release bundle too). Dev/self-update builds keep linked external maps. */
  release?: boolean;
  /** Version shown next to the brand (native builds pass the APK's versionName). */
  appVersion?: string;
}

export async function buildWeb(opts: WebBuildOptions = {}): Promise<{ dist: string; entry: string }> {
  const root = import.meta.dir; // anvild/web (sources always come from here)
  const outBase = opts.outBase ?? root;
  const dist = join(outBase, "dist");
  const next = join(outBase, "dist.next"); // staging dir — swapped in only on full success
  const old = join(outBase, "dist.old"); // transient holding spot during the swap

  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });

  // Version shown next to the brand. The native build passes APP_VERSION (the APK's versionName),
  // so bumping the app version surfaces the same number in the UI. The daemon-served PWA has no
  // APP_VERSION, so it falls back to the repo-root VERSION file (MAJOR.MINOR) — the ONE source of
  // truth every other artifact (Android/iOS/macOS/server) already derives from — as MAJOR.MINOR.0.
  const majorMinor = readFileSync(join(root, "../../VERSION"), "utf8").trim();
  const appVersion = opts.appVersion || `${majorMinor}.0`;

  const result = await Bun.build({
    entrypoints: [join(root, "src/main.ts")],
    outdir: next,
    target: "browser",
    format: "esm",
    splitting: true, // mermaid/xterm/sortable load as lazy chunks
    minify: true,
    // [WEB2-3] Content-hash the entry too (chunks already were): stale-bundle bugs die when the
    // filename changes on every content change and the old name simply stops existing.
    naming: { entry: "[name]-[hash].[ext]", chunk: "chunk-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    sourcemap: opts.release ? "none" : "linked",
    define: { __APP_VERSION__: JSON.stringify(appVersion) },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    rmSync(next, { recursive: true, force: true }); // leave the live dist untouched
    if (import.meta.main) process.exit(1);
    throw new Error("web build failed");
  }

  // The hashed entry name (main-<hash>.js) — index.html must reference it.
  const entryOut = result.outputs.find((o) => o.kind === "entry-point");
  if (!entryOut) throw new Error("web build produced no entry-point output");
  const entryName = basename(entryOut.path);

  // Content-hash the app stylesheet the same way (it changes with nearly every UI tweak).
  const css = readFileSync(join(root, "styles/app.css"));
  const cssName = `app-${Bun.hash(css).toString(36)}.css`;
  writeFileSync(join(next, cssName), css);

  // Rewrite index.html to the hashed names. Fail loudly if the source tags drift — a silent
  // non-match would ship an index.html pointing at files that don't exist.
  let html = readFileSync(join(root, "index.html"), "utf8");
  html = html.replace('src="/main.js"', `src="/${entryName}"`);
  html = html.replace('href="/app.css"', `href="/${cssName}"`);
  if (!html.includes(entryName) || !html.includes(cssName)) {
    throw new Error("index.html rewrite failed — the /main.js or /app.css tag no longer matches build.ts");
  }
  writeFileSync(join(next, "index.html"), html);

  cpSync(join(root, "manifest.json"), join(next, "manifest.json"));
  cpSync(join(root, "assets/anvil.svg"), join(next, "anvil.svg")); // brand mark

  // KaTeX stylesheet + fonts (math is server-rendered to HTML+MathML; the client just styles it)
  const katex = join(root, "../node_modules/katex/dist");
  mkdirSync(join(next, "katex/fonts"), { recursive: true });
  cpSync(join(katex, "katex.min.css"), join(next, "katex/katex.min.css"));
  cpSync(join(katex, "fonts"), join(next, "katex/fonts"), { recursive: true });

  // xterm.js stylesheet (terminal)
  cpSync(join(root, "../node_modules/@xterm/xterm/css/xterm.css"), join(next, "xterm.css"));
  // Tom Select stylesheet (stylized selectors) — structural base; app.css overrides the colors to
  // match the active theme. See the `.ts-*`/`.ts-wrapper` overrides in app.css.
  cpSync(join(root, "../node_modules/tom-select/dist/css/tom-select.css"), join(next, "tom-select.css"));
  // Material Symbols: web loads the font from Google's CDN (index.html); the `material-symbols`
  // dep stays installed so the native client apps can bundle the woff2 offline.

  // [WEB2-17] Stamp the service worker with the build manifest: every servable asset (sourcemaps
  // excluded — debug-only; sw.js itself excluded — it's the updater, not an asset) plus a version
  // hashed from their contents. The SW keys its cache off that version (so ANY shipped change —
  // even in an unhashed shell file like index.html — rolls the cache automatically), precaches
  // exactly this manifest, and prunes everything outside it on activate.
  const assets = walkDist(next)
    .sort()
    .filter((f) => !f.endsWith(".map"));
  let acc = "";
  for (const f of assets) acc += `${f}:${Bun.hash(readFileSync(join(next, f))).toString(36)}\n`;
  const version = Bun.hash(acc).toString(36);
  const swPreamble = `self.__ANVIL_BUILD = ${JSON.stringify({ version, assets: assets.map((f) => `/${f}`) })};\n`;
  writeFileSync(join(next, "sw.js"), swPreamble + readFileSync(join(root, "sw.js"), "utf8")); // service worker (web push + offline shell)

  // Swap `dist.next` → `dist` atomically. The gap between the two renames is two metadata ops
  // (sub-millisecond), versus the multi-second rebuild window the old in-place delete exposed.
  rmSync(old, { recursive: true, force: true });
  if (existsSync(dist)) renameSync(dist, old);
  renameSync(next, dist);
  rmSync(old, { recursive: true, force: true });

  return { dist, entry: entryName };
}

/** All files under `dir`, as /-separated paths relative to it. */
function walkDist(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkDist(join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

if (import.meta.main) {
  const { dist } = await buildWeb({
    // ANVIL_BUILD_OUT: test-only redirect (guard tests build into a temp dir in a SUBPROCESS — an
    // in-process second Bun.build corrupts the bundler state boot-init.test.ts's build relies on).
    outBase: process.env.ANVIL_BUILD_OUT || undefined,
    release: !!process.env.RELEASE,
    appVersion: process.env.APP_VERSION,
  });
  console.log(`built web client → ${dist}`);
}
