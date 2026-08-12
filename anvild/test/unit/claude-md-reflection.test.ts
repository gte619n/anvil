/**
 * Post-PR CLAUDE.md reflection. Pins the env gate, the prompt guardrails, and the Supervisor
 * trigger — a successful interactive `create-pr` injects exactly one reflection turn into the
 * session's driver, subject to the env/degrade/once/session-exists guards, and never lets a
 * failure in that path escape `gitOp` (the client is waiting on the git result).
 *
 * The trigger is exercised without spawning a real agent: we pre-seed the private `sessions`
 * and `drivers` maps with a fake driver and stub `gitProjection.gitOp`, so `ensureDriver`
 * returns our spy instead of constructing an AgentDriver (which would launch a subprocess).
 */
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import type { GitCmd, GitResultEvent } from "@protocol";
import { Supervisor } from "../../src/session/supervisor";
import { ConnectionRegistry } from "../../src/server/registry";
import { AccountStore } from "../../src/auth/accounts";
import {
  CLAUDE_MD_REFLECTION_PROMPT,
  claudeMdReflectionEnabled,
} from "../../src/session/claude-md-reflection";

// ── env gate ────────────────────────────────────────────────────────────────────────────────
const ENV_KEY = "ANVIL_CLAUDEMD_REFLECT";
const savedEnv = process.env[ENV_KEY];
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

test("claudeMdReflectionEnabled defaults on when unset and disables only on falsy words", () => {
  delete process.env[ENV_KEY];
  expect(claudeMdReflectionEnabled()).toBe(true);
  for (const off of ["0", "false", "off", "no", "FALSE", " Off "]) {
    process.env[ENV_KEY] = off;
    expect(claudeMdReflectionEnabled()).toBe(false);
  }
  for (const on of ["1", "true", "on", "yes", "anything"]) {
    process.env[ENV_KEY] = on;
    expect(claudeMdReflectionEnabled()).toBe(true);
  }
});

test("the reflection prompt keeps its load-bearing guardrails", () => {
  const p = CLAUDE_MD_REFLECTION_PROMPT;
  expect(p).toContain("CLAUDE.md");
  expect(p).toContain("AskUserQuestion"); // interview mechanism
  expect(p).toContain("git push"); // amends the existing PR
  expect(p).toMatch(/do NOT open a new pull request/i);
});

// ── Supervisor trigger ──────────────────────────────────────────────────────────────────────
function tempState(): string {
  return mkdtempSync(join(tmpdir(), "anvil-claudemd-"));
}
const gitCmd = (op: GitCmd["op"], sessionId = "s1"): GitCmd =>
  ({ v: PROTOCOL_VERSION, ts: "t", type: "git", op, sessionId }) as GitCmd;

/** A supervisor whose git layer is stubbed and whose session `s1` has a spy driver, so gitOp's
 *  reflection hook can be observed without touching git or the agent subprocess. */
function harness(nextResult: Partial<GitResultEvent>) {
  const dir = tempState();
  const sup = new Supervisor({ stateDir: dir, accounts: new AccountStore(dir), envFile: join(dir, "env") }, new ConnectionRegistry());
  const prompts: string[] = [];
  const anySup = sup as unknown as {
    sessions: Map<string, unknown>;
    drivers: Map<string, unknown>;
    gitProjection: { gitOp: (c: GitCmd) => GitResultEvent };
    authDegrade: { degraded: () => boolean };
  };
  anySup.sessions.set("s1", { data: {} }); // plain interactive session (no teamRole/workUnitId)
  anySup.drivers.set("s1", { prompt: (t: string) => prompts.push(t) });
  anySup.gitProjection = {
    gitOp: (c) => ({ v: PROTOCOL_VERSION, type: "git.result", ts: "t", sessionId: c.sessionId, op: c.op, ok: true, output: "", ...nextResult }),
  };
  anySup.authDegrade = { degraded: () => false }; // usable token by default; the degraded test overrides
  return { sup, prompts, anySup, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a successful create-pr injects exactly one reflection turn per PR cycle", () => {
  const h = harness({ ok: true, url: "https://github.com/o/r/pull/1" });
  try {
    h.sup.gitOp(gitCmd("create-pr"));
    expect(h.prompts).toEqual([CLAUDE_MD_REFLECTION_PROMPT]);
    // a re-click on the same PR does NOT re-interview (once-per-cycle guard)
    h.sup.gitOp(gitCmd("create-pr"));
    expect(h.prompts).toHaveLength(1);
    // …but merging the PR starts a new cycle (worktree rolls onto a follow-up branch), so the
    // NEXT create-pr reflects again.
    h.sup.gitOp(gitCmd("merge-pr"));
    h.sup.gitOp(gitCmd("create-pr"));
    expect(h.prompts).toHaveLength(2);
  } finally {
    h.cleanup();
  }
});

test("a create-pr whose gh output yields no parseable url still reflects (gate is ok, not url)", () => {
  const h = harness({ ok: true }); // url regex miss — the PR exists regardless
  try {
    h.sup.gitOp(gitCmd("create-pr"));
    expect(h.prompts).toHaveLength(1);
  } finally {
    h.cleanup();
  }
});

test("no reflection when the op is not create-pr or the PR creation failed", () => {
  for (const [label, cmdOp, result] of [
    ["non-create-pr op", "push", { ok: true, url: "https://x/pull/1" }],
    ["failed create-pr", "create-pr", { ok: false, url: "https://x/pull/1" }],
  ] as const) {
    const h = harness(result);
    try {
      h.sup.gitOp(gitCmd(cmdOp));
      expect(h.prompts, label).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  }
});

test("team and autopilot work-unit sessions are skipped — interactive sessions only", () => {
  for (const data of [{ teamRole: "lead" }, { teamRole: "member" }, { workUnitId: "wu1" }]) {
    const h = harness({ ok: true, url: "https://x/pull/1" });
    h.anySup.sessions.set("s1", { data });
    try {
      h.sup.gitOp(gitCmd("create-pr"));
      expect(h.prompts, JSON.stringify(data)).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  }
});

test("the env off-switch and the degraded gate both suppress the reflection", () => {
  // env off
  process.env[ENV_KEY] = "0";
  const off = harness({ ok: true, url: "https://x/pull/1" });
  try {
    off.sup.gitOp(gitCmd("create-pr"));
    expect(off.prompts).toHaveLength(0);
  } finally {
    off.cleanup();
  }
  // degraded (no usable token) — even with the feature on
  delete process.env[ENV_KEY];
  const deg = harness({ ok: true, url: "https://x/pull/1" });
  deg.anySup.authDegrade = { degraded: () => true };
  try {
    deg.sup.gitOp(gitCmd("create-pr"));
    expect(deg.prompts).toHaveLength(0);
  } finally {
    deg.cleanup();
  }
});

test("a throw inside the reflection hook never escapes gitOp", () => {
  const h = harness({ ok: true, url: "https://x/pull/1" });
  h.anySup.drivers.set("s1", { prompt: () => { throw new Error("boom"); } });
  try {
    const ev = h.sup.gitOp(gitCmd("create-pr"));
    expect(ev.ok).toBe(true); // the PR result still comes back to the client
    expect(ev.url).toBe("https://x/pull/1");
  } finally {
    h.cleanup();
  }
});
