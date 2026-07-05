/**
 * Protocol contract test — the guard against silent daemon↔client drift.
 *
 * The daemon and its three clients (web PWA, iOS/macOS Swift, Android Kotlin) share the wire
 * protocol defined in `protocol.ts`. Nothing else enforces that the set of event/command `type`
 * strings stays stable: renaming `session.updated`, dropping an event, or adding one silently
 * breaks whichever clients weren't updated in lockstep.
 *
 * This test pins two things to a checked-in golden (`protocol-surface.golden.json`):
 *   1. `PROTOCOL_VERSION` — bumping it is a breaking-change signal for every client.
 *   2. The complete sorted set of wire `type: "..."` literals in the protocol.
 *
 * When you intentionally change the protocol, regenerate the golden:
 *   cd anvild && bun test/contract/regen-golden.ts
 * The point of the friction is that the regen step is the moment to update all three clients.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";

const HERE = import.meta.dir;
const PROTOCOL_SRC = join(HERE, "..", "..", "protocol.ts");
const GOLDEN_PATH = join(HERE, "protocol-surface.golden.json");

/** Extract every `type: "wire.name"` literal from the protocol source, sorted + de-duped. */
export function extractWireTypes(src: string): string[] {
  const out = new Set<string>();
  const re = /^\s*type:\s*"([^"]+)"/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.add(m[1]!);
  return [...out].sort();
}

const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as {
  protocolVersion: number;
  wireTypes: string[];
};

test("PROTOCOL_VERSION matches the golden (a bump is a breaking-change signal)", () => {
  // Widen the const-typed `1` to number so the runtime golden value is comparable.
  expect(PROTOCOL_VERSION as number).toBe(golden.protocolVersion);
});

test("the set of wire event/command types matches the golden (no undocumented drift)", () => {
  const current = extractWireTypes(readFileSync(PROTOCOL_SRC, "utf8"));
  const goldenSet = new Set(golden.wireTypes);
  const currentSet = new Set(current);

  const added = current.filter((t) => !goldenSet.has(t));
  const removed = golden.wireTypes.filter((t) => !currentSet.has(t));

  // A precise message so a real drift tells you exactly what to reconcile across clients.
  expect({ added, removed }).toEqual({ added: [], removed: [] });
});
