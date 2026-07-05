/**
 * [SEC-L3] Push subscription registries hold secrets (web-push `auth`/`p256dh`, device tokens).
 * They must not be world-readable on a multi-user host. The VAPID key file already uses 0600; this
 * pins that the subscriptions registry does too.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebPush } from "../../src/push/webpush";

test("web-push subscriptions.json is written 0600", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "anvil-push-"));
  const wp = new WebPush(stateDir);
  wp.subscribe({ endpoint: "https://example.com/ep", keys: { p256dh: "p", auth: "a" } });
  const mode = statSync(join(stateDir, "push", "subscriptions.json")).mode & 0o777;
  expect(mode).toBe(0o600);
});
