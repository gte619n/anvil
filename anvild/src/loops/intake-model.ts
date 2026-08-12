/**
 * Real-model loop intake (loops-circuit follow-up FU-1). A one-shot Sonnet call that reads the outcome
 * the user typed and proposes the loop's check / scope / assumptions — the seed the web intake
 * conversation drives off. Mirrors `judgeGoal`'s SDK shape (no tools, one turn, hard timeout) so it
 * never wedges the daemon, and THROWS on timeout / transport failure / an unparseable reply — every one
 * of those is caught at the call site (LoopService.intakeSuggest), which falls back to the deterministic
 * heuristic. So intake is always available; the model just makes it sharper when it's reachable.
 *
 * The daemon is the permission authority: this runs with no tools and no settingSources, exactly like
 * the goal judge, so it can't touch the repo — it only reads the prompt text we pass it.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeCliOptions } from "../agent/cli";
import type { LoopRung } from "@protocol";

/** What the model may sharpen on top of the heuristic base. Every field is optional + validated; a
 *  missing/invalid field just leaves the heuristic's value in place. */
export interface IntakeOverlay {
  name?: string;
  checkCommand?: string;
  checkLocks?: string[];
  scopeAllow?: string[];
  assumptions?: string[];
  rung?: LoopRung;
}

export interface IntakeModelContext {
  prompt: string;
  isFeature: boolean;
  testScript?: string; // the repo's configured test command, if known
}

/** The minimal SDK `query` shape — injectable so tests can script the reply without a subprocess. */
export type IntakeQueryLike = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<unknown>;

const RUNGS: LoopRung[] = ["suggest", "draft", "pr", "ship"];

/**
 * Ask the model for an intake overlay. Resolves with the validated overlay, or throws on any failure
 * (the caller falls back to the heuristic). 25s hard timeout, Sonnet, no tools.
 */
export async function modelIntake(
  ctx: IntakeModelContext,
  env: Record<string, string>,
  queryFn?: IntakeQueryLike,
): Promise<IntakeOverlay> {
  const prompt = buildPrompt(ctx);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25_000);
  try {
    const run = queryFn ?? (query as unknown as IntakeQueryLike);
    const q = run({
      prompt,
      options: {
        model: "sonnet",
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
      const msg = m as { type: string; message?: { content?: Array<{ type: string; text?: string }> } };
      if (msg.type === "assistant") {
        for (const b of msg.message?.content ?? []) if (b.type === "text" && b.text) text += b.text;
      }
      if (msg.type === "result") break;
    }
    return parseOverlay(text, ctx);
  } finally {
    clearTimeout(timer);
  }
}

function buildPrompt(ctx: IntakeModelContext): string {
  return (
    `You are helping set up an autonomous coding "loop". The user stated this outcome:\n\n` +
    `"""${ctx.prompt.slice(0, 1000)}"""\n\n` +
    `This is a ${ctx.isFeature ? "FEATURE (build something new)" : "FIX (repair something broken)"}.\n` +
    (ctx.testScript ? `The repo's test command is: ${ctx.testScript}\n` : "") +
    `\nPropose how the loop should PROVE it's done. Reply with ONE JSON object, nothing else:\n` +
    `{\n` +
    `  "name": "<≤60-char loop name>",\n` +
    `  "checkCommand": "<a shell command that exits 0 iff the outcome is met; prefer the repo test command narrowed to the relevant area>",\n` +
    `  "checkLocks": ["<repo-relative file the check reads and the lap must NOT edit>", ...],\n` +
    `  "scopeAllow": ["<repo-relative glob the lap may touch>", ...],\n` +
    `  "assumptions": ["<a decision you had to make because the outcome is still ambiguous>", ...],\n` +
    `  "rung": "suggest" | "draft" | "pr"\n` +
    `}\n\n` +
    `Rules: If a check is a METRIC (a number vs a threshold), its command must print ONLY the number ` +
    `(append " | tail -1" if needed). Keep scope tight. New loops start gated — never propose "ship". ` +
    `Output ONLY the JSON object.`
  );
}

/** Parse + validate the model's JSON reply into an overlay. Throws on anything unusable. */
export function parseOverlay(text: string, ctx: IntakeModelContext): IntakeOverlay {
  const json = extractJson(text);
  if (!json) throw new Error(`intake reply had no JSON object: ${text.slice(0, 120)}`);
  const raw = JSON.parse(json) as Record<string, unknown>;
  const overlay: IntakeOverlay = {};
  if (typeof raw.name === "string" && raw.name.trim()) overlay.name = raw.name.trim().slice(0, 60);
  if (typeof raw.checkCommand === "string" && raw.checkCommand.trim()) overlay.checkCommand = raw.checkCommand.trim();
  const locks = strArray(raw.checkLocks);
  if (locks) overlay.checkLocks = locks;
  const scope = strArray(raw.scopeAllow);
  if (scope) overlay.scopeAllow = scope;
  const assumptions = strArray(raw.assumptions);
  if (assumptions) overlay.assumptions = assumptions;
  // Never trust a model into a higher rung than a new loop earns — cap at "pr".
  if (typeof raw.rung === "string" && RUNGS.includes(raw.rung as LoopRung) && raw.rung !== "ship") overlay.rung = raw.rung as LoopRung;
  // A totally empty overlay is a failed parse — fall back rather than silently no-op.
  if (Object.keys(overlay).length === 0) throw new Error(`intake reply had no usable fields (isFeature=${ctx.isFeature})`);
  return overlay;
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim());
  return out.length ? out : undefined;
}

/** Pull the first balanced `{ … }` object out of the reply (models often wrap JSON in prose/fences). */
function extractJson(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}
