import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewPlan, formatReview } from "../../src/integrations/adversarial";
import type { OpenRouterClient, OpenRouterMessage } from "../../src/integrations/openrouter";

// The orchestrator fans the plan out to competing models, tolerates per-model failure / garbage JSON,
// and computes consensus from the survivors. A fake client (just a `chat` method) stands in for the
// real OpenRouterClient — no network needed.

const INPUT = { title: "Do the thing", rationale: "they belong together", plan: "# Plan\nChange src/x.ts." };

/** Build a fake client whose `chat` returns a canned reply per model (keyed by model slug). */
function fakeClient(replies: Record<string, string | (() => Promise<string>)>): OpenRouterClient {
  return {
    chat: async (model: string) => {
      const r = replies[model];
      if (r === undefined) throw new Error(`no stub for ${model}`);
      return typeof r === "function" ? r() : r;
    },
  } as unknown as OpenRouterClient;
}

test("consensus is the mean of scores; strongest objection comes from the lowest score", async () => {
  const client = fakeClient({
    high: JSON.stringify({ score: 8, verdict: "solid", objections: ["minor nit"] }),
    low: JSON.stringify({ score: 4, verdict: "risky", objections: ["misses the auth path", "no rollback"] }),
  });
  const review = await reviewPlan(INPUT, { client, models: ["high", "low"] });

  expect(review.critiques).toHaveLength(2);
  expect(review.consensusScore).toBe(6);
  expect(review.strongestObjection).toBe("misses the auth path"); // top objection of the score-4 critique
});

test("a model that throws becomes an error critique excluded from consensus; no throw", async () => {
  const client = fakeClient({
    good: JSON.stringify({ score: 7, verdict: "ok", objections: ["one thing"] }),
    bad: () => Promise.reject(new Error("502 upstream")),
  });
  const review = await reviewPlan(INPUT, { client, models: ["good", "bad"] });

  expect(review.critiques).toHaveLength(2);
  const errored = review.critiques.find((c) => c.error);
  expect(errored?.model).toBe("bad");
  expect(errored?.error).toContain("502");
  // consensus computed only from the survivor
  expect(review.consensusScore).toBe(7);
});

test("prose/fence-wrapped JSON is tolerated via the shared extractJson", async () => {
  const client = fakeClient({
    chatty: "Sure, here's my review:\n```json\n{\"score\": 5, \"verdict\": \"meh\", \"objections\": [\"scaling\"]}\n```\nHope that helps!",
  });
  const review = await reviewPlan(INPUT, { client, models: ["chatty"] });

  expect(review.critiques[0]!.error).toBeUndefined();
  expect(review.critiques[0]!.score).toBe(5);
  expect(review.consensusScore).toBe(5);
  expect(review.strongestObjection).toBe("scaling");
});

test("agentic mode: the critic reads the repo via tools before it scores", async () => {
  const repo = mkdtempSync(join(tmpdir(), "anvil-adv-"));
  writeFileSync(join(repo, "widget.ts"), "export const FLAG = true;\n");
  try {
    // A fake client that drives the OpenAI tool loop: first turn asks to read a file, second turn (now
    // that a tool result is in the transcript) commits to a verdict. It also proves the executor ran by
    // echoing what it saw into the objection.
    let turn = 0;
    let toolResultSeen = "";
    const client = {
      complete: async (_model: string, messages: OpenRouterMessage[]) => {
        turn++;
        if (turn === 1) {
          return {
            content: "",
            toolCalls: [{ id: "t1", type: "function" as const, function: { name: "read_file", arguments: JSON.stringify({ path: "widget.ts" }) } }],
          };
        }
        const toolMsg = messages.find((m) => m.role === "tool");
        toolResultSeen = String(toolMsg?.content ?? "");
        return {
          content: JSON.stringify({ score: 3, verdict: "read the code", objections: ["saw: " + toolResultSeen.trim()] }),
          toolCalls: [],
        };
      },
    } as unknown as OpenRouterClient;

    const review = await reviewPlan(INPUT, { client, models: ["agent"] }, { repoRoot: repo });

    expect(turn).toBe(2); // one tool round, then the verdict
    expect(toolResultSeen).toContain("FLAG = true"); // the daemon actually read the file
    expect(review.critiques[0]!.error).toBeUndefined();
    expect(review.critiques[0]!.score).toBe(3);
    expect(review.strongestObjection).toContain("FLAG = true");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("agentic fallback: a client that can't do tools still reviews the plan text", async () => {
  // `complete` throws (mimicking a model/endpoint that rejects tool calls); `chat` works. With a
  // repoRoot set, critiqueOne should fall back to the plain plan-only pass rather than dropping the vote.
  const client = {
    complete: async () => {
      throw new Error("400 this model does not support tools");
    },
    chat: async () => JSON.stringify({ score: 7, verdict: "fine on paper", objections: ["untested assumption"] }),
  } as unknown as OpenRouterClient;

  const review = await reviewPlan(INPUT, { client, models: ["no-tools"] }, { repoRoot: "/tmp" });
  expect(review.critiques[0]!.error).toBeUndefined();
  expect(review.consensusScore).toBe(7);
  expect(review.strongestObjection).toBe("untested assumption");
});

test("formatReview renders a markdown block with the heading and consensus", async () => {
  const client = fakeClient({ m: JSON.stringify({ score: 6, verdict: "fine", objections: ["gap"] }) });
  const review = await reviewPlan(INPUT, { client, models: ["m"] });
  const md = formatReview(review);
  expect(md).toContain("## Adversarial Review");
  expect(md).toContain("Consensus score:** 6/10");
  expect(md).toContain("gap");
});
