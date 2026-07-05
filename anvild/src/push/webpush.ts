import webpush from "web-push";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../util/atomic";
import { TokenStore, fanOut } from "./token-store";

interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface PushPayload {
  title: string;
  body: string;
  sessionId?: string;
  tag?: string;
  /**
   * "permission" pushes carry an actionable request the client can resolve in-place (Allow/Deny);
   * "question" pushes mean Claude is asking a multiple-choice question — tap to open and answer
   * (no shade actions, since options can't be buttons); "result" means the turn finished;
   * "clear" is a silent dismissal — close the session's existing notification, don't show one.
   */
  kind?: "permission" | "question" | "result" | "clear";
  /** Permission request id — lets a native client answer Allow/Deny from the notification. */
  requestId?: string;
  /** The tool awaiting approval (for the notification body / labels). */
  tool?: string;
  /** Session context for the notification: the working dir's basename (which project). */
  dir?: string;
  /** One-line summary of what the session is asking for (e.g. "Run: git push"). */
  ask?: string;
}

/**
 * Web Push for the web client (arch §6.7): VAPID keys + persisted browser subscriptions +
 * encrypted send via the `web-push` lib. FCM/APNs for native clients can layer on later.
 */
export class WebPush {
  private readonly dir: string;
  private readonly keys: { publicKey: string; privateKey: string };
  private readonly store: TokenStore<Subscription>;

  constructor(stateDir: string) {
    this.dir = join(stateDir, "push");
    mkdirSync(this.dir, { recursive: true });
    this.keys = this.loadKeys();
    this.store = new TokenStore(join(this.dir, "subscriptions.json"), (s) => s.endpoint);
    webpush.setVapidDetails("mailto:anvil@localhost", this.keys.publicKey, this.keys.privateKey);
  }

  get publicKey(): string {
    return this.keys.publicKey;
  }

  private loadKeys(): { publicKey: string; privateKey: string } {
    const f = join(this.dir, "vapid.json");
    if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as { publicKey: string; privateKey: string };
    const k = webpush.generateVAPIDKeys();
    writeFileAtomic(f, JSON.stringify(k), { mode: 0o600 });
    return k;
  }
  subscribe(sub: Subscription): void {
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return; // incomplete — reject
    this.store.add(sub); // dedupes by endpoint
  }
  unsubscribe(endpoint: string): void {
    this.store.remove(endpoint);
  }

  /** Encrypt + send to every subscription; prune ones the push service reports as gone. */
  async notify(payload: PushPayload): Promise<void> {
    if (this.store.size === 0) return;
    const data = JSON.stringify(payload);
    const dead = await fanOut(this.store.list(), async (s) => {
      try {
        await webpush.sendNotification(s, data, { TTL: 600 });
        return false;
      } catch (e) {
        const code = (e as { statusCode?: number })?.statusCode;
        return code === 404 || code === 410; // gone/expired → prune
      }
    });
    this.store.prune(dead);
  }
}
