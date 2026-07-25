# Anvil-native `/goal` — Implementation Plan

**Goal:** Give a session a stated objective it keeps working toward — `/goal <condition>` blocks the
session from going idle until a Haiku judge says the condition is met, a ceiling of 10 is hit, or the
user sends `/goal clear`.

**Architecture:** A `Stop` hook is registered unconditionally alongside the existing `PreToolUse`
gate and reads goal state off the live `Session` object (the SDK has no `setHooks`, so it cannot be
added later). `/goal` is parsed in `supervisor.prompt()` beside the existing `/clear` and `/compact`
intercepts. Goal state lives on the protocol `Session`, so it persists and rides `session.updated`
to every device. Display-only composer chip; cleared via `/goal clear`.

**Tech Stack:** Bun + TypeScript, `@anthropic-ai/claude-agent-sdk@0.3.183`, `bun:test`, vanilla-TS web client.

**Design doc:** `docs/plans/2026-07-25-goal-stop-hook-design.md` (committed `661ef3b`, all 10 sections approved)

**Worktree:** `.claude/worktrees/goal-stop-hook`, branch `worktree-goal-stop-hook`, `node_modules` symlinked.

---

## Status

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | Protocol: `SessionGoal`, `Session.goal`, `GOAL_MAX_ITERATIONS` | pending | no | no |
| 2 | `goal.ts`: `parseGoalCommand` | pending | no | no |
| 3 | `goal.ts`: `judgeGoal` (Haiku one-shot) | pending | no | no |
| 4 | `Session`: `recentTurns` rolling buffer | pending | no | no |
| 5 | `goal.ts`: `makeStopHook` | pending | no | no |
| 6 | `driver.ts`: register `Stop` hook + feed `recentTurns` | pending | no | no |
| 7 | `supervisor.ts`: `/goal` intercept, dividers, counter reset | pending | no | no |
| 8 | `supervisor.ts`: push suppression + resolve push | pending | no | no |
| 9 | `skills.ts`: `/goal` menu blurb | pending | no | no |
| 10 | Web: composer chip | pending | no | no |
| 11 | Integration test: full `/goal` flow | pending | no | no |
| 12 | **User-driven E2E verification** (manual, live daemon) | pending | no | no |
| 13 | Full gate + PR | pending | no | no |

**Conventions to preserve (verified in-repo):**
- Unit tests: `test/unit/*.test.ts`, `bun:test`, direct `src/` imports, dependencies injected
  (`AgentDriver`'s `queryFn` param exists for exactly this — see `test/unit/driver-cleanup.test.ts`).
- Integration tests: `test/integration/*.test.ts` using `mock.module("@anthropic-ai/claude-agent-sdk", …)`.
  **The mock must re-export `createSdkMcpServer` and `tool`**, not just `query` — see the comment at
  the top of `test/integration/dispatch.test.ts`; a query-only stub link-errors every later file.
- Web imports protocol via the relative `"../../protocol"` (there is no `@protocol` alias in `web/tsconfig.json`).
- `esc` / `icon` come from `web/src/dom`.

Run everything from `anvild/`.

---

### Task 1: Protocol — goal state on `Session`

**Files:**
- Modify: `docs/plans/anvil-protocol.ts` (symlinked as `anvild/protocol.ts`)

**Step 1: Add the type + constant.** Insert directly above `export interface Session {` (~line 207):

```ts
/** Ceiling on unmet stop attempts before a goal auto-clears (design D4). Shared with the web client. */
export const GOAL_MAX_ITERATIONS = 10;

/**
 * A session's active goal (design 2026-07-25). Set with `/goal <condition>`, cleared with
 * `/goal clear`, and enforced by a Stop hook that blocks the session from going idle until a judge
 * says the condition is met. Display-only on the client — there is no goal command in the protocol;
 * both `/goal` forms arrive as ordinary `prompt.send` text.
 */
export interface SessionGoal {
  condition: string; // natural language, exactly as the user typed it
  iterations: number; // unmet stop attempts since the last reset; auto-clears at GOAL_MAX_ITERATIONS
  lastReason?: string; // the judge's most recent blocker, shown as the chip's tooltip
  paused?: boolean; // restored from disk after a restart; re-arms on the next user prompt (D5)
  setAt: Iso8601;
}
```

**Step 2: Add the field.** Inside `export interface Session`, immediately after the `commands?` field
(the last member, ~line 246):

```ts
  // The session's active goal (design 2026-07-25). Absent when no goal is set. Drives the composer's
  // goal chip; updated on every unmet stop attempt so the iteration count is live on every device.
  goal?: SessionGoal;
}
```

**Step 3: Verify the contract test still passes.** Both changes are additive, so `PROTOCOL_VERSION`
stays `2`.

Run: `bun test test/contract/`
Expected: PASS (the golden pins the event set and version, neither of which changed).

**Step 4: Commit**
`git commit -am "feat(protocol): SessionGoal + Session.goal (additive)"`

---

### Task 2: `parseGoalCommand`

**Files:**
- Create: `anvild/src/agent/goal.ts`
- Create: `anvild/test/unit/goal.test.ts`

**Step 1: Write failing test.** Create `test/unit/goal.test.ts`:

```ts
import { test, expect } from "bun:test";
import { parseGoalCommand } from "../../src/agent/goal";

test("parseGoalCommand recognises set, clear, and status", () => {
  expect(parseGoalCommand("/goal all tests pass")).toEqual({ kind: "set", condition: "all tests pass" });
  expect(parseGoalCommand("  /goal   all tests pass  ")).toEqual({ kind: "set", condition: "all tests pass" });
  expect(parseGoalCommand("/goal clear")).toEqual({ kind: "clear" });
  expect(parseGoalCommand("/goal")).toEqual({ kind: "status" });
});

test("parseGoalCommand ignores anything that is not the whole message", () => {
  // Matches Claude Code's slash-command rule and the existing /clear + /compact intercepts.
  expect(parseGoalCommand("please run /goal all tests pass")).toBeUndefined();
  expect(parseGoalCommand("/goalpost is unrelated")).toBeUndefined();
  expect(parseGoalCommand("/goals all tests pass")).toBeUndefined();
  expect(parseGoalCommand("")).toBeUndefined();
});
```

**Step 2: Run test, verify failure**
Run: `bun test test/unit/goal.test.ts`
Expected: FAIL — `Cannot find module '../../src/agent/goal'`

**Step 3: Implement.** Create `src/agent/goal.ts`:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { GOAL_MAX_ITERATIONS, type SessionGoal } from "@protocol";
import { claudeCliOptions } from "./cli";
import type { Session } from "../session/session";

export { GOAL_MAX_ITERATIONS };

/** How many buffered transcript lines the judge sees (~5 turns of assistant text + tool results). */
export const GOAL_TRANSCRIPT_LINES = 40;

export type GoalCommand =
  | { kind: "set"; condition: string }
  | { kind: "clear" }
  | { kind: "status" };

/**
 * Parse a `/goal` message. Like `/clear` and `/compact`, the command must be the WHOLE message —
 * anything else is ordinary prose and must reach the model untouched.
 */
export function parseGoalCommand(text: string): GoalCommand | undefined {
  const t = text.trim();
  if (t === "/goal") return { kind: "status" };
  if (!t.startsWith("/goal ")) return undefined;
  const rest = t.slice("/goal ".length).trim();
  if (!rest) return { kind: "status" };
  if (rest.toLowerCase() === "clear") return { kind: "clear" };
  return { kind: "set", condition: rest };
}
```

**Step 4: Run test, verify pass**
Run: `bun test test/unit/goal.test.ts`
Expected: PASS (2 tests)

**Step 5: Commit**
`git commit -am "feat(goal): parseGoalCommand"`

---

### Task 3: `judgeGoal`

**Files:**
- Modify: `anvild/src/agent/goal.ts`
- Modify: `anvild/test/unit/goal.test.ts`

Mirrors `classifyBranchKind` (`src/agent/branch-kind.ts:35`) exactly: one-shot Haiku, no tools,
`settingSources: []`, `maxTurns: 1`, 20s abort, §3 OAuth env.

**Step 1: Write failing test.** Append to `test/unit/goal.test.ts`:

```ts
import { parseVerdict } from "../../src/agent/goal";

test("parseVerdict reads the judge's reply", () => {
  expect(parseVerdict("MET")).toEqual({ met: true, reason: "" });
  expect(parseVerdict("  met  ")).toEqual({ met: true, reason: "" });
  expect(parseVerdict("UNMET: 3 tests still failing")).toEqual({ met: false, reason: "3 tests still failing" });
  expect(parseVerdict("unmet: no evidence the file was created")).toEqual({
    met: false,
    reason: "no evidence the file was created",
  });
});

test("parseVerdict throws on an unparseable reply so the hook fails open (D6)", () => {
  expect(() => parseVerdict("I think maybe?")).toThrow();
  expect(() => parseVerdict("")).toThrow();
});
```

**Step 2: Run test, verify failure**
Run: `bun test test/unit/goal.test.ts`
Expected: FAIL — `parseVerdict is not a function` / export missing

**Step 3: Implement.** Append to `src/agent/goal.ts`:

```ts
export interface GoalVerdict {
  met: boolean;
  reason: string;
}

/**
 * Parse the judge's reply. Deliberately strict: anything unrecognised THROWS so the hook's
 * fail-open path (design D6) treats a confused judge exactly like an unreachable one — a goal must
 * never trap a session on the strength of a garbled answer.
 */
export function parseVerdict(text: string): GoalVerdict {
  const t = text.trim();
  if (/^met\b/i.test(t)) return { met: true, reason: "" };
  const m = /^unmet\s*:?\s*(.*)$/is.exec(t);
  if (m) return { met: false, reason: (m[1] ?? "").trim() || "condition not yet satisfied" };
  throw new Error(`unparseable goal verdict: ${t.slice(0, 120)}`);
}

/**
 * Judge whether `condition` is satisfied by the recent transcript. One-shot Haiku, no tools —
 * mirrors `classifyBranchKind`. Throws on timeout, transport failure, or an unparseable reply;
 * every one of those is fail-open at the call site (D6).
 */
export async function judgeGoal(
  condition: string,
  transcript: string,
  env: Record<string, string>,
): Promise<GoalVerdict> {
  const prompt =
    `You are judging whether a coding agent has satisfied a stated goal.\n\n` +
    `GOAL: ${condition}\n\n` +
    `Recent transcript (most recent last):\n"""\n${transcript.slice(-8000)}\n"""\n\n` +
    `Judge ONLY on evidence in the transcript — tool results, command output, errors. A claim by ` +
    `the agent that it succeeded is NOT evidence if the tool result contradicts it or is absent.\n\n` +
    `Reply with EXACTLY one line:\n` +
    `MET\n` +
    `or\n` +
    `UNMET: <short reason, max 15 words>`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const q = query({
      prompt,
      options: {
        model: "haiku",
        settingSources: [],
        allowedTools: [],
        permissionMode: "bypassPermissions",
        maxTurns: 1,
        ...claudeCliOptions(),
        abortController: ac,
        env,
      },
    });
    let text = "";
    for await (const m of q) {
      if (m.type === "assistant") {
        for (const b of (m as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? []) {
          if (b.type === "text" && b.text) text += b.text;
        }
      }
      if (m.type === "result") break;
    }
    return parseVerdict(text);
  } finally {
    clearTimeout(timer);
  }
}
```

**Step 4: Run test, verify pass**
Run: `bun test test/unit/goal.test.ts`
Expected: PASS (4 tests). No network — only `parseVerdict` is exercised.

**Step 5: Commit**
`git commit -am "feat(goal): judgeGoal — one-shot Haiku verdict"`

---

### Task 4: `Session.recentTurns` rolling buffer

The judge needs evidence, not the last assertion (design D2). `Session` already keeps
`lastAssistantText` for push snippets; this adds a bounded ring of recent transcript lines.

**Files:**
- Modify: `anvild/src/session/session.ts`

**Step 1: Implement.** Add next to `lastAssistantText` (~line 51):

```ts
  /** Recent transcript lines (assistant prose + tool results), newest last, capped for the goal
   *  judge (design D2 — judge evidence, not the last claim). In memory only; a restart drops it,
   *  which is correct: a restored goal is paused until the user prompts again anyway (D5). */
  readonly recentTurns: string[] = [];
```

And a method on the class (place it after `emit`):

```ts
  /** Append a transcript line for the goal judge, trimming to the cap. Cheap and allocation-free
   *  when no goal is set — the buffer is maintained unconditionally so a goal set mid-session
   *  immediately has evidence to judge. */
  recordTurnLine(line: string, cap: number): void {
    const t = line.trim();
    if (!t) return;
    this.recentTurns.push(t.length > 500 ? `${t.slice(0, 500)}…` : t);
    while (this.recentTurns.length > cap) this.recentTurns.shift();
  }
```

**Step 2: Verify types**
Run: `bunx tsc --noEmit`
Expected: exit 0

**Step 3: Commit**
`git commit -am "feat(session): recentTurns buffer for the goal judge"`

---

### Task 5: `makeStopHook`

**Files:**
- Modify: `anvild/src/agent/goal.ts`
- Modify: `anvild/test/unit/goal.test.ts`

**Step 1: Write failing tests.** Append to `test/unit/goal.test.ts`:

```ts
import { makeStopHook, GOAL_MAX_ITERATIONS } from "../../src/agent/goal";
import type { SessionGoal } from "@protocol";

function fakeSession(goal?: SessionGoal) {
  return {
    data: { goal },
    recentTurns: ["assistant: ran the tests", "tool: 3 failed"],
    recordTurnLine() {},
  } as any;
}
const noEnv = () => ({});

test("stop hook is a no-op with no goal, and never calls the judge", async () => {
  let judged = 0;
  const s = fakeSession(undefined);
  const hook = makeStopHook(s, noEnv, () => {}, async () => {
    judged++;
    return { met: false, reason: "x" };
  });
  expect(await hook({} as any, undefined, {} as any)).toEqual({ continue: true });
  expect(judged).toBe(0); // guards the "free for every non-goal session" invariant
});

test("stop hook is a no-op while the goal is paused", async () => {
  const s = fakeSession({ condition: "c", iterations: 0, paused: true, setAt: "t" });
  const hook = makeStopHook(s, noEnv, () => {}, async () => ({ met: false, reason: "x" }));
  expect(await hook({} as any, undefined, {} as any)).toEqual({ continue: true });
});

test("unmet blocks the stop, increments, and records the blocker", async () => {
  const s = fakeSession({ condition: "all tests pass", iterations: 0, setAt: "t" });
  const hook = makeStopHook(s, noEnv, () => {}, async () => ({ met: false, reason: "3 tests still failing" }));
  const out = (await hook({} as any, undefined, {} as any)) as any;
  expect(out.decision).toBe("block");
  expect(out.reason).toBe("[all tests pass]: 3 tests still failing");
  expect(s.data.goal.iterations).toBe(1);
  expect(s.data.goal.lastReason).toBe("3 tests still failing");
});

test("met clears the goal and reports resolved(met=true) once", async () => {
  const s = fakeSession({ condition: "c", iterations: 2, setAt: "t" });
  const seen: boolean[] = [];
  const hook = makeStopHook(s, noEnv, (met) => seen.push(met), async () => ({ met: true, reason: "" }));
  expect(await hook({} as any, undefined, {} as any)).toEqual({ continue: true });
  expect(s.data.goal).toBeUndefined();
  expect(seen).toEqual([true]);
});

test("at the ceiling the goal clears WITHOUT calling the judge", async () => {
  let judged = 0;
  const s = fakeSession({ condition: "c", iterations: GOAL_MAX_ITERATIONS, lastReason: "still red", setAt: "t" });
  const seen: boolean[] = [];
  const hook = makeStopHook(s, noEnv, (met) => seen.push(met), async () => {
    judged++;
    return { met: false, reason: "x" };
  });
  expect(await hook({} as any, undefined, {} as any)).toEqual({ continue: true });
  expect(s.data.goal).toBeUndefined();
  expect(seen).toEqual([false]);
  expect(judged).toBe(0);
});

test("a judge failure fails open and does NOT consume an iteration (D6)", async () => {
  const s = fakeSession({ condition: "c", iterations: 4, setAt: "t" });
  const hook = makeStopHook(s, noEnv, () => {}, async () => {
    throw new Error("haiku unreachable");
  });
  expect(await hook({} as any, undefined, {} as any)).toEqual({ continue: true });
  expect(s.data.goal.iterations).toBe(4); // unchanged
  expect(s.data.goal).toBeDefined(); // still armed
});
```

**Step 2: Run test, verify failure**
Run: `bun test test/unit/goal.test.ts`
Expected: FAIL — `makeStopHook is not a function`

**Step 3: Implement.** Append to `src/agent/goal.ts`:

```ts
/** Called when a goal resolves — met (true) or abandoned at the ceiling (false). */
export type GoalResolved = (met: boolean, goal: SessionGoal) => void;
/** Called after an unmet attempt so the supervisor can persist + broadcast the new count. */
export type GoalProgress = (goal: SessionGoal) => void;

/**
 * The `Stop` hook. Registered unconditionally at query start (the SDK has no `setHooks`, so it can
 * never be added later) and reads goal state off the LIVE session each time it fires — which is what
 * lets `/goal` arm mid-session with no driver restart.
 *
 * Return shape verified by spike (design §10 R1): `{decision:"block", reason}` blocks the stop and
 * the model complies, receiving `Stop hook feedback:\n<reason>`. Do NOT switch to
 * `hookSpecificOutput.additionalContext` — that arrives as a system reminder the model refuses as a
 * suspected prompt injection, yielding a session that loops without doing the work.
 */
export function makeStopHook(
  session: Session,
  env: () => Record<string, string>,
  onResolved: GoalResolved,
  judge: (c: string, t: string, e: Record<string, string>) => Promise<GoalVerdict> = judgeGoal,
  onProgress: GoalProgress = () => {},
): HookCallback {
  return async () => {
    const goal = session.data.goal;
    // Free path: the overwhelming majority of stops belong to sessions with no goal.
    if (!goal || goal.paused) return { continue: true };

    if (goal.iterations >= GOAL_MAX_ITERATIONS) {
      session.data.goal = undefined;
      onResolved(false, goal);
      return { continue: true };
    }

    let verdict: GoalVerdict;
    try {
      verdict = await judge(goal.condition, session.recentTurns.join("\n"), env());
    } catch {
      return { continue: true }; // D6: fail open — never trap a session on an unreachable judge
    }

    if (verdict.met) {
      session.data.goal = undefined;
      onResolved(true, goal);
      return { continue: true };
    }

    goal.iterations += 1;
    goal.lastReason = verdict.reason;
    onProgress(goal);
    return { decision: "block", reason: `[${goal.condition}]: ${verdict.reason}` };
  };
}
```

**Step 4: Run test, verify pass**
Run: `bun test test/unit/goal.test.ts`
Expected: PASS (10 tests)

**Step 5: Commit**
`git commit -am "feat(goal): makeStopHook — ceiling, fail-open, verified block shape"`

---

### Task 6: Register the hook in the driver

**Files:**
- Modify: `anvild/src/agent/driver.ts`

**Step 1: Import + constructor param.** Add the import:

```ts
import { GOAL_TRANSCRIPT_LINES, makeStopHook, type GoalProgress, type GoalResolved } from "./goal";
```

Add two params at the END of the constructor list (after `onTurnError`), so existing positional
call sites are untouched:

```ts
    /** Called when this session's goal resolves — met, or abandoned at the ceiling. */
    private readonly onGoalResolved?: GoalResolved,
    /** Called after each unmet attempt so the supervisor can persist + broadcast the count. */
    private readonly onGoalProgress?: GoalProgress,
```

**Step 2: Register the hook.** In `ensureStarted()`, replace the `hooks:` block:

```ts
        hooks: {
          PreToolUse: [{ hooks: [makePreToolUseHook(s, this.broker, this.onPlanProposed)], timeout: 3600 }],
          // The goal hook (design 2026-07-25). Registered unconditionally — the SDK offers no way to
          // add a hook to a live query — and returns `{continue:true}` immediately when the session
          // has no goal. 60s covers the judge's own 20s abort with headroom.
          Stop: [
            {
              hooks: [
                makeStopHook(
                  s,
                  () => this.env,
                  (met, goal) => this.onGoalResolved?.(met, goal),
                  undefined,
                  (goal) => this.onGoalProgress?.(goal),
                ),
              ],
              timeout: 60,
            },
          ],
        },
```

**Step 3: Feed the buffer.** In `consume()`, inside the existing `if (m.type === "assistant")` block
that sets `lastAssistantText`, add after `if (text) this.session.lastAssistantText = text;`:

```ts
          if (text) this.session.recordTurnLine(`assistant: ${text}`, GOAL_TRANSCRIPT_LINES);
```

And in the `user` branch handling of tool results — add immediately after the existing
`for (const id of askUserQuestionToolIds(m))` line:

```ts
        // Tool results are the evidence the goal judge needs (design D2) — a claim of success that
        // the tool result contradicts must be visible to it.
        if (m.type === "user") {
          for (const b of ((m as any).message?.content ?? []) as any[]) {
            if (b?.type === "tool_result") {
              const body = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
              this.session.recordTurnLine(`tool${b.is_error ? " ERROR" : ""}: ${body}`, GOAL_TRANSCRIPT_LINES);
            }
          }
        }
```

**Step 4: Verify types**
Run: `bunx tsc --noEmit && bun test test/unit/driver-cleanup.test.ts`
Expected: exit 0, PASS (the new params are optional — existing construction is unaffected)

**Step 5: Commit**
`git commit -am "feat(driver): register the goal Stop hook and feed the judge buffer"`

---

### Task 7: `/goal` intercept in the supervisor

**Files:**
- Modify: `anvild/src/session/supervisor.ts` (in `prompt()`, ~line 2338)

**Step 1: Import**

```ts
import { GOAL_MAX_ITERATIONS, parseGoalCommand } from "../agent/goal";
```

**Step 2: Implement.** Insert immediately AFTER the existing `/compact` block and BEFORE the
`const attachments = …` line:

```ts
    // `/goal` (design 2026-07-25) — daemon-handled like the context controls. Sets/clears/reports the
    // session's goal without consuming a turn; the Stop hook registered in the driver enforces it.
    const goalCmd = parseGoalCommand(text);
    if (goalCmd) {
      this.handleGoalCommand(s, goalCmd);
      return;
    }

    // Any ordinary prompt is new information: re-arm a restored goal and reset the ceiling, so it
    // means "10 turns without human help" rather than "10 turns ever" (design D8/D5).
    if (s.data.goal) {
      s.data.goal.iterations = 0;
      s.data.goal.paused = undefined;
      this.persist();
      this.broadcastUpdated(s.data);
    }
```

**Step 3: Add the handler.** Add these private methods next to `newTopic`:

```ts
  /** Apply a parsed `/goal` command. Never consumes a turn. */
  private handleGoalCommand(s: Session, cmd: GoalCommand): void {
    if (cmd.kind === "set") {
      s.data.goal = { condition: cmd.condition, iterations: 0, setAt: now() };
      this.goalDivider(s, "Goal set", `${cmd.condition}\n\nThis session will keep working until the goal is met, ${GOAL_MAX_ITERATIONS} attempts pass, or you send \`/goal clear\`.`);
    } else if (cmd.kind === "clear") {
      if (!s.data.goal) {
        this.goalDivider(s, "No goal set", "Send `/goal <condition>` to set one.");
        return;
      }
      s.data.goal = undefined;
      this.goalDivider(s, "Goal cleared", "The session will stop normally from now on.");
    } else {
      const g = s.data.goal;
      this.goalDivider(
        s,
        g ? "Goal" : "No goal set",
        g
          ? `${g.condition}\n\n${g.iterations}/${GOAL_MAX_ITERATIONS} attempts${g.paused ? " · paused until your next message" : ""}${g.lastReason ? `\n\nLast blocker: ${g.lastReason}` : ""}`
          : "Usage: `/goal <condition>`",
      );
      return; // status is read-only — nothing to persist
    }
    this.persist();
    this.broadcastUpdated(s.data);
  }

  /** A goal lifecycle marker in the transcript — same divider block the compact boundary uses. */
  private goalDivider(s: Session, label: string, note: string): void {
    s.emit({ type: "assistant.message", blocks: [{ kind: "divider", label, note }] });
  }
```

Add the type import: `import type { GoalCommand } from "../agent/goal";`

**Step 4: Verify types**
Run: `bunx tsc --noEmit`
Expected: exit 0

**Step 5: Commit**
`git commit -am "feat(supervisor): /goal set/clear/status intercept + counter reset"`

---

### Task 8: Push suppression + resolve push

**Files:**
- Modify: `anvild/src/session/supervisor.ts` (`maybeNotify`, ~line 2563; `ensureDriver`, ~line 2390)

**Step 1: Suppress the `result` branch.** In `maybeNotify`, change the `result` branch guard:

```ts
    } else if (event.type === "result") {
      // A goal in flight ends a turn on every iteration. Suppressing the "your turn" push here is
      // what makes a 10-iteration goal send ONE notification instead of ten (design D3). The
      // permission and question branches above are deliberately untouched: a goal blocked on an
      // approval still has to reach the user.
      if (data?.goal && !data.goal.paused) return;
      const snippet = summarize(this.sessions.get(sessionId)?.lastAssistantText ?? "");
```

**Step 2: Wire the driver callbacks.** In `ensureDriver`, append two arguments to the
`new AgentDriver(...)` call, after `(err) => this.onTurnError(err)`:

```ts
        (met, goal) => this.onGoalResolved(id, met, goal),
        () => {
          this.persist();
          this.broadcastUpdated(s.data);
        },
```

**Step 3: Add the resolve handler.** Next to `handleGoalCommand`:

```ts
  /** A goal finished — met, or abandoned at the ceiling. Marks the transcript, persists, and sends
   *  the ONE push the whole goal is allowed (design D3/D4). */
  private onGoalResolved(id: string, met: boolean, goal: SessionGoal): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const label = met ? "Goal met" : `Goal abandoned after ${GOAL_MAX_ITERATIONS} turns`;
    const note = met
      ? `${goal.condition}\n\nReached in ${goal.iterations} attempt${goal.iterations === 1 ? "" : "s"}.`
      : `${goal.condition}\n\nLast blocker: ${goal.lastReason ?? "unknown"}`;
    this.goalDivider(s, label, note);
    this.persist();
    this.broadcastUpdated(s.data);
    const dir = s.data.cwd ? basename(s.data.cwd) : undefined;
    void this.webpush.notify({ title: s.data.title, body: `${label}: ${goal.condition}`, dir, sessionId: id, tag: `goal-${id}`, kind: "result" });
    void this.fcm.notify({ title: s.data.title, body: `${label}: ${goal.condition}`, dir, sessionId: id, tag: `goal-${id}`, kind: "result" });
    void this.apns.notify({ title: s.data.title, body: `${label}: ${goal.condition}`, dir, sessionId: id, tag: `goal-${id}`, kind: "result" });
  }
```

Add `SessionGoal` to the `@protocol` type import at the top of the file.

**Step 4: Restore-as-paused.** In the restore loop (~line 2856), after the session is constructed
from `p.data`:

```ts
      // A restored goal is re-armed PAUSED (design D5): a self-update must never resume an
      // unattended loop. The next user prompt un-pauses it (see prompt()).
      if (p.data.goal) p.data.goal.paused = true;
```

**Step 5: Verify**
Run: `bunx tsc --noEmit && bun test`
Expected: exit 0, full suite PASS

**Step 6: Commit**
`git commit -am "feat(supervisor): one push per goal + restore paused"`

---

### Task 9: `/goal` in the `/` menu

**Files:**
- Modify: `anvild/src/agent/skills.ts` (`BUILTIN_DESCRIPTIONS`)
- Modify: `anvild/test/unit/skills.test.ts`

**Step 1: Write failing test.** Add to `test/unit/skills.test.ts`:

```ts
test("buildCommandInfo blurbs /goal — it is genuinely daemon-handled", () => {
  const cmds = buildCommandInfo(["goal"], "/tmp");
  expect(cmds).toContainEqual({
    name: "goal",
    source: "builtin",
    description: "Keep working until a condition is met — /goal <condition>, /goal clear to stop",
  });
});
```

**Step 2: Run test, verify failure**
Run: `bun test test/unit/skills.test.ts`
Expected: FAIL — received `{ name: "goal", source: "builtin" }` with no description

**Step 3: Implement.** Add to `BUILTIN_DESCRIPTIONS`:

```ts
  goal: "Keep working until a condition is met — /goal <condition>, /goal clear to stop",
```

**Step 4: Run test, verify pass**
Run: `bun test test/unit/skills.test.ts`
Expected: PASS

**Step 5: Commit**
`git commit -am "feat(skills): blurb /goal in the composer menu"`

---

### Task 10: Composer chip

**Files:**
- Modify: `anvild/web/index.html:67`
- Modify: `anvild/web/src/main.ts` (~2422 and ~840)
- Modify: `anvild/web/styles/app.css`

**Step 1: Markup.** In `web/index.html`, insert immediately BEFORE `<form id="composer">`:

```html
            <div id="goal-chip" class="goal-chip" hidden></div>
```

**Step 2: Render.** In `web/src/main.ts`, add after `updateContextMeter`:

```ts
/**
 * Goal chip (design 2026-07-25): a slim, display-only bar above the composer showing the session's
 * active goal and how many attempts it has made. Cleared with `/goal clear` — deliberately no button.
 */
function updateGoalChip(s: Session | undefined): void {
  const el = document.getElementById("goal-chip");
  if (!el) return;
  const g = s?.goal;
  if (!g) {
    el.hidden = true;
    el.replaceChildren();
    return;
  }
  el.hidden = false;
  el.className = "goal-chip" + (g.paused ? " paused" : "");
  const count = g.paused ? "paused" : `${g.iterations}/${GOAL_MAX_ITERATIONS}`;
  el.innerHTML = `${icon("target")}<span class="goal-cond">${esc(g.condition)}</span><span class="goal-count">${count}</span>`;
  el.title = g.lastReason ? `Last blocker: ${g.lastReason}` : "Send /goal clear to stop early";
}
```

Extend the existing protocol import at `main.ts:39`:

```ts
import { GOAL_MAX_ITERATIONS, MODELS, modelLabel, type Model } from "../../protocol";
```

Call it in both refresh paths — after `updateContextMeter(s);` (~2422) and after
`updateContextMeter(e.session);` (~840):

```ts
  updateGoalChip(s);          // (and `updateGoalChip(e.session);` at the other site)
```

**Step 3: Styles.** Append to `web/styles/app.css`:

```css
/* Goal chip — display-only bar above the composer (design 2026-07-25). */
.goal-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 12px 6px;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--surface-2, rgba(127, 127, 127, 0.12));
  font-size: 0.85rem;
  min-width: 0;
}
.goal-chip .goal-cond {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.goal-chip .goal-count {
  flex: none;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}
.goal-chip.paused {
  opacity: 0.6;
}
```

**Step 4: Verify**
Run: `bun run typecheck:web && bun run build:web`
Expected: both exit 0

**Step 5: Commit**
`git commit -am "feat(web): goal chip above the composer"`

---

### Task 11: Integration test — the whole `/goal` flow

Follows `test/integration/dispatch.test.ts`. **The SDK mock must export `createSdkMcpServer` and
`tool` as well as `query`** — a query-only stub link-errors every file loaded after it.

**Files:**
- Create: `anvild/test/integration/goal-flow.test.ts`

**Step 1: Write the test**

```ts
/**
 * End-to-end `/goal` wiring: the intercept sets state without consuming a turn, the Stop hook blocks
 * an unmet goal and increments, a met goal clears, and `/goal clear` removes it. This is the tier
 * that would have caught the failure found on 2026-07-25 — five `/goal` attempts that looked correct
 * and did nothing, because the command never reached anything that could act on it.
 */
import { test, expect, mock } from "bun:test";

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: () => ({ type: "sdk", name: "mock", instance: {} }),
  tool: (name: string, _d: unknown, _s: unknown, handler: unknown) => ({ name, handler }),
  query: () => ({
    async *[Symbol.asyncIterator]() {
      /* no turns — this test drives the hook directly */
    },
    interrupt: async () => {},
    setModel: async () => {},
    close: () => {},
  }),
}));

const { parseGoalCommand, makeStopHook, GOAL_MAX_ITERATIONS } = await import("../../src/agent/goal");

test("/goal set → unmet blocks and counts → met clears", async () => {
  const session = {
    data: { goal: undefined as any },
    recentTurns: ["assistant: ran tests", "tool ERROR: 3 failed"],
    recordTurnLine() {},
  } as any;

  // set
  const cmd = parseGoalCommand("/goal all tests pass");
  expect(cmd).toEqual({ kind: "set", condition: "all tests pass" });
  session.data.goal = { condition: "all tests pass", iterations: 0, setAt: "t" };

  // unmet → blocks, counts, and the model receives the CC-compatible reason format
  let verdict = { met: false, reason: "3 tests still failing" };
  const resolved: boolean[] = [];
  const hook = makeStopHook(session, () => ({}), (met) => resolved.push(met), async () => verdict);

  const blocked = (await hook({} as any, undefined, {} as any)) as any;
  expect(blocked).toEqual({ decision: "block", reason: "[all tests pass]: 3 tests still failing" });
  expect(session.data.goal.iterations).toBe(1);

  // met → clears, reports once
  verdict = { met: true, reason: "" };
  expect(await hook({} as any, undefined, {} as any)).toEqual({ continue: true });
  expect(session.data.goal).toBeUndefined();
  expect(resolved).toEqual([true]);
});

test("/goal clear parses and the ceiling is shared with the protocol", () => {
  expect(parseGoalCommand("/goal clear")).toEqual({ kind: "clear" });
  expect(GOAL_MAX_ITERATIONS).toBe(10);
});
```

**Step 2: Run**
Run: `bun test test/integration/goal-flow.test.ts`
Expected: PASS (2 tests)

**Step 3: Commit**
`git commit -am "test(goal): integration coverage for the /goal flow"`

---

### Task 12: User-driven E2E verification (manual, live daemon)

Automated tests stub the judge and the SDK. This task exercises the real thing — real Haiku, real
hook, real chip, real push — before anything is proposed for merge. **Do not open the PR until the
user has confirmed this checklist.**

**Step 1: Deploy the branch locally**

```bash
cd /home/stonelyd/anvil/.claude/worktrees/goal-stop-hook/anvild
ANVIL_HOST=127.0.0.1 ANVIL_PORT=7702 bun run dev
```

Open `http://localhost:7702`. (Bind host matters: the daemon defaults to the tailnet IP, which the
Windows browser cannot reach — `config.ts:104`.)

**Step 2: Hand the checklist to the user.** They run it in the browser; the agent records results.

| # | Action | Expected |
|---|---|---|
| 1 | Start a session in a scratch dir. Send `/goal the file ./DONE.txt exists` | Divider "Goal set". Chip appears: `◎ the file ./DONE.txt exists · 0/10`. **No turn consumed** (no assistant reply). |
| 2 | Send `hello` | Session works; on its stop attempt the goal blocks it. Chip climbs to `1/10`. Assistant visibly keeps going rather than idling. |
| 3 | Watch for ~3 iterations | Chip increments each time. **No push per iteration.** |
| 4 | Create the file: `touch DONE.txt` in the session's cwd, then send `check again` | Judge reports met → divider "Goal met", chip disappears, **exactly one push** arrives. |
| 5 | Send `/goal` | Divider "No goal set · Usage: /goal <condition>". |
| 6 | Send `/goal something impossible`, then `/goal clear` | Chip appears then disappears; divider "Goal cleared". No push. |
| 7 | Send `/goal x`, restart the daemon, reload the UI | Chip shows `paused`; session is idle and consumes nothing. |
| 8 | Send any message | Chip un-pauses and resets to `0/10`. |
| 9 | With a goal active, trigger a permission prompt (e.g. ask it to write outside cwd) | Permission push **still arrives** (D3 — only the result branch is suppressed). |

**Step 3: Record the outcome.** Add a "Verified" line under the status table with the date and any
deviations. If any row fails, fix it and re-run the affected rows before Task 13.

**Step 4: Commit** (only if fixes were needed)
`git commit -am "fix(goal): address E2E findings"`

---

### Task 13: Full gate + PR

**Step 1: Run the complete CI gate** (all four, as `.github/workflows/ci.yml` does)

```bash
cd /home/stonelyd/anvil/.claude/worktrees/goal-stop-hook/anvild
bun run typecheck && bun run typecheck:web && bun run build:web && bun test
```

Expected: all four exit 0.

**Step 2: Update both docs.** Flip every row in this plan's status table to `done`/`yes`, and flip
the design doc's §9 phase table to match.

**Step 3: Commit + push.** Remember `remote.pushDefault` is `fork`, and the PR goes **fork →
upstream** (`gte619n/anvil`); the user only has READ on upstream.

```bash
git add -A && git commit -m "docs: mark /goal plan + design phases complete"
git push -u fork worktree-goal-stop-hook
```

**Step 4: Open the PR**

```bash
gh pr create --repo gte619n/anvil --base main --head stonelyd:worktree-goal-stop-hook \
  --title "feat: Anvil-native /goal (Stop hook)" --body "$(cat <<'EOF'
Implements `/goal <condition>` natively so the goal's state belongs to Anvil and reaches every device.

Claude Code's `/goal` is a session Stop hook, but its state never crosses the SDK wire (0 `goal`
hits in `sdk.d.ts`) and slash commands other than `/clear` + `/compact` do not execute on Anvil's
input path — prompts are wrapped as plain `SDKUserMessage`s, which the CLI's slash-command layer
never sees. So this registers Anvil's own Stop hook and owns the state.

- `/goal <condition>` · `/goal clear` · `/goal` (status) — parsed beside the `/compact` intercept
- Haiku judge over recent turns (evidence, not the last claim)
- Ceiling of 10 → auto-clear + one push; judge failure fails open
- Persists across restart as paused; re-arms on the next prompt
- Exactly one push per goal (only the `result` branch is suppressed — permission pushes still fire)
- Display-only composer chip

Design: `docs/plans/2026-07-25-goal-stop-hook-design.md` (all sections approved).
Verified end-to-end against a live daemon — see the plan's Task 12 checklist.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Step 5: Do NOT merge from the worktree.** When it's time, use `anvild/scripts/merge-session.sh
--squash` (`gh pr merge --delete-branch` strands the worktree — see `CLAUDE.md`). Note that script
hardcodes `git push origin --delete`, which silently no-ops on a fork PR; delete the branch on
`fork` by hand.

---

## Out of scope

Per design §8 — each is real, verified on 2026-07-25, and separable: filtering the ~40 unbacked
built-ins from the `/` menu; `!command` conditions; configurable ceiling; teams goal propagation and
`background_tasks` awareness; `SendMessage` fidelity (`origin`/`priority`/`shouldQuery`); Monitor
task-event mapping and its push `tag` collision; native app re-ship.
