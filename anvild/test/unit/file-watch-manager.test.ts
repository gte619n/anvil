/**
 * [Phase 3 / BE-7] FileWatchManager is extracted from supervisor.ts, where fs-change watching used
 * watchFile inline (untestable). With injected locate/read/watch primitives the dedup, file-kind
 * filtering, debounced change→emit, and per-session cleanup are now unit-testable.
 */
import { test, expect } from "bun:test";
import type { FileContent } from "@protocol";
import { FileWatchManager, type WatchSession, type WatchPrimitive } from "../../src/session/file-watch-manager";

// Minimal FileContent-shaped stub for the fake reader (the manager just passes it through).
const fc = (content: string, path = "f"): FileContent => ({ path, content }) as unknown as FileContent;

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fakeSession(cwd = "/wt") {
  const emitted: Array<{ type: string; content?: unknown }> = [];
  const session: WatchSession = { cwd, emit: (b) => emitted.push(b) };
  return { session, emitted };
}

/** A watch primitive that records registrations and lets the test fire the change callback. */
function fakeWatch() {
  const active = new Map<string, { onChange: () => void; stopped: boolean }>();
  const watch: WatchPrimitive = (abs, onChange) => {
    const rec = { onChange, stopped: false };
    active.set(abs, rec);
    return () => {
      rec.stopped = true;
    };
  };
  return { watch, active };
}

function make(opts: {
  session?: WatchSession;
  locate?: (cwd: string, path: string) => { kind: string; abs: string };
  read?: (sessionId: string, path: string) => FileContent;
  watch: WatchPrimitive;
  debounceMs?: number;
}) {
  const { session = fakeSession().session } = opts;
  return new FileWatchManager(
    () => session,
    opts.locate ?? ((_c, p) => ({ kind: "file", abs: `/abs/${p}` })),
    opts.read ?? ((_s, p) => fc("x", p)),
    opts.watch,
    opts.debounceMs ?? 5,
  );
}

test("add registers a watch once (dedup) and only for a file", () => {
  const { watch, active } = fakeWatch();
  const mgr = make({ watch });
  mgr.add("s1", "a.ts");
  mgr.add("s1", "a.ts"); // duplicate — no second registration
  expect(active.size).toBe(1);
  expect([...active.keys()]).toEqual(["/abs/a.ts"]);
});

test("add ignores a non-file (ambiguous basename) and a not-found path", () => {
  const { watch, active } = fakeWatch();
  const dir = make({ watch, locate: () => ({ kind: "dir", abs: "/abs/d" }) });
  dir.add("s1", "d");
  const missing = make({
    watch,
    locate: () => {
      throw new Error("not found");
    },
  });
  missing.add("s1", "gone");
  expect(active.size).toBe(0);
});

test("a file change emits a debounced fs.changed with the freshly read content", async () => {
  const { session, emitted } = fakeSession();
  const { watch, active } = fakeWatch();
  const mgr = make({ session, watch, read: (_s, p) => fc("NEW", p), debounceMs: 5 });
  mgr.add("s1", "a.ts");

  active.get("/abs/a.ts")!.onChange();
  active.get("/abs/a.ts")!.onChange(); // rapid second change coalesces
  await tick(20);
  const changes = emitted.filter((e) => e.type === "fs.changed");
  expect(changes.length).toBe(1); // debounced to one
  expect((changes[0]!.content as { content: string }).content).toBe("NEW");
});

test("a read error during a change is swallowed (no emit, no throw)", async () => {
  const { session, emitted } = fakeSession();
  const { watch, active } = fakeWatch();
  const mgr = make({
    session,
    watch,
    read: () => {
      throw new Error("deleted");
    },
    debounceMs: 5,
  });
  mgr.add("s1", "a.ts");
  active.get("/abs/a.ts")!.onChange();
  await tick(20);
  expect(emitted.some((e) => e.type === "fs.changed")).toBe(false);
});

test("unwatch stops and removes a single watch", () => {
  const { watch, active } = fakeWatch();
  const mgr = make({ watch });
  mgr.add("s1", "a.ts");
  mgr.unwatch("s1", "a.ts");
  expect(active.get("/abs/a.ts")!.stopped).toBe(true);
  mgr.add("s1", "a.ts"); // can re-add after unwatch
  expect(active.size).toBe(1);
});

test("clear stops every watch for a session, leaving other sessions' watches", () => {
  const { watch, active } = fakeWatch();
  const mgr = make({ watch, locate: (_c, p) => ({ kind: "file", abs: `/abs/${p}` }) });
  mgr.add("s1", "a.ts");
  mgr.add("s1", "b.ts");
  mgr.add("s2", "c.ts");
  mgr.clear("s1");
  expect(active.get("/abs/a.ts")!.stopped).toBe(true);
  expect(active.get("/abs/b.ts")!.stopped).toBe(true);
  expect(active.get("/abs/c.ts")!.stopped).toBe(false); // s2 untouched
});
