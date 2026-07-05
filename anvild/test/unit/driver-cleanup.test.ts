/**
 * [BE-3] When the SDK turn throws mid-stream, the driver used to emit an error but never reset
 * status (UI spins forever), never cleared `this.q` (session non-restartable in place), and never
 * resolved parked permission/question prompts (broker-map leak + a phone stuck on a prompt). One
 * `finally` fixes all three. This drives a real `consume()` with an injected query that parks until
 * the test triggers a crash, then pins:
 *   - both brokers' parked prompts for the session are resolved,
 *   - status returns to idle,
 *   - the query is released so the session can restart in place.
 */
import { test, expect } from "bun:test";
import { AgentDriver } from "../../src/agent/driver";
import { PermissionBroker } from "../../src/agent/permissions";
import { QuestionBroker } from "../../src/agent/questions";
import type { Session } from "../../src/session/session";

function fakeSession(id: string) {
  const data = {
    model: "opus",
    cwd: "/tmp/wt",
    claudeSessionId: undefined as string | undefined,
    isDefault: false,
    source: "existing-dir",
    worktree: undefined,
    status: "thinking",
    usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
  };
  return {
    id,
    data,
    lastAssistantText: "",
    setStatus(s: string) {
      data.status = s;
    },
    emit() {},
    emitError() {},
    requestPermission() {},
    requestQuestion() {},
  } as unknown as Session;
}

test("a crashing turn resolves parked brokers, resets status to idle, and releases the query", async () => {
  const broker = new PermissionBroker();
  const qBroker = new QuestionBroker();
  const session = fakeSession("sess_crash");

  // The turn parks on `crash` until the test triggers it — so prompt() fully sets "thinking" first,
  // mirroring a real mid-turn failure (not an instant throw that races prompt()).
  let triggerCrash!: () => void;
  const crash = new Promise<void>((r) => (triggerCrash = r));
  let queryCalls = 0;
  const makeQuery = () => {
    const q: any = {
      async *[Symbol.asyncIterator]() {
        await crash;
        throw new Error("sdk boom");
      },
      interrupt: async () => {},
      setModel: async () => {},
    };
    return () => {
      queryCalls++;
      return q;
    };
  };

  const parkedPerm = broker.request("perm_1", "sess_crash");
  const parkedQ = qBroker.request("q_1", "sess_crash");

  const driver = new AgentDriver(
    session,
    { render: (s: string) => ({ source: s, html: s }) } as never, // renderer stub
    broker,
    qBroker,
    {},
    () => {},
    undefined,
    undefined,
    makeQuery() as unknown as never,
  );

  driver.prompt("go");
  const statusOf = () => (session as unknown as { data: { status: string } }).data.status;
  // The turn is in flight, parked on `crash`; status is "thinking" and no cleanup has run yet.
  expect(statusOf()).toBe("thinking");
  expect(queryCalls).toBe(1);

  triggerCrash(); // simulate the mid-turn SDK failure

  // Both parked prompts resolve (deny / cancelled) rather than hanging forever.
  expect((await parkedPerm).decision).toBe("deny");
  expect((await parkedQ).cancelled).toBe(true);

  // Status returns to idle (poll: it lands a tick after broker resolution).
  for (let i = 0; i < 50 && statusOf() !== "idle"; i++) await new Promise((r) => setTimeout(r, 2));
  expect(statusOf()).toBe("idle");

  // The query was released, so the session can be restarted in place.
  driver.prompt("again");
  expect(queryCalls).toBe(2);
});
