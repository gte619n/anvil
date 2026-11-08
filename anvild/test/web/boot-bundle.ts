/**
 * [#158] Build web/src/main.ts into a single browser IIFE bundle ONCE per test process.
 *
 * Several dom-suite files (boot-init.test.ts, fleet-default-collision.test.ts, subagents.test.ts, the
 * mirror/offline suites) boot this same bundle under node+jsdom. Bun shares the module registry across
 * test files in a process, so a memoized module-level build hands every consumer the one artifact —
 * and keeps us to a single Bun.build of the graph per process (building twice has historically been
 * flaky on this entry graph).
 *
 * `import.meta.url` is defined away because jsdom executes this bundle as a CLASSIC script (not a
 * module): any surviving `import.meta` token is a parse-time SyntaxError that aborts the whole bundle
 * before our boot try/catch can run. The IIFE format doesn't strip it on its own, and three's
 * DRACOLoader (pulled in by the CAD viewer's wireGltfDecoders) ships a
 * `new URL("../libs/draco/draco_decoder.wasm", import.meta.url)` — so without this define every boot
 * test fails with theme/initErr both null. Production is unaffected: that build is ESM + splitting,
 * where import.meta is legal, and the viewer overrides the decoder path with setDecoderPath("/draco/")
 * regardless. The replacement value is a dummy base that keeps `new URL(...)` from throwing; nothing
 * in these tests fetches the decoder.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let built: Promise<string> | null = null;

/** Path to the built IIFE bundle (created on first call; reused by every later caller). */
export function buildBootBundle(): Promise<string> {
  if (!built) {
    built = (async () => {
      const dir = mkdtempSync(join(tmpdir(), "anvil-boot-bundle-"));
      process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
      const res = await Bun.build({
        entrypoints: [join(import.meta.dir, "../../web/src/main.ts")],
        target: "browser",
        format: "iife",
        define: { __APP_VERSION__: '"test"', "import.meta.url": '"file:///boot-bundle"' },
      });
      if (!res.success) throw new Error(`web bundle build failed:\n${res.logs.map((l) => String(l)).join("\n")}`);
      const out = join(dir, "main.iife.js");
      writeFileSync(out, await res.outputs[0]!.text());
      return out;
    })();
  }
  return built;
}
