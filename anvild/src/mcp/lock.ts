/**
 * Exclusive lock for MCP integrations that only one session may drive at a time (mcp-integrations
 * spec §4.5). In memory only: a daemon restart frees every lock, which is correct because every
 * driver is gone. It is a concurrency guard, not a permission, so it applies under `bypass` too.
 *
 * Every method is synchronous, so `acquire` is one check-and-set with no await in between.
 */
export const MCP_LOCK_IDLE_MS = 10 * 60_000;

interface Held {
  sessionId: string;
  lastActivity: number;
}

export type McpLockResult = { ok: true } | { ok: false; heldBy: string };

export class McpLock {
  private readonly held = new Map<string, Held>();

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly idleMs: number = MCP_LOCK_IDLE_MS,
  ) {}

  /** The session holding `integrationId`, if any. A holder silent for `idleMs` no longer holds it. */
  holder(integrationId: string): string | undefined {
    const h = this.held.get(integrationId);
    if (!h) return undefined;
    if (this.clock() - h.lastActivity >= this.idleMs) {
      this.held.delete(integrationId);
      return undefined;
    }
    return h.sessionId;
  }

  /** Take the lock for `sessionId`, or refresh it if that session already holds it. Refused (and left
   *  untouched) when another session holds it. */
  acquire(integrationId: string, sessionId: string): McpLockResult {
    const current = this.holder(integrationId);
    if (current && current !== sessionId) return { ok: false, heldBy: current };
    this.held.set(integrationId, { sessionId, lastActivity: this.clock() });
    return { ok: true };
  }

  /** Mark activity (an approved call or a tool result) so a long call does not count as idle. A no-op
   *  unless `sessionId` is the holder. */
  refresh(integrationId: string, sessionId: string): void {
    if (this.holder(integrationId) === sessionId) this.held.set(integrationId, { sessionId, lastActivity: this.clock() });
  }

  /** Release one integration. With `sessionId`, only if that session is the holder. */
  release(integrationId: string, sessionId?: string): boolean {
    const h = this.held.get(integrationId);
    if (!h || (sessionId !== undefined && h.sessionId !== sessionId)) return false;
    this.held.delete(integrationId);
    return true;
  }

  /** Release everything a session holds (its turn ended, it was reset or deleted). Returns the ids. */
  releaseSession(sessionId: string): string[] {
    const out: string[] = [];
    for (const [id, h] of this.held) {
      if (h.sessionId === sessionId) {
        this.held.delete(id);
        out.push(id);
      }
    }
    return out;
  }

  /** Drop every lock whose holder has gone silent. Returns the released integration ids. */
  sweep(): string[] {
    const out: string[] = [];
    for (const id of [...this.held.keys()]) if (this.holder(id) === undefined) out.push(id);
    return out;
  }
}
