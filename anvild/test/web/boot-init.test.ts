import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression for the 3.0.33 "dead app" bug: the skeleton-first change made the top-level "instant
// restore" call loadConversation → clearConversation, which touches `permCards`/`questionCards` — consts
// declared thousands of lines below and thus in their temporal dead zone during module init. Init threw
// for EVERY returning user (activeId set), leaving a static shell with the wrong theme and no
// servers/environments. Fresh installs (no activeId) never hit it, so the whole test suite + typecheck +
// build stayed green. This boots the REAL bundle with a returning user's state and asserts it survives.
//
// Runs under node (not bun) because bun's jsdom can't execute page scripts ("Proxy is not allowed in the
// global prototype chain"); node's jsdom runs them fine. We bundle main.ts to a single IIFE first.

test("the built client boots for a returning user (activeId set) — no init crash, theme applied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-boot-"));
  try {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "../../web/src/main.ts")],
      target: "browser",
      format: "iife",
      define: { __APP_VERSION__: '"test"' },
    });
    expect(built.success).toBe(true);
    const artifact = built.outputs[0];
    expect(artifact).toBeDefined();
    const bundle = join(dir, "main.iife.js");
    writeFileSync(bundle, await artifact!.text());

    // node harness: load index.html into jsdom, seed a returning user's localStorage (saved dark theme +
    // an open session), run the bundle, and report whether the theme got applied (proves init completed).
    // It lives in the anvild root (not the tmpdir) so node resolves `jsdom` by the normal node_modules
    // walk — NODE_PATH doesn't apply to ESM imports.
    const anvildRoot = join(import.meta.dir, "../..");
    const harness = join(anvildRoot, `.boot-harness-${process.pid}.mjs`);
    writeFileSync(
      harness,
      `import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
const html = readFileSync(${JSON.stringify(join(import.meta.dir, "../../web/dist/index.html"))}, "utf8");
const dom = new JSDOM(html, { url: "https://appassets.androidplatform.net/", runScripts: "dangerously", pretendToBeVisual: true });
const w = dom.window;
w.WebSocket = class { constructor(){ this.readyState = 0; } send(){ return true; } close(){} addEventListener(){} };
w.matchMedia = () => ({ matches:false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });
w.localStorage.setItem("anvil.theme", "dark");      // returning user's saved theme
w.localStorage.setItem("anvil.active", "sess_old");  // returning user has an open session
const code = readFileSync(${JSON.stringify(bundle)}, "utf8");
const s = w.document.createElement("script");
s.textContent = 'var __APP_VERSION__="test";\\ntry{' + code + '\\n}catch(e){window.__initErr=(e&&(e.name+": "+e.message))||String(e);}';
w.document.body.appendChild(s);
setTimeout(() => { console.log(JSON.stringify({ theme: w.document.documentElement.dataset.theme || null, initErr: w.__initErr || null })); }, 500);
`,
    );

    let out: string;
    try {
      const proc = Bun.spawnSync(["node", harness], { cwd: anvildRoot, stderr: "pipe", stdout: "pipe" });
      out = proc.stdout.toString() || proc.stderr.toString();
    } finally {
      rmSync(harness, { force: true });
    }
    const line = out.split("\n").filter((l) => l.trim().startsWith("{")).pop() ?? "{}";
    const result = JSON.parse(line) as { theme: string | null; initErr: string | null };

    expect(result.initErr).toBeNull(); // init must NOT throw (the 3.0.33 regression threw here)
    expect(result.theme).toBe("dark"); // the saved theme applied ⇒ init ran to completion
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
