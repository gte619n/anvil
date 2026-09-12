// ── Greedy background prefetch (comprehensive-offline spec §4.2, Phase 2) ─────────────────────────
// On every (re)connect, after resume.watermarks + session.list land, we pull the history of any session
// whose mirror is behind the server — so sessions the user hasn't opened this boot are still readable
// offline. This is the ROBUSTNESS CORE: the work-list is re-derived from watermarks each connect, so it
// self-heals from any client state (evicted mirror, dropped frames, cold boot). Push (Phase 3) only
// makes it faster; this is what makes it correct.
//
// Discipline (spec §4.2): capability-gated, one in-flight request per server, idle-scheduled so live
// traffic always wins, and abort-the-whole-list on the first timeout/error (never retry-loop a dying
// link — the next connect rebuilds the list from fresh watermarks).

import type { Epoch, Seq, ServerEvent } from "../../protocol";
import { mirror } from "./mirror";

export const PREFETCH_MAX_SESSIONS = 20; // spec OD-3: conservative per-connect breadth

/** Per-session facts the caller (main.ts) supplies from the server's watermarks + routing. */
export interface PrefetchSessionInfo {
  sessionId: string;
  lastActivityAt: string;
  serverEpoch: Epoch;
  serverLastSeq: Seq;
}
export interface PrefetchCandidate extends PrefetchSessionInfo {
  mirrorEpoch: Epoch | null; // null = no mirror yet
  mirrorLastSeq: Seq; // 0 = no mirror
}
export interface PrefetchPlanItem {
  sessionId: string;
  sinceSeq?: number; // delta when set; snapshot when absent
}

/** Pure work-list derivation (unit-tested): the ordered, capped set of history fetches that would bring
 *  each mirror level with its server. Fresh sessions (mirror == server, same epoch) are omitted; a
 *  compatible-prefix mirror → delta (sinceSeq), otherwise a full snapshot. Newest-active first. */
export function planPrefetch(candidates: PrefetchCandidate[], cap = PREFETCH_MAX_SESSIONS): PrefetchPlanItem[] {
  const stale = candidates.filter((c) => c.mirrorEpoch !== c.serverEpoch || c.mirrorLastSeq < c.serverLastSeq);
  stale.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0)); // newest first
  return stale.slice(0, cap).map((c) => {
    const canDelta = c.mirrorEpoch === c.serverEpoch && c.mirrorLastSeq > 0;
    return canDelta ? { sessionId: c.sessionId, sinceSeq: c.mirrorLastSeq } : { sessionId: c.sessionId };
  });
}

export interface PrefetcherDeps {
  /** Does this server advertise the "history" capability? (Gate — an older daemon serves nothing.) */
  supportsHistory: (url: string) => boolean;
  /** Metered/Settings gate (spec §4.2): false on cellular with save-data / prefetch="off". */
  gateAllows: () => boolean;
  /** The sessions routed to this server, with the server's reported {epoch,lastSeq} watermark. Excludes
   *  the active session (it's handled by attach) — the caller filters. */
  sessionsForServer: (url: string) => PrefetchSessionInfo[];
  /** The owning serverUrl + lastActivityAt to stamp on mirror writes for a session. */
  sessionServerUrl: (sessionId: string) => string;
  /** Send session.history and await its cid-correlated response; resolves null on timeout/error. */
  fetchHistory: (url: string, item: PrefetchPlanItem) => Promise<ServerEvent | null>;
  /** Persist a session's resume watermark so a later attach can delta-resume (main.ts epochStore/seqStore). */
  setWatermark: (sessionId: string, epoch: Epoch, lastSeq: Seq) => void;
  /** Yield to idle so background pulls never compete with live rendering. */
  nextTick: () => Promise<void>;
  /** ISO timestamp for completeAt stamps (injectable for tests). */
  now: () => string;
  mark: (key: "prefetchSessions" | "prefetchEvents" | "prefetchAborts" | "shadowDegraded", n?: number) => void;
}

/** The subset of deps needed to write a history response into the mirror (shared by the prefetcher and
 *  the native staged-history apply hook, §4.4a). */
export interface ApplyHistoryDeps {
  sessionServerUrl: (sessionId: string) => string;
  setWatermark: (sessionId: string, epoch: Epoch, lastSeq: Seq) => void;
  now: () => string;
}

/** Apply one history response to the mirror; returns how many events landed. Snapshot → new base;
 *  events → tail extend + coverage advance. Both stamp the resume watermark + completeAt. Exported so
 *  the Android background-sync handoff (§4.4a) can reuse the exact same write path as prefetch. */
export async function applyHistoryToMirror(resp: ServerEvent, deps: ApplyHistoryDeps): Promise<number> {
  const url = (r: { sessionId: string }) => deps.sessionServerUrl(r.sessionId);
  const at = deps.now();
  if (resp.type === "session.history.snapshot") {
    const { sessionId, snapshot } = resp;
    await mirror.applySnapshot(sessionId, { events: snapshot.events, lastSeq: snapshot.lastSeq, epoch: snapshot.epoch }, url(resp), at);
    deps.setWatermark(sessionId, snapshot.epoch, snapshot.lastSeq);
    await mirror.markComplete(sessionId, snapshot.epoch, snapshot.lastSeq, at);
    return snapshot.events.length;
  }
  if (resp.type === "session.history.events") {
    const { sessionId, events, epoch, lastSeq } = resp;
    for (const e of events) {
      const seq = (e as { seq?: number }).seq;
      if (typeof seq === "number") await mirror.applyEvent(sessionId, seq, e, epoch, url(resp), at);
    }
    await mirror.setCovered(sessionId, epoch, lastSeq); // advance past trailing transient seqs
    deps.setWatermark(sessionId, epoch, lastSeq);
    await mirror.markComplete(sessionId, epoch, lastSeq, at);
    return events.length;
  }
  return 0;
}

export function createPrefetcher(deps: PrefetcherDeps) {
  const running = new Set<string>(); // per-server single-flight

  async function run(url: string): Promise<void> {
    if (!deps.supportsHistory(url) || !deps.gateAllows() || running.has(url)) return;
    running.add(url);
    try {
      const infos = deps.sessionsForServer(url);
      const candidates: PrefetchCandidate[] = [];
      for (const info of infos) {
        const meta = await mirror.getMeta(info.sessionId);
        // Already level with the server under the same epoch → mark verified-complete, don't refetch.
        if (meta && meta.epoch === info.serverEpoch && meta.lastSeq >= info.serverLastSeq) {
          await mirror.markComplete(info.sessionId, info.serverEpoch, info.serverLastSeq, deps.now());
          continue;
        }
        // Had a current-lineage mirror yet it's behind → a live shadow frame was shed or missed (spec
        // §4.3, E5). Count it: pull will now reconcile the exact gap. (A cold/lineage-reset mirror is a
        // first-fill, not degradation, so it's excluded.)
        if (meta && meta.epoch === info.serverEpoch && meta.lastSeq > 0 && meta.lastSeq < info.serverLastSeq) deps.mark("shadowDegraded");
        candidates.push({ ...info, mirrorEpoch: meta?.epoch ?? null, mirrorLastSeq: meta?.lastSeq ?? 0 });
      }
      const plan = planPrefetch(candidates);
      let sessions = 0;
      let events = 0;
      for (const item of plan) {
        const resp = await deps.fetchHistory(url, item);
        if (!resp) {
          deps.mark("prefetchAborts"); // stalled/errored link → abandon; next connect rebuilds the list
          break;
        }
        events += await applyHistoryToMirror(resp, deps);
        sessions += 1;
        await deps.nextTick(); // let live rendering breathe between pulls
      }
      if (sessions) deps.mark("prefetchSessions", sessions);
      if (events) deps.mark("prefetchEvents", events);
    } finally {
      running.delete(url);
    }
  }

  return { run };
}
