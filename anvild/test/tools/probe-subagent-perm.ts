/**
 * ACCURATE end-to-end probe for the SUB-AGENT (Task) permission path.
 *
 * The open question (branch `tool-call-issue`): when the model spawns a sub-agent via the
 * Task tool, do the tool calls made *inside* that sub-agent re-enter the PARENT query's
 * PreToolUse hook — the daemon's one authoritative permission gate (anvild/src/agent/
 * permissions.ts) — or do they run in the SDK's own permission context, where (with
 * settingSources:[] + permissionMode:"default" and no surfacing path) they silently
 * default-deny? The latter would explain the live symptom: "needed permission, no
 * notification, assumed denied" — the same CLASS of bug as the AskUserQuestion/interview
 * issue (an interaction the daemon never surfaces, falling to a default).
 *
 * Method: reproduce anvild's exact query() wiring. The PreToolUse hook LOGS every call and
 * tags whether it ever sees the sub-agent's inner Bash. That inner command carries a unique
 * marker (ANVIL_SUBAGENT_PROBE) and the hook DENIES it — so we observe three outcomes:
 *
 *   1. innerBashHookFired = true
 *      → the parent hook DOES gate sub-agent tools. Routing is fine; the live bug is
 *        notification delivery / the single pendingPermission slot under fan-out, NOT this.
 *   2. innerBashHookFired = false  AND  the sub-agent reports it could not run / was denied
 *      → the parent hook does NOT see sub-agent tools; the SDK default-denied silently.
 *        CONFIRMS the "same class as the questions bug" theory.
 *   3. innerBashHookFired = false  AND  the sub-agent ran the command anyway
 *      → the SDK auto-allows sub-agent tools; gating is bypassed entirely (a different,
 *        arguably worse, problem — the danger list never runs inside sub-agents).
 *
 * Run (same as the other probes — real SDK, real OAuth, no API key):
 *   set -a; . ~/.config/anvil/env; set +a; unset ANTHROPIC_API_KEY
 *   bun run test/tools/probe-subagent-perm.ts
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

const log = (tag: string, o?: unknown) =>
  console.log(`\x1b[36m[${tag}]\x1b[0m`, o === undefined ? "" : JSON.stringify(o));

const MARKER = "ANVIL_SUBAGENT_PROBE";

let hookCalls = 0;
let innerBashHookFired = false; // did the parent hook ever see the sub-agent's marked Bash?
const toolsSeenByHook: string[] = [];
let subagentRanMarker = false; // did the marker command's output actually appear (i.e. it ran)?
let sawDenyText = false; // did any tool_result mention the denial?

const q = query({
  prompt:
    `Use the Task tool to launch ONE sub-agent (subagent_type "general-purpose"). Instruct that ` +
    `sub-agent to run exactly this shell command with the Bash tool and report its full output back: ` +
    `\`echo ${MARKER}_OUTPUT\`. Do NOT run any Bash command yourself at the top level — only the ` +
    `sub-agent should run it. After the sub-agent returns, tell me verbatim what it reported.`,
  options: {
    // Mirror the daemon (driver.ts): no on-disk settings, default permission mode, the hook
    // is the authority. Sonnet is enough and cheaper for a routing probe.
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
              hookCalls++;
              const tool = input?.tool_name;
              const cmd = typeof input?.tool_input?.command === "string" ? input.tool_input.command : "";
              toolsSeenByHook.push(tool);
              log("HOOK PreToolUse", { tool, cmd: cmd || undefined });

              // The decisive signal: the parent hook is being consulted for the sub-agent's
              // marked Bash. If this never logs, inner tools bypass our gate entirely.
              if (tool === "Bash" && cmd.includes(MARKER)) {
                innerBashHookFired = true;
                log("HOOK → DENY the marked sub-agent command (simulating an un-granted prompt)");
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: "probe: denying the sub-agent's marked command",
                  },
                };
              }
              // Everything else (Task itself, any reads) auto-allowed so the run reaches the
              // interesting point quickly.
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
  },
});

const TIMEOUT_MS = 180000;
const timer = setTimeout(() => {
  console.error("\x1b[31mTIMEOUT\x1b[0m");
  summarize();
  process.exit(1);
}, TIMEOUT_MS);

function summarize(): void {
  log("SUMMARY", { hookCalls, toolsSeenByHook, innerBashHookFired, subagentRanMarker, sawDenyText });
  console.log("\x1b[1m── Verdict ──\x1b[0m");
  if (innerBashHookFired) {
    console.log(
      "\x1b[32m✓ The parent PreToolUse hook DID fire for the sub-agent's inner Bash.\x1b[0m\n" +
        "  → Sub-agent tools ARE gated by the daemon. The live 'no notification / assumed denied'\n" +
        "    symptom is NOT a routing gap — look at notification delivery and the single\n" +
        "    pendingPermission slot / shared push tag under sub-agent fan-out (supervisor.ts).",
    );
  } else if (subagentRanMarker) {
    console.log(
      "\x1b[31m✗ The hook NEVER saw the inner Bash, and the sub-agent RAN it anyway.\x1b[0m\n" +
        "  → Sub-agent tool calls bypass the daemon's gate entirely (the danger list never runs\n" +
        "    inside sub-agents). Different from the questions bug, and more dangerous.",
    );
  } else {
    console.log(
      "\x1b[33m✗ The hook NEVER saw the inner Bash, and the sub-agent did NOT run it.\x1b[0m\n" +
        "  → The SDK resolved the sub-agent's permission WITHOUT consulting our hook and\n" +
        "    defaulted to deny — never surfaced, never notified. CONFIRMS the 'same class as\n" +
        "    the AskUserQuestion bug' theory: an interaction the daemon can't see, silently\n" +
        "    falling to a default.",
    );
  }
}

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
      for (const b of m.message?.content ?? []) {
        if (b.type === "tool_result") {
          const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          if (content.includes(`${MARKER}_OUTPUT`)) subagentRanMarker = true;
          if (/deny|denied|not allowed|permission/i.test(content)) sawDenyText = true;
          log("tool_result", { is_error: b.is_error, content: content.slice(0, 400) });
        }
      }
      break;
    }
    case "result":
      log("result", { subtype: m.subtype, stop_reason: m.stop_reason, num_turns: m.num_turns });
      clearTimeout(timer);
      summarize();
      process.exit(0);
  }
}
