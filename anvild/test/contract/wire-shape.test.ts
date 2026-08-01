/**
 * [P5] Field-level protocol contract — the guard the existing `protocol-surface` golden CANNOT provide.
 *
 * `protocol-surface.test.ts` pins only PROTOCOL_VERSION + the set of `type:"..."` literals. That means
 * renaming a v4 field (`watermarks`→`items`), retyping `lastSeq`, flipping `epoch` to optional, or
 * dropping it from `conversation.snapshot` all PASS — yet those are exactly the fields the Swift/Kotlin
 * clients decode, so any of them silently breaks a native client at runtime.
 *
 * This pins the REQUIRED fields + declared types (and optionality) of the highest-blast-radius wire
 * interfaces (the v4 resume envelopes + `server.hello` + `permission.request`, plus the shared
 * `Envelope`/`SessionScoped` bases) to an inline golden. A rename/retype/drop/optionality-flip on any of
 * them fails HERE, at the seam, instead of in a shipped native client.
 *
 * When you intentionally change one of these interfaces, update the golden below IN THE SAME COMMIT that
 * updates all three clients — the friction is the point.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROTOCOL_SRC = join(import.meta.dir, "..", "..", "protocol.ts");
const src = readFileSync(PROTOCOL_SRC, "utf8");

interface Field {
  optional: boolean;
  type: string;
}
interface Shape {
  bases: string[];
  fields: Record<string, Field>;
}

/** Parse one flat interface: its `extends` bases and each own field's {optional, declared type}. */
function parseInterface(name: string): Shape {
  const start = src.indexOf(`export interface ${name} `);
  if (start < 0) throw new Error(`interface ${name} not found`);
  const braceAt = src.indexOf("{", start);
  const header = src.slice(start, braceAt);
  const ext = header.match(/extends\s+([^{]+)/);
  const bases = ext ? ext[1]!.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const fields: Record<string, Field> = {};
  for (const raw of src.slice(braceAt + 1).split("\n")) {
    const line = raw.trim();
    if (line === "}") break; // end of this interface body
    if (!line || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;
    const m = line.match(/^(\w+)(\??):\s*([^;]+);/);
    if (!m) continue;
    fields[m[1]!] = { optional: m[2] === "?", type: m[3]!.replace(/\/\/.*$/, "").trim() };
  }
  return { bases, fields };
}

// ── The golden: what the native clients decode. Change deliberately + update clients in the same commit.
const GOLDEN: Record<string, Shape> = {
  Envelope: {
    bases: [],
    fields: { v: { optional: false, type: "ProtocolVersion" }, type: { optional: false, type: "string" }, ts: { optional: false, type: "Iso8601" } },
  },
  SessionScoped: {
    bases: [],
    fields: { sessionId: { optional: false, type: "SessionId" }, seq: { optional: false, type: "Seq" } },
  },
  ServerHelloEvent: {
    bases: ["Envelope"],
    fields: {
      type: { optional: false, type: '"server.hello"' },
      serverId: { optional: false, type: "string" },
      serverName: { optional: false, type: "string" },
      version: { optional: false, type: "string" },
      protocolVersion: { optional: false, type: "ProtocolVersion" },
      updateApiVersion: { optional: true, type: "UpdateApiVersion" },
      capabilities: { optional: true, type: "string[]" },
      role: { optional: false, type: '"hub" | "member" | "standalone"' },
      hubServerId: { optional: true, type: "string" },
    },
  },
  ResumeWatermark: {
    bases: [],
    fields: {
      sessionId: { optional: false, type: "SessionId" },
      epoch: { optional: false, type: "Epoch" },
      lastSeq: { optional: false, type: "Seq" },
    },
  },
  ResumeWatermarksEvent: {
    bases: ["Envelope"],
    fields: { type: { optional: false, type: '"resume.watermarks"' }, watermarks: { optional: false, type: "ResumeWatermark[]" } },
  },
  ConversationSnapshotEvent: {
    bases: ["Envelope", "SessionScoped"],
    fields: {
      type: { optional: false, type: '"conversation.snapshot"' },
      events: { optional: false, type: "ConversationEvent[]" },
      lastSeq: { optional: false, type: "Seq" },
      epoch: { optional: false, type: "Epoch" },
    },
  },
  PermissionRequestEvent: {
    bases: ["Envelope", "SessionScoped"],
    fields: {
      type: { optional: false, type: '"permission.request"' },
      requestId: { optional: false, type: "RequestId" },
      tool: { optional: false, type: "string" },
      input: { optional: false, type: "unknown" },
      suggestions: { optional: false, type: "PermissionSuggestion[]" },
      replay: { optional: true, type: "boolean" },
    },
  },
};

for (const [name, expected] of Object.entries(GOLDEN)) {
  test(`wire shape of ${name} matches the golden (field rename/retype/drop/optionality is breaking)`, () => {
    expect(parseInterface(name)).toEqual(expected);
  });
}
