import { test, expect } from "bun:test";
import type { Question } from "@protocol";
import { QuestionBroker, makeUserDialogHandler, ASK_USER_QUESTION_DIALOG } from "../../src/agent/questions";
import type { Session } from "../../src/session/session";

/** Minimal Session stub: the handler only needs `id` and `requestQuestion`. */
function fakeSession(): { session: Session; asked: { requestId: string; questions: Question[] }[] } {
  const asked: { requestId: string; questions: Question[] }[] = [];
  const session = {
    id: "sess_1",
    requestQuestion(requestId: string, questions: Question[]) {
      asked.push({ requestId, questions });
    },
  } as unknown as Session;
  return { session, asked };
}

const payload = {
  questions: [
    { question: "Which library?", header: "Library", options: [{ label: "date-fns", description: "small" }, { label: "luxon", description: "rich" }] },
  ],
};

test("non-AskUserQuestion dialog kinds are cancelled (host can't render them)", async () => {
  const broker = new QuestionBroker();
  const { session } = fakeSession();
  const handler = makeUserDialogHandler(session, broker);
  expect(await handler({ dialogKind: "something_else", payload: {} }, { signal: new AbortController().signal })).toEqual({ behavior: "cancelled" });
});

test("answered question → completed PermissionResult with answers in updatedInput", async () => {
  const broker = new QuestionBroker();
  const { session, asked } = fakeSession();
  const handler = makeUserDialogHandler(session, broker);

  const resultP = handler({ dialogKind: ASK_USER_QUESTION_DIALOG, payload }, { signal: new AbortController().signal });
  // The handler parks a request; answer it via the broker (as dispatch/supervisor would).
  expect(asked).toHaveLength(1);
  const requestId = asked[0]!.requestId;
  expect(broker.resolve(requestId, { cancelled: false, answers: [{ question: "Which library?", labels: ["luxon"] }] })).toBe(true);

  const result = await resultP;
  expect(result).toEqual({
    behavior: "completed",
    result: { behavior: "allow", updatedInput: { questions: payload.questions, answers: { "Which library?": "luxon" } } },
  });
});

test("multiSelect answers become an array; free-text becomes annotations", async () => {
  const broker = new QuestionBroker();
  const { session, asked } = fakeSession();
  const handler = makeUserDialogHandler(session, broker);
  const resultP = handler({ dialogKind: ASK_USER_QUESTION_DIALOG, payload }, { signal: new AbortController().signal });
  broker.resolve(asked[0]!.requestId, {
    cancelled: false,
    answers: [{ question: "Which library?", labels: ["date-fns", "luxon"], notes: "or moment" }],
  });
  const result = (await resultP) as any;
  expect(result.behavior).toBe("completed");
  expect(result.result.updatedInput.answers).toEqual({ "Which library?": ["date-fns", "luxon"] });
  expect(result.result.updatedInput.annotations).toEqual({ "Which library?": { notes: "or moment" } });
});

test("cancelled answer → cancelled (SDK applies the dialog default)", async () => {
  const broker = new QuestionBroker();
  const { session, asked } = fakeSession();
  const handler = makeUserDialogHandler(session, broker);
  const resultP = handler({ dialogKind: ASK_USER_QUESTION_DIALOG, payload }, { signal: new AbortController().signal });
  broker.resolve(asked[0]!.requestId, { cancelled: true });
  expect(await resultP).toEqual({ behavior: "cancelled" });
});

test("resolveSession cancels every parked question for a session", async () => {
  const broker = new QuestionBroker();
  const { session, asked } = fakeSession();
  const handler = makeUserDialogHandler(session, broker);
  const resultP = handler({ dialogKind: ASK_USER_QUESTION_DIALOG, payload }, { signal: new AbortController().signal });
  expect(broker.resolveSession("sess_1")).toBe(1);
  expect(await resultP).toEqual({ behavior: "cancelled" });
  expect(asked).toHaveLength(1);
});
