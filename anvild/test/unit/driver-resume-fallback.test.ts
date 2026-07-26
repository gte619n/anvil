/**
 * Multi-account §5.3 / Task 23: a `--resume` rejected by the CLI (a possible outcome across a Claude
 * account switch, though the 2026-07-26 spike found it actually succeeds for the two accounts tested —
 * see docs/plans/2026-07-26-multi-account-tokens-plan.md Task 1) must fall back to a fresh context with
 * a friendly divider, not an opaque crash. Only fires when the failed query actually ATTEMPTED a resume
 * — a fresh session hitting a similarly-worded error is a real failure and keeps the normal error path.
 */
import { test, expect } from "bun:test";
import { AgentDriver, isResumeRejectedError } from "../../src/agent/driver";
import { PermissionBroker } from "../../src/agent/permissions";
import { QuestionBroker } from "../../src/agent/questions";
import type { Session } from "../../src/session/session";

test("isResumeRejectedError matches session-not-found / auth-rejection wording", () => {
  expect(isResumeRejectedError(new Error("session not found"))).toBe(true);
  expect(isResumeRejectedError(new Error("Session does not exist"))).toBe(true);
  expect(isResumeRejectedError(new Error("no conversation found for that id"))).toBe(true);
  expect(isResumeRejectedError(new Error("401 Unauthorized"))).toBe(true);
  expect(isResumeRejectedError(new Error("403 Forbidden"))).toBe(true);
  expect(isResumeRejectedError(new Error("network timeout"))).toBe(false);
  expect(isResumeRejectedError(new Error("ENOENT: no such file or directory"))).toBe(false);
});

interface FakeSessionData {
  model: string;
  cwd: string;
  claudeSessionId: string | undefined;
  context: unknown;
  isDefault: boolean;
  source: string;
  worktree: undefined;
  status: string;
  usage: { inputTokens: number; outputTokens: number; turns: number };
}
function fakeSession(id: string, claudeSessionId: string | undefined): { session: Session; emitted: unknown[]; errors: string[] } {
  const data: FakeSessionData = {
    model: "opus",
    cwd: "/tmp/wt",
    claudeSessionId,
    context: { used: 100, max: 1000 },
    isDefault: false,
    source: "existing-dir",
    worktree: undefined,
    status: "thinking",
    usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
  };
  const emitted: unknown[] = [];
  const errors: string[] = [];
  const session = {
    id,
    data,
    lastAssistantText: "",
    setStatus(s: string) {
      data.status = s;
    },
    emit(body: unknown) {
      emitted.push(body);
    },
    emitError(message: string) {
      errors.push(message);
    },
    requestPermission() {},
    requestQuestion() {},
  } as unknown as Session;
  return { session, emitted, errors };
}

function throwingQuery(message: string): () => unknown {
  return () =>
    ({
      async *[Symbol.asyncIterator]() {
        throw new Error(message);
      },
      interrupt: async () => {},
      setModel: async () => {},
    }) as any;
}

test("a resume-rejected error on a RESUMED session falls back to a fresh context with a divider", async () => {
  const { session, emitted, errors } = fakeSession("sess_a", "prior-claude-session-id");
  const driver = new AgentDriver(
    session,
    { render: (s: string) => ({ source: s, html: s }) } as never,
    new PermissionBroker(),
    new QuestionBroker(),
    {},
    () => {},
    undefined,
    undefined,
    undefined,
    throwingQuery("session not found") as unknown as never,
  );
  driver.prompt("go");
  await new Promise((r) => setTimeout(r, 10));

  expect(errors).toEqual([]); // no raw error surfaced
  const divider = emitted.find((e: any) => e.blocks?.[0]?.kind === "divider") as any;
  expect(divider).toBeDefined();
  expect(divider.blocks[0].note).toContain("fresh context");
  expect((session.data as unknown as FakeSessionData).claudeSessionId).toBeUndefined();
  expect((session.data as unknown as FakeSessionData).context).toBeUndefined();
});

test("the SAME error on a FRESH session (no resume attempted) is a real error, not a fallback", async () => {
  const { session, emitted, errors } = fakeSession("sess_b", undefined);
  const driver = new AgentDriver(
    session,
    { render: (s: string) => ({ source: s, html: s }) } as never,
    new PermissionBroker(),
    new QuestionBroker(),
    {},
    () => {},
    undefined,
    undefined,
    undefined,
    throwingQuery("session not found") as unknown as never,
  );
  driver.prompt("go");
  await new Promise((r) => setTimeout(r, 10));

  expect(errors).toEqual(["session not found"]);
  expect(emitted.find((e: any) => e.blocks?.[0]?.kind === "divider")).toBeUndefined();
});

test("an unrelated error on a resumed session keeps the normal error path", async () => {
  const { session, emitted, errors } = fakeSession("sess_c", "prior-claude-session-id");
  const driver = new AgentDriver(
    session,
    { render: (s: string) => ({ source: s, html: s }) } as never,
    new PermissionBroker(),
    new QuestionBroker(),
    {},
    () => {},
    undefined,
    undefined,
    undefined,
    throwingQuery("network timeout") as unknown as never,
  );
  driver.prompt("go");
  await new Promise((r) => setTimeout(r, 10));

  expect(errors).toEqual(["network timeout"]);
  expect(emitted.find((e: any) => e.blocks?.[0]?.kind === "divider")).toBeUndefined();
  expect((session.data as unknown as FakeSessionData).claudeSessionId).toBe("prior-claude-session-id"); // untouched
});
