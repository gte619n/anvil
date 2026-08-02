// Anvil service worker — Web Push (arch §6.7) + offline app-shell caching.
// [WEB2-17] build.ts prepends `self.__ANVIL_BUILD = { version, assets }` when it copies this file
// into dist: `assets` is the exact list of servable bundle files (the precache manifest — hashed
// entry/chunks included, so every lazy chunk works offline) and `version` is a hash of their
// contents. The cache key derives from that version, so ANY shipped change — even to an unhashed
// shell file — rolls the cache automatically (no more manual CACHE bumps; the last manual key was
// anvil-shell-v4, which the != CACHE sweep below purges like any other stale cache). The fallback
// only exists for an unstamped source checkout; production dist is always stamped.
const BUILD = self.__ANVIL_BUILD || { version: "dev", assets: ["/", "/index.html", "/anvil.svg", "/manifest.json"] };
const CACHE = "anvil-shell-" + BUILD.version;

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    // Precache the whole manifest. Hashed chunks are served `immutable`, so cross-version installs
    // refetch only what actually changed — the rest fills from the browser's HTTP cache.
    caches.open(CACHE).then((c) => Promise.all(BUILD.assets.map((u) => c.add(u).catch(() => {})))),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      // Old versions die wholesale (their cache key != ours) — a stale shell and its orphaned
      // hashed chunks are gone the moment this version activates…
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      // …and anything in OUR cache that isn't in the manifest (e.g. runtime-cached strays from the
      // waiting window) is pruned, so the cache converges to exactly the shipped asset set.
      const manifest = new Set(BUILD.assets);
      const cache = await caches.open(CACHE);
      for (const req of await cache.keys()) {
        if (!manifest.has(new URL(req.url).pathname)) await cache.delete(req);
      }
    })(),
  );
});

// Network-first with cache fallback for same-origin GETs (so it's always fresh online but loads
// fully offline). The control plane (/api, /ws) is never cached.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;
  const key = req.mode === "navigate" ? "/index.html" : req;
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const c = await caches.open(CACHE);
          c.put(key, res.clone());
        }
        return res;
      } catch {
        return (await caches.match(key)) || (await caches.match("/index.html")) || Response.error();
      }
    })(),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* non-JSON payload */
  }
  event.waitUntil(
    (async () => {
      // A "clear" push is a silent dismissal (you viewed/answered the session on another device):
      // close the matching notification instead of showing one.
      if (data.kind === "clear") {
        await closeSessionNotifications(data.sessionId || data.tag);
        return;
      }
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (wins.some((c) => c.focused)) return;
      // title = which session; body = what it's asking, prefixed with the dir for context. Key the
      // tag off the session so a newer reminder SUPERSEDES the old one (instead of permission and
      // result stacking as separate tags) — matching the Android client.
      const body = data.dir ? `${data.dir} — ${data.body || ""}` : data.body || "";
      await self.registration.showNotification(data.title || "Anvil", {
        body,
        tag: data.sessionId || data.tag,
        renotify: true,
        data: { sessionId: data.sessionId || null },
      });
    })(),
  );
});

/** Close any open notification for a session (by tag or matching data.sessionId). */
async function closeSessionNotifications(sessionId) {
  if (!sessionId) return;
  const notes = await self.registration.getNotifications();
  for (const n of notes) {
    if (n.tag === sessionId || (n.data && n.data.sessionId === sessionId)) n.close();
  }
}

// The app tells us when it opens a session so we can clear its reminder immediately (faster than,
// and a backstop to, the daemon's "clear" push) — opening the session is acting on it.
self.addEventListener("message", (event) => {
  const m = event.data;
  if (m && m.type === "close-notifications") event.waitUntil(closeSessionNotifications(m.sessionId));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data && event.notification.data.sessionId;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of wins) {
        if ("focus" in c) {
          c.postMessage({ type: "open-session", sessionId });
          return c.focus();
        }
      }
      return self.clients.openWindow(sessionId ? `/#s/${encodeURIComponent(sessionId)}` : "/");
    })(),
  );
});
