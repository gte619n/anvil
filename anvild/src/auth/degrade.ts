import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mask } from "./env-file";
import { checkAuth } from "./guard";

/**
 * Auto-degrade on credential failure (headless-join §4.6 · HJ-23/HJ-28/HJ-35).
 *
 * A token that is well-formed but expired/revoked can't be caught statically — the guard only checks
 * shape. So it's caught at USE: an auth-class (401/403) spawn failure twice in a row flips the daemon
 * into the same degraded state an absent token produces, which self-presents as the setup/pairing
 * screen and is recovered by re-pairing. Network, timeout, and rate-limit failures never count —
 * degrading on those would let a flaky link log the machine out.
 *
 * ### Why a marker file
 * Clearing `process.env` alone does NOT survive a restart: the launcher does `set -a; . ~/.config/anvil/env`
 * on every start, and `loadPersistedClaudeToken()` reloads that key even when it doesn't. Without a
 * durable marker the daemon comes back looking authed, the takeover screen vanishes, and the box
 * re-degrades only after burning two more turns — on every reboot. The marker is read at boot BEFORE
 * the guard and, when present, wins over whatever the env file carried.
 *
 * The marker is state, not a security control: deleting it by hand and restarting is a legitimate
 * "I fixed the env file myself" escape hatch, exactly as trusted as editing the env file.
 */

export const CLAUDE_TOKEN_ENV_KEY = "CLAUDE_CODE_OAUTH_TOKEN";

/** Consecutive auth-class turn failures before the daemon degrades itself (HJ-28). */
export const DEGRADE_AFTER_CONSECUTIVE_AUTH_FAILURES = 2;

export interface DegradeMarker {
  at: string; // ISO8601
  reason: string;
  /** `mask()`ed preview of the token that was in play — never the raw secret (§8.5). */
  masked?: string;
}

/** `<stateDir>/auth-degraded` — mode 600, written only by the auto-degrade path. */
export function degradeMarkerPath(stateDir: string): string {
  return join(stateDir, "auth-degraded");
}

export function readDegradeMarker(stateDir: string): DegradeMarker | null {
  const file = degradeMarkerPath(stateDir);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<DegradeMarker>;
    return { at: String(raw.at ?? ""), reason: String(raw.reason ?? "auth failure"), ...(raw.masked ? { masked: String(raw.masked) } : {}) };
  } catch {
    // Present but unreadable/corrupt still means "we degraded" — the file's existence is the signal.
    return { at: "", reason: "auth failure (unreadable marker)" };
  }
}

export function writeDegradeMarker(stateDir: string, reason: string, token?: string): DegradeMarker {
  mkdirSync(stateDir, { recursive: true });
  const marker: DegradeMarker = {
    at: new Date().toISOString(),
    reason,
    ...(token && token.trim() ? { masked: mask(token) } : {}),
  };
  writeFileSync(degradeMarkerPath(stateDir), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  return marker;
}

/** Remove the marker. Returns true if one was actually there. */
export function clearDegradeMarker(stateDir: string): boolean {
  const file = degradeMarkerPath(stateDir);
  if (!existsSync(file)) return false;
  try {
    rmSync(file);
  } catch {
    return false;
  }
  return true;
}

// ─── Process-wide binding ──────────────────────────────────────────────────────────────────────
// `setClaudeToken()` (a direct paste), a successful pair, and a successful rotation must all clear the
// marker, but none of them knows the stateDir. Bind it once at startup so those credential-write paths
// can clear without threading a directory through every call site.

let boundStateDir: string | undefined;

/** Bind the state dir the marker lives in (called once from `createServer`). */
export function bindDegradeStateDir(stateDir: string): void {
  boundStateDir = stateDir;
}
export function degradeStateDir(): string | undefined {
  return boundStateDir;
}

/** Clear the marker for the bound state dir — the "a credential was successfully written" hook.
 *  No-op (and safe) before `bindDegradeStateDir`, e.g. in unit tests that only exercise the store. */
export function clearBoundDegradeMarker(): boolean {
  return boundStateDir ? clearDegradeMarker(boundStateDir) : false;
}

/**
 * Consult the marker at boot, BETWEEN `loadPersistedClaudeToken()` and the §3 guard. Present ⇒ this
 * machine is degraded regardless of what the env file carried, so the loaded token is dropped from
 * `process.env` again and no spawn can pick it up. The persisted env-file value is deliberately left
 * alone so the operator can inspect it; re-pairing overwrites it (HJ-10/HJ-27).
 */
export function applyDegradeMarkerAtBoot(stateDir: string, env: NodeJS.ProcessEnv = process.env): DegradeMarker | null {
  const marker = readDegradeMarker(stateDir);
  if (!marker) return null;
  delete env[CLAUDE_TOKEN_ENV_KEY];
  return marker;
}

// ─── Failure classification ────────────────────────────────────────────────────────────────────

/**
 * Is this turn failure an explicit CREDENTIAL rejection (HJ-28)? Deliberately narrow: only 401/403-class
 * signals count. A 429, a socket hang-up, or a timeout must never degrade the machine — those are
 * transient and would otherwise let a flaky link log the box out of its own fleet.
 */
export function isAuthClassFailure(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  if (!msg) return false;
  // Explicit non-auth rejections that can carry auth-ish words in a wrapper message.
  if (/\b(429|rate[_ -]?limit|overloaded|timed? ?out|timeout|econnrefused|econnreset|enotfound|etimedout|socket hang up|network)\b/.test(msg)) {
    return false;
  }
  return /\b(401|403)\b/.test(msg) || /(unauthorized|forbidden|authentication_error|invalid[_ ]api[_ ]key|invalid bearer|oauth token (has )?expired|token (has )?expired|revoked)/.test(msg);
}

/**
 * Counts consecutive auth-class turn failures and flips the daemon to degraded on the Nth (HJ-28).
 * Owned by the supervisor: `recordTurnSuccess()` on every completed turn, `recordTurnFailure()` on
 * every turn that threw. Degrading clears the live token from `process.env` (so the next spawn refuses
 * rather than retrying a dead credential), writes the marker, and fires `onDegrade` for the notification.
 */
export class AuthDegradeTracker {
  private consecutive = 0;
  /** True once an alert has been emitted for the CURRENT degraded episode (HJ-12/HJ-33 coalescing). */
  private alerted = false;

  constructor(
    private readonly stateDir: string,
    private readonly onDegrade: (marker: DegradeMarker) => void = () => {},
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Degraded == "no usable token, but not a §3 violation". Derived from the env rather than stored,
   *  so it can never disagree with what `/api/health` reports. */
  degraded(): boolean {
    const s = checkAuth(this.env as Record<string, string | undefined>);
    return !s.fatal && !s.subscriptionAuthOk;
  }

  recordTurnSuccess(): void {
    this.consecutive = 0;
  }

  /** Returns the marker if THIS failure crossed the threshold, else null. */
  recordTurnFailure(err: unknown): DegradeMarker | null {
    if (!isAuthClassFailure(err)) {
      // A non-auth failure breaks the streak: two 401s separated by a timeout are not "consecutive".
      this.consecutive = 0;
      return null;
    }
    this.consecutive += 1;
    if (this.consecutive < DEGRADE_AFTER_CONSECUTIVE_AUTH_FAILURES) return null;
    return this.degrade(`${this.consecutive} consecutive auth failures (401/403)`);
  }

  /** Flip to degraded now: drop the live token, persist the marker, notify once. */
  degrade(reason: string): DegradeMarker {
    const token = this.env[CLAUDE_TOKEN_ENV_KEY];
    delete this.env[CLAUDE_TOKEN_ENV_KEY];
    const marker = writeDegradeMarker(this.stateDir, reason, token);
    this.consecutive = 0;
    this.alerted = false;
    console.error(`[anvild] ⚠️  auth degraded — ${reason}. Pair this machine again (or set a token in Settings → Auth).`);
    this.onDegrade(marker);
    return marker;
  }

  /** A credential was successfully written (paste, pair, or rotation): leave degraded mode. */
  recover(): void {
    this.consecutive = 0;
    this.alerted = false;
    clearDegradeMarker(this.stateDir);
  }

  /** True the FIRST time it's called in a degraded episode — the "exactly one alert" gate for
   *  suppressed scheduled work (HJ-12). Resets when the machine recovers or re-degrades. */
  claimEpisodeAlert(): boolean {
    if (this.alerted) return false;
    this.alerted = true;
    return true;
  }
}
