import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { GOAL_MAX_ITERATIONS, type SessionGoal } from "@protocol";
import { claudeCliOptions } from "./cli";
import type { Session } from "../session/session";

export { GOAL_MAX_ITERATIONS };

/** How many buffered transcript lines the judge sees (~5 turns of assistant text + tool results). */
export const GOAL_TRANSCRIPT_LINES = 40;

export type GoalCommand =
  | { kind: "set"; condition: string }
  | { kind: "clear" }
  | { kind: "status" };

/**
 * Parse a `/goal` message. Like `/clear` and `/compact`, the command must be the WHOLE message —
 * anything else is ordinary prose and must reach the model untouched.
 */
export function parseGoalCommand(text: string): GoalCommand | undefined {
  const t = text.trim();
  if (t === "/goal") return { kind: "status" };
  if (!t.startsWith("/goal ")) return undefined;
  const rest = t.slice("/goal ".length).trim();
  if (!rest) return { kind: "status" };
  if (rest.toLowerCase() === "clear") return { kind: "clear" };
  return { kind: "set", condition: rest };
}

export interface GoalVerdict {
  met: boolean;
  reason: string;
}

/**
 * Parse the judge's reply. Deliberately strict: anything unrecognised THROWS so the hook's
 * fail-open path (design D6) treats a confused judge exactly like an unreachable one — a goal must
 * never trap a session on the strength of a garbled answer.
 */
export function parseVerdict(text: string): GoalVerdict {
  const t = text.trim();
  if (/^met\b/i.test(t)) return { met: true, reason: "" };
  const m = /^unmet\s*:?\s*(.*)$/is.exec(t);
  if (m) return { met: false, reason: (m[1] ?? "").trim() || "condition not yet satisfied" };
  throw new Error(`unparseable goal verdict: ${t.slice(0, 120)}`);
}

/**
 * Judge whether `condition` is satisfied by the recent transcript. One-shot Haiku, no tools —
 * mirrors `classifyBranchKind`. Throws on timeout, transport failure, or an unparseable reply;
 * every one of those is fail-open at the call site (D6).
 */
export async function judgeGoal(
  condition: string,
  transcript: string,
  env: Record<string, string>,
): Promise<GoalVerdict> {
  const prompt =
    `You are judging whether a coding agent has satisfied a stated goal.\n\n` +
    `GOAL: ${condition}\n\n` +
    `Recent transcript (most recent last):\n"""\n${transcript.slice(-8000)}\n"""\n\n` +
    `Judge ONLY on evidence in the transcript — tool results, command output, errors. A claim by ` +
    `the agent that it succeeded is NOT evidence if the tool result contradicts it or is absent.\n\n` +
    `Reply with EXACTLY one line:\n` +
    `MET\n` +
    `or\n` +
    `UNMET: <short reason, max 15 words>`;

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
        for (const b of (m as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? []) {
          if (b.type === "text" && b.text) text += b.text;
        }
      }
      if (m.type === "result") break;
    }
    return parseVerdict(text);
  } finally {
    clearTimeout(timer);
  }
}

/** Called when a goal resolves — met (true) or abandoned at the ceiling (false). */
export type GoalResolved = (met: boolean, goal: SessionGoal) => void;
/** Called after an unmet attempt so the supervisor can persist + broadcast the new count. */
export type GoalProgress = (goal: SessionGoal) => void;

/**
 * The `Stop` hook. Registered unconditionally at query start (the SDK has no `setHooks`, so it can
 * never be added later) and reads goal state off the LIVE session each time it fires — which is what
 * lets `/goal` arm mid-session with no driver restart.
 *
 * Return shape verified by spike (design §10 R1): `{decision:"block", reason}` blocks the stop and
 * the model complies, receiving `Stop hook feedback:\n<reason>`. Do NOT switch to
 * `hookSpecificOutput.additionalContext` — that arrives as a system reminder the model refuses as a
 * suspected prompt injection, yielding a session that loops without doing the work.
 */
export function makeStopHook(
  session: Session,
  env: () => Record<string, string>,
  onResolved: GoalResolved,
  judge: (c: string, t: string, e: Record<string, string>) => Promise<GoalVerdict> = judgeGoal,
  onProgress: GoalProgress = () => {},
): HookCallback {
  return async () => {
    const goal = session.data.goal;
    // Free path: the overwhelming majority of stops belong to sessions with no goal.
    if (!goal || goal.paused) return { continue: true };

    if (goal.iterations >= GOAL_MAX_ITERATIONS) {
      session.data.goal = undefined;
      onResolved(false, goal);
      return { continue: true };
    }

    let verdict: GoalVerdict;
    try {
      verdict = await judge(goal.condition, session.recentTurns.join("\n"), env());
    } catch {
      return { continue: true }; // D6: fail open — never trap a session on an unreachable judge
    }

    if (verdict.met) {
      session.data.goal = undefined;
      onResolved(true, goal);
      return { continue: true };
    }

    goal.iterations += 1;
    goal.lastReason = verdict.reason;
    onProgress(goal);
    return { decision: "block", reason: `[${goal.condition}]: ${verdict.reason}` };
  };
}
