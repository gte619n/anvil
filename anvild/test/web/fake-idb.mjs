// A small in-memory IndexedDB good enough for convoCache + mirror: multiple named databases, keyed
// get/put/delete, and openCursor over IDBKeyRange.bound (incl. compound [string, number] keys, as the
// mirror's tail store uses). Node's jsdom ships no indexedDB, so boot-harness tests install this.
//
// Not spec-complete — just the surface our stores touch. Async callbacks fire on a 0ms timer so the
// success/error handlers the callers attach synchronously are in place first.

/** IDB key comparison (subset): numbers numerically, strings lexically, arrays element-wise. */
function cmp(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = cmp(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
function serialize(key) {
  return JSON.stringify(key);
}

function makeReq(resultFn) {
  const r = {};
  setTimeout(() => {
    try {
      r.result = resultFn();
      r.onsuccess && r.onsuccess({ target: r });
    } catch (e) {
      r.error = e;
      r.onerror && r.onerror({ target: r });
    }
  }, 0);
  return r;
}

function makeStore(map) {
  return {
    get: (key) => makeReq(() => map.get(serialize(key))?.value),
    put: (value, key) => makeReq(() => void map.set(serialize(key), { key, value })),
    delete: (key) => makeReq(() => void map.delete(serialize(key))),
    openCursor(range) {
      const entries = [...map.values()]
        .filter((e) => (!range || (cmp(e.key, range.lower) >= 0 && cmp(e.key, range.upper) <= 0)))
        .sort((a, b) => cmp(a.key, b.key));
      let i = 0;
      const req = {};
      const step = () => {
        if (i >= entries.length) {
          req.result = null;
        } else {
          const e = entries[i];
          req.result = {
            key: e.key,
            value: e.value,
            continue() {
              i += 1;
              setTimeout(step, 0); // advance to the next entry, then re-fire onsuccess
            },
            delete() {
              map.delete(serialize(e.key));
              return makeReq(() => undefined);
            },
          };
        }
        req.onsuccess && req.onsuccess({ target: req });
      };
      setTimeout(step, 0);
      return req;
    },
  };
}

/** Install a fresh in-memory indexedDB (+ IDBKeyRange) onto `w`. `seed` optionally pre-populates:
 *  { "<dbName>": { "<store>": [[key, value], ...] } }. */
export function installFakeIdb(w, seed = {}) {
  const dbs = new Map(); // dbName → { stores: Map<storeName, Map<serKey,{key,value}>> }

  w.IDBKeyRange = {
    bound: (lower, upper) => ({ lower, upper }),
    only: (v) => ({ lower: v, upper: v }),
  };

  w.indexedDB = {
    open(name) {
      let db = dbs.get(name);
      const firstOpen = !db;
      if (!db) {
        db = { stores: new Map() };
        dbs.set(name, db);
        for (const [store, rows] of Object.entries(seed[name] ?? {})) {
          const m = new Map();
          for (const [key, value] of rows) m.set(serialize(key), { key, value });
          db.stores.set(store, m);
        }
      }
      const handle = {
        objectStoreNames: { contains: (n) => db.stores.has(n) },
        createObjectStore(n) {
          if (!db.stores.has(n)) db.stores.set(n, new Map());
          return makeStore(db.stores.get(n));
        },
        transaction(names, _mode) {
          const first = Array.isArray(names) ? names[0] : names;
          return {
            objectStore(n) {
              const store = n ?? first;
              if (!db.stores.has(store)) db.stores.set(store, new Map());
              return makeStore(db.stores.get(store));
            },
          };
        },
      };
      const req = {};
      setTimeout(() => {
        req.result = handle;
        // onupgradeneeded only on first open (fresh, unseeded stores get created by the caller)
        if (firstOpen && req.onupgradeneeded) req.onupgradeneeded({ target: req });
        req.onsuccess && req.onsuccess({ target: req });
      }, 0);
      return req;
    },
  };
  return dbs;
}
