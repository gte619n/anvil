/** Design 2026-08-08: multi-terminal protocol fields are ADDITIVE (no version bump). A v4 client
 *  that omits `termId` must still satisfy the types, and `Session.terminals` must stay optional —
 *  this test failing to COMPILE is the guard. */
import { test, expect } from "bun:test";
import { PROTOCOL_VERSION } from "../../protocol";
import type { TerminalOpenCmd, TerminalInputCmd, TerminalResizeCmd, TerminalCloseCmd, TerminalDataEvent, TerminalExitEvent } from "../../protocol";

test("terminal.* messages compile without termId; version stays 4", () => {
  const open: TerminalOpenCmd = { v: PROTOCOL_VERSION, type: "terminal.open", ts: "t", sessionId: "s", cols: 80, rows: 24 };
  const input: TerminalInputCmd = { v: PROTOCOL_VERSION, type: "terminal.input", ts: "t", sessionId: "s", data: "" };
  const resize: TerminalResizeCmd = { v: PROTOCOL_VERSION, type: "terminal.resize", ts: "t", sessionId: "s", cols: 80, rows: 24 };
  const close: TerminalCloseCmd = { v: PROTOCOL_VERSION, type: "terminal.close", ts: "t", sessionId: "s" };
  const data: TerminalDataEvent = { v: PROTOCOL_VERSION, type: "terminal.data", ts: "t", sessionId: "s", seq: 1, data: "" };
  const exit: TerminalExitEvent = { v: PROTOCOL_VERSION, type: "terminal.exit", ts: "t", sessionId: "s", seq: 2, code: 0 };
  for (const m of [open, input, resize, close, data, exit]) expect(m.termId).toBeUndefined();
  expect(PROTOCOL_VERSION).toBe(4);
});
