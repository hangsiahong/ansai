// ansai service worker: installable app shell, offline fallback, and push notifications.
// API and WebSocket traffic is never cached.
const CACHE = "ansai-shell-v2";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add("/")).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put("/", copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match("/").then((r) => r || new Response("ansai is offline", { status: 503 }))),
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {}
  e.waitUntil(
    self.registration.showNotification(d.title || "ansai", {
      body: d.body || "",
      tag: d.tag || undefined,
      renotify: !!d.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // "Needs you" can be answered from the notification (Android, desktop; iOS shows no buttons).
      actions: (d.actions || []).slice(0, 2).map((a) => ({ action: a.id, title: a.title })),
      data: { url: d.url || "/", session: d.session, since: d.since, actions: d.actions || [] },
    }),
  );
});

/** Press a notification button's keys in the agent's terminal; if that fails (it moved on), open the session. */
async function answer(data, actionId) {
  const a = (data.actions || []).find((x) => x.id === actionId);
  if (!a || !data.session) return false;
  try {
    const res = await fetch(`/api/sessions/${data.session}/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: a.keys, ifSince: data.since ?? null }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = data.url || "/";
  e.waitUntil(
    (async () => {
      if (e.action && (await answer(data, e.action))) return;
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if ("focus" in w) {
          await w.focus();
          w.postMessage({ nav: url });
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
