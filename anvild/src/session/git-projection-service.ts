/**
 * Git projection + PR-badge domain, extracted from Supervisor (P7 slice 4). Owns the per-session git
 * status projection (`s.data.git`), the interactive git commands (status/diff/commit/push/create-pr/
 * merge-pr), the remote-branch resolution, and the async PR-state refresh + fleet-wide sweep. `refreshGit`
 * is local-only (fast); the PR probes go through git.prStatusAsync so a stalled `gh` never freezes the
 * event loop (BE2-1). This is the natural home for the deferred BE2-2/3/5 async-git conversion.
 *
 * Behaviour-preserving: moved verbatim from Supervisor with its session/persistence/broadcast deps
 * injected. The Supervisor delegates gitOp/refreshPrState/refreshAllPrStates/refreshGit here.
 */
import { PROTOCOL_VERSION, type GitCmd, type GitResultEvent, type Session as SessionData } from "@protocol";
import { now } from "../util/envelope";
import * as git from "../git/ops";
import { applyPrBadge, carryPrBadge, gitStatus, isPrSweepEligible, prBadgeFor } from "./worktree";
import { heuristicKind } from "../agent/branch-kind";
import type { Session } from "./session";

export interface GitProjectionDeps {
  /** Resolve a session or throw BadCommand (mirrors Supervisor.require). */
  require: (id: string) => Session;
  getSession: (id: string) => Session | undefined;
  sessions: () => Iterable<Session>;
  persist: () => void;
  broadcastUpdated: (data: SessionData) => void;
}

export class GitProjectionService {
  constructor(private readonly deps: GitProjectionDeps) {}

  /** The remote branch a push should target — the worktree's recorded `remoteBranch`, or a first-time
   *  heuristic (`feature/…` etc.) derived from the session's opening prompt/title, then persisted. */
  private resolveRemoteBranch(s: Session): string | undefined {
    const wt = s.data.worktree;
    if (!wt) return undefined;
    if (wt.remoteBranch) return wt.remoteBranch;
    const existing = git.upstreamRemoteBranch(s.data.cwd);
    wt.remoteBranch = existing ?? `${heuristicKind(s.openingPrompt ?? s.data.title ?? "")}/${wt.branch}`;
    this.deps.persist();
    this.deps.broadcastUpdated(s.data);
    return wt.remoteBranch;
  }

  // Git lifecycle (arch §8): operate on the session worktree, return combined output.
  gitOp(cmd: GitCmd): GitResultEvent {
    const s = this.deps.require(cmd.sessionId);
    const cwd = s.data.cwd;
    const branch = s.data.worktree?.branch ?? "HEAD";
    let ok = true;
    let output = "";
    let url: string | undefined;
    switch (cmd.op) {
      case "status": {
        this.refreshGit(s);
        if (s.data.git) {
          // [BE2-1] The PR-state probe (`gh pr view`, network) used to run SYNCHRONOUSLY here — a single
          // "git status" click could freeze the whole single-threaded daemon for up to NET_TIMEOUT_MS
          // (60s) on a stalled connection. Kick it off the request path via refreshPrState (the async
          // twin, which does the same `gh` probe with Bun.spawn and broadcasts the badge when it
          // resolves). The immediate response carries the local status + last-known PR badge.
          void this.refreshPrState(cmd.sessionId);
          output = `${s.data.git.branch} — ${s.data.git.dirtyFileCount} changed, ${s.data.git.ahead} ahead / ${s.data.git.behind} behind${s.data.git.prState ? ` · PR ${s.data.git.prState}` : ""}`;
        } else {
          output = "(not a git repo)";
        }
        break;
      }
      case "diff": {
        const r = git.diff(cwd);
        ok = r.ok;
        output = r.output;
        break;
      }
      case "commit": {
        const r = git.commit(cwd, cmd.message?.trim() || "update");
        ok = r.ok;
        output = r.output;
        this.refreshGit(s);
        break;
      }
      case "push": {
        const r = git.push(cwd, branch, this.resolveRemoteBranch(s));
        ok = r.ok;
        output = r.output;
        this.refreshGit(s);
        break;
      }
      case "create-pr": {
        const r = git.createPr(cwd, cmd.title?.trim() || s.data.title, cmd.body ?? "");
        ok = r.ok;
        output = r.output;
        url = r.url;
        break;
      }
      case "merge-pr": {
        const r = git.mergePr(cwd, cmd.method ?? "squash", s.data.worktree?.branch, s.data.worktree?.remoteBranch);
        ok = r.ok;
        output = r.output;
        if (r.ok) {
          // The worktree rolled onto a fresh follow-up branch — track it so the restart health
          // check (which compares against worktree.branch) stays happy and work can continue here.
          if (r.newBranch && s.data.worktree) s.data.worktree.branch = r.newBranch;
          this.refreshGit(s); // refresh dirty/ahead and pick up the new current branch (the follow-up)
          if (s.data.git) {
            // Show the merged badge scoped to the current branch (the follow-up after a rollover) so
            // it clears once new work starts — a dirty tree, or another branch switch. See prBadgeFor.
            const badge = prBadgeFor("merged", s.data.git.prUrl, s.data.git.branch, s.data.git.dirtyFileCount);
            applyPrBadge(s.data.git, badge);
          }
          this.deps.persist();
          this.deps.broadcastUpdated(s.data);
        }
        break;
      }
    }
    return { v: PROTOCOL_VERSION, type: "git.result", ts: now(), sessionId: cmd.sessionId, op: cmd.op, ok, output, url };
  }

  refreshGit(s: Session): void {
    const g = gitStatus(s.data.cwd);
    if (g) {
      // gitStatus() is local-only; carry the PR badge learned from gh across refreshes — but it
      // clears once work moves to a new branch, or (for a merged PR) once the tree is dirty again.
      Object.assign(g, carryPrBadge(s.data.git, g));
      const changed = JSON.stringify(s.data.git) !== JSON.stringify(g);
      s.data.git = g;
      if (changed) {
        this.deps.persist();
        this.deps.broadcastUpdated(s.data);
      }
    }
  }

  /** Best-effort, non-blocking PR-state refresh (network via gh), called on attach so a PR merged
   *  outside the app surfaces its badge without opening the git panel. Skips sessions already known
   *  merged (terminal) or without a branch, so the common case costs nothing. */
  async refreshPrState(id: string): Promise<void> {
    const s = this.deps.getSession(id);
    if (!s) return;
    this.refreshGit(s); // local: pick up a branch switch / new changes and clear a stale badge first
    const g = s.data.git;
    // Skip the gh probe for sessions with no branch or already terminal-merged (shared with the sweep).
    if (!g || !isPrSweepEligible(g, s.data.worktree?.branch)) return;
    const pr = await git.prStatusAsync(s.data.cwd);
    const cur = this.deps.getSession(id); // may have changed/closed during the await
    if (!cur?.data.git) return;
    const badge = prBadgeFor(pr.state, pr.url, cur.data.git.branch, cur.data.git.dirtyFileCount);
    if (!applyPrBadge(cur.data.git, badge)) return; // nothing changed → no persist/broadcast
    this.deps.persist();
    this.deps.broadcastUpdated(cur.data);
  }

  private prSweepRunning = false; // a sweep is in flight — don't stack `gh` storms
  private lastPrSweepAt = 0; // throttle: at most one sweep per PR_SWEEP_THROTTLE_MS
  /** Refresh PR badges for EVERY eligible session, not just the one a client has open. The per-session
   *  attach refresh (`refreshPrState`) only covers the session you click into, so a PR merged on
   *  GitHub, from another device, or in another session left the rest of the sidebar's merge badges
   *  frozen at their last-known state. This reconciles the whole list. Bounded concurrency keeps us
   *  from spawning a `gh` per session at once on the single-threaded daemon; `refreshPrState` already
   *  skips terminal-merged and branchless sessions cheaply (no network). */
  async refreshAllPrStates(force = false): Promise<void> {
    if (this.prSweepRunning) return;
    const t = Date.now();
    if (!force && t - this.lastPrSweepAt < 30_000) return; // coalesce bursts (e.g. many clients reconnecting)
    this.prSweepRunning = true;
    this.lastPrSweepAt = t;
    try {
      // Only sessions that could have a live PR worth a network probe: on a branch, and not already
      // terminal-merged on that same branch. Mirrors refreshPrState's own guards to avoid the work.
      const ids = [...this.deps.sessions()]
        .filter((s) => isPrSweepEligible(s.data.git, s.data.worktree?.branch))
        .map((s) => s.id);
      const LIMIT = 4;
      for (let i = 0; i < ids.length; i += LIMIT) {
        await Promise.all(ids.slice(i, i + LIMIT).map((id) => this.refreshPrState(id).catch(() => {})));
      }
    } finally {
      this.prSweepRunning = false;
    }
  }
}
