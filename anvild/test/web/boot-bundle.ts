/**
 * [#158] Build web/src/main.ts into a single browser IIFE bundle ONCE per test process.
 *
 * Two dom-suite files (boot-init.test.ts, fleet-default-collision.test.ts) boot this same bundle
 * under node+jsdom. Running Bun.build TWICE on the same entry graph inside one `bun test` process
 * intermittently corrupts the bundler's resolution cache — mermaid's dynamic chunk imports get
 * misattributed to markdown-it/index.mjs and whichever build runs LATER fails with
 * "Could not resolve: ./chunks/mermaid.core/…". (Each file's build passes in isolation; only the
 * second in-process build of the full suite trips it.) Bun shares the module registry across test
 * files in a process, so a memoized module-level build hands every consumer the one artifact.
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
        define: { __APP_VERSION__: '"test"' },
      });
      if (!res.success) throw new Error(`web bundle build failed:\n${res.logs.map((l) => String(l)).join("\n")}`);
      const out = join(dir, "main.iife.js");
      writeFileSync(out, await res.outputs[0]!.text());
      return out;
    })();
  }
  return built;
}
