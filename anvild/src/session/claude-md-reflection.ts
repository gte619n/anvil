/**
 * CLAUDE.md reflection (post-PR learning loop).
 *
 * When a user creates a PR interactively, the knowledge accumulated during the session —
 * deployment quirks, build/test commands, code-style conventions, gotchas the agent hit —
 * would otherwise evaporate. Right after PR creation the Supervisor injects ONE follow-up
 * turn (see `Supervisor.maybeReflectOnClaudeMd`) carrying the prompt below. The session's own
 * agent already holds the transcript in context, already has the AskUserQuestion interview UI
 * wired, and already has Edit/Bash/git tools — so it reviews the work, interviews the user
 * about any durable additions, and (for accepted items) edits CLAUDE.md + commits + pushes,
 * which updates the already-open PR on the same branch. No new PR, no bespoke daemon pipeline.
 */

/** Whether the post-PR CLAUDE.md reflection is enabled. On by default; disabled only when
 *  `ANVIL_CLAUDEMD_REFLECT` is explicitly a falsy word (`0`/`false`/`off`/`no`). Follows the
 *  existing `process.env.ANVIL_*` convention (e.g. agent/file-offer.ts). */
export function claudeMdReflectionEnabled(): boolean {
  const raw = process.env.ANVIL_CLAUDEMD_REFLECT?.trim().toLowerCase();
  if (!raw) return true; // unset ⇒ default-on
  return !["0", "false", "off", "no"].includes(raw);
}

/** The single injected turn. Tightly scoped so the agent reflects-then-interviews-then-amends
 *  without wandering off into unrelated work. */
export const CLAUDE_MD_REFLECTION_PROMPT = [
  "You just opened a pull request for the work in this session. Before moving on, do a quick",
  "CLAUDE.md reflection — this is an automated step, not a request from the user:",
  "",
  "1. Silently review what happened in THIS session: decisions you made, conventions you",
  "   discovered, build/test/deploy commands you ran, and any gotchas you had to work around.",
  "2. Read the existing CLAUDE.md at the repo root (if the project has none, you may propose",
  "   creating one as part of the interview below). Identify ONLY durable, project-wide",
  "   learnings that would make future development more solid and streamlined AND that are not",
  "   already documented there. Be strict: exclude anything one-off or specific to this task.",
  "3. If nothing clears that bar, reply with a single short sentence saying there's nothing",
  "   worth adding, and STOP — do not edit, commit, or push anything.",
  "4. Otherwise, use the AskUserQuestion tool to interview the user about your candidates. For",
  "   each proposed addition, give a concise description AND the exact text you would add, and",
  "   ask whether to accept it. Skipping is always a valid answer. AskUserQuestion carries at",
  "   most 4 questions per call — batch across multiple calls if you have more candidates.",
  "5. For accepted items ONLY: edit CLAUDE.md (merging into the appropriate section), then run",
  "   `git add CLAUDE.md`, `git commit`, and `git push` to update the pull request you just",
  "   opened. Finish by confirming with the PR link.",
  "",
  "Hard guardrails: do NOT open a new pull request, do NOT modify or stage any file other than",
  "CLAUDE.md, and do NOT push unrelated changes. If the user skips every candidate, leave the",
  "working tree untouched.",
].join("\n");
