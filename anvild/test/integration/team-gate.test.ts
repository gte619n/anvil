import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ServerEvent, type SessionCreateCmd } from "@protocol";
import { Supervisor } from "../../src/session/supervisor";
import { ConnectionRegistry } from "../../src/server/registry";

/** A registry that records every broadcast instead of sending it over a socket. */
class RecordingRegistry extends ConnectionRegistry {
  readonly events: ServerEvent[] = [];
  override toAll(event: ServerEvent): void {
    this.events.push(event);
  }
}

const dirs: string[] = [];
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "anvil-team-repo-"));
  dirs.push(repo);
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(repo, "f.txt"), "x");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  return repo;
}
function makeSup(): { sup: Supervisor; reg: RecordingRegistry } {
  const dir = mkdtempSync(join(tmpdir(), "anvil-team-state-"));
  dirs.push(dir);
  const reg = new RecordingRegistry();
  return { sup: new Supervisor({ stateDir: dir }, reg), reg };
}
const leadCmd = (repo: string, over: Partial<SessionCreateCmd> = {}): SessionCreateCmd =>
  ({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "fresh-worktree", repoRoot: repo, base: "HEAD", title: "lead", teamRole: "lead", ...over } as SessionCreateCmd);

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("a lead created with teamRole carries its policy verbatim", async () => {
  const { sup } = makeSup();
  const lead = await sup.create(leadCmd(makeRepo(), { team: { integration: "pr-per-member", maxConcurrentMembers: 2 } }));
  expect(lead.data.teamRole).toBe("lead");
  expect(lead.data.team).toEqual({ integration: "pr-per-member", maxConcurrentMembers: 2 });
});

test("a lead with no explicit policy gets combined-pr + cap 3 defaults", async () => {
  const { sup } = makeSup();
  const lead = await sup.create(leadCmd(makeRepo()));
  expect(lead.data.team).toEqual({ integration: "combined-pr", maxConcurrentMembers: 3 });
});

test("#3: maxConcurrentMembers is clamped to >= 1 (a 0/negative cap would wedge the team)", async () => {
  const { sup } = makeSup();
  const zero = await sup.create(leadCmd(makeRepo(), { team: { integration: "combined-pr", maxConcurrentMembers: 0 } }));
  expect(zero.data.team?.maxConcurrentMembers).toBe(1);
  const neg = await sup.create(leadCmd(makeRepo(), { team: { integration: "combined-pr", maxConcurrentMembers: -5 } }));
  expect(neg.data.team?.maxConcurrentMembers).toBe(1);
});

test("#8: approving an empty plan is rejected (no silent no-op spawn)", async () => {
  const { sup } = makeSup();
  const lead = await sup.create(leadCmd(makeRepo()));
  await expect(sup.approveTeamPlan(lead.id, { leadId: lead.id, members: [], integration: "combined-pr" })).rejects.toThrow();
});

test("rejectTeamPlan broadcasts team.plan.resolved{approved:false} without spawning members", async () => {
  const { sup, reg } = makeSup();
  const lead = await sup.create(leadCmd(makeRepo()));
  reg.events.length = 0; // ignore the create burst
  sup.rejectTeamPlan(lead.id);
  const resolved = reg.events.find((e) => e.type === "team.plan.resolved");
  expect(resolved).toMatchObject({ type: "team.plan.resolved", sessionId: lead.id, approved: false });
  // No member sessions were created.
  expect(sup.list().filter((s) => s.parentId === lead.id)).toHaveLength(0);
});

test("approving/rejecting an unknown session throws a BadCommand", async () => {
  const { sup } = makeSup();
  expect(() => sup.rejectTeamPlan("sess_nope")).toThrow();
  await expect(sup.approveTeamPlan("sess_nope")).rejects.toThrow();
});

test("approveTeamPlan refuses a non-lead session (auth boundary — no member spawn off a plain session)", async () => {
  const { sup } = makeSup();
  // A plain (non-lead) session, plus a hand-built plan a malicious/confused client could send.
  const plain = await sup.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "fresh-worktree", repoRoot: makeRepo(), base: "HEAD", title: "plain" } as SessionCreateCmd);
  expect(plain.data.teamRole).toBeUndefined();
  const plan = { leadId: plain.id, integration: "combined-pr" as const, members: [{ title: "X", task: "t", source: "fresh-worktree" as const }] };
  await expect(sup.approveTeamPlan(plain.id, plan)).rejects.toThrow();
  expect(sup.list().filter((s) => s.parentId === plain.id)).toHaveLength(0);
});
