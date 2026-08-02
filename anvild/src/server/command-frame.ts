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

  if (typeof record.type !== "string") {
    return { ok: false, message: "missing command type", cid };
  }
  // The version gate is a FLOOR, not an equality (issue #162). The protocol is additive-or-bump
  // (protocol.ts changelog), so a frame from an OLDER client still parses; strict equality turned
  // every bump into a fleet-wide outage where a one-release-behind peer was unreachable from the
  // UI — and the "Update Anvil" recovery command was rejected by this very check. Only frames
  // NEWER than this daemon speaks are refused (they may rely on semantics this daemon predates).
  // Runs AFTER the `type` check so the command is inspected first and the error can name it.
  if (typeof record.v !== "number" || record.v > PROTOCOL_VERSION) {
    return {
      ok: false,
      message: `unsupported protocol version: ${String(record.v)} for ${record.type} (this daemon speaks ≤ ${PROTOCOL_VERSION})`,
      cid,
    };
  }
  return { ok: true, cmd: msg as ClientCommand, cid };
}
