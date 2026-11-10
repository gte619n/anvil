import { describe, expect, test } from "bun:test";
import type { Model, ModelTierInfo } from "@protocol";
import { modelFamilyPrefix, sdkModelId } from "../../src/agent/models";

describe("sdkModelId", () => {
  test("passes the short alias through for the auto-upgrading tiers", () => {
    expect(sdkModelId("opus")).toBe("opus");
    expect(sdkModelId("sonnet")).toBe("sonnet");
    expect(sdkModelId("haiku")).toBe("haiku");
  });

  test("falls back to the pinned fable id when no catalog is available (fresh boot / offline)", () => {
    expect(sdkModelId("fable")).toBe("claude-fable-5");
  });

  test("runs the catalog-resolved fable id so a new release is actually used, not just displayed", () => {
    const catalog: Partial<Record<Model, ModelTierInfo>> = {
      fable: { modelId: "claude-fable-5-2", label: "Fable 5.2", releasedAt: "2026-11-09T18:30:00Z" },
    };
    expect(sdkModelId("fable", catalog)).toBe("claude-fable-5-2");
  });

  test("ignores the catalog for alias tiers — they must stay aliases so the SDK auto-upgrades them", () => {
    const catalog: Partial<Record<Model, ModelTierInfo>> = {
      opus: { modelId: "claude-opus-5-5", label: "Opus 5.5" },
    };
    expect(sdkModelId("opus", catalog)).toBe("opus");
  });
});

describe("modelFamilyPrefix", () => {
  test("gives each tier the id-family the catalog resolves its newest member from", () => {
    expect(modelFamilyPrefix("opus")).toBe("claude-opus-");
    expect(modelFamilyPrefix("sonnet")).toBe("claude-sonnet-");
    expect(modelFamilyPrefix("haiku")).toBe("claude-haiku-");
    expect(modelFamilyPrefix("fable")).toBe("claude-fable-");
  });
});
