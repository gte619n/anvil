/** Build the web client into web/dist. Run: bun run build:web */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir; // anvild/web
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "src/main.ts")],
  outdir: dist,
  target: "browser",
  format: "esm",
  splitting: true, // mermaid loads as a lazy chunk
  minify: true,
  sourcemap: "linked",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

cpSync(join(root, "index.html"), join(dist, "index.html"));
cpSync(join(root, "styles/app.css"), join(dist, "app.css"));

// KaTeX stylesheet + fonts (math is server-rendered to HTML+MathML; the client just styles it)
const katex = join(root, "../node_modules/katex/dist");
mkdirSync(join(dist, "katex/fonts"), { recursive: true });
cpSync(join(katex, "katex.min.css"), join(dist, "katex/katex.min.css"));
cpSync(join(katex, "fonts"), join(dist, "katex/fonts"), { recursive: true });

console.log(`built web client → ${dist}`);
