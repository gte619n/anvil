/**
 * Tolerant JSON extraction for model output. Models routinely wrap the JSON they were asked to emit
 * in prose or ```json fences; this pulls the first balanced object/array out regardless. Shared by
 * the autopilot planner (bundling) and the adversarial panel (critique parsing).
 */

/** Pull the first JSON value (object or array) out of a model response that may wrap it in prose/fences. */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error(`no JSON found in model output: ${text.slice(0, 200)}`);
  // Walk to the matching close bracket so trailing prose doesn't break JSON.parse. [BE-12] The walk
  // is string/escape-aware: brackets inside a JSON string literal (e.g. a `reason` mentioning "{")
  // must not change depth, or a legal reply mis-balances and is thrown away as unrecoverable.
  const open = candidate[start]!;
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      return JSON.parse(candidate.slice(start, i + 1)) as T;
    }
  }
  throw new Error(`unbalanced JSON in model output: ${text.slice(0, 200)}`);
}
