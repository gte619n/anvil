import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// [WEB2-3] Guard the hashed-bundle contract by running the REAL build (into a temp dir — never the
// live web/dist a dev daemon may be serving) and asserting on its output:
//   • index.html references a content-hashed entry (main-<hash>.js) + stylesheet (app-<hash>.css)
//     that actually exist in dist — the naming and the rewrite can't drift apart silently.
//   • a RELEASE build ships zero sourcemaps.
// The build runs in a SUBPROCESS (exactly how `bun run build:web` runs it), not via an in-process
// buildWeb() call: a second in-process Bun.build corrupts bundler state that boot-init.test.ts's
// own Bun.build depends on when the whole suite shares one process (order-dependent full-suite
// failure, observed on bun 1.3.14). It's fast (<1s), so building once per suite run is cheap.

const anvildRoot = join(import.meta.dir, "../..");
let outBase = "";
let dist = "";
let html = "";
beforeAll(() => {
  outBase = mkdtempSync(join(tmpdir(), "anvil-webbuild-"));
  const proc = Bun.spawnSync(["bun", "run", join(anvildRoot, "web/build.ts")], {
    cwd: anvildRoot,
    env: { ...process.env, RELEASE: "1", ANVIL_BUILD_OUT: outBase, APP_VERSION: "0.0.0-test" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(`build:web failed:\n${proc.stdout}\n${proc.stderr}`);
  dist = join(outBase, "dist");
  html = readFileSync(join(dist, "index.html"), "utf8");
});
afterAll(() => rmSync(outBase, { recursive: true, force: true }));

/** All files under dist, as /-separated paths relative to it. */
function walk(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

test("dist/index.html references a hashed entry that exists (and no unhashed /main.js survives)", () => {
  const m = html.match(/<script type="module" src="\/(main-[a-z0-9]+\.js)">/);
  expect(m).not.toBeNull();
  expect(existsSync(join(dist, m![1]!))).toBe(true);
  expect(html).not.toContain('src="/main.js"');
  expect(existsSync(join(dist, "main.js"))).toBe(false);
}, 30_000);

test("dist/index.html references a hashed app stylesheet that exists", () => {
  const m = html.match(/<link rel="stylesheet" href="\/(app-[a-z0-9]+\.css)"/);
  expect(m).not.toBeNull();
  expect(existsSync(join(dist, m![1]!))).toBe(true);
  expect(existsSync(join(dist, "app.css"))).toBe(false);
}, 30_000);

test("a RELEASE build ships no sourcemaps", () => {
  expect(walk(dist).filter((f) => f.endsWith(".map"))).toEqual([]);
}, 30_000);
