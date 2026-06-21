import webpush from "web-push";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface PushPayload {
  title: string;
  body: string;
  sessionId?: string;
  tag?: string;
  /** "permission" pushes carry an actionable request the client can resolve in-place. */
  kind?: "permission" | "result";
  /** Permission request id — lets a native client answer Allow/Deny from the notification. */
  requestId?: string;
  /** The tool awaiting approval (for the notification body / labels). */
  tool?: string;
}

/**
 * Web Push for the web client (arch §6.7): VAPID keys + persisted browser subscriptions +
 * encrypted send via the `web-push` lib. FCM/APNs for native clients can layer on later.
 */
export class WebPush {
  private readonly dir: string;
  private readonly keys: { publicKey: string; privateKey: string };
  private subs: Subscription[] = [];

  constructor(stateDir: string) {
    this.dir = join(stateDir, "push");
    mkdirSync(this.dir, { recursive: true });
    this.keys = this.loadKeys();
    this.subs = this.loadSubs();
    webpush.setVapidDetails("mailto:anvil@localhost", this.keys.publicKey, this.keys.privateKey);
  }

  get publicKey(): string {
    return this.keys.publicKey;
  }

  private loadKeys(): { publicKey: string; privateKey: string } {
    const f = join(this.dir, "vapid.json");
    if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as { publicKey: string; privateKey: string };
    const k = webpush.generateVAPIDKeys();
    writeFileSync(f, JSON.stringify(k), { mode: 0o600 });
    return k;
  }
  private loadSubs(): Subscription[] {
    const f = join(this.dir, "subscriptions.json");
    if (!existsSync(f)) return [];
    try {
      return JSON.parse(readFileSync(f, "utf8")) as Subscription[];
    } catch {
      return [];
    }
  }
  private saveSubs(): void {
    writeFileSync(join(this.dir, "subscriptions.json"), JSON.stringify(this.subs));
  }

  subscribe(sub: Subscription): void {
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return;
    if (!this.subs.some((s) => s.endpoint === sub.endpoint)) {
      this.subs.push(sub);
      this.saveSubs();
    }
  }
  unsubscribe(endpoint: string): void {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length !== before) this.saveSubs();
  }

  /** Encrypt + send to every subscription; prune ones the push service reports as gone. */
  async notify(payload: PushPayload): Promise<void> {
    if (this.subs.length === 0) return;
    const data = JSON.stringify(payload);
    const dead: string[] = [];
    await Promise.all(
      this.subs.map(async (s) => {
        try {
          await webpush.sendNotification(s, data, { TTL: 600 });
        } catch (e) {
          const code = (e as { statusCode?: number })?.statusCode;
          if (code === 404 || code === 410) dead.push(s.endpoint); // gone/expired
        }
      }),
    );
    if (dead.length) {
      this.subs = this.subs.filter((s) => !dead.includes(s.endpoint));
      this.saveSubs();
    }
  }
}
