# Real-tool tests

Tests in this folder drive the real tools on the machine: the installed SolidCraft, real Chrome.
They are the suite described in `docs/plans/2026-11-19-agent-cad-and-browser.md` §8.3.

Plain `bun test` picks these files up like any other, so every test here must skip itself unless
the run asked for real tools:

```ts
import { test, expect } from "bun:test";
import { REAL, SOLIDCRAFT_CLI, hasSolidcraft } from "../helpers/real-tools";

test.skipIf(!REAL)("the reference plate measures 35335.2 mm³ at L=120", async () => {
  expect(hasSolidcraft()).toBe(true); // absent binary is a FAILURE in a real run, not a skip
  // … drive SOLIDCRAFT_CLI …
});
```

Rules:

- Guard with `test.skipIf(!REAL)` and nothing else. `REAL` is true only when `ANVIL_REAL_TOOLS` is set.
- Do not skip on "tool not installed". In a real run a missing tool must fail, otherwise the gate
  would pass on a machine that proved nothing.
- Work in a temp folder. Never touch `~/.anvil`, the live daemon on port 7701, or a real profile.
- List each test under its phase's `"real"` key in `test/phase-manifest.json`.

Run them through the phase gate, which sets `ANVIL_REAL_TOOLS=1` and fails on any skip:

```sh
cd anvild && bun test/tools/phase-gate.ts A1 --require-real
```

Without `--require-real` the gate reports them as "not run".
