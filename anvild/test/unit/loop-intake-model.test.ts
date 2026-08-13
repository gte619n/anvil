/**
 * Real-model intake (loops-circuit follow-up FU-1). Proves the JSON parse/validation is strict and the
 * SDK call is driven by an injectable `queryFn` (no subprocess / model spend): a scripted reply flows
 * through `modelIntake`, and every malformed reply throws so the LoopService caller falls back to the
 * heuristic.
 */
import { test, expect } from "bun:test";
import { modelIntake, parseOverlay, type IntakeQueryLike } from "../../src/loops/intake-model";

const ctx = { prompt: "Add CSV export to reports", isFeature: true, testScript: "bun test" };

/** A scripted SDK `query`: yields one assistant text block then a result. */
function scripted(reply: string): IntakeQueryLike {
  return () =>
    (async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: reply }] } };
      yield { type: "result" };
    })();
}

test("parseOverlay accepts a well-formed object and caps the rung at pr", () => {
  const o = parseOverlay(
    `{"name":"CSV export","checkCommand":"bun test export","checkLocks":["test/export.test.ts"],"scopeAllow":["src/reports/"],"assumptions":["comma delimiter"],"rung":"ship"}`,
    ctx,
  );
  expect(o.name).toBe("CSV export");
  expect(o.checkCommand).toBe("bun test export");
  expect(o.checkLocks).toEqual(["test/export.test.ts"]);
  expect(o.scopeAllow).toEqual(["src/reports/"]);
  expect(o.assumptions).toEqual(["comma delimiter"]);
  expect(o.rung).toBeUndefined(); // "ship" is refused — a new loop can't be trusted into auto-merge
});

test("parseOverlay pulls JSON out of surrounding prose/fences", () => {
  const o = parseOverlay("Sure! Here you go:\n```json\n{\"checkCommand\":\"bun test\"}\n```\nHope that helps", ctx);
  expect(o.checkCommand).toBe("bun test");
});

test("parseOverlay throws on no JSON, on invalid JSON, and on an all-empty object", () => {
  expect(() => parseOverlay("no json here", ctx)).toThrow();
  expect(() => parseOverlay("{not valid json}", ctx)).toThrow();
  expect(() => parseOverlay("{}", ctx)).toThrow(/no usable fields/);
  // An object with only junk/blank fields is also unusable.
  expect(() => parseOverlay(`{"name":"   ","checkLocks":[]}`, ctx)).toThrow();
});

test("modelIntake drives the injected query and returns the parsed overlay", async () => {
  const overlay = await modelIntake(ctx, {}, scripted(`{"checkCommand":"bun test export","rung":"draft"}`));
  expect(overlay.checkCommand).toBe("bun test export");
  expect(overlay.rung).toBe("draft");
});

test("modelIntake throws on a garbage reply (caller falls back to the heuristic)", async () => {
  await expect(modelIntake(ctx, {}, scripted("I couldn't do that"))).rejects.toThrow();
});
