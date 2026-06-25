/** Build the web client into web/dist. Run: bun run build:web
 *
 * Atomic: we build into a sibling `dist.next` and only swap it over `dist` once the build AND all
 * asset copies have succeeded. The live `dist` (which the daemon serves from) is therefore never
 * deleted unless a complete replacement is ready — so a failed/interrupted build can't leave the
 * running daemon with no bundle to serve (which is exactly how a self-update once took down the UI).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir; // anvild/web
const dist = join(root, "dist");
const next = join(root, "dist.next"); // staging dir — swapped in only on full success
const old = join(root, "dist.old"); // transient holding spot during the swap

rmSync(next, { recursive: true, force: true });
mkdirSync(next, { recursive: true });

// Version shown next to the brand. The native build passes APP_VERSION (the APK's versionName),
// so bumping the app version surfaces the same number in the UI; the PWA falls back to the
// daemon package.json version.
const pkgVersion = (JSON.parse(readFileSync(join(root, "../package.json"), "utf8")) as { version: string }).version;
const appVersion = process.env.APP_VERSION || pkgVersion;

const result = await Bun.build({
  entrypoints: [join(root, "src/main.ts")],
  outdir: next,
  target: "browser",
  format: "esm",
  splitting: true, // mermaid loads as a lazy chunk
  minify: true,
  sourcemap: "linked",
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  rmSync(next, { recursive: true, force: true }); // leave the live dist untouched
  process.exit(1);
}

cpSync(join(root, "index.html"), join(next, "index.html"));
cpSync(join(root, "styles/app.css"), join(next, "app.css"));
cpSync(join(root, "sw.js"), join(next, "sw.js")); // service worker (web push)
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

// Swap `dist.next` → `dist` atomically. The gap between the two renames is two metadata ops
// (sub-millisecond), versus the multi-second rebuild window the old in-place delete exposed.
rmSync(old, { recursive: true, force: true });
if (existsSync(dist)) renameSync(dist, old);
renameSync(next, dist);
rmSync(old, { recursive: true, force: true });

console.log(`built web client → ${dist}`);
