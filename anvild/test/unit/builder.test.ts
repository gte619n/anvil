import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Autopilot, type BuildHost, type SettledStatus } from "../../src/integrations/builder";
import { WorkUnitStore } from "../../src/integrations/workunit";
import type { TodoistClient } from "../../src/integrations/todoist";
import type { ValidationResult } from "../../src/integrations/validation";

const ENV = { id: "env1", name: "Env" };

class FakeHost implements BuildHost {
  settled: SettledStatus[] = ["idle"];
  validations: ValidationResult[] = [{ passed: true, autodetected: false, results: [] }];
  changes = true;
  prResult: { ok: boolean; url?: string; output: string } = { ok: true, url: "https://pr/1", output: "" };
  prompts: string[] = [];
  stopped: string[] = [];
  validateCalls = 0;
  startBuildSession() {
    return { sessionId: "sess_x" };
  }
  promptSession(_id: string, text: string) {
    this.prompts.push(text);
  }
  async awaitSettled(): Promise<SettledStatus> {
    return this.settled.shift() ?? "idle";
  }
  hasChanges() {
    return this.changes;
  }
  async validate(): Promise<ValidationResult> {
    this.validateCalls++;
    return this.validations.shift() ?? { passed: true, autodetected: false, results: [] };
  }
  openPr() {
    return this.prResult;
  }
  async stopSession(id: string) {
    this.stopped.push(id);
  }
}

const tagged: Array<{ id: string; labels: string[] }> = [];
const fakeClient = {
  getTask: async (id: string) => ({ id, content: "t", project_id: "p", labels: ["anvil:planned", "mine"] }),
  setTaskLabels: async (id: string, labels: string[]) => {
    tagged.push({ id, labels });
  },
  addComment: async () => ({ id: "c", content: "" }),
} as unknown as TodoistClient;

let dir: string;
let store: WorkUnitStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anvil-builder-"));
  store = new WorkUnitStore(dir);
  tagged.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function plannedUnit() {
  return store.create({ environmentId: "env1", todoistProjectId: "p", taskIds: ["t1"], title: "Do it", plan: "the plan", status: "planned" });
}

const fail = (): ValidationResult => ({ passed: false, autodetected: false, results: [{ command: "bun test", code: 1, output: "boom" }] });

test("happy path → review with PR url, tasks tagged anvil:review (user label preserved)", async () => {
  const host = new FakeHost();
  const u = plannedUnit();
  await new Autopilot(host, { client: fakeClient, workUnits: store }).runWorkUnit(u, ENV);
  const after = store.get(u.id)!;
  expect(after.status).toBe("review");
  expect(after.prUrl).toBe("https://pr/1");
  expect(host.stopped).toContain("sess_x");
  expect(tagged.at(-1)).toEqual({ id: "t1", labels: ["mine", "anvil:review"] });
});

test("validation fails then passes → one fix prompt, ends in review", async () => {
  const host = new FakeHost();
  host.settled = ["idle", "idle"];
  host.validations = [fail(), { passed: true, autodetected: false, results: [] }];
  const u = plannedUnit();
  await new Autopilot(host, { client: fakeClient, workUnits: store }).runWorkUnit(u, ENV);
  expect(host.prompts).toHaveLength(1);
  expect(host.prompts[0]).toContain("boom");
  expect(store.get(u.id)!.status).toBe("review");
});

test("validation keeps failing → blocked after maxFixAttempts", async () => {
  const host = new FakeHost();
  host.settled = ["idle", "idle"];
  host.validations = [fail(), fail()];
  const u = plannedUnit();
  await new Autopilot(host, { client: fakeClient, workUnits: store }, { maxFixAttempts: 1 }).runWorkUnit(u, ENV);
  const after = store.get(u.id)!;
  expect(after.status).toBe("blocked");
  expect(after.blockedReason).toContain("still failing");
  expect(host.prompts).toHaveLength(1); // one retry, then gave up
});

test("agent asks a question → blocked, validation never runs", async () => {
  const host = new FakeHost();
  host.settled = ["awaiting_question"];
  const u = plannedUnit();
  await new Autopilot(host, { client: fakeClient, workUnits: store }).runWorkUnit(u, ENV);
  expect(store.get(u.id)!.status).toBe("blocked");
  expect(host.validateCalls).toBe(0);
  expect(host.stopped).toContain("sess_x");
});

test("no committed changes → blocked", async () => {
  const host = new FakeHost();
  host.changes = false;
  const u = plannedUnit();
  await new Autopilot(host, { client: fakeClient, workUnits: store }).runWorkUnit(u, ENV);
  expect(store.get(u.id)!.status).toBe("blocked");
  expect(store.get(u.id)!.blockedReason).toContain("no committed changes");
});

test("PR open fails after passing validation → blocked", async () => {
  const host = new FakeHost();
  host.prResult = { ok: false, output: "gh: not authenticated" };
  const u = plannedUnit();
  await new Autopilot(host, { client: fakeClient, workUnits: store }).runWorkUnit(u, ENV);
  expect(store.get(u.id)!.status).toBe("blocked");
  expect(store.get(u.id)!.blockedReason).toContain("PR failed");
});

test("runBuildPhase only touches planned units", async () => {
  const host = new FakeHost();
  host.settled = ["idle", "idle"]; // two planned units
  plannedUnit();
  plannedUnit();
  store.create({ environmentId: "env1", todoistProjectId: "p", taskIds: ["t9"], title: "done", status: "review" });
  const done = await new Autopilot(host, { client: fakeClient, workUnits: store }).runBuildPhase(ENV);
  expect(done).toHaveLength(2); // the review unit is skipped
});
