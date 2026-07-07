import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LapoTokens, LapoEntryEndpoint } from "./lapo";

/**
 * Persisted lapo (OAuth2 authorization-code) connection state. Lives at
 * `<stateDir>/integrations/lapo.json` (mode 0600, like the Todoist token and VAPID keys). Holds the
 * access/refresh tokens plus a short-lived `pending` handshake (the CSRF `state` + redirect_uri) that
 * spans the browser round-trip between "begin auth" and the OAuth callback.
 */
export interface LapoState {
  accessToken?: string;
  refreshToken?: string;
  /** Absolute epoch-ms expiry of the access token (from the token endpoint's `expires_in`). */
  expiresAt?: number;
  tokenType?: string;
  /** Discovered token endpoint (RFC 8414), stored so refreshes don't re-run discovery. */
  tokenEndpoint?: string;
  /** Discovered entry endpoint (RFC 9728 `x-lapo-entry`), stored so posting a report doesn't re-discover. */
  entry?: LapoEntryEndpoint;
  /** When the connection was first authorized. */
  connectedAt?: string;
  /** Cached account label for display. */
  account?: string;
  /** In-flight OAuth handshake, cleared once the callback consumes it. Carries the discovered token
   *  endpoint + PKCE verifier so the code exchange uses exactly what the authorize step used. */
  pending?: { state: string; redirectUri: string; startedAt: number; codeVerifier?: string; tokenEndpoint?: string };
}

/** A pending OAuth handshake is only valid for a few minutes — a stale one is treated as absent. */
const PENDING_AUTH_TTL_MS = 10 * 60_000;

/**
 * Persisted Todoist connection state. Lives at `<stateDir>/integrations/todoist.json`
 * (mode 0600, like the Web Push VAPID keys) — the token is daemon-wide and must survive
 * session/worktree churn, so it does NOT belong in a session or environment record.
 */
export interface TodoistState {
  /** Personal API token (Settings → Integrations → Developer). Sent as `Bearer <token>`. */
  accessToken: string;
  /** When the token was last successfully validated against the API. */
  connectedAt?: string;
  /** Cached account label for display (the user's email/full name from /user). */
  account?: string;
  /** Cursor for the Sync API's incremental sync; `*` (or undefined) means "full sync next". */
  syncToken?: string;
  /** Last time a sync completed. */
  lastSyncAt?: string;
}

/**
 * Storage for third-party integration credentials/state. Today only Todoist; structured so
 * other integrations can be added as sibling files under `<stateDir>/integrations/`.
 */
export class IntegrationStore {
  private readonly dir: string;
  private readonly todoistFile: string;
  private todoistState: TodoistState | undefined;
  private readonly lapoFile: string;
  private lapoState: LapoState | undefined;

  constructor(stateDir: string) {
    this.dir = join(stateDir, "integrations");
    mkdirSync(this.dir, { recursive: true });
    this.todoistFile = join(this.dir, "todoist.json");
    this.todoistState = this.loadTodoist();
    this.lapoFile = join(this.dir, "lapo.json");
    this.lapoState = this.loadLapo();
  }

  // ── lapo (OAuth2 information-entry integration) ────────────────────────────
  lapo(): LapoState | undefined {
    return this.lapoState ? { ...this.lapoState } : undefined;
  }

  isLapoConnected(): boolean {
    return !!this.lapoState?.accessToken;
  }

  /** Record a fresh set of tokens (post code-exchange), clearing any pending handshake. */
  setLapoTokens(tokens: LapoTokens, account?: string, tokenEndpoint?: string, entry?: LapoEntryEndpoint): void {
    this.lapoState = {
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
      ...(tokens.tokenType ? { tokenType: tokens.tokenType } : {}),
      ...(tokenEndpoint ? { tokenEndpoint } : {}),
      ...(entry ? { entry } : {}),
      connectedAt: new Date().toISOString(),
      ...(account ? { account } : {}),
    };
    this.saveLapo();
  }

  /** Update just the token material after a silent refresh, preserving account/connectedAt. */
  patchLapoTokens(tokens: LapoTokens): void {
    if (!this.lapoState) return;
    this.lapoState = {
      ...this.lapoState,
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      expiresAt: tokens.expiresAt,
      ...(tokens.tokenType ? { tokenType: tokens.tokenType } : {}),
    };
    this.saveLapo();
  }

  /** Cache the discovered entry endpoint on an already-connected state (e.g. discovered lazily on the
   *  first report post for a connection made before resource discovery existed). No-op if not connected. */
  patchLapoEntry(entry: LapoEntryEndpoint): void {
    if (!this.lapoState) return;
    this.lapoState = { ...this.lapoState, entry };
    this.saveLapo();
  }

  /** Stash the CSRF `state` + redirect_uri (and any discovered token endpoint / PKCE verifier) for an
   *  in-flight OAuth handshake. */
  setLapoPendingAuth(state: string, redirectUri: string, extra: { codeVerifier?: string; tokenEndpoint?: string } = {}): void {
    this.lapoState = {
      ...(this.lapoState ?? {}),
      pending: {
        state,
        redirectUri,
        startedAt: Date.now(),
        ...(extra.codeVerifier ? { codeVerifier: extra.codeVerifier } : {}),
        ...(extra.tokenEndpoint ? { tokenEndpoint: extra.tokenEndpoint } : {}),
      },
    };
    this.saveLapo();
  }

  /** Validate + consume a callback's `state`, returning what the token exchange needs (redirect_uri,
   *  plus the discovered token endpoint + PKCE verifier the authorize step used). Returns undefined if
   *  the state doesn't match or the handshake expired. Always clears `pending`. */
  consumeLapoPendingAuth(state: string): { redirectUri: string; codeVerifier?: string; tokenEndpoint?: string } | undefined {
    const pending = this.lapoState?.pending;
    if (this.lapoState) {
      const { pending: _drop, ...rest } = this.lapoState;
      this.lapoState = rest;
      this.saveLapo();
    }
    if (!pending || pending.state !== state) return undefined;
    if (Date.now() - pending.startedAt > PENDING_AUTH_TTL_MS) return undefined;
    return {
      redirectUri: pending.redirectUri,
      ...(pending.codeVerifier ? { codeVerifier: pending.codeVerifier } : {}),
      ...(pending.tokenEndpoint ? { tokenEndpoint: pending.tokenEndpoint } : {}),
    };
  }

  disconnectLapo(): void {
    this.lapoState = undefined;
    if (existsSync(this.lapoFile)) writeFileSync(this.lapoFile, "{}", { mode: 0o600 });
  }

  private loadLapo(): LapoState | undefined {
    if (!existsSync(this.lapoFile)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.lapoFile, "utf8")) as LapoState;
      return parsed.accessToken || parsed.pending ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  private saveLapo(): void {
    writeFileSync(this.lapoFile, JSON.stringify(this.lapoState ?? {}, null, 2), { mode: 0o600 });
  }

  todoist(): TodoistState | undefined {
    return this.todoistState ? { ...this.todoistState } : undefined;
  }

  isTodoistConnected(): boolean {
    return !!this.todoistState?.accessToken;
  }

  /** Persist a new token (and reset sync state — a new account means a fresh full sync). */
  setTodoistToken(accessToken: string, account?: string): void {
    this.todoistState = {
      accessToken: accessToken.trim(),
      connectedAt: new Date().toISOString(),
      account,
    };
    this.saveTodoist();
  }

  /** Merge fields into the existing Todoist state (e.g. after a sync). No-op if not connected. */
  patchTodoist(fields: Partial<TodoistState>): void {
    if (!this.todoistState) return;
    this.todoistState = { ...this.todoistState, ...fields };
    this.saveTodoist();
  }

  disconnectTodoist(): void {
    this.todoistState = undefined;
    if (existsSync(this.todoistFile)) writeFileSync(this.todoistFile, "{}", { mode: 0o600 });
  }

  private loadTodoist(): TodoistState | undefined {
    if (!existsSync(this.todoistFile)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.todoistFile, "utf8")) as Partial<TodoistState>;
      return parsed.accessToken ? (parsed as TodoistState) : undefined;
    } catch {
      return undefined;
    }
  }
  private saveTodoist(): void {
    writeFileSync(this.todoistFile, JSON.stringify(this.todoistState ?? {}, null, 2), { mode: 0o600 });
  }
}
