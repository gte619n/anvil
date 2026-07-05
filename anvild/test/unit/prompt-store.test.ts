import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptStore } from "../../src/prompts/store";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "anvil-prompts-"));
}

test("save creates, mints an id, and persists across reloads", () => {
  const dir = tmp();
  try {
    const s = new PromptStore(dir);
    const p = s.save({ title: "Write tests", shortTitle: "Tests", icon: "science", body: "Add unit tests." });
    expect(p.id).toMatch(/^prompt_/);
    expect(p.updatedAt).toBeGreaterThan(0);
    expect(s.list()).toHaveLength(1);
    // reload from disk
    expect(new PromptStore(dir).list()[0]!.title).toBe("Write tests");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("save with an existing id updates in place (no duplicate)", () => {
  const dir = tmp();
  try {
    const s = new PromptStore(dir);
    const p = s.save({ title: "A", shortTitle: "A", icon: "bookmark", body: "one" });
    s.save({ id: p.id, title: "A2", shortTitle: "A2", icon: "star", body: "two" });
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0]!.title).toBe("A2");
    expect(s.list()[0]!.body).toBe("two");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list sorts by short title, case-insensitive", () => {
  const dir = tmp();
  try {
    const s = new PromptStore(dir);
    s.save({ title: "z", shortTitle: "zebra", icon: "", body: "b" });
    s.save({ title: "a", shortTitle: "Apple", icon: "", body: "b" });
    s.save({ title: "m", shortTitle: "mango", icon: "", body: "b" });
    expect(s.list().map((p) => p.shortTitle)).toEqual(["Apple", "mango", "zebra"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each field falls back to the other, and icon defaults to bookmark", () => {
  const dir = tmp();
  try {
    const s = new PromptStore(dir);
    const onlyTitle = s.save({ title: "Full title", shortTitle: "", icon: "", body: "b" });
    expect(onlyTitle.shortTitle).toBe("Full title");
    expect(onlyTitle.icon).toBe("bookmark");
    const onlyShort = s.save({ title: "", shortTitle: "Short", icon: "code", body: "b" });
    expect(onlyShort.title).toBe("Short");
    expect(onlyShort.icon).toBe("code");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("save rejects an empty body or a title-less prompt", () => {
  const dir = tmp();
  try {
    const s = new PromptStore(dir);
    expect(() => s.save({ title: "x", shortTitle: "x", icon: "", body: "   " })).toThrow(/text/);
    expect(() => s.save({ title: "", shortTitle: "", icon: "", body: "hi" })).toThrow(/title/);
    expect(s.list()).toHaveLength(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remove deletes by id and persists", () => {
  const dir = tmp();
  try {
    const s = new PromptStore(dir);
    const a = s.save({ title: "A", shortTitle: "A", icon: "", body: "b" });
    const b = s.save({ title: "B", shortTitle: "B", icon: "", body: "b" });
    s.remove(a.id);
    expect(s.list().map((p) => p.id)).toEqual([b.id]);
    expect(new PromptStore(dir).list().map((p) => p.id)).toEqual([b.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt prompts.json starts empty instead of throwing", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "prompts.json"), "{ not valid json");
    expect(new PromptStore(dir).list()).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
