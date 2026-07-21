import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Joiner-side fleet pairing on the daemon's own :7701 API (anvil-headless-join.md §5.3 + §7).
 *
 * The macOS Server.app hosts an equivalent listener on :7702 (`Pairing.swift`), but it only exists on
 * a Mac — which is precisely why a headless Linux box could never be handed a fleet credential. This
 * module is the daemon's own version: the same two gates (code for first join, identity for rotation),
 * the same rejection vocabulary, no new port and no new process.
 *
 * Everything here is pure state + pure decisions with injectable seams (`whois`, `selfLogin`, `now`),
 * so the gates are unit-testable without a tailnet.
 */

// ─── The armed join window (HJ-16/HJ-17) ───────────────────────────────────────────────────────

/** Default lifetime of a join window. Long enough to walk to the other machine, short enough that a
 *  forgotten window closes itself. */
export const DEFAULT_ARM_TTL_MS = 10 * 60_000;
/** Hard ceiling on a client-requested TTL — the window is a credential-accepting hole (§8.2). */
export const MAX_ARM_TTL_MS = 30 * 60_000;

export type PairRejection = "not accepting pairings" | "wrong code" | "expired" | "different tailnet user" | "locked to another hub";

export interface ArmedState {
  code: string;
  expiresAt: number;
  /**
   * Set once a valid code has been ACCEPTED (HJ-17). From then on the window only answers a retry
   * carrying this same hub — a strictly smaller surface than a fresh armed window, which is what makes
   * "stay armed until ACK" (HJ-16) safe to leave open.
   */
  lockedHubServerId?: string;
  /** Rejections seen in THIS window, so the notification can coalesce to one with a count (HJ-33). */
  rejections: number;
  /** True once a rejection notification has been sent for this window. */
  notifiedRejection: boolean;
}

/** Six digits, uniformly drawn from a CSPRNG — `Math.random()` is not acceptable for a credential gate. */
export function generatePairCode(): string {
  // Rejection-sample so the modulo doesn't bias low codes. 2^32 % 1e6 != 0, so a naive % would make
  // codes below 294967 marginally likelier — cheap to avoid, and this guards a token push.
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return String(buf[0]! % 1_000_000).padStart(6, "0");
  }
}

/** Constant-time-ish string compare, so a wrong code can't be recovered byte-by-byte from timing. */
function codesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The joiner's join window. **Default closed**: with nothing armed, every pair attempt is rejected and
 * — per HJ-33 — an unarmed machine never notifies, so a tailnet scanner can't turn this into a doorbell.
 */
export class PairingWindow {
  private armed: ArmedState | null = null;

  constructor(private readonly clock: () => number = Date.now) {}

  arm(ttlMs = DEFAULT_ARM_TTL_MS): { code: string; expiresAt: number } {
    const ttl = Math.min(Math.max(60_000, Math.floor(ttlMs) || DEFAULT_ARM_TTL_MS), MAX_ARM_TTL_MS);
    this.armed = { code: generatePairCode(), expiresAt: this.clock() + ttl, rejections: 0, notifiedRejection: false };
    return { code: this.armed.code, expiresAt: this.armed.expiresAt };
  }

  disarm(): void {
    this.armed = null;
  }

  /** The live window, expiring it lazily so a stale one is never reported armed. */
  state(): ArmedState | null {
    if (this.armed && this.clock() >= this.armed.expiresAt) this.armed = null;
    return this.armed;
  }

  isArmed(): boolean {
    return this.state() !== null;
  }

  /**
   * Check a pair attempt's CODE gate (identity is checked separately — §7). Returns null when the
   * attempt may proceed. Accepting also LOCKS the window to this hub (HJ-17) so the retry window that
   * HJ-16 leaves open answers only the caller that already succeeded.
   */
  accept(code: string, hubServerId: string): PairRejection | null {
    const w = this.state();
    if (!w) return "not accepting pairings";
    if (w.lockedHubServerId && w.lockedHubServerId !== hubServerId) {
      this.countRejection();
      return "locked to another hub";
    }
    if (!codesMatch(w.code, code ?? "")) {
      this.countRejection();
      return "wrong code";
    }
    w.lockedHubServerId = hubServerId;
    return null;
  }

  /**
   * The hub confirms it recorded the member; the joiner disarms (HJ-16). Gated on the SAME hub and code
   * the window locked to — without that, any tailnet peer could POST an ACK and cancel someone else's
   * pairing mid-flow. **Idempotent**: an ACK for an already-disarmed window returns true rather than an
   * error, because the hub retries an ACK whose reply it lost (the mirror of HJ-16's own case).
   */
  ack(code: string, hubServerId: string): boolean {
    const w = this.state();
    if (!w) return true; // already disarmed (or expired) — the hub's retry is satisfied
    if (w.lockedHubServerId !== hubServerId) return false;
    if (!codesMatch(w.code, code ?? "")) return false;
    this.armed = null;
    return true;
  }

  /** Record a rejection and report whether THIS one should notify — at most one per window (HJ-33). */
  claimRejectionAlert(): { notify: boolean; count: number } {
    const w = this.state();
    if (!w) return { notify: false, count: 0 }; // unarmed machines log but never notify
    const notify = !w.notifiedRejection;
    w.notifiedRejection = true;
    return { notify, count: w.rejections };
  }

  private countRejection(): void {
    if (this.armed) this.armed.rejections += 1;
  }
}

// ─── The hub this machine was joined by (HJ-26) ────────────────────────────────────────────────

/**
 * Persisted at `<stateDir>/pairing.json`. Recorded for ROTATION GATING only — the joiner stays
 * standalone and does not adopt the hub's fleet registry (HJ-26). Read §8.6 before treating this as
 * authentication: it's a self-asserted body field, so it stops a *different* hub in the same tailnet
 * from silently retargeting this member (HJ-14's detach case); it is not a credential.
 */
export interface PairedHub {
  hubServerId: string;
  fleetName?: string;
  at: string;
}

export class PairedHubStore {
  private readonly file: string;
  private state: PairedHub | null = null;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, "pairing.json");
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PairedHub>;
        if (raw.hubServerId) this.state = { hubServerId: raw.hubServerId, fleetName: raw.fleetName, at: raw.at ?? "" };
      } catch {
        this.state = null; // corrupt — behave as unpaired (rotation then rejects, pairing still works)
      }
    }
  }

  get(): PairedHub | null {
    return this.state ? { ...this.state } : null;
  }

  record(hubServerId: string, fleetName?: string): void {
    this.state = { hubServerId, ...(fleetName ? { fleetName } : {}), at: new Date().toISOString() };
    writeFileSync(this.file, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
  }
}

// ─── Caller identity (§7 · HJ-37) ──────────────────────────────────────────────────────────────

/**
 * How much this daemon trusts the caller. Mirrors `Tailscale.peerTrust` on the macOS side so the two
 * implementations stay recognisably the same gate.
 *  - `sameUser`  — proven to be this node's own tailnet user.
 *  - `unknown`   — `whois` couldn't resolve the peer. Permitted for a CODE-gated pair (matching
 *                  `notOtherUser` in Pairing.swift:118), never for identity-gated rotation.
 *  - `otherUser` — a DIFFERENT tailnet user. Always rejected, even with a correct code.
 */
export type PeerTrust = "sameUser" | "unknown" | "otherUser";

export interface IdentityResult {
  trust: PeerTrust;
  /** Set when the request must be rejected outright, regardless of the code. */
  reject?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

/** Tailscale's own address space: CGNAT 100.64.0.0/10 and the ULA prefix fd7a:115c:a1e0::/48. */
export function isTailnetAddress(ip: string): boolean {
  const addr = ip.replace(/^::ffff:/i, "").replace(/%.*$/, "");
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
  return /^fd7a:115c:a1e0:/i.test(addr);
}

export function isLoopbackAddress(ip: string): boolean {
  return LOOPBACK.has(ip.replace(/%.*$/, "").toLowerCase());
}

export interface IdentityOpts {
  /** The socket's real peer address (`Bun.serve`'s `requestIP`). Undefined ⇒ we can't tell ⇒ reject. */
  peerAddress: string | undefined;
  /** The `Tailscale-User-Login` request header, verbatim (or null). */
  headerLogin: string | null;
  /** This node's own tailnet login, e.g. from `tailscale status --json`. */
  selfLogin: () => Promise<string | null>;
  /** `tailscale whois <ip>` → that peer's login, or null when it can't be resolved. */
  whois: (ip: string) => Promise<string | null>;
}

/**
 * Resolve who is calling — **branching on the peer address first, never on the header** (HJ-37).
 *
 * `Tailscale-User-Login` is trustworthy only because `tailscale serve` injects it; it is NOT an
 * authenticated field on the wire. `setup_serve` (service.sh:134) falls back to binding the tailnet IP
 * directly when serve is unavailable (the sandboxed App Store Tailscale), and in that mode ANY tailnet
 * peer can set the header itself. Checking the header first would let a forged header override the
 * `whois` result and defeat the identity check entirely.
 *
 * In one line: **an inbound `Tailscale-User-Login` is evidence only from loopback, and loopback is
 * evidence only with the header.**
 */
export async function resolveCallerIdentity(opts: IdentityOpts): Promise<IdentityResult> {
  const peer = opts.peerAddress;
  if (!peer) return { trust: "otherUser", reject: "unknown caller address" };

  // 1. Loopback — the serve-mode case: `tailscale serve` terminated TLS and proxied over loopback.
  if (isLoopbackAddress(peer)) {
    const header = opts.headerLogin?.trim();
    if (!header) {
      // NOT "unknown identity" — an unauthenticated local process is what presents this. It's a caller
      // that bypassed the proxy, so it gets nothing (§7 branch 1).
      return { trust: "otherUser", reject: "local caller without a Tailscale identity" };
    }
    const self = (await opts.selfLogin())?.trim();
    if (!self) return { trust: "unknown" }; // can't compare — fall back to the code-only posture
    return self.toLowerCase() === header.toLowerCase()
      ? { trust: "sameUser" }
      : { trust: "otherUser", reject: "different tailnet user" };
  }

  // 2. A tailnet peer — the direct-bind case. The header here can ONLY be caller-supplied, so it is
  //    ignored entirely and `whois` on the real peer IP decides.
  if (isTailnetAddress(peer)) {
    const [self, peerLogin] = await Promise.all([opts.selfLogin(), opts.whois(peer)]);
    if (!peerLogin) return { trust: "unknown" }; // whois unavailable → code-only (Pairing.swift:118)
    if (!self) return { trust: "unknown" };
    return self.trim().toLowerCase() === peerLogin.trim().toLowerCase()
      ? { trust: "sameUser" }
      : { trust: "otherUser", reject: "different tailnet user" };
  }

  // 3. Neither loopback nor a tailnet address — an unexpected source. Reject.
  return { trust: "otherUser", reject: "caller is not on the tailnet" };
}

// ─── Tailscale identity lookups (the production seams) ─────────────────────────────────────────

const TAILSCALE_BINS = [
  "tailscale",
  "/usr/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

async function runTailscale(args: string[]): Promise<string | null> {
  for (const bin of TAILSCALE_BINS) {
    try {
      const p = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(p.stdout).text();
      await p.exited;
      if (p.exitCode === 0 && out.trim()) return out;
    } catch {
      /* not at this path / not runnable — try the next */
    }
  }
  return null;
}

/** This node's own tailnet login (`Self.UserID` → `User[id].LoginName`). */
export async function tailscaleSelfLogin(): Promise<string | null> {
  const json = await runTailscale(["status", "--json"]);
  if (!json) return null;
  try {
    const s = JSON.parse(json) as { Self?: { UserID?: number }; User?: Record<string, { LoginName?: string }> };
    const uid = s.Self?.UserID;
    if (uid === undefined) return null;
    return s.User?.[String(uid)]?.LoginName ?? null;
  } catch {
    return null;
  }
}

/** `tailscale whois --json <ip>` → the peer's login, or null when it can't be resolved. */
export async function tailscaleWhois(ip: string): Promise<string | null> {
  const json = await runTailscale(["whois", "--json", ip]);
  if (!json) return null;
  try {
    return (JSON.parse(json) as { UserProfile?: { LoginName?: string } }).UserProfile?.LoginName ?? null;
  } catch {
    return null;
  }
}
