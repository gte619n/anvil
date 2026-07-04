/**
 * [SEC-M2] The attachment store builds a filesystem path from the client-supplied filename's
 * extension (`join(dir, `${id}.${ext}`)`) and from `sessionId`. A crafted name like
 * `foo.png/../../../evil` makes `ext` contain path separators, so the base64 body is written OUTSIDE
 * the attachments dir — arbitrary file write. These tests pin containment.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore } from "../../src/attach/store";

const b64 = Buffer.from("payload").toString("base64");

test("a traversal filename cannot escape the session attachments dir", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "anvil-attach-"));
  const store = new AttachmentStore(stateDir);
  const attachDir = join(stateDir, "sessions", "sess_abc", "attachments");

  const ref = store.add("sess_abc", "foo.png/../../../../pwned", "image/png", b64);

  // The stored blob stays inside the attachments dir...
  expect(ref.path.startsWith(attachDir)).toBe(true);
  // ...and nothing was written outside it.
  expect(existsSync(join(stateDir, "pwned"))).toBe(false);
  expect(existsSync(join(stateDir, "sessions", "pwned"))).toBe(false);
  // Every file created lives directly under the attachments dir (no nested escape).
  for (const f of readdirSync(attachDir)) {
    expect(f.includes("/")).toBe(false);
    expect(f.includes("..")).toBe(false);
  }
});

test("a benign filename keeps a sensible extension", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "anvil-attach-"));
  const store = new AttachmentStore(stateDir);
  const ref = store.add("sess_ok", "diagram.png", "image/png", b64);
  expect(ref.path.endsWith(".png")).toBe(true);
  // round-trips through the store
  expect(store.bytes("sess_ok", ref.id)?.path).toBe(ref.path);
});

test("a traversal sessionId is rejected", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "anvil-attach-"));
  const store = new AttachmentStore(stateDir);
  expect(() => store.add("../../../../etc", "a.png", "image/png", b64)).toThrow();
});
