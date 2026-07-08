import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeCliOptions } from "./cli";

/**
 * The three remote-branch prefixes anvil uses. The local worktree branch stays the bare session
 * slug (arch §8); only the *remote* branch is prefixed so it reads as intent to reviewers on the
 * host — `feature/…`, `bugfix/…`, or `hotfix/…`.
 */
export type BranchKind = "feature" | "bugfix" | "hotfix";
const KINDS: BranchKind[] = ["feature", "bugfix", "hotfix"];
const KIND_SET = new Set<string>(KINDS);

/**
 * Keyword heuristic used both as the LLM's fallback and as a synchronous last resort (e.g. a push
 * that lands before the eager classification finished). Order matters: an urgent production fix
 * ("hotfix") outranks a plain bug fix, which outranks the default "feature".
 */
export function heuristicKind(text: string): BranchKind {
  const t = text.toLowerCase();
  if (/\b(hotfix|urgent|asap|prod(uction)?\s+(down|outage|incident)|emergency|sev-?\d)\b/.test(t)) {
    return "hotfix";
  }
  if (/\b(fix|bug|broken|regression|crash|error|defect|incorrect|failing|doesn'?t work)\b/.test(t)) {
    return "bugfix";
  }
  return "feature";
}

/**
 * Classify a session's goal — drawn from its first user prompt(s) — into a branch prefix. Mirrors
 * `pickIcon`: one-shot Haiku, no tools, §3 OAuth env, hard timeout. The model only has to emit one
 * of three words, so Haiku is plenty; on any failure/timeout/off-list answer we fall back to the
 * keyword heuristic so a prefix is ALWAYS produced (never a bare, unprefixed remote branch).
 */
export async function classifyBranchKind(prompts: string, env: Record<string, string>): Promise<BranchKind> {
  const brief = prompts.trim().slice(0, 2000);
  if (!brief) return "feature";
  const prompt =
    `A developer is starting a coding session. Based on their opening message(s), classify the work as one of:\n` +
    `- bugfix: fixing a defect, regression, crash, or incorrect behavior in existing code\n` +
    `- hotfix: an urgent fix for a live production issue/outage/incident\n` +
    `- feature: anything else — new functionality, refactors, chores, docs, tests, config\n\n` +
    `Opening message(s):\n"""${brief}"""\n\n` +
    `Reply with ONLY one word: bugfix, hotfix, or feature.`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const q = query({
      prompt,
      options: {
        model: "haiku",
        settingSources: [],
        allowedTools: [],
        permissionMode: "bypassPermissions",
        maxTurns: 1,
        ...claudeCliOptions(),
        abortController: ac,
        env,
      },
    });
    let text = "";
    for await (const m of q) {
      if (m.type === "assistant") {
        for (const block of (m as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? []) {
          if (block.type === "text" && block.text) text += block.text;
        }
      }
      if (m.type === "result") break;
    }
    const word = text.trim().toLowerCase().replace(/[^a-z]/g, "");
    return KIND_SET.has(word) ? (word as BranchKind) : heuristicKind(brief);
  } catch {
    return heuristicKind(brief);
  } finally {
    clearTimeout(timer);
  }
}
