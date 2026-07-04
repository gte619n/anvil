/**
 * [SEC-H4] The autonomous dev pipeline drives a third-party model (GLM) through the Agent SDK with
 * Write/Edit/Bash enabled and NO danger gate — unlike interactive sessions, which run every tool
 * through the PreToolUse danger list. There is no human to prompt in an unattended run, so the
 * correct posture is to DENY dangerous tools outright. These tests pin that:
 *   1. the guard verdict (pure) denies the danger-list set and allows benign tools,
 *   2. the hook wrapper emits a proper PreToolUse deny/allow, and
 *   3. runAgentQuery actually installs the hook (so the pipeline path is gated, not just the fn).
 */
import { test, expect } from "bun:test";
import { pipelineGuardVerdict, makePipelineGuardHook } from "../../src/agent/pipeline-guard";
import { runAgentQuery, type QueryLike } from "../../src/agent/query";
import { CLAUDE } from "../../src/agent/model-roster";

test("pipelineGuardVerdict denies the danger-list set, allows benign tools", () => {
  const cwd = "/tmp/worktree";
  expect(pipelineGuardVerdict("Bash", { command: "rm -rf /" }, cwd).behavior).toBe("deny");
  expect(pipelineGuardVerdict("Bash", { command: "sudo apt install x" }, cwd).behavior).toBe("deny");
  expect(pipelineGuardVerdict("Bash", { command: "git push --force origin main" }, cwd).behavior).toBe("deny");
  expect(pipelineGuardVerdict("Read", { file_path: "/tmp/worktree/a.ts" }, cwd).behavior).toBe("allow");
  expect(pipelineGuardVerdict("Bash", { command: "bun test" }, cwd).behavior).toBe("allow");
  // write escaping the worktree is dangerous even when the command itself is benign
  expect(pipelineGuardVerdict("Write", { file_path: "/etc/cron.d/evil" }, cwd).behavior).toBe("deny");
  // secret paths are denied across tools
  expect(pipelineGuardVerdict("Read", { file_path: "/tmp/worktree/.env" }, cwd).behavior).toBe("deny");
});

test("makePipelineGuardHook emits a PreToolUse deny for dangerous, allow otherwise", async () => {
  const hook = makePipelineGuardHook("/tmp/worktree");
  const call = (tool: string, input: Record<string, unknown>) =>
    (hook as unknown as (i: unknown) => Promise<any>)({ tool_name: tool, tool_input: input });

  const denied = await call("Bash", { command: "rm -rf /" });
  expect(denied.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("recursive force remove");

  const allowed = await call("Grep", { pattern: "TODO" });
  expect(allowed.hookSpecificOutput.permissionDecision).toBe("allow");
});

test("runAgentQuery installs the PreToolUse guard hook on the SDK options", async () => {
  let captured: Record<string, unknown> | undefined;
  const fakeQuery: QueryLike = (args) => {
    captured = args.options;
    return (async function* () {
      /* no messages — we only care about the options passed in */
    })();
  };

  await runAgentQuery("do work", { model: CLAUDE, cwd: "/tmp/worktree", readonly: false, queryFn: fakeQuery });

  const hooks = (captured?.hooks as any)?.PreToolUse;
  expect(Array.isArray(hooks)).toBe(true);
  const installed = hooks[0].hooks[0] as (i: unknown) => Promise<any>;
  const verdict = await installed({ tool_name: "Bash", tool_input: { command: "rm -rf /tmp" } });
  expect(verdict.hookSpecificOutput.permissionDecision).toBe("deny");
});
