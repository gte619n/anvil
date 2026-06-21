/**
 * Prepare the web client for bundling INSIDE a native app (Android assets / Apple resources):
 * copies web/dist, vendors the Material Symbols font locally (so the app never depends on
 * Google's CDN), and rewrites index.html to use the local font. The native shell injects
 * window.ANVIL_DAEMON_URL at runtime, so the bundled UI talks to the daemon over Tailscale
 * while the app shell + fonts always load offline.
 *
 * Usage: bun run web/bundle-native.ts <targetDir>
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir; // anvild/web
const dist = join(root, "dist");
const target = process.argv[2];
if (!target) {
  console.error("usage: bun run web/bundle-native.ts <targetDir>");
  process.exit(1);
}
if (!existsSync(join(dist, "index.html"))) {
  console.error("web/dist not built — run `bun run build:web` first");
  process.exit(1);
}

mkdirSync(target, { recursive: true });
cpSync(dist, target, { recursive: true });

// Drop sourcemaps — pure bloat inside the APK.
for (const f of readdirSync(target)) if (f.endsWith(".map")) rmSync(join(target, f));

// Vendor the Material Symbols font locally.
const woff2 = join(root, "../node_modules/material-symbols/material-symbols-rounded.woff2");
cpSync(woff2, join(target, "material-symbols.woff2"));
writeFileSync(
  join(target, "fonts.css"),
  `@font-face{font-family:"Material Symbols Rounded";font-style:normal;font-weight:100 700;src:url("./material-symbols.woff2") format("woff2");}\n`,
);

// Rewrite index.html: drop the Google Fonts CDN <link>s, add the local font stylesheet.
const indexPath = join(target, "index.html");
let html = readFileSync(indexPath, "utf8");
html = html
  .replace(/\s*<link[^>]*fonts\.googleapis\.com[^>]*>/g, "")
  .replace(/\s*<link[^>]*rel="preconnect"[^>]*fonts\.g[^>]*>/g, "")
  .replace(/(<link rel="stylesheet" href="\/app\.css" \/>)/, '<link rel="stylesheet" href="/fonts.css" />\n    $1');
writeFileSync(indexPath, html);

console.log(`bundled native web assets → ${target} (local Material Symbols font)`);
