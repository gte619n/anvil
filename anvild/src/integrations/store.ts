import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

  constructor(stateDir: string) {
    this.dir = join(stateDir, "integrations");
    mkdirSync(this.dir, { recursive: true });
    this.todoistFile = join(this.dir, "todoist.json");
    this.todoistState = this.loadTodoist();
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
