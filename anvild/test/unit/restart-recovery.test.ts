import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { Supervisor, SEQ_CRASH_GAP } from "../../src/session/supervisor";
import { ConnectionRegistry } from "../../src/server/registry";

const tempState = () => mkdtempSync(join(tmpdir(), "anvil-recover-"));
const createExisting = (sup: Supervisor, cwd: string) =>
  sup.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd });

// ── Hard gate: daemon restart → recovery (spec §7.4 gate 2) ────────────────────────────────────────
// After a restart the client reconnects and delta-resumes from its cached lastSeq. This proves the
// server side of that: the epoch is stable (so the client stays in delta mode), the persisted log
// survives, and a delta resume returns ONLY the missed events, always ending with a live status — so a
// client whose spinner was "optimistically" left running self-heals the moment it re-attaches (D6).
test("after a restart, a client delta-resumes the missed tail and status re-asserts", async () => {
  const dir = tempState();
  const sup1 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = await createExisting(sup1, dir);

  // The client has seen up to here (its cached watermark).
  const clientLastSeq = sup1.get(s.id)!.lastSeq;
  const epochBefore = s.epoch;

  // While the client is disconnected, the session emits more events (e.g. a turn finishing).
  sup1.get(s.id)!.emit({ type: "assistant.message", blocks: [{ kind: "markdown", rendered: { source: "done", html: "done" } }] });
  sup1.get(s.id)!.setStatus("idle");
  const serverLastSeq = sup1.get(s.id)!.lastSeq;
  expect(serverLastSeq).toBeGreaterThan(clientLastSeq);

  // ── restart ──
  const sup2 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const restored = sup2.get(s.id)!;
  expect(restored).toBeDefined();
  expect(restored.epoch).toBe(epochBefore); // stable lineage → client stays in delta mode

  // The watermark the reconnecting client verifies against reflects the advanced seq.
  const wm = sup2.resumeWatermarksEvent().watermarks.find((w) => w.sessionId === s.id)!;
  expect(wm.epoch).toBe(epochBefore);
  expect(wm.lastSeq).toBe(restored.lastSeq);

  // A delta resume from the client's cached seq returns ONLY newer events, and ALWAYS ends with a
  // status (so an "optimistically" stuck spinner is corrected on re-attach — the D6 safety property).
  const delta = sup2.resume(s.id, clientLastSeq);
  expect(delta.length).toBeGreaterThan(0);
  expect(delta.every((e) => (e as { seq?: number }).seq === undefined || (e as { seq: number }).seq > clientLastSeq || e.type === "status")).toBe(true);
  expect(delta[delta.length - 1]!.type).toBe("status"); // resume always re-asserts live status
  // It must NOT be a full snapshot (that's the cross-reload win we're protecting).
  expect(delta.some((e) => e.type === "conversation.snapshot")).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

// A cold client (no cached seq) still gets a full snapshot after restart — the safe fallback.
test("after a restart, a cold client (no lastSeq) gets a full snapshot", async () => {
  const dir = tempState();
  const sup1 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = await createExisting(sup1, dir);
  sup1.get(s.id)!.emit({ type: "assistant.message", blocks: [{ kind: "markdown", rendered: { source: "x", html: "x" } }] });

  const sup2 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const events = sup2.resume(s.id); // no lastSeq → cold
  const snap = events.find((e) => e.type === "conversation.snapshot") as { epoch?: string } | undefined;
  expect(snap).toBeDefined();
  expect(snap!.epoch).toBe(s.epoch); // snapshot seeds the client's epoch for future delta resumes
  rmSync(dir, { recursive: true, force: true });
});

// A background sub-agent in flight at restart died with the old CLI process — its task_notification can
// never arrive. Restore must settle it durably (canceled) so a reconnecting client's row stops spinning,
// and must not re-settle it on the NEXT restart.
test("restart cancels an in-flight background sub-agent durably, exactly once", async () => {
  const dir = tempState();
  const sup1 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = await createExisting(sup1, dir);
  const bg = { id: "toolu_bg", label: "Long audit", state: "running" as const, steps: 2, background: true };
  sup1.get(s.id)!.emit({ type: "tool.result", toolUseId: "toolu_bg", content: "Async agent launched successfully.", isError: false, subagent: bg });
  const before = sup1.get(s.id)!.lastSeq;
  await sup1.shutdown(); // a real restart flushes the registry (SIGTERM handler)

  const sup2 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const settled = sup2.resume(s.id, before).filter((e) => e.type === "subagent.settled") as any[];
  expect(settled).toHaveLength(1);
  expect(settled[0].agent).toMatchObject({ id: "toolu_bg", label: "Long audit", state: "canceled", background: true });

  await sup2.shutdown();
  const sup3 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  expect(sup3.resume(s.id, 0).filter((e) => e.type === "subagent.settled")).toHaveLength(1); // not duplicated
  rmSync(dir, { recursive: true, force: true });
});

// ── Seq high-water mark across an UNCLEAN restart ──────────────────────────────────────────────────
// The registry's lastSeq is flushed on a 100ms debounce, so a hard crash can leave it behind both the
// durable log and the transient frames (assistant.delta) clients advance their watermark from. Restore
// must never re-mint those numbers. (No `shutdown()` before the restart = a crash.)
const md = (text: string) => ({ type: "assistant.message" as const, blocks: [{ kind: "markdown" as const, rendered: { source: text, html: text } }] });

test("after a crash, new events never reuse a seq already in the log", async () => {
  const dir = tempState();
  const sup1 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = await createExisting(sup1, dir);
  await sup1.shutdown(); // registry flushed at the session's creation…
  const sup1b = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  for (let i = 0; i < 5; i++) sup1b.get(s.id)!.emit(md(`m${i}`)); // …then events the debounced flush never saw
  // ── crash (no shutdown) → restart ──
  const sup2 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  sup2.get(s.id)!.emit(md("after the crash"));
  const seqs = sup2.resume(s.id, 0).filter((e) => e.type === "assistant.message").map((e) => (e as { seq: number }).seq);
  expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
  expect(seqs[seqs.length - 1]).toBeGreaterThan(Math.max(...seqs.slice(0, -1)));
  rmSync(dir, { recursive: true, force: true });
});

test("after a crash, a client whose watermark came from a transient frame still receives the new events", async () => {
  const dir = tempState();
  const sup1 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = await createExisting(sup1, dir);
  await sup1.shutdown();
  const sup1b = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const live = sup1b.get(s.id)!;
  live.emit(md("start"));
  let clientSeq = 0;
  for (let i = 0; i < 20; i++) clientSeq = (live.emit({ type: "assistant.delta", text: "x" }) as { seq: number }).seq; // never persisted
  // ── crash → restart; the agent's next message lands while the client is away ──
  const sup2 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const wm = sup2.resumeWatermarksEvent().watermarks.find((w) => w.sessionId === s.id)!;
  expect(wm.lastSeq).toBeGreaterThanOrEqual(clientSeq); // the client stays in delta mode…
  sup2.get(s.id)!.emit(md("the answer"));
  const delta = sup2.resume(s.id, clientSeq);
  // …and its delta carries the new message (before the fix it reused a seq ≤ clientSeq and was skipped).
  expect(delta.some((e) => e.type === "assistant.message" && (e as any).blocks[0].rendered.source === "the answer")).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("a clean shutdown skips nothing; the marker is consumed so a later crash still skips", async () => {
  const dir = tempState();
  const sup1 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = await createExisting(sup1, dir);
  sup1.get(s.id)!.emit(md("a"));
  const before = sup1.get(s.id)!.lastSeq;
  await sup1.shutdown();
  const sup2 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  expect(sup2.get(s.id)!.lastSeq).toBe(before); // clean → exact continuation
  // sup2 "crashes" (no shutdown): the marker was consumed at its boot, so the next restart skips ahead.
  const sup3 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  expect(sup3.get(s.id)!.lastSeq).toBeGreaterThanOrEqual(before + SEQ_CRASH_GAP);
  rmSync(dir, { recursive: true, force: true });
});
