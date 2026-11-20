/**
 * Decision 128 (merge item (e)): a card the owner has to SEE — a browser hard stop (it carries the
 * page screenshot), any permission card with an image or a reason of its own, and every CAD owner
 * card — reaches the owner's devices as a push that only OPENS the session: kind "question" (no
 * Allow/Deny category on iOS, no action buttons on Android), and no requestId to answer with. The
 * notification-button endpoint refuses to approve such a card (deny still works). Ordinary
 * permission prompts keep their inline Allow/Deny.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import type { PushPayload } from "../../src/push/webpush";
import { ConnectionRegistry } from "../../src/server/registry";
import { Supervisor } from "../../src/session/supervisor";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function harness(features: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "anvil-push-open-"));
  dirs.push(dir);
  const sup = new Supervisor({ stateDir: dir, features }, new ConnectionRegistry());
  const pushes: PushPayload[] = [];
  const spy = async (p: PushPayload) => void pushes.push(p);
  (sup as any).webpush = { notify: spy, subscribe() {}, unsubscribe() {}, publicKey: "" };
  (sup as any).fcm = { notify: spy };
  (sup as any).apns = { notify: spy };
  const s = await sup.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd: dir });
  return { sup, pushes, id: s.id, session: (sup as any).sessions.get(s.id) };
}
const IMAGE = { mediaType: "image/png", data: "iVBORw0KGgo=" };
/** Park a permission exactly as the permission hook does: broker first, then the session's card. */
function park(sup: Supervisor, session: any, requestId: string, card?: { reason?: string; image?: unknown }) {
  void (sup as any).broker.request(requestId, session.data.id);
  session.requestPermission(requestId, "mcp__browser__browser_click", { element: "Pay now" }, [], card);
}

describe("notifications for cards that must be seen", () => {
  test("[C3] a hard-stop card (screenshot + reason) is pushed as open-only: kind question, no requestId; an ordinary prompt keeps Allow/Deny", async () => {
    const { sup, pushes, session } = await harness();
    park(sup, session, "perm_hard", { reason: "Clicking “Pay now” on a logged-in site", image: IMAGE });
    expect(pushes.length).toBe(3); // web, FCM, APNs
    for (const p of pushes) {
      expect(p.kind).toBe("question");
      expect(p.requestId).toBeUndefined();
      expect(p.body).toContain("Open to see");
    }
    pushes.length = 0;
    park(sup, session, "perm_image_only", { image: IMAGE });
    expect(pushes.every((p) => p.kind === "question" && !p.requestId)).toBe(true);
    pushes.length = 0;
    park(sup, session, "perm_plain");
    expect(pushes.length).toBe(3);
    expect(pushes.every((p) => p.kind === "permission" && p.requestId === "perm_plain")).toBe(true);
  });

  test("[C3] the notification-button endpoint cannot approve a hard stop (deny works); an ordinary prompt can still be approved from it", async () => {
    const { sup, session } = await harness();
    park(sup, session, "perm_hard", { reason: "Submitting a form on a logged-in site", image: IMAGE });
    expect(() => sup.resolvePermissionFromNotification("perm_hard", "allow")).toThrow(/has to be seen/);
    expect(() => sup.resolvePermissionFromNotification("perm_hard", "allow_always")).toThrow(/has to be seen/);
    expect(session.pendingPermissions.has("perm_hard")).toBe(true); // still open, on the card
    sup.resolvePermissionFromNotification("perm_hard", "deny");
    expect(session.pendingPermissions.has("perm_hard")).toBe(false);
    park(sup, session, "perm_plain");
    sup.resolvePermissionFromNotification("perm_plain", "allow");
    expect(session.pendingPermissions.has("perm_plain")).toBe(false);
  });

  test("[A4] every CAD owner card (expectations, dimensions, release) sends a push that only opens the session; a replayed card sends none", async () => {
    const { sup, pushes, id, session } = await harness(["cad-work"]);
    const cadwork = (sup as any).cadwork;
    for (const kind of ["propose", "initial", "confirm", "dimensions", "release", "adopt-expectations", "adopt-ownerParams", "adopt-rules"] as const) {
      pushes.length = 0;
      const requestId = `cadreq_${kind}`;
      cadwork.park({ requestId, sessionId: id, ref: { key: `k-${kind}` }, kind, sha: "x", body: { type: "cad.expectations.request", requestId, sessionId: id, cwd: session.data.cwd, part: "plate", kind, rows: [] } });
      expect(pushes.length).toBe(3);
      for (const p of pushes) {
        expect(p.kind).toBe("question");
        expect(p.requestId).toBeUndefined();
        expect(p.sessionId).toBe(id);
        expect(p.body).toContain("plate");
      }
    }
    pushes.length = 0;
    (sup as any).cadwork.deps.registry.toAll({ v: PROTOCOL_VERSION, ts: "t", type: "cad.expectations.request", requestId: "r", sessionId: id, cwd: "/x", part: "plate", kind: "release", rows: [], replay: true });
    expect(pushes.length).toBe(0);
  });
});
