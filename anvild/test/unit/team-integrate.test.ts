import { test, expect } from "bun:test";
import { integrateTeam, type IntegrateGit, type IntegrateMember } from "../../src/integrations/team-integrate";

function fakeGit(over: Partial<IntegrateGit> & { ancestors?: string[]; conflictOn?: string } = {}): { git: IntegrateGit; merged: string[]; prs: number } {
  const merged: string[] = [];
  const state = { prs: 0 };
  const git: IntegrateGit = {
    isAncestor: (_cwd, ref) => (over.ancestors ?? []).includes(ref),
    mergeBranch: (_cwd, branch) => {
      if (over.conflictOn === branch) return { ok: false, conflicted: true, output: `CONFLICT in ${branch}` };
      merged.push(branch);
      return { ok: true, conflicted: false, output: `merged ${branch}` };
    },
    push: () => ({ ok: true, output: "pushed" }),
    createPr: () => { state.prs++; return { ok: true, output: "created", url: "https://gh/pr/1" }; },
    ...over,
  };
  return { git, get merged() { return merged; }, get prs() { return state.prs; } } as any;
}

const M = (title: string, branch?: string): IntegrateMember => ({ sessionId: `s_${title}`, title, branch: branch ?? `b_${title}` });

test("pr-per-member merges nothing and opens no combined PR", () => {
  const fg = fakeGit();
  const r = integrateTeam({ integration: "pr-per-member", leadCwd: "/l", leadBranch: "lead", members: [M("A")], prTitle: "t", prBody: "b", git: fg.git });
  expect(r.mode).toBe("pr-per-member");
  expect(fg.merged).toHaveLength(0);
  expect(fg.prs).toBe(0);
});

test("combined-pr merges every member in the given order, then opens one PR", () => {
  const fg = fakeGit();
  const r = integrateTeam({ integration: "combined-pr", leadCwd: "/l", leadBranch: "lead", members: [M("A"), M("B")], prTitle: "t", prBody: "b", git: fg.git });
  expect(r.ok).toBe(true);
  expect(fg.merged).toEqual(["b_A", "b_B"]);
  expect(r.merged).toEqual(["A", "B"]);
  expect(r.prUrl).toBe("https://gh/pr/1");
  expect(fg.prs).toBe(1);
});

test("already-merged members (ancestor of HEAD) are skipped but counted — resume after a conflict", () => {
  const fg = fakeGit({ ancestors: ["b_A"] });
  const r = integrateTeam({ integration: "combined-pr", leadCwd: "/l", leadBranch: "lead", members: [M("A"), M("B")], prTitle: "t", prBody: "b", git: fg.git });
  expect(fg.merged).toEqual(["b_B"]); // A was already merged, only B is merged this run
  expect(r.merged).toEqual(["A", "B"]);
  expect(r.ok).toBe(true);
});

test("a member with no branch (read-only) is not merged", () => {
  const fg = fakeGit();
  const r = integrateTeam({ integration: "combined-pr", leadCwd: "/l", leadBranch: "lead", members: [{ sessionId: "s", title: "Doc", branch: undefined }, M("B")], prTitle: "t", prBody: "b", git: fg.git });
  expect(fg.merged).toEqual(["b_B"]);
  expect(r.ok).toBe(true);
});

test("a merge conflict parks: reports the member as a real conflict, opens no PR", () => {
  const fg = fakeGit({ conflictOn: "b_B" });
  const r = integrateTeam({ integration: "combined-pr", leadCwd: "/l", leadBranch: "lead", members: [M("A"), M("B"), M("C")], prTitle: "t", prBody: "b", git: fg.git });
  expect(r.ok).toBe(false);
  expect(r.failedMember).toBe("B");
  expect(r.conflicted).toBe(true);
  expect(fg.merged).toEqual(["b_A"]); // stopped at the conflict; C not attempted
  expect(fg.prs).toBe(0);
  expect(r.output).toContain("Merge conflict");
});

test("a non-conflict merge failure is reported distinctly (not as a resolvable conflict)", () => {
  const g: IntegrateGit = {
    isAncestor: () => false,
    mergeBranch: () => ({ ok: false, conflicted: false, output: "error: Your local changes would be overwritten" }),
    push: () => ({ ok: true, output: "pushed" }),
    createPr: () => ({ ok: true, output: "created", url: "u" }),
  };
  const r = integrateTeam({ integration: "combined-pr", leadCwd: "/l", leadBranch: "lead", members: [M("A")], prTitle: "t", prBody: "b", git: g });
  expect(r.ok).toBe(false);
  expect(r.failedMember).toBe("A");
  expect(r.conflicted).toBe(false);
  expect(r.output).toContain("NOT a conflict");
  expect(r.output).not.toContain("Resolve the conflicts");
});
