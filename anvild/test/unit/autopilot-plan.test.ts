import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPlanMeta } from "../../src/integrations/plan-meta";
import { readStatus, withStatus, STATUSES } from "../../src/integrations/status";
import { WorkUnitStore } from "../../src/integrations/workunit";
import { TodoistClient } from "../../src/integrations/todoist";

// A `claude`-profile spawn now REQUIRES a subscription token (agent/env.ts) — a tokenless machine
// fails loudly with a pair-this-machine message instead of an opaque SDK error. These tests drive
// the SDK layer with a fake query, so give them a placeholder credential to get past that gate.
process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "sk-ant-oat-test-placeholder";

// extractPlanMeta is the pure (SDK-free) parser for the planner's trailing metadata block.

test("extractPlanMeta pulls summary + effort and strips the block", () => {
  const raw = `# Plan

Do the thing in src/foo.ts.

\`\`\`json
{"summary": "Wrap the upload client in a retry.", "size": "m", "filesTouched": 6}
\`\`\``;
  const { plan, summary, effort } = extractPlanMeta(raw);
  expect(plan.endsWith("src/foo.ts.")).toBe(true);
  expect(plan).not.toContain("```json");
  expect(summary).toBe("Wrap the upload client in a retry.");
  expect(effort).toEqual({ size: "m", filesTouched: 6 });
});

test("extractPlanMeta tolerates a missing block", () => {
  const { plan, summary, effort } = extractPlanMeta("Just a plan, no metadata.");
  expect(plan).toBe("Just a plan, no metadata.");
  expect(summary).toBeUndefined();
  expect(effort).toBeUndefined();
});

test("extractPlanMeta tolerates a malformed block (keeps the plan)", () => {
  const raw = "Plan body.\n\n```json\n{not valid json\n```";
  const { plan, effort } = extractPlanMeta(raw);
  expect(plan).toContain("Plan body.");
  expect(effort).toBeUndefined();
});

test("extractPlanMeta rejects an unknown size and clamps files", () => {
  const raw = 'Body.\n\n```json\n{"size": "huge", "filesTouched": -3.7}\n```';
  const { effort } = extractPlanMeta(raw);
  // "huge" isn't a valid size → no effort at all (size gates the object)
  expect(effort).toBeUndefined();

  const ok = extractPlanMeta('Body.\n\n```json\n{"size": "l", "filesTouched": 2.6}\n```');
  expect(ok.effort).toEqual({ size: "l", filesTouched: 3 }); // rounded
});

// The Autopilot "dismiss" action depends on a real `dismissed` status label.

test("dismissed is a first-class anvil status", () => {
  expect(STATUSES).toContain("dismissed");
  const labels = withStatus(["waiting", "anvil:planned"], "dismissed");
  expect(labels).toContain("anvil:dismissed");
  expect(labels).toContain("waiting"); // user labels preserved
  expect(labels).not.toContain("anvil:planned"); // exactly one anvil status at a time
  expect(readStatus(labels)).toBe("dismissed");
});

// The autopilot run's watchdog cancels via a run-level AbortSignal threaded into the Todoist client.
// An already-aborted signal must short-circuit a request before it touches the network — that's the
// wiring that lets a hung run unwind instead of latching the "running" spinner open forever.

test("TodoistClient honors a run-level abort signal (no network)", async () => {
  const client = new TodoistClient("fake-token", AbortSignal.abort());
  // whoami() → request() → fetch with the aborted signal: rejects immediately, never connects.
  await expect(client.whoami()).rejects.toMatchObject({ name: "AbortError" });
});

// pendingPlans() (supervisor) = status "planned" && no sessionId; mirror that filter over the store.

test("work-unit lifecycle drops started + dismissed units from the pending set", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-wu-"));
  try {
    const store = new WorkUnitStore(dir);
    const base = { environmentId: "env1", todoistProjectId: "p1", taskIds: ["t1"] };
    const planned = store.create({ ...base, title: "Planned", summary: "s", effort: { size: "s", filesTouched: 1 } });
    const started = store.create({ ...base, taskIds: ["t2"], title: "Started" });
    const toDismiss = store.create({ ...base, taskIds: ["t3"], title: "Dismiss me" });

    const pending = () => store.list().filter((u) => u.status === "planned" && !u.sessionId);
    expect(pending().map((u) => u.id).sort()).toEqual([planned.id, started.id, toDismiss.id].sort());

    // start one: sessionId + building → leaves the pending set
    store.update(started.id, { sessionId: "sess_x", status: "building" });
    // dismiss one: status dismissed → leaves the pending set
    store.update(toDismiss.id, { status: "dismissed" });

    expect(pending().map((u) => u.id)).toEqual([planned.id]);

    // round-trips through persistence with the new fields intact
    const reloaded = new WorkUnitStore(dir).get(planned.id)!;
    expect(reloaded.summary).toBe("s");
    expect(reloaded.effort).toEqual({ size: "s", filesTouched: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
