import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelLabelStore } from "../../src/models/store";

describe("ModelLabelStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anvil-models-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const CATALOG = { opus: { modelId: "claude-opus-5", label: "Opus 5", releasedAt: "2026-07-24T00:00:00Z" } };

  test("derives back-compat labels from the stored catalog", () => {
    const s = new ModelLabelStore(dir);
    s.set(CATALOG, "2026-11-09T00:00:00Z");
    expect(s.get()).toEqual({ opus: "Opus 5" });
    expect(s.catalog().opus?.modelId).toBe("claude-opus-5");
    expect(s.checkedAt()).toBe("2026-11-09T00:00:00Z");
  });

  test("set() reports changed only when the catalog actually differs, but always advances checkedAt", () => {
    const s = new ModelLabelStore(dir);
    expect(s.set(CATALOG, "t1")).toBe(true); // first write is a change
    expect(s.set(CATALOG, "t2")).toBe(false); // same catalog → no change…
    expect(s.checkedAt()).toBe("t2"); // …but the timestamp still moved
  });

  test("set(undefined) bumps only the timestamp (a tokenless / failed check)", () => {
    const s = new ModelLabelStore(dir);
    s.set(CATALOG, "t1");
    expect(s.set(undefined, "t2")).toBe(false);
    expect(s.catalog().opus?.modelId).toBe("claude-opus-5"); // catalog preserved
    expect(s.checkedAt()).toBe("t2");
  });

  test("persists across instances and ignores a legacy flat-label file", () => {
    new ModelLabelStore(dir).set(CATALOG, "t1");
    expect(new ModelLabelStore(dir).catalog().opus?.label).toBe("Opus 5");

    // A pre-catalog file is just `{opus:"Opus 5"}` — ignored, so labels fall back until the next refresh.
    writeFileSync(join(dir, "model-labels.json"), JSON.stringify({ opus: "Opus 5" }));
    const legacy = new ModelLabelStore(dir);
    expect(legacy.catalog()).toEqual({});
    expect(legacy.checkedAt()).toBe("");
  });
});
