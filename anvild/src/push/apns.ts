import { createSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PushPayload } from "./webpush";

interface ApnsKey {
  /** APNs auth key id (the "Key ID" of the .p8). */
  keyId: string;
  /** Apple Developer team id (the JWT `iss`). */
  teamId: string;
  /** App bundle id — the `apns-topic` header. */
  bundleId: string;
  /** Contents of the AuthKey_XXXX.p8 (PEM, "-----BEGIN PRIVATE KEY-----…"). */
  key: string;
  /**
   * Which APNs environment to send to. TestFlight/App Store builds use "production"
   * (api.push.apple.com); Xcode debug builds with the development aps-environment use
   * "sandbox" (api.sandbox.push.apple.com). Defaults to production.
   */
  production?: boolean;
}

/**
 * APNs HTTP/2 sender for the iOS/iPadOS client (arch §6.7), parallel to {@link Fcm}. Signs an
 * ES256 JWT with the team's .p8 auth key (cached ~40 min; APNs rejects tokens older than 60 min),
 * and POSTs an alert push per device token to api.push.apple.com. Disabled (no-op) when the key
 * file is absent, exactly like Fcm — so the daemon runs fine on a host with no Apple credentials.
 *
 * Unlike FCM (which we send data-only so the Android client always handles it in onMessageReceived),
 * APNs needs a visible `aps.alert` to attach Allow/Deny action buttons via a `category`. Custom keys
 * (sessionId, kind, requestId, …) ride alongside `aps`; the iOS client reads them in its
 * UNUserNotificationCenter delegate to deep-link and resolve permissions.
 */
export class Apns {
  private readonly cfg?: ApnsKey;
  private readonly host: string;
  private readonly tokensFile: string;
  private tokens: string[] = [];
  private jwt?: { token: string; iat: number };

  constructor(stateDir: string) {
    const dir = join(stateDir, "push");
    mkdirSync(dir, { recursive: true });
    this.tokensFile = join(dir, "apns-tokens.json");
    this.tokens = this.loadTokens();
    const path = process.env.ANVIL_APNS_KEY || join(process.env.HOME ?? "", ".config/anvil/apns-key.json");
    let cfg: ApnsKey | undefined;
    if (existsSync(path)) {
      try {
        cfg = JSON.parse(readFileSync(path, "utf8")) as ApnsKey;
        if (!cfg.keyId || !cfg.teamId || !cfg.bundleId || !cfg.key) cfg = undefined; // incomplete — stays disabled
      } catch {
        /* malformed — stays disabled */
      }
    }
    this.cfg = cfg;
    this.host = cfg?.production === false ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  }

  get enabled(): boolean {
    return !!this.cfg;
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
    writeFileSync(this.tokensFile, JSON.stringify(this.tokens));
  }

  /** Provider JWT, ES256-signed with the .p8. Cached and refreshed ~every 40 min. */
  private authToken(): string | undefined {
    if (!this.cfg) return undefined;
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt && now - this.jwt.iat < 40 * 60) return this.jwt.token;
    const b64 = (s: string): string => Buffer.from(s).toString("base64url");
    const head = b64(JSON.stringify({ alg: "ES256", kid: this.cfg.keyId }));
    const claims = b64(JSON.stringify({ iss: this.cfg.teamId, iat: now }));
    // EC keys sign to DER by default; JOSE/ES256 requires the raw r||s (P1363) form.
    const sig = createSign("SHA256")
      .update(`${head}.${claims}`)
      .sign({ key: this.cfg.key, dsaEncoding: "ieee-p1363" })
      .toString("base64url");
    const token = `${head}.${claims}.${sig}`;
    this.jwt = { token, iat: now };
    return token;
  }

  /** Send to every registered device; prune tokens APNs reports as gone (410 / BadDeviceToken). */
  async notify(payload: PushPayload): Promise<void> {
    if (!this.cfg || this.tokens.length === 0) return;
    const jwt = this.authToken();
    if (!jwt) return;

    // "clear" is a silent dismissal — content-available so the app can retire the matching
    // notification without showing a new banner; everything else is a visible alert.
    const silent = payload.kind === "clear";
    const aps: Record<string, unknown> = silent
      ? { "content-available": 1 }
      : { alert: { title: payload.title, body: payload.body }, sound: "default", "thread-id": payload.sessionId };
    if (!silent && payload.kind) aps.category = payload.kind; // drives the Allow/Deny action buttons
    const body: Record<string, unknown> = { aps };
    for (const k of ["sessionId", "kind", "requestId", "tool", "dir", "ask"] as const) {
      if (payload[k]) body[k] = payload[k];
    }
    const json = JSON.stringify(body);
    const pushType = silent ? "background" : "alert";
    const priority = silent ? "5" : "10";

    const dead: string[] = [];
    await Promise.all(
      this.tokens.map(async (token) => {
        try {
          const res = await fetch(`${this.host}/3/device/${token}`, {
            method: "POST",
            headers: {
              authorization: `bearer ${jwt}`,
              "apns-topic": this.cfg!.bundleId,
              "apns-push-type": pushType,
              "apns-priority": priority,
            },
            body: json,
          });
          if (res.status === 410) {
            dead.push(token); // device token is no longer valid
          } else if (!res.ok) {
            const text = await res.text();
            if (/BadDeviceToken|Unregistered/i.test(text)) dead.push(token);
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
