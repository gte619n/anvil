/**
 * [Phase 3 / BE-7] parseCommandFrame is the pure protocol-conformance gate extracted from dispatch.ts
 * (the 435-line WS router). It validates the envelope before any command runs: JSON, object shape,
 * PROTOCOL_VERSION, and a string `type`, preserving the correlation id for the error reply. Pinning
 * it as a unit makes the malformed/unsupported cases fast to test without spinning a server.
 */
import { test, expect } from "bun:test";
import { PROTOCOL_VERSION } from "@protocol";
import { parseCommandFrame } from "../../src/server/command-frame";

const frame = (o: Record<string, unknown>) => JSON.stringify({ v: PROTOCOL_VERSION, ...o });

test("rejects invalid JSON (no cid available)", () => {
  const r = parseCommandFrame("{not json");
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.message).toMatch(/invalid JSON/);
    expect(r.cid).toBeUndefined();
  }
});

test("rejects non-object frames", () => {
  for (const raw of ["123", "\"hi\"", "null", "[1,2]"]) {
    const r = parseCommandFrame(raw);
    // arrays are objects in JS; the router narrows on `type`, so an array fails the type check, not
    // the object check — either way it must not be ok.
    expect(r.ok).toBe(false);
  }
});

test("rejects an unsupported protocol version and preserves the cid", () => {
  const r = parseCommandFrame(JSON.stringify({ v: 999, type: "session.list", cid: "c1" }));
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.message).toMatch(/unsupported protocol version/);
    expect(r.cid).toBe("c1");
  }
});

test("rejects a missing/non-string type and preserves the cid", () => {
  const r = parseCommandFrame(frame({ cid: "c2" }));
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.message).toMatch(/missing command type/);
    expect(r.cid).toBe("c2");
  }
});

test("accepts a well-formed frame and surfaces the cid", () => {
  const r = parseCommandFrame(frame({ type: "session.attach", cid: "c3" }));
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.cmd.type).toBe("session.attach");
    expect(r.cid).toBe("c3");
  }
});

test("a non-string cid is dropped (undefined), not surfaced", () => {
  const r = parseCommandFrame(frame({ type: "session.list", cid: 42 }));
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.cid).toBeUndefined();
});
