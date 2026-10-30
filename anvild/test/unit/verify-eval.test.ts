/**
 * [P2] Real-model calibration eval — ADVISORY, opt-in, NOT a CI gate (spec §8 / R2-T1/T2/T9).
 *
 * The SDK has no temperature knob and an agentic verifier isn't sampling-deterministic, so a real-model
 * pass/fail assertion would be flaky theater. This instead RUNS the real verifier against generated
 * fixtures and REPORTS: per-kind K-run agreement, and — the thing that matters — whether the `done`
 * evidence actually CITES each fixture's unique sentinel symbol (a path alone is echoable from the task
 * text; the sentinel is only in the code body, so citing it proves the model read the repo — R2-T6).
 *
 * Skipped unless ANVIL_VERIFY_EVAL=1 and an account/token is available. Paste the printed report into the
 * phase evidence as calibration; it documents that `present-but-broken` reads as `done` under tier-1 (NG7).
 *
 * Run: ANVIL_VERIFY_EVAL=1 bun test ./test/unit/verify-eval.test.ts
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TodoistTask } from "../../src/integrations/todoist";
import { verifyUnit } from "../../src/integrations/autopilot";
import { resolveBaseSha, createReadWorktree, removeReadWorktree } from "../../src/session/worktree";
import { generateFixture, type FixtureKind } from "../fixtures/verify/generate";

const RUN = process.env.ANVIL_VERIFY_EVAL === "1";
const K = Number(process.env.ANVIL_VERIFY_EVAL_K ?? "3");
const PROMPT_HASH = "v1"; // bump when the verifyUnit prompt changes — labels are versioned to it (R2-T5)

const gate = RUN ? test : test.skip;

gate(
  `[P2] real-model eval (advisory, prompt=${PROMPT_HASH}, K=${K})`,
  async () => {
    const kinds: FixtureKind[] = ["done", "not-done", "partial", "present-but-broken"];
    const report: string[] = [`real-model eval — prompt=${PROMPT_HASH}, K=${K}`];
    for (const kind of kinds) {
      const fx = generateFixture(kind);
      const wtRoot = mkdtempSync(join(tmpdir(), "anvil-eval-wt-"));
      try {
        const { ref } = await resolveBaseSha(fx.repo, "HEAD");
        const { cwd } = await createReadWorktree(fx.repo, ref, wtRoot, kind);
        const tasks: TodoistTask[] = fx.tasks.map((t) => ({ id: t.id, project_id: "p", content: t.content }));
        const verdicts: string[] = [];
        let sentinelCites = 0;
        for (let k = 0; k < K; k++) {
          const r = await verifyUnit({ title: kind }, tasks, { baseWorktree: cwd });
          verdicts.push(r.verdict);
          // Did the evidence cite at least one real sentinel symbol (not just a path echoed from the task)?
          if (fx.sentinels.some((s) => s && r.evidence.includes(s))) sentinelCites++;
        }
        const agreement = verdicts.filter((v) => v === verdicts[0]).length / K;
        report.push(`  ${kind}: verdicts=[${verdicts.join(",")}] agreement=${agreement.toFixed(2)} sentinelCites=${sentinelCites}/${K}`);
        removeReadWorktree(fx.repo, cwd);
      } finally {
        rmSync(wtRoot, { recursive: true, force: true });
        fx.cleanup();
      }
    }
    // Report only — the assertion is merely that the eval completed end-to-end.
    console.log(report.join("\n"));
    expect(report.length).toBe(5);
  },
  180_000,
);
