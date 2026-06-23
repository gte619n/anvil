import { test, expect } from "bun:test";
import type { Question } from "@protocol";
import { QuestionBroker, makeCanUseTool } from "../../src/agent/questions";
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

const opts = { signal: new AbortController().signal, toolUseID: "tool_1" } as any;
const input = {
  questions: [
    { question: "Which library?", header: "Library", options: [{ label: "date-fns", description: "small" }, { label: "luxon", description: "rich" }] },
  ],
};

test("non-AskUserQuestion tools allow through unchanged (the hook already vetted them)", async () => {
  const broker = new QuestionBroker();
  const { session } = fakeSession();
  const canUseTool = makeCanUseTool(session, broker);
  expect(await canUseTool("Read", { file_path: "/tmp/x" }, opts)).toEqual({ behavior: "allow", updatedInput: { file_path: "/tmp/x" } });
});

test("answered question → allow with answers in updatedInput", async () => {
  const broker = new QuestionBroker();
  const { session, asked } = fakeSession();
  const canUseTool = makeCanUseTool(session, broker);

  const resultP = canUseTool("AskUserQuestion", input, opts);
  // The handler parks a request; answer it via the broker (as dispatch/supervisor would).
  expect(asked).toHaveLength(1);
  const requestId = asked[0]!.requestId;
  expect(broker.resolve(requestId, { cancelled: false, answers: [{ question: "Which library?", labels: ["luxon"] }] })).toBe(true);

  const result = await resultP;
  // updatedInput keeps the original input (questions round-trip) and adds the answers map.
  expect(result).toEqual({
    behavior: "allow",
    updatedInput: { questions: input.questions, answers: { "Which library?": "luxon" } },
  });
});

test("multiSelect answers become an array; free-text becomes annotations", async () => {
  const broker = new QuestionBroker();
  const { session, asked } = fakeSession();
  const canUseTool = makeCanUseTool(session, broker);
  const resultP = canUseTool("AskUserQuestion", input, opts);
  broker.resolve(asked[0]!.requestId, {
    cancelled: false,
    answers: [{ question: "Which library?", labels: ["date-fns", "luxon"], notes: "or moment" }],
  });
  const result = (await resultP) as any;
  expect(result.behavior).toBe("allow");
  expect(result.updatedInput.answers).toEqual({ "Which library?": ["date-fns", "luxon"] });
  expect(result.updatedInput.annotations).toEqual({ "Which library?": { notes: "or moment" } });
});

test("skipped/cancelled answer → allow with no answers (CLI emits 'did not answer', model proceeds)", async () => {
  const broker = new QuestionBroker();
  const { session, asked } = fakeSession();
  const canUseTool = makeCanUseTool(session, broker);
  const resultP = canUseTool("AskUserQuestion", input, opts);
  broker.resolve(asked[0]!.requestId, { cancelled: true });
  const result = (await resultP) as any;
  expect(result.behavior).toBe("allow");
  expect(result.updatedInput.answers).toBeUndefined();
});

test("resolveSession cancels every parked question for a session", async () => {
  const broker = new QuestionBroker();
  const { session, asked } = fakeSession();
  const canUseTool = makeCanUseTool(session, broker);
  const resultP = canUseTool("AskUserQuestion", input, opts);
  expect(broker.resolveSession("sess_1")).toBe(1);
  const result = (await resultP) as any;
  expect(result.behavior).toBe("allow");
  expect(asked).toHaveLength(1);
});
