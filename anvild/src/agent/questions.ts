import type { OnUserDialog, UserDialogResult } from "@anthropic-ai/claude-agent-sdk";
import type { Question, QuestionAnswer } from "@protocol";
import { newId } from "../util/ids";
import type { Session } from "../session/session";

/**
 * AskUserQuestion plumbing (arch §6.6).
 *
 * Claude's AskUserQuestion tool does NOT come back as a normal tool result — the Agent SDK
 * delivers it as a `request_user_dialog` control request (dialogKind
 * `permission_ask_user_question`) and parks the turn until the host answers via the
 * `onUserDialog` callback. With no handler the SDK "stays silent" and the tool eventually
 * resolves to "The user did not answer the questions." — which is exactly the broken
 * behavior we're fixing. We register a handler that parks the question in a broker (so it can
 * be answered from any device, like a permission prompt) and feeds the choice back.
 *
 * The CLI consumes the dialog result as a PermissionResult whose `updatedInput` carries the
 * answer: `{ ...originalInput, answers: { [questionText]: label | label[] }, annotations }`
 * (reverse-engineered from the bundled CLI's answer builder). The `questions` array in
 * `updatedInput` must be the original tool input, passed straight through.
 */

/** The CLI dialog kind for AskUserQuestion. The SDK fails closed unless we declare it. */
export const ASK_USER_QUESTION_DIALOG = "permission_ask_user_question";

interface QuestionResolution {
  cancelled: boolean;
  answers?: QuestionAnswer[];
}
interface Pending {
  resolve: (r: QuestionResolution) => void;
  sessionId: string;
}

/** Holds AskUserQuestion prompts parked in `onUserDialog` until a client answers them. */
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
 * Register as `options.onUserDialog` (paired with `supportedDialogKinds`). Parks the question,
 * surfaces it to clients, and turns the answer into the PermissionResult the CLI expects.
 */
export function makeUserDialogHandler(session: Session, broker: QuestionBroker): OnUserDialog {
  return async (request): Promise<UserDialogResult> => {
    if (request.dialogKind !== ASK_USER_QUESTION_DIALOG) return { behavior: "cancelled" };
    const payload = request.payload as { questions?: unknown };
    const questions = normalizeQuestions(payload.questions);
    if (questions.length === 0) return { behavior: "cancelled" };

    const requestId = newId("q");
    const answer = broker.request(requestId, session.id);
    session.requestQuestion(requestId, questions);
    const res = await answer;
    if (res.cancelled || !res.answers || res.answers.length === 0) return { behavior: "cancelled" };

    // Reconstruct the tool input the CLI's answer builder expects: the original questions plus an
    // `answers` map (questionText → chosen label(s)) and optional free-text `annotations`.
    const answers: Record<string, string | string[]> = {};
    const annotations: Record<string, { notes?: string }> = {};
    for (const a of res.answers) {
      if (a.labels.length) answers[a.question] = a.labels.length === 1 ? a.labels[0]! : a.labels;
      if (a.notes?.trim()) annotations[a.question] = { notes: a.notes.trim() };
    }
    const updatedInput: Record<string, unknown> = { questions: payload.questions, answers };
    if (Object.keys(annotations).length) updatedInput.annotations = annotations;

    return { behavior: "completed", result: { behavior: "allow", updatedInput } };
  };
}
