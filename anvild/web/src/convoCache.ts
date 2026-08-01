// ── Durable conversation cache (incremental-offline-resilience.md Phase 3 / spec D8) ──────────────
// The rendered transcript of the last-viewed session is cached so it's available instantly on reload
// and fully offline. Moved off localStorage into IndexedDB to kill the old 1.5MB cliff (a large
// transcript used to silently drop its cache and force a full snapshot on every reload).
//
// IndexedDB is async, but the attach decision (delta vs snapshot) needs a SYNCHRONOUS "do we have a
// cache for this session?" answer at boot — so we keep a tiny id index in localStorage (`has()`), while
// the bulky HTML lives in IDB. A same-origin in-memory fallback keeps the module working where IDB is
// absent (jsdom tests, private-mode edge cases) without changing the call sites.

const DB_NAME = "anvil";
const STORE = "conversations";
const INDEX_KEY = "anvil.convo.index"; // sync hint: which session ids currently have a cached transcript

const memFallback = new Map<string, string>();
const hasIndexedDb = typeof indexedDB !== "undefined";

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return db().then((d) => d.transaction(STORE, mode).objectStore(STORE));
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
    /* quota — the in-memory/IDB copy is still authoritative */
  }
}

export const convoCache = {
  /** Synchronous hint (from the localStorage index) — does a cached transcript exist for this session?
   *  Drives the delta-vs-snapshot attach decision before the async `get` resolves. */
  has(id: string): boolean {
    return loadIndex().has(id);
  },

  async get(id: string): Promise<string | null> {
    if (!hasIndexedDb) return memFallback.get(id) ?? null;
    try {
      const store = await tx("readonly");
      const v = await wrap(store.get(id) as IDBRequest<string | undefined>);
      return v ?? null;
    } catch {
      return null; // a blocked/failed IDB read must never break the load — fall back to a snapshot
    }
  },

  async set(id: string, html: string): Promise<void> {
    const index = loadIndex();
    index.add(id);
    saveIndex(index);
    if (!hasIndexedDb) {
      memFallback.set(id, html);
      return;
    }
    try {
      const store = await tx("readwrite");
      await wrap(store.put(html, id));
    } catch {
      /* durable cache is best-effort — a snapshot still loads from the daemon */
    }
  },

  async delete(id: string): Promise<void> {
    const index = loadIndex();
    if (index.delete(id)) saveIndex(index);
    memFallback.delete(id);
    if (!hasIndexedDb) return;
    try {
      const store = await tx("readwrite");
      await wrap(store.delete(id));
    } catch {
      /* best-effort */
    }
  },

  /** [WEB2-11] The ids that currently have a cached transcript (from the sync index) — lets a boot
   *  sweep drop cache entries for sessions no longer known. */
  keys(): string[] {
    return [...loadIndex()];
  },

  /** Migrate an optimistic (offline-created) session's cache to its real id once the server realizes it. */
  async move(from: string, to: string): Promise<void> {
    const html = await this.get(from);
    if (html) await this.set(to, html);
    await this.delete(from);
  },
};

/** One-time cleanup: drop the pre-Phase-3 `anvil.convo.*` localStorage blobs (superseded by IDB), so we
 *  reclaim that quota. Best-effort; safe to run on every boot. */
export function migrateLegacyConvoCache(): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("anvil.convo.") && k !== INDEX_KEY) stale.push(k);
    }
    for (const k of stale) localStorage.removeItem(k);
  } catch {
    /* best-effort */
  }
}
