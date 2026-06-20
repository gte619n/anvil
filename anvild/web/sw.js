// Anvil service worker — Web Push (arch §6.7).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* non-JSON payload */
  }
  event.waitUntil(
    (async () => {
      // Don't buzz the device you're already looking at.
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (wins.some((c) => c.focused)) return;
      await self.registration.showNotification(data.title || "Anvil", {
        body: data.body || "",
        tag: data.tag,
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
