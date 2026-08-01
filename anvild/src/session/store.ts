import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session as SessionData } from "@protocol";

export interface PersistedSession {
  data: SessionData;
  lastSeq: number;
  /** Resume lineage token (v4). Absent on rows written by a pre-v4 daemon → the supervisor mints a
   *  fresh one on load, which harmlessly forces one full snapshot on the next client attach. */
  epoch?: string;
}

/**
 * Durable session registry (arch §5). `sessions.json` holds the rows + `lastSeq`; per-
 * session dirs hold future event logs (M6) and worktrees live under `worktrees/`.
 */
export class SessionStore {
  private readonly file: string;

  constructor(private readonly stateDir: string) {
    this.file = join(stateDir, "sessions.json");
    mkdirSync(join(stateDir, "sessions"), { recursive: true });
    mkdirSync(join(stateDir, "worktrees"), { recursive: true });
  }

  loadAll(): PersistedSession[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { sessions?: PersistedSession[] };
      return parsed.sessions ?? [];
    } catch (e) {
      // A truncated/corrupt registry must NOT silently wipe every session. Move it aside so the
      // daemon can still start (with whatever sessions it can otherwise reconstruct) and the bad
      // file is kept for forensics.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        renameSync(this.file, backup);
        console.error(`[store] sessions.json was unreadable (${e instanceof Error ? e.message : e}); backed up to ${backup}`);
      } catch {
        /* best-effort */
      }
      return [];
    }
  }

  /** Atomic write (tmp + rename) so a crash mid-write can never truncate the registry. */
  saveAll(sessions: PersistedSession[]): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions }, null, 2));
    renameSync(tmp, this.file);
  }

  /** Session state dirs present on disk (for restore reconciliation/logging). */
  listSessionDirs(): string[] {
    const dir = join(this.stateDir, "sessions");
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir).filter((name) => {
        try {
          return statSync(join(dir, name)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }

  sessionDir(id: string): string {
    return join(this.stateDir, "sessions", id);
  }
  worktreeRoot(): string {
    return join(this.stateDir, "worktrees");
  }
}
