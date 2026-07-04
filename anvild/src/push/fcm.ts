import { createSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../util/atomic";
import { join } from "node:path";
import type { PushPayload } from "./webpush";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri: string;
}

/**
 * FCM HTTP v1 sender for the Android client (arch §6.7). Signs a JWT with the service-account
 * key, exchanges it for an OAuth access token (cached ~1h), and POSTs notifications. Disabled
 * (no-op) if the service-account file is absent.
 */
export class Fcm {
  private readonly sa?: ServiceAccount;
  private readonly tokensFile: string;
  private tokens: string[] = [];
  private access?: { token: string; exp: number };

  constructor(stateDir: string) {
    const dir = join(stateDir, "push");
    mkdirSync(dir, { recursive: true });
    this.tokensFile = join(dir, "fcm-tokens.json");
    this.tokens = this.loadTokens();
    const path = process.env.ANVIL_FCM_SERVICE_ACCOUNT || join(process.env.HOME ?? "", ".config/anvil/fcm-service-account.json");
    if (existsSync(path)) {
      try {
        this.sa = JSON.parse(readFileSync(path, "utf8")) as ServiceAccount;
      } catch {
        /* malformed — stays disabled */
      }
    }
  }

  get enabled(): boolean {
    return !!this.sa;
  }

  register(token: string): void {
    if (token && !this.tokens.includes(token)) {
      this.tokens.push(token);
      this.save();
    }
  }
  unregister(token: string): void {
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => t !== token);
    if (this.tokens.length !== before) this.save();
  }

  private loadTokens(): string[] {
    if (!existsSync(this.tokensFile)) return [];
    try {
      return JSON.parse(readFileSync(this.tokensFile, "utf8")) as string[];
    } catch {
      return [];
    }
  }
  private save(): void {
    // [SEC-L3] device tokens are sensitive — non-world-readable. [BE-9] atomic (tmp+rename).
    writeFileAtomic(this.tokensFile, JSON.stringify(this.tokens), { mode: 0o600 });
  }

  private async accessToken(): Promise<string | undefined> {
    if (!this.sa) return undefined;
    const now = Math.floor(Date.now() / 1000);
    if (this.access && this.access.exp - 60 > now) return this.access.token;
    const b64 = (s: string): string => Buffer.from(s).toString("base64url");
    const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64(
      JSON.stringify({ iss: this.sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: this.sa.token_uri, iat: now, exp: now + 3600 }),
    );
    const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(this.sa.private_key).toString("base64url");
    const res = await fetch(this.sa.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${sig}` }),
    });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.access = { token: j.access_token, exp: now + j.expires_in };
    return j.access_token;
  }

  /** Send to every registered device; prune tokens the FCM service reports as gone. */
  async notify(payload: PushPayload): Promise<void> {
    if (!this.sa || this.tokens.length === 0) return;
    const access = await this.accessToken();
    if (!access) return;
    const url = `https://fcm.googleapis.com/v1/projects/${this.sa.project_id}/messages:send`;
    const dead: string[] = [];
    await Promise.all(
      this.tokens.map(async (token) => {
        // ALL pushes are sent data-only so the Android client's onMessageReceived ALWAYS handles
        // them (even backgrounded) via Notifications.show(). That path keys the notification id off
        // sessionId, so a new reminder for a session supersedes the old one instead of stacking,
        // deep-links to that session on tap, and clears when the app opens it. A notification-payload
        // message would instead be auto-rendered by the system tray with a fresh id each time —
        // stacking, no session link, no auto-clear.
        const data: Record<string, string> = { title: payload.title, body: payload.body };
        if (payload.sessionId) data.sessionId = payload.sessionId;
        if (payload.kind) data.kind = payload.kind;
        if (payload.requestId) data.requestId = payload.requestId;
        if (payload.tool) data.tool = payload.tool;
        if (payload.dir) data.dir = payload.dir;
        if (payload.ask) data.ask = payload.ask;
        const message: Record<string, unknown> = { token, data, android: { priority: "HIGH" } };
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
            body: JSON.stringify({ message }),
          });
          if (!res.ok) {
            const text = await res.text();
            if (/UNREGISTERED|NOT_FOUND|InvalidRegistration/i.test(text)) dead.push(token);
          }
        } catch {
          /* network — keep the token, retry next time */
        }
      }),
    );
    if (dead.length) {
      this.tokens = this.tokens.filter((t) => !dead.includes(t));
      this.save();
    }
  }
}
