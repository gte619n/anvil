import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Question, QuestionAnswer } from "@protocol";
import { newId } from "../util/ids";
import type { Session } from "../session/session";

/**
 * AskUserQuestion plumbing (arch §6.6).
 *
 * Claude's AskUserQuestion tool does NOT come back as a normal tool result. Its `checkPermissions`
 * always resolves to "ask", and the Agent SDK surfaces that "ask" to the host through the
 * `canUseTool` callback — NOT through `onUserDialog`. (We originally wired `onUserDialog` +
 * `supportedDialogKinds` for the `permission_ask_user_question` dialog kind; verified live against
 * SDK 0.3.183 that dialog never fires for AskUserQuestion, so with no `canUseTool` the tool was
 * denied and the CLI's own `call` produced "The user did not answer the questions." — the model
 * then continued with defaults. That was the broken-interview bug.)
 *
 * The fix: answer AskUserQuestion from `canUseTool` by returning a PermissionResult whose
 * `updatedInput` carries the answer. The CLI re-runs the tool with that input and its result
 * builder emits "Your questions have been answered: …". The wire shape (confirmed live):
 * `{ behavior: "allow", updatedInput: { ...originalInput, answers: { [questionText]: label | label[] },
 * annotations? } }`. The `answers` map MUST be keyed by the exact question text (the CLI looks up
 * `answers[question]` per original question); a multiSelect answer may be an array (the CLI joins it)
 * or a comma-joined string. We park the question in a broker so it can be answered from any device
 * (like a permission prompt) and feed the choice back.
 */

interface QuestionResolution {
  cancelled: boolean;
  answers?: QuestionAnswer[];
}
interface Pending {
  resolve: (r: QuestionResolution) => void;
  sessionId: string;
}

/** Holds AskUserQuestion prompts parked in `canUseTool` until a client answers them. */
export class QuestionBroker {
  private readonly pending = new Map<string, Pending>();

  request(requestId: string, sessionId: string): Promise<QuestionResolution> {
    return new Promise((resolve) => this.pending.set(requestId, { resolve, sessionId }));
  }
  sessionFor(requestId: string): string | undefined {
    return this.pending.get(requestId)?.sessionId;
  }
  resolve(requestId: string, resolution: QuestionResolution): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    p.resolve(resolution);
    return true;
  }
  /** Cancel every question parked for a session (used by session.reset to unblock the dialog). */
  resolveSession(sessionId: string): number {
    let n = 0;
    for (const [requestId, p] of this.pending) {
      if (p.sessionId === sessionId) {
        this.pending.delete(requestId);
        p.resolve({ cancelled: true });
        n++;
      }
    }
    return n;
  }
}

/** Coerce the SDK's opaque dialog payload `questions` into our typed shape (defensive). */
function normalizeQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return [];
  const out: Question[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const r = q as Record<string, unknown>;
    if (typeof r.question !== "string") continue;
    const options = Array.isArray(r.options)
      ? r.options
          .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
          .map((o) => ({
            label: typeof o.label === "string" ? o.label : String(o.label ?? ""),
            description: typeof o.description === "string" ? o.description : "",
            ...(typeof o.preview === "string" ? { preview: o.preview } : {}),
          }))
      : [];
    out.push({
      question: r.question,
      header: typeof r.header === "string" ? r.header : "",
      options,
      ...(typeof r.multiSelect === "boolean" ? { multiSelect: r.multiSelect } : {}),
    });
  }
  return out;
}

/**
 * Register as `options.canUseTool`. The PreToolUse hook is the authoritative gate for every other
 * tool (it returns allow/deny, which bypasses `canUseTool` entirely — see SDK docs), and lets
 * AskUserQuestion fall through with a bare `continue` so its "ask" verdict reaches here. We park the
 * question in the broker, surface it to clients, and turn the answer into the PermissionResult whose
 * `updatedInput` the CLI re-runs the tool with.
 */
export function makeCanUseTool(session: Session, broker: QuestionBroker): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    // Only AskUserQuestion ever reaches canUseTool: the hook resolves all other tools to allow/deny,
    // which short-circuits before this callback. Anything else here was already vetted by the hook,
    // so allow it through unchanged rather than second-guessing it.
    if (toolName !== "AskUserQuestion") return { behavior: "allow", updatedInput: input };

    const questions = normalizeQuestions(input.questions);
    // No parseable questions → let the CLI's own tool run produce its "did not answer" result so the
    // model proceeds, rather than hard-denying (which would read as the user refusing).
    if (questions.length === 0) return { behavior: "allow", updatedInput: input };

    const requestId = newId("q");
    const answer = broker.request(requestId, session.id);
    session.requestQuestion(requestId, questions);
    const res = await answer;
    // Skip/cancel (or a session reset): allow with no answers → the CLI emits "The user did not
    // answer the questions." and the model continues with its own judgment (native skip semantics).
    if (res.cancelled || !res.answers || res.answers.length === 0) return { behavior: "allow", updatedInput: input };

    // Hand the CLI the answer it expects: the original input plus an `answers` map (questionText →
    // chosen label(s)) and optional free-text `annotations`. Keep `...input` so `questions` and any
    // `metadata` round-trip — the CLI's result builder iterates the original questions to format them.
    const answers: Record<string, string | string[]> = {};
    const annotations: Record<string, { notes?: string }> = {};
    for (const a of res.answers) {
      if (a.labels.length) answers[a.question] = a.labels.length === 1 ? a.labels[0]! : a.labels;
      if (a.notes?.trim()) annotations[a.question] = { notes: a.notes.trim() };
    }
    const updatedInput: Record<string, unknown> = { ...input, answers };
    if (Object.keys(annotations).length) updatedInput.annotations = annotations;

    return { behavior: "allow", updatedInput };
  };
}
