/**
 * Throwaway: confirm the OAuth token authenticates and observe the live SDK stream shape.
 *   set -a; . ~/.config/anvil/env; set +a; unset ANTHROPIC_API_KEY
 *   bun run test/tools/sdk-smoke.ts
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: "Reply with exactly the word PONG and nothing else.",
  options: {
    model: "sonnet", // conserve the Opus pool for the smoke
    includePartialMessages: true,
    executable: "bun",
    cwd: process.cwd(),
    maxTurns: 1,
  },
});

let deltas = 0;
for await (const raw of q) {
  const m = raw as any;
  switch (m.type) {
    case "stream_event":
      deltas++;
      break;
    case "system":
      console.log(`[system:${m.subtype ?? "?"}] session_id=${m.session_id ?? "?"} model=${m.model ?? "?"}`);
      break;
    case "assistant": {
      const text = (m.message?.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      console.log("[assistant]", JSON.stringify(text));
      break;
    }
    case "result":
      console.log("[result]", {
        subtype: m.subtype,
        stop_reason: m.stop_reason,
        num_turns: m.num_turns,
        total_cost_usd: m.total_cost_usd,
        result: typeof m.result === "string" ? m.result.slice(0, 80) : undefined,
      });
      break;
    default:
      console.log(`[${m.type}]`, m.subtype ?? "");
  }
}
console.log("stream_event deltas:", deltas);
