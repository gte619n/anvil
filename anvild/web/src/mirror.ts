// ── Durable conversation event mirror (comprehensive-offline spec §4.1, Phase 1) ──────────────────
// A per-session mirror of the daemon's persisted event log, stored in IndexedDB, so ANY recently-active
// session (not just the last-viewed one) is fully readable offline. It supersedes convoCache as the
// SOURCE OF TRUTH for offline paint: convoCache stays only as a rendered-HTML paint accelerator.
//
// Shape mirrors the server's own resume model — a base snapshot blob + a seq-keyed delta tail — because
// folded snapshots carry no per-event seqs (verified against eventlog/log.ts). Render = replay
// base, then tail in seq order, through the SAME renderer the wire snapshot uses.
//
// Completeness is a PULL-derived property (spec §2): the mirror is "complete as of" the moment a
// reconciliation observed server.lastSeq === meta.lastSeq under a matching epoch. We never infer
// completeness from local seq contiguity — the log has legitimate seq gaps (transient events mint seqs
// but aren't persisted), so a gap is ambiguous and only a pull can resolve it.

import type { ConversationEvent, Epoch, Seq, ServerEvent } from "../../protocol";

const DB_NAME = "anvil-mirror"; // [D1.1] own DB, independent of convoCache's "anvil" — no version coordination
const META = "meta";
const BASE = "base";
const TAIL = "tail";
const INDEX_KEY = "anvil.mirror.index"; // sync boot hint: which sessions have a mirror

// [D1.5] Caps (spec OD-2). Eviction is LRU by lastActivityAt; pinned sessions are exempt.
export const MIRROR_MAX_SESSIONS = 50;
export const MIRROR_MAX_BYTES = 256 * 1024 * 1024;
export const TAIL_COMPACT_THRESHOLD = 500; // beyond this many tail events, re-snapshot to fold them away

export interface MirrorMeta {
  sessionId: string;
  epoch: Epoch;
  baseSeq: Seq; // the lastSeq the stored base snapshot covers (0 = no base yet)
  lastSeq: Seq; // highest seq applied (base or tail); tail spans (baseSeq, lastSeq]
  serverUrl: string;
  lastActivityAt: string; // eviction ordering
  bytes: number; // approx stored size (base + tail), maintained on write
  completeAt: string; // last reconciliation that observed server.lastSeq === lastSeq (empty = never)
  tailCount: number; // number of tail entries (compaction input)
}

/** The persistable event kinds — exactly the set the server folds into a snapshot (eventlog/log.ts).
 *  Everything else (status, assistant.delta, tool.use, permission/question, error, usage) is transient
 *  and never mirrored, so client and server agree on what "durable" means. */
export function foldEvent(e: ServerEvent): ConversationEvent | null {
  // Mirrors eventlog/log.ts `snapshot()` exactly — same fields, same 5 kinds.
  switch (e.type) {
    case "message.user":
      return { kind: "user", ts: e.ts, rendered: e.rendered, attachments: e.attachments ?? [] };
    case "assistant.message":
      return { kind: "assistant", ts: e.ts, blocks: e.blocks };
    case "tool.result":
      return { kind: "tool_result", ts: e.ts, toolUseId: e.toolUseId, content: e.content, isError: e.isError, ...(e.images ? { images: e.images } : {}) };
    case "result":
      return { kind: "result", ts: e.ts, stopReason: e.stopReason, usage: e.usage };
    case "file.offer":
      return { kind: "file_offer", ts: e.ts, file: e.file };
    default:
      return null; // transient — not part of the durable mirror
  }
}

// ── Storage plumbing: IndexedDB with an in-memory fallback (jsdom tests / private mode) ─────────────
const hasIndexedDb = typeof indexedDB !== "undefined";
const memMeta = new Map<string, MirrorMeta>();
const memBase = new Map<string, ConversationEvent[]>();
const memTail = new Map<string, Map<number, ConversationEvent>>(); // sessionId → seq → event

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META);
        if (!d.objectStoreNames.contains(BASE)) d.createObjectStore(BASE);
        if (!d.objectStoreNames.contains(TAIL)) d.createObjectStore(TAIL); // out-of-line [sessionId, seq] keys
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return db().then((d) => d.transaction(name, mode).objectStore(name));
}
function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function loadIndex(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(INDEX_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function saveIndex(s: Set<string>): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify([...s]));
  } catch {
    /* quota — the store copy is still authoritative */
  }
}
function addToIndex(id: string): void {
  const s = loadIndex();
  if (!s.has(id)) {
    s.add(id);
    saveIndex(s);
  }
}
function removeFromIndex(id: string): void {
  const s = loadIndex();
  if (s.delete(id)) saveIndex(s);
}
/** [D1.2] A resume watermark must never outlive the mirror it points into — else attach would
 *  delta-resume against an empty base. Drop these whenever the mirror for `id` goes away. */
function dropResumeWatermark(id: string): void {
  try {
    localStorage.removeItem(`anvil.epoch.${id}`);
    localStorage.removeItem(`anvil.seq.${id}`);
  } catch {
    /* best-effort */
  }
}

function approxBytes(v: unknown): number {
  try {
    return JSON.stringify(v).length;
  } catch {
    return 0;
  }
}

async function readTailSorted(id: string): Promise<{ seq: number; event: ConversationEvent }[]> {
  if (!hasIndexedDb) {
    const m = memTail.get(id);
    if (!m) return [];
    return [...m.entries()].map(([seq, event]) => ({ seq, event })).sort((a, b) => a.seq - b.seq);
  }
  const s = await store(TAIL, "readonly");
  const range = IDBKeyRange.bound([id, -Infinity], [id, Infinity]);
  const out: { seq: number; event: ConversationEvent }[] = [];
  return new Promise((resolve, reject) => {
    const req = s.openCursor(range);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) {
        out.sort((a, b) => a.seq - b.seq);
        resolve(out);
        return;
      }
      out.push({ seq: (cur.key as [string, number])[1], event: cur.value as ConversationEvent });
      cur.continue();
    };
  });
}

async function clearTailUpTo(id: string, maxSeqInclusive: number): Promise<void> {
  if (!hasIndexedDb) {
    const m = memTail.get(id);
    if (m) for (const seq of [...m.keys()]) if (seq <= maxSeqInclusive) m.delete(seq);
    return;
  }
  const s = await store(TAIL, "readwrite");
  const range = IDBKeyRange.bound([id, -Infinity], [id, maxSeqInclusive]);
  await new Promise<void>((resolve, reject) => {
    const req = s.openCursor(range);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) {
        resolve();
        return;
      }
      cur.delete();
      cur.continue();
    };
  });
}

async function putMeta(m: MirrorMeta): Promise<void> {
  if (!hasIndexedDb) {
    memMeta.set(m.sessionId, m);
  } else {
    const s = await store(META, "readwrite");
    await wrap(s.put(m, m.sessionId));
  }
  addToIndex(m.sessionId);
}

export const mirror = {
  /** Synchronous boot hint (from the localStorage index) — is there a mirror for this session? */
  has(id: string): boolean {
    return loadIndex().has(id);
  },
  keys(): string[] {
    return [...loadIndex()];
  },

  async getMeta(id: string): Promise<MirrorMeta | null> {
    try {
      if (!hasIndexedDb) return memMeta.get(id) ?? null;
      const s = await store(META, "readonly");
      return (await wrap(s.get(id) as IDBRequest<MirrorMeta | undefined>)) ?? null;
    } catch {
      return null;
    }
  },

  /** Replace the base from a fresh snapshot (establishes or resets the mirror). Clears folded tail
   *  entries now covered by the base. */
  async applySnapshot(
    id: string,
    snap: { events: ConversationEvent[]; lastSeq: Seq; epoch: Epoch },
    serverUrl: string,
    lastActivityAt: string,
  ): Promise<void> {
    try {
      if (!hasIndexedDb) {
        memBase.set(id, snap.events);
      } else {
        const s = await store(BASE, "readwrite");
        await wrap(s.put(snap.events, id));
      }
      await clearTailUpTo(id, snap.lastSeq);
      const remainingTail = await readTailSorted(id);
      const tailBytes = remainingTail.reduce((n, t) => n + approxBytes(t.event), 0);
      const lastSeq = Math.max(snap.lastSeq, remainingTail.at(-1)?.seq ?? 0);
      await putMeta({
        sessionId: id,
        epoch: snap.epoch,
        baseSeq: snap.lastSeq,
        lastSeq,
        serverUrl,
        lastActivityAt,
        bytes: approxBytes(snap.events) + tailBytes,
        completeAt: "",
        tailCount: remainingTail.length,
      });
    } catch {
      /* best-effort — a snapshot still loads from the daemon; correctness is pull-derived */
    }
  },

  /** Extend an existing mirror with one durable delta event. [D1.4] A lone delta with no base is
   *  skipped — a tail can't stand without a base. Epoch mismatch invalidates the mirror (lineage
   *  reset): the caller's next snapshot rebuilds it. Returns false when nothing was applied. */
  async applyEvent(id: string, seq: number, e: ServerEvent, epoch: Epoch, serverUrl: string, lastActivityAt: string): Promise<boolean> {
    const folded = foldEvent(e);
    if (!folded) return false; // transient — not mirrored
    try {
      const meta = await this.getMeta(id);
      if (!meta || meta.baseSeq === 0) return false; // [D1.4] no base yet
      if (meta.epoch !== epoch) {
        await this.invalidate(id); // lineage reset — drop stale lineage, await a fresh snapshot
        return false;
      }
      if (seq <= meta.lastSeq) return true; // idempotent: already applied (keyed by seq)
      if (!hasIndexedDb) {
        let m = memTail.get(id);
        if (!m) memTail.set(id, (m = new Map()));
        m.set(seq, folded);
      } else {
        const s = await store(TAIL, "readwrite");
        await wrap(s.put(folded, [id, seq]));
      }
      await putMeta({ ...meta, lastSeq: seq, serverUrl, lastActivityAt, bytes: meta.bytes + approxBytes(folded), tailCount: meta.tailCount + 1 });
      return true;
    } catch {
      return false;
    }
  },

  /** The full transcript as ConversationEvents (base ++ folded tail, seq order) for offline replay
   *  through renderSnapshotEvents. Null when there's nothing mirrored. */
  async read(id: string): Promise<ConversationEvent[] | null> {
    try {
      const base = !hasIndexedDb ? memBase.get(id) ?? null : (await wrap((await store(BASE, "readonly")).get(id) as IDBRequest<ConversationEvent[] | undefined>)) ?? null;
      const tail = await readTailSorted(id);
      if (!base && tail.length === 0) return null;
      return [...(base ?? []), ...tail.map((t) => t.event)];
    } catch {
      return null;
    }
  },

  /** Number of tail events (compaction threshold input). */
  async tailCount(id: string): Promise<number> {
    return (await this.getMeta(id))?.tailCount ?? 0;
  },

  /** Mark the mirror verified-complete IFF the server's watermark matches what we hold under the same
   *  epoch (spec §2, anti-gaming guard). This is the ONLY path that sets completeAt. Returns whether
   *  the mirror is complete for that watermark. */
  async markComplete(id: string, serverEpoch: Epoch, serverLastSeq: Seq, at: string): Promise<boolean> {
    const meta = await this.getMeta(id);
    if (!meta) return false;
    const complete = meta.epoch === serverEpoch && meta.lastSeq === serverLastSeq;
    if (complete && meta.completeAt !== at) await putMeta({ ...meta, completeAt: at });
    return complete;
  },

  /** Advance the mirror's coverage watermark to `lastSeq` after a prefetch/resume has applied every
   *  DURABLE event up to it. Necessary because the server's lastSeq counts transient events (status,
   *  deltas) that are never mirrored — without this, meta.lastSeq would forever trail the watermark by
   *  the trailing transient seqs and the mirror could never be marked complete. Epoch-guarded. */
  async setCovered(id: string, epoch: Epoch, lastSeq: Seq): Promise<void> {
    const meta = await this.getMeta(id);
    if (!meta || meta.epoch !== epoch || lastSeq <= meta.lastSeq) return;
    await putMeta({ ...meta, lastSeq });
  },

  /** Lineage reset: drop base + tail + meta but keep nothing stale. Same as delete for storage; kept
   *  as a distinct name for call-site intent. */
  async invalidate(id: string): Promise<void> {
    await this.delete(id);
  },

  /** Forget a session's mirror entirely (killed/purged/evicted). Also drops its resume watermark
   *  [D1.2] so a later attach can't delta-resume against a mirror that no longer exists. */
  async delete(id: string): Promise<void> {
    removeFromIndex(id);
    dropResumeWatermark(id);
    try {
      if (!hasIndexedDb) {
        memMeta.delete(id);
        memBase.delete(id);
        memTail.delete(id);
        return;
      }
      await wrap((await store(META, "readwrite")).delete(id));
      await wrap((await store(BASE, "readwrite")).delete(id));
      await clearTailUpTo(id, Infinity);
    } catch {
      /* best-effort */
    }
  },

  /** Migrate an optimistic (offline-created) session's mirror to its real id once the server realizes
   *  it — mirrors convoCache.move. */
  async move(from: string, to: string): Promise<void> {
    const meta = await this.getMeta(from);
    if (!meta) return;
    const base = !hasIndexedDb ? memBase.get(from) ?? [] : (await wrap((await store(BASE, "readonly")).get(from) as IDBRequest<ConversationEvent[] | undefined>)) ?? [];
    const tail = await readTailSorted(from);
    if (!hasIndexedDb) {
      memBase.set(to, base);
      const m = new Map<number, ConversationEvent>();
      for (const t of tail) m.set(t.seq, t.event);
      memTail.set(to, m);
    } else {
      await wrap((await store(BASE, "readwrite")).put(base, to));
      const s = await store(TAIL, "readwrite");
      for (const t of tail) await wrap(s.put(t.event, [to, t.seq]));
    }
    await putMeta({ ...meta, sessionId: to });
    await this.delete(from);
  },

  /** Enforce the LRU caps. `keep` (active + outbox-pinned sessions) is never evicted. Returns the
   *  count evicted (telemetry input). */
  async evictLRU(keep: Set<string>): Promise<number> {
    const metas: MirrorMeta[] = [];
    for (const id of this.keys()) {
      const m = await this.getMeta(id);
      if (m) metas.push(m);
    }
    metas.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? -1 : a.lastActivityAt > b.lastActivityAt ? 1 : 0)); // oldest first
    let count = metas.length;
    let bytes = metas.reduce((n, m) => n + m.bytes, 0);
    let evicted = 0;
    for (const m of metas) {
      if (count <= MIRROR_MAX_SESSIONS && bytes <= MIRROR_MAX_BYTES) break;
      if (keep.has(m.sessionId)) continue;
      await this.delete(m.sessionId);
      count -= 1;
      bytes -= m.bytes;
      evicted += 1;
    }
    return evicted;
  },
};
