/**
 * ACCURATE end-to-end probe for the AskUserQuestion ("interview") path.
 *
 * Reproduces anvild's exact query() wiring — PreToolUse hook that lets AskUserQuestion
 * fall through with bare {continue:true}, plus a canUseTool — and LOGS every hook call and
 * every canUseTool call, so we can see, against the REAL SDK + REAL OAuth session, whether:
 *   (a) the PreToolUse hook fires for AskUserQuestion,
 *   (b) canUseTool is actually invoked for AskUserQuestion,
 *   (c) returning answers via updatedInput makes the model receive them.
 *
 * Run:
 *   set -a; . ~/.config/anvil/env; set +a; unset ANTHROPIC_API_KEY
 *   bun run test/tools/probe-askquestion.ts
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

const log = (tag: string, o?: unknown) =>
  console.log(`\x1b[36m[${tag}]\x1b[0m`, o === undefined ? "" : JSON.stringify(o));

let canUseToolCalls = 0;
let hookAskCalls = 0;

const q = query({
  prompt:
    "Use the AskUserQuestion tool to ask me ONE question: what is my favorite color, " +
    "offering the options Red, Green, and Blue. Then tell me exactly which color I picked.",
  options: {
    model: "sonnet",
    includePartialMessages: true,
    executable: "bun",
    cwd: process.cwd(),
    permissionMode: "default",
    settingSources: [],
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input: any) => {
              const tool = input?.tool_name;
              log("HOOK PreToolUse", { tool });
              if (tool === "AskUserQuestion") {
                hookAskCalls++;
                log("HOOK → bare continue (let ask reach canUseTool)");
                return { continue: true };
              }
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "allow",
                  permissionDecisionReason: "probe auto-allow",
                },
              };
            },
          ],
          timeout: 120,
        },
      ],
    },
    canUseTool: async (toolName: string, input: any) => {
      canUseToolCalls++;
      log("canUseTool CALLED", { toolName, inputKeys: Object.keys(input ?? {}) });
      if (toolName !== "AskUserQuestion") return { behavior: "allow", updatedInput: input };

      // Find each question text and answer "Blue".
      const questions = Array.isArray(input?.questions) ? input.questions : [];
      log("canUseTool AskUserQuestion questions", questions);
      const answers: Record<string, string> = {};
      for (const qq of questions) if (typeof qq?.question === "string") answers[qq.question] = "Blue";
      const updatedInput = { ...input, answers };
      log("canUseTool → allow with answers", { answers });
      return { behavior: "allow", updatedInput };
    },
  },
});

setTimeout(() => {
  console.error("\x1b[31mTIMEOUT after 120s\x1b[0m");
  process.exit(1);
}, 120000);

for await (const raw of q) {
  const m = raw as any;
  switch (m.type) {
    case "system":
      log("system", { subtype: m.subtype, session_id: m.session_id, model: m.model });
      break;
    case "assistant": {
      for (const b of m.message?.content ?? []) {
        if (b.type === "text") log("assistant text", b.text);
        else if (b.type === "tool_use") log("assistant tool_use", { name: b.name, input: b.input });
      }
      break;
    }
    case "user": {
      // tool_result echoes — this is where "did not answer" vs "answered: Blue" shows up.
      for (const b of m.message?.content ?? []) {
        if (b.type === "tool_result") log("tool_result", { content: b.content, is_error: b.is_error });
      }
      break;
    }
    case "result":
      log("result", { subtype: m.subtype, stop_reason: m.stop_reason, num_turns: m.num_turns });
      log("SUMMARY", { canUseToolCalls, hookAskCalls });
      console.log(
        canUseToolCalls > 0
          ? "\x1b[32m✓ canUseTool WAS invoked\x1b[0m"
          : "\x1b[31m✗ canUseTool was NEVER invoked — the fix theory is wrong\x1b[0m",
      );
      process.exit(0);
  }
}
