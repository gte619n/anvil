/**
 * [Phase 3 / BE-7] Per-session file-change watching (arch §8.1), extracted from Supervisor.
 *
 * Watches the specific file `fs.read` resolved (subdir match included) and emits a debounced
 * `fs.changed` when it changes, so an open reader/editor live-updates. The watch primitive, the
 * file locator, and the content reader are injected so dedup/debounce/cleanup are unit-testable; the
 * default watch uses node's `watchFile`/`unwatchFile`.
 */
import { unwatchFile, watchFile } from "node:fs";
import type { FileContent } from "@protocol";

export interface WatchSession {
  readonly cwd: string;
  emit(body: { type: "fs.changed"; content: FileContent }): void;
}

/** Register a watch on an absolute path; returns a stop function. */
export type WatchPrimitive = (abs: string, onChange: () => void) => () => void;

const defaultWatch: WatchPrimitive = (abs, onChange) => {
  watchFile(abs, { interval: 1000 }, onChange);
  return () => unwatchFile(abs, onChange);
};

export class FileWatchManager {
  private readonly watchers = new Map<string, () => void>(); // `${sessionId}:${path}` → stop fn

  constructor(
    /** Resolve a session (throws if it doesn't exist — mirrors Supervisor.require). */
    private readonly resolve: (sessionId: string) => WatchSession,
    /** Locate what `path` resolves to under the worktree. Only a single-file match carries `abs`
     *  (an ambiguous basename resolves to `choices` with no single file to watch). */
    private readonly locate: (cwd: string, path: string) => { kind: string; abs?: string },
    /** Read + render the file's current content for the change event. */
    private readonly readContent: (sessionId: string, path: string) => FileContent,
    private readonly watch: WatchPrimitive = defaultWatch,
    /** Debounce so a burst of writes coalesces into one emit (250ms in the daemon). */
    private readonly debounceMs = 250,
  ) {}

  add(sessionId: string, path: string): void {
    const key = `${sessionId}:${path}`;
    if (this.watchers.has(key)) return;
    const s = this.resolve(sessionId);
    let located: { kind: string; abs?: string };
    try {
      located = this.locate(s.cwd, path);
    } catch {
      return; // not found / not yet created — nothing to watch (read already reported the error)
    }
    // Only a single-file match has an `abs` to watch; an ambiguous basename resolves to choices.
    if (located.kind !== "file" || located.abs === undefined) return;
    const abs = located.abs;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          s.emit({ type: "fs.changed", content: this.readContent(sessionId, path) });
        } catch {
          /* file deleted / unreadable — ignore */
        }
      }, this.debounceMs);
    };
    this.watchers.set(key, this.watch(abs, onChange));
  }

  unwatch(sessionId: string, path: string): void {
    const key = `${sessionId}:${path}`;
    this.watchers.get(key)?.();
    this.watchers.delete(key);
  }

  clear(sessionId: string): void {
    for (const [key, stop] of this.watchers) {
      if (key.startsWith(`${sessionId}:`)) {
        stop();
        this.watchers.delete(key);
      }
    }
  }
}
