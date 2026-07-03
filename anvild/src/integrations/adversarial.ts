/**
 * The adversarial panel: after Claude writes a single-model implementation plan, competing OpenRouter
 * models independently critique it and score it. When a repo root is supplied, each critic runs as an
 * AGENT — it can read the actual codebase through read-only repo tools (list_dir / read_file / grep) to
 * check the plan against real code, not just Claude's prose. The lowest-scoring critique's strongest
 * objection is surfaced to the human reviewer so a single-model plan's blind spots are visible before
 * build.
 *
 * Advisory only: a model that errors, can't do tool-calling, or returns unparseable JSON is retained as
 * an `error` critique but excluded from the consensus math, and the panel never throws — planning must
 * never fail because a third-party API hiccuped.
 */
import { extractJson } from "./json";
import type { OpenRouterClient, OpenRouterMessage } from "./openrouter";
import { REPO_TOOLS, executeRepoTool } from "./repo-tools";

// A critic runs at most this many tool rounds before it's asked to commit to a verdict — a backstop so a
// model that keeps spelunking can't run up unbounded latency/cost on one plan.
const MAX_TOOL_ROUNDS = 12;

export interface AdversarialCritique {
  model: string;
  score: number; // 0–10; lower = the model thinks the plan is weaker
  verdict: string; // one-line overall judgement
  objections: string[]; // concrete problems found, strongest first
  error?: string; // set when the model failed or returned unparseable output (excluded from consensus)
}

export interface AdversarialReview {
  critiques: AdversarialCritique[];
  consensusScore?: number; // mean of successful scores (undefined if none succeeded)
  strongestObjection?: string; // the top objection from the lowest-scoring successful critique
}

interface RawCritique {
  score?: unknown;
  verdict?: unknown;
  objections?: unknown;
}

const RESPONSE_INSTRUCTION = `When you are done inspecting, respond with ONLY a JSON object, no prose or code fences:
{"score": <integer 0-10, where 10 = excellent plan with no serious problems and 0 = fundamentally broken>, "verdict": "<one sentence overall judgement>", "objections": ["<strongest objection>", "<next>", ...]}`;

function systemPrompt(agentic: boolean): string {
  const role = `You are an adversarial reviewer on an engineering panel. Another model wrote an implementation plan. Your job is to find the STRONGEST reason it is wrong, incomplete, or risky — missed edge cases, unstated assumptions, wrong approach, hidden complexity, or anything that would make the change fail review or break in production. Be specific and technical; do not rubber-stamp it.`;
  const tools = agentic
    ? `\n\nYou have READ-ONLY access to the repository through tools: list_dir, read_file, and grep. USE THEM to verify the plan against the actual code — check that the files and functions it names exist and behave as it assumes, and look for anything it overlooked. Base your objections on what you actually find.`
    : "";
  return `${role}${tools}\n\n${RESPONSE_INSTRUCTION}`;
}

function userPrompt(input: { title: string; rationale: string; plan: string }): string {
  return `Unit: ${input.title}
Why these tasks are bundled: ${input.rationale}

Plan under review:
${input.plan}`;
}

/** Parse a model's final message into a critique, clamping the score and coercing fields defensively. */
function parseCritique(model: string, content: string): AdversarialCritique {
  const parsed = extractJson<RawCritique>(content);
  const score = Math.max(0, Math.min(10, Math.round(Number(parsed.score))));
  if (!Number.isFinite(score)) throw new Error("model returned a non-numeric score");
  const objections = Array.isArray(parsed.objections)
    ? parsed.objections.map((o) => String(o)).filter((o) => o.trim())
    : [];
  return {
    model,
    score,
    verdict: typeof parsed.verdict === "string" ? parsed.verdict.trim() : "",
    objections,
  };
}

/**
 * Drive one model to a final critique. With `repoRoot`, it runs an agent loop: the model requests repo
 * tools, the daemon executes them read-only and feeds results back, until the model answers (or the
 * round cap forces a verdict). Without `repoRoot`, it's a single plan-only completion.
 */
async function runCritic(
  client: OpenRouterClient,
  model: string,
  input: { title: string; rationale: string; plan: string },
  repoRoot?: string,
): Promise<string> {
  const messages: OpenRouterMessage[] = [
    { role: "system", content: systemPrompt(!!repoRoot) },
    { role: "user", content: userPrompt(input) },
  ];
  if (!repoRoot) return client.chat(model, messages, { temperature: 0.4 });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await client.complete(model, messages, { temperature: 0.4, tools: REPO_TOOLS });
    if (!res.toolCalls.length) return res.content; // model committed to a verdict
    // Echo the assistant's tool request, then answer every call before the next turn (OpenAI requires a
    // tool reply per tool_call_id). Tool execution is read-only and confined to the repo root.
    messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
    for (const call of res.toolCalls) {
      const result = await executeRepoTool(repoRoot, call.function.name, call.function.arguments);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  // Round cap hit — ask once more with tools off so the model must produce its verdict now.
  return client.complete(model, messages, { temperature: 0.4, toolChoice: "none" }).then((r) => r.content);
}

/** Run one model's critique. Never throws — failures come back as a critique with `error` set. A model
 *  that can't do tool-calling falls back to reviewing the plan text alone so it still gets a vote. */
async function critiqueOne(
  client: OpenRouterClient,
  model: string,
  input: { title: string; rationale: string; plan: string },
  repoRoot?: string,
): Promise<AdversarialCritique> {
  try {
    return parseCritique(model, await runCritic(client, model, input, repoRoot));
  } catch (e) {
    if (repoRoot) {
      // The agentic path failed (often: the model doesn't support tools). Give it one plain, tool-free
      // pass so a capable reviewer isn't dropped just because it can't drive tools.
      try {
        return parseCritique(model, await runCritic(client, model, input));
      } catch {
        /* fall through to the error critique below */
      }
    }
    return { model, score: 0, verdict: "", objections: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Fan the plan out to every model in parallel (`Promise.allSettled` — one model failing must not sink
 * the others), collect the critiques, and compute the consensus. Successful critiques drive the
 * consensus score (mean) and the strongest objection (top objection of the lowest-scoring critique).
 * When `opts.repoRoot` is set, critics inspect the real codebase; otherwise they review the plan text.
 */
export async function reviewPlan(
  input: { title: string; rationale: string; plan: string },
  deps: { client: OpenRouterClient; models: string[] },
  // signal is honoured inside the client (it carries the run-level abort from construction); repoRoot,
  // when present, switches critics into agentic (codebase-reading) mode.
  opts: { signal?: AbortSignal; repoRoot?: string } = {},
): Promise<AdversarialReview> {
  const settled = await Promise.allSettled(
    deps.models.map((m) => critiqueOne(deps.client, m, input, opts.repoRoot)),
  );
  // critiqueOne never throws, so every entry fulfils; keep the defensive rejection→error mapping anyway.
  const critiques: AdversarialCritique[] = settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { model: deps.models[i]!, score: 0, verdict: "", objections: [], error: String(r.reason) },
  );

  const ok = critiques.filter((c) => !c.error);
  const review: AdversarialReview = { critiques };
  if (ok.length) {
    review.consensusScore = Math.round((ok.reduce((s, c) => s + c.score, 0) / ok.length) * 100) / 100;
    // Strongest objection = the top objection from the harshest (lowest-scoring) critique that has one.
    const byScore = [...ok].sort((a, b) => a.score - b.score);
    const harshest = byScore.find((c) => c.objections.length > 0);
    if (harshest) review.strongestObjection = harshest.objections[0];
  }
  return review;
}

/** Render a review as a markdown block appended under `## Adversarial Review` in the stored plan. */
export function formatReview(review: AdversarialReview): string {
  const lines: string[] = ["## Adversarial Review", ""];
  if (review.consensusScore !== undefined) {
    lines.push(`**Consensus score:** ${review.consensusScore}/10`);
  }
  if (review.strongestObjection) {
    lines.push(`**Strongest objection:** ${review.strongestObjection}`);
  }
  lines.push("");
  for (const c of review.critiques) {
    if (c.error) {
      lines.push(`### ${c.model} — ⚠ unavailable`);
      lines.push(c.error);
      lines.push("");
      continue;
    }
    lines.push(`### ${c.model} — score ${c.score}/10`);
    if (c.verdict) lines.push(`_${c.verdict}_`);
    for (const o of c.objections) lines.push(`- ${o}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
