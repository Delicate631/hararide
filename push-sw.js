// HaulGo notification worker. Shows calls, messages and ride updates when the app is closed.
// Separate from your main sw.js so nothing there needs to change.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch (_) { d = { title: "HaulGo", body: e.data ? e.data.text() : "" }; }
  const ios = /iPhone|iPad|iPod/.test(self.navigator.userAgent);
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      // app is open and in front: the in-app pop-up already shows it (iPhones must always show a notification)
      if (!ios && list.some((c) => c.visibilityState === "visible")) return;
      return self.registration.showNotification(d.title || "HaulGo", {
        body: d.body || "",
        tag: d.tag || undefined,
        renotify: !!d.tag,
        vibrate: [200, 100, 200],
        data: { url: d.url || "/" },
      });
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow(url);
    })
  );
});
