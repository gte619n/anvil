import { test, expect } from "bun:test";
import { buildAgentEnv, OPENROUTER_ANTHROPIC_BASE_URL } from "../../src/agent/env";
import { checkAuth } from "../../src/auth/guard";
import { CLAUDE, GLM, roster, assertIndependent, PHASE_ASSIGNMENT } from "../../src/agent/model-roster";

// The dual-model execution path is the pipeline's keystone: Claude runs on the subscription token, GLM
// runs the SAME Agent SDK against OpenRouter's Anthropic Skin. The load-bearing property is that a GLM
// spawn carries an Anthropic *base URL + bearer* into the CHILD env only, without ever tripping the §3
// guard, which governs the daemon's own env.

const DAEMON_ENV = {
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-daemon",
  OPENROUTER_API_KEY: "sk-or-v1-key",
  PATH: "/usr/bin",
  HOME: "/home/anvil",
};

test("claude profile carries the subscription token and NO Anthropic key/base-url", () => {
  const env = buildAgentEnv({ profile: "claude", src: DAEMON_ENV });
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-daemon");
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  expect(env.PATH).toBe("/usr/bin");
});

test("glm profile points the SDK at OpenRouter with the OpenRouter key and drops the Claude token", () => {
  const env = buildAgentEnv({ profile: "glm", src: DAEMON_ENV });
  expect(env.ANTHROPIC_BASE_URL).toBe(OPENROUTER_ANTHROPIC_BASE_URL);
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-v1-key"); // OpenRouter key as bearer, NOT a metered Anthropic key
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); // no auth-precedence confusion
  expect(env.PATH).toBe("/usr/bin");
});

test("glm profile refuses to build without an OpenRouter key", () => {
  expect(() => buildAgentEnv({ profile: "glm", src: { PATH: "/usr/bin" } })).toThrow(/OPENROUTER_API_KEY/);
});

test("defaults to the claude profile (backward compatible with the no-arg call)", () => {
  const env = buildAgentEnv({ src: DAEMON_ENV });
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-daemon");
  expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
});

test("building a GLM child env does not disturb the daemon's §3 auth state", () => {
  // buildAgentEnv is pure — it reads `src` and returns a fresh object, mutating nothing. So the daemon's
  // own env still satisfies the guard (OAuth token present, no Anthropic key) even though the child got one.
  const before = { ...DAEMON_ENV };
  buildAgentEnv({ profile: "glm", src: DAEMON_ENV });
  expect(DAEMON_ENV).toEqual(before); // src untouched
  // A daemon env with the OAuth token and no ANTHROPIC_* passes the guard; the child's ANTHROPIC_AUTH_TOKEN
  // lives only in the returned object, never in what the guard inspects.
  expect(checkAuth(DAEMON_ENV).subscriptionAuthOk).toBe(true);
});

// ── Model roster + independence rule (spec §2.2, §3.2) ──

test("the roster is exactly two decorrelated models on one execution path", () => {
  expect(CLAUDE.profile).toBe("claude");
  expect(GLM.profile).toBe("glm");
  expect(CLAUDE.id).not.toBe(GLM.id);
});

test("roster() overrides GLM's slug (to track new releases) but leaves Claude fixed", () => {
  const r = roster("z-ai/glm-6");
  expect(r.glm.sdkModel).toBe("z-ai/glm-6");
  expect(r.claude.sdkModel).toBe("opus");
  expect(roster().glm.sdkModel).toBe("z-ai/glm-5.2"); // default
});

test("every phase's default author≠adversary (independence holds where an adversary exists)", () => {
  for (const [phase, a] of Object.entries(PHASE_ASSIGNMENT)) {
    if (a.adversary) expect(a.author).not.toBe(a.adversary);
  }
  // the judgment-stronger model reviews the two judgment gates
  expect(PHASE_ASSIGNMENT.requirements.adversary).toBe("claude");
  expect(PHASE_ASSIGNMENT.design.author).toBe("claude");
});

test("assertIndependent throws only when author and adversary are the same model", () => {
  expect(() => assertIndependent("requirements", "glm", "claude")).not.toThrow();
  expect(() => assertIndependent("requirements", "claude", "claude")).toThrow(/independence violation/);
});
