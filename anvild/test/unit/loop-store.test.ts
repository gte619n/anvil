import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopStore } from "../../src/loops/store";
import type { Loop, LoopRun } from "../../protocol";

const tmp = (): string => mkdtempSync(join(tmpdir(), "anvil-loopstore-"));
const loop = (id: string): Loop => ({
  id,
  name: id,
  status: "armed",
  trigger: { kind: "manual" },
  act: { kind: "session-prompt", prompt: "x" },
  checks: [],
  checksMode: "all",
  rung: "pr",
  hardStops: { maxLaps: 10, tokenBudget: 300_000, noProgressLaps: 2 },
  assumptions: [],
  notify: { onGate: true, onFailure: true, onSuccess: false, dailyDigest: false },
  cleanGatedLaps: 0,
  configRevision: 1,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
});
const run = (id: string, loopId: string, at: string, status: LoopRun["status"] = "running"): LoopRun => ({
  id,
  loopId,
  configRevision: 1,
  trigger: { kind: "manual", at },
  status,
  laps: [],
  startedAt: at,
});

test("catalog round-trips loops across reloads; remove drops them + their runs", () => {
  const dir = tmp();
  try {
    const s = new LoopStore(dir);
    s.save(loop("loop_a"));
    s.save(loop("loop_b"));
    s.putRun(run("run_1", "loop_a", "2026-08-11T01:00:00.000Z"));
    expect(s.list().map((l) => l.id).sort()).toEqual(["loop_a", "loop_b"]);
    const reloaded = new LoopStore(dir);
    expect(reloaded.get("loop_a")?.name).toBe("loop_a");
    expect(reloaded.runs("loop_a").length).toBe(1);
    expect(reloaded.remove("loop_a")).toBe(true);
    expect(reloaded.get("loop_a")).toBeUndefined();
    expect(reloaded.runs("loop_a").length).toBe(0); // run file gone
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runs fold by id (last write wins), newest first", () => {
  const dir = tmp();
  try {
    const s = new LoopStore(dir);
    s.putRun(run("r1", "loop_a", "2026-08-11T01:00:00.000Z", "running"));
    s.putRun({ ...run("r1", "loop_a", "2026-08-11T01:00:00.000Z"), status: "at-gate" }); // update r1
    s.putRun(run("r2", "loop_a", "2026-08-11T02:00:00.000Z", "shipped"));
    const runs = s.runs("loop_a");
    expect(runs.length).toBe(2); // r1 deduped
    expect(runs[0]!.id).toBe("r2"); // newest first
    expect(runs.find((r) => r.id === "r1")!.status).toBe("at-gate"); // last write won
    expect(s.latestRun("loop_a")?.id).toBe("r2");
    expect(s.runById("loop_a", "r1")?.status).toBe("at-gate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt catalog is quarantined and the store starts empty (never wiped silently)", () => {
  const dir = tmp();
  try {
    new LoopStore(dir); // create the dir structure
    writeFileSync(join(dir, "loops", "loops.json"), "{ not json");
    const s = new LoopStore(dir);
    expect(s.list()).toEqual([]);
    const quarantined = readdirSync(join(dir, "loops")).filter((f) => f.startsWith("loops.json.corrupt-"));
    expect(quarantined.length).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt run line is skipped, the rest survive (never wipes the history)", () => {
  const dir = tmp();
  try {
    const s = new LoopStore(dir);
    s.putRun(run("r1", "loop_a", "2026-08-11T01:00:00.000Z"));
    // Append a garbage line directly.
    writeFileSync(join(dir, "loops", "runs", "loop_a.jsonl"), JSON.stringify(run("r1", "loop_a", "2026-08-11T01:00:00.000Z")) + "\n{bad line}\n" + JSON.stringify(run("r2", "loop_a", "2026-08-11T02:00:00.000Z")) + "\n");
    const runs = s.runs("loop_a");
    expect(runs.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runs compaction bounds the history and drops the oldest (retention ~200, logged)", () => {
  const dir = tmp();
  try {
    const s = new LoopStore(dir);
    for (let i = 0; i < 450; i++) s.putRun(run(`r${i}`, "loop_a", new Date(Date.parse("2026-08-11T00:00:00.000Z") + i * 1000).toISOString()));
    const runs = s.runs("loop_a");
    // Lazy compaction (fires at the 400-line threshold, keeping the newest 200) → bounded, newest kept,
    // oldest dropped — never unbounded growth, never wiped.
    expect(runs.length).toBeGreaterThanOrEqual(200);
    expect(runs.length).toBeLessThanOrEqual(400);
    expect(runs[0]!.id).toBe("r449"); // newest first
    expect(runs.some((r) => r.id === "r0")).toBe(false); // oldest dropped by compaction
    expect(existsSync(join(dir, "loops", "runs", "loop_a.jsonl"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("byWorkUnit finds a loop converted from a unit", () => {
  const dir = tmp();
  try {
    const s = new LoopStore(dir);
    s.save({ ...loop("loop_a"), workUnitId: "wu7" });
    expect(s.byWorkUnit("wu7")?.id).toBe("loop_a");
    expect(s.byWorkUnit("nope")).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
