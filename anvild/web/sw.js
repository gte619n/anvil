// Anvil service worker — Web Push (arch §6.7) + offline app-shell caching.
const CACHE = "anvil-shell-v1";
const CORE = ["/", "/index.html", "/main.js", "/app.css", "/xterm.css", "/katex/katex.min.css", "/anvil.svg", "/manifest.json"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((c) => Promise.all(CORE.map((u) => c.add(u).catch(() => {})))),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
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
