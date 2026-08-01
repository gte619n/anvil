import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression for the 3.0.33 "dead app" bug and its WEB2-1 siblings: the skeleton-first change made the
// top-level "instant restore" call loadConversation → clearConversation, which touches
// `permCards`/`questionCards` — consts declared thousands of lines below and thus in their temporal dead
// zone during module init. Init threw for EVERY returning user (activeId set). WEB2-1 found the SAME
// class survives on a cold deep-link boot (#p/<id>, #autopilot): openPlanDeepLink/openAutopilot →
// renderScheduleBar → scheduleSummaryHtml read serverSchedule/autopilotLog/runState, also declared far
// below. Both are now deferred to a queueMicrotask so the module body finishes first. This boots the
// REAL bundle under each scenario and asserts init survives.
//
// Runs under node (not bun) because bun's jsdom can't execute page scripts ("Proxy is not allowed in the
// global prototype chain"); node's jsdom runs them fine. We bundle main.ts to a single IIFE first.

// Build the bundle ONCE into a shared dir (a full esbuild pass per test would be wasteful) and reuse it.
let sharedDir = "";
let bundle = "";
beforeAll(async () => {
  sharedDir = mkdtempSync(join(tmpdir(), "anvil-boot-"));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "../../web/src/main.ts")],
    target: "browser",
    format: "iife",
    define: { __APP_VERSION__: '"test"' },
  });
  expect(built.success).toBe(true);
  const artifact = built.outputs[0];
  expect(artifact).toBeDefined();
  bundle = join(sharedDir, "main.iife.js");
  writeFileSync(bundle, await artifact!.text());
});
afterAll(() => rmSync(sharedDir, { recursive: true, force: true }));

/** Boot the real bundle in node+jsdom at `url`, with the given localStorage seeds; report init outcome. */
function runBoot(bundle: string, url: string, seeds: Record<string, string>): { theme: string | null; initErr: string | null } {
  const anvildRoot = join(import.meta.dir, "../..");
  // The daemon serves web/dist/index.html, but build.ts copies web/index.html to it verbatim — so the
  // source shell is byte-identical. Prefer dist (matches production) but fall back to source when dist is
  // absent (fresh worktree, before `bun run build:web`) so the guard runs without a prior build.
  const distHtml = join(anvildRoot, "web/dist/index.html");
  const srcHtml = join(anvildRoot, "web/index.html");
  const htmlPath = existsSync(distHtml) ? distHtml : srcHtml;
  const seedJs = Object.entries(seeds)
    .map(([k, v]) => `w.localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join("\n");
  const harness = join(anvildRoot, `.boot-harness-${process.pid}-${Math.abs(hashOf(url + JSON.stringify(seeds)))}.mjs`);
  writeFileSync(
    harness,
    `import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
const html = readFileSync(${JSON.stringify(htmlPath)}, "utf8");
const dom = new JSDOM(html, { url: ${JSON.stringify(url)}, runScripts: "dangerously", pretendToBeVisual: true });
const w = dom.window;
w.WebSocket = class { constructor(){ this.readyState = 0; } send(){ return true; } close(){} addEventListener(){} };
w.matchMedia = () => ({ matches:false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });
${seedJs}
const code = readFileSync(${JSON.stringify(bundle)}, "utf8");
const s = w.document.createElement("script");
s.textContent = 'var __APP_VERSION__="test";\\ntry{' + code + '\\n}catch(e){window.__initErr=(e&&(e.name+": "+e.message))||String(e);}';
w.document.body.appendChild(s);
setTimeout(() => { console.log(JSON.stringify({ theme: w.document.documentElement.dataset.theme || null, initErr: w.__initErr || null })); }, 500);
`,
  );
  try {
    const proc = Bun.spawnSync(["node", harness], { cwd: anvildRoot, stderr: "pipe", stdout: "pipe" });
    const out = proc.stdout.toString() || proc.stderr.toString();
    const line = out.split("\n").filter((l) => l.trim().startsWith("{")).pop() ?? "{}";
    return JSON.parse(line) as { theme: string | null; initErr: string | null };
  } finally {
    rmSync(harness, { force: true });
  }
}

function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

const BASE = "https://appassets.androidplatform.net/";

test("the built client boots for a returning user (activeId set) — no init crash, theme applied", () => {
  // Returning user: saved dark theme + an open session that IS in the persisted list (exercises the
  // synchronous setHeaderTitle branch as well as the deferred loadConversation).
  const result = runBoot(bundle, BASE, {
    "anvil.theme": "dark",
    "anvil.active": "sess_old",
    "anvil.sessions": JSON.stringify([
      {
        id: "sess_old",
        title: "old",
        cwd: "/tmp/x",
        source: "existing-dir",
        model: "sonnet",
        autonomy: "mostly-autonomous",
        status: "idle",
        createdAt: "2026-08-01T00:00:00.000Z",
        lastActivityAt: "2026-08-01T00:00:00.000Z",
        usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
      },
    ]),
  });
  expect(result.initErr).toBeNull();
  expect(result.theme).toBe("dark");
}, 30_000);

test("[WEB2-1] cold #autopilot deep-link boot does not crash init", () => {
  const result = runBoot(bundle, `${BASE}#autopilot`, { "anvil.theme": "dark" });
  expect(result.initErr).toBeNull();
  expect(result.theme).toBe("dark");
}, 30_000);

test("[WEB2-1] cold #p/<id> plan deep-link boot does not crash init", () => {
  const result = runBoot(bundle, `${BASE}#p/plan_123`, { "anvil.theme": "dark" });
  expect(result.initErr).toBeNull();
  expect(result.theme).toBe("dark");
}, 30_000);
