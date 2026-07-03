import { test, expect, afterEach } from "bun:test";
import { runAgentQuery, type QueryLike } from "../../src/agent/query";
import { CLAUDE, GLM } from "../../src/agent/model-roster";
import { OPENROUTER_ANTHROPIC_BASE_URL } from "../../src/agent/env";

// runAgentQuery is the one path both models share. These assert it selects the right SDK `model` id and
// the right env profile per ModelSpec — the wiring that lets authorship flip by phase — using an
// injected fake `query` so no subprocess spawns.

const ORIG = { c: process.env.CLAUDE_CODE_OAUTH_TOKEN, o: process.env.OPENROUTER_API_KEY };
afterEach(() => {
  if (ORIG.c === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIG.c;
  if (ORIG.o === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ORIG.o;
});

/** A fake SDK query that captures the options and yields a canned plan + result. */
function captureQuery(): { fn: QueryLike; opts: () => Record<string, any> } {
  let captured: Record<string, any> = {};
  const fn: QueryLike = (args) => {
    captured = args.options;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "assistant", message: { content: [{ type: "tool_use", name: "ExitPlanMode", input: { plan: "PLAN" } }] } };
        yield { type: "result", result: "done" };
      },
    };
  };
  return { fn, opts: () => captured };
}

test("Claude spec drives the SDK with model=opus and the subscription-token env (no Anthropic base URL)", async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-x";
  const cap = captureQuery();
  const res = await runAgentQuery("plan it", { model: CLAUDE, readonly: true, cwd: "/repo", queryFn: cap.fn });

  const o = cap.opts();
  expect(o.model).toBe("opus");
  expect(o.permissionMode).toBe("plan"); // readonly → plan mode
  expect(o.cwd).toBe("/repo");
  expect(o.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-x");
  expect(o.env.ANTHROPIC_BASE_URL).toBeUndefined();
  expect(res.plan).toBe("PLAN");
  expect(res.text).toBe("done");
});

test("GLM spec drives the SAME SDK with the GLM slug and the OpenRouter Anthropic-Skin env", async () => {
  process.env.OPENROUTER_API_KEY = "sk-or-v1-k";
  const cap = captureQuery();
  await runAgentQuery("implement it", { model: GLM, readonly: false, queryFn: cap.fn });

  const o = cap.opts();
  expect(o.model).toBe("z-ai/glm-5.2");
  expect(o.permissionMode).toBe("default"); // write phase
  expect(o.env.ANTHROPIC_BASE_URL).toBe(OPENROUTER_ANTHROPIC_BASE_URL);
  expect(o.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-v1-k");
  expect(o.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
});

test("an already-aborted signal is bridged to the SDK's AbortController", async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-x";
  const cap = captureQuery();
  await runAgentQuery("x", { model: CLAUDE, signal: AbortSignal.abort(), queryFn: cap.fn });
  const ac = cap.opts().abortController as AbortController;
  expect(ac.signal.aborted).toBe(true);
});
