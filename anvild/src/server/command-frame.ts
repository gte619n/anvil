/**
 * [Phase 3 / BE-7] The pure protocol-conformance gate for the WS command router (arch §6.1).
 * Extracted from dispatch.ts so the malformed / unsupported-version / missing-type cases are
 * unit-testable without a live server. Preserves the correlation id (`cid`) so the router can
 * reply `command.error` on the right frame.
 */
import { PROTOCOL_VERSION, type ClientCommand } from "@protocol";

export type ParsedFrame =
  | { ok: true; cmd: ClientCommand; cid?: string }
  | { ok: false; message: string; cid?: string };

export function parseCommandFrame(raw: string): ParsedFrame {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { ok: false, message: "invalid JSON" };
  }
  if (typeof msg !== "object" || msg === null) {
    return { ok: false, message: "malformed message: expected an object" };
  }
  const record = msg as Record<string, unknown>;
  const cid = typeof record.cid === "string" ? record.cid : undefined;

  if (record.v !== PROTOCOL_VERSION) {
    return { ok: false, message: `unsupported protocol version: ${String(record.v)} (expected ${PROTOCOL_VERSION})`, cid };
  }
  if (typeof record.type !== "string") {
    return { ok: false, message: "missing command type", cid };
  }
  return { ok: true, cmd: msg as ClientCommand, cid };
}
