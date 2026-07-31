/* Service Worker — إشعارات الجوال (Web Push) */
self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { title: "طلب قطع جديد", body: event.data ? event.data.text() : "" }; }
  const title = data.title || "طلب قطع جديد";
  const options = {
    body: data.body || "",
    icon: "assets/logo.png",
    badge: "assets/logo.png",
    dir: "rtl",
    lang: "ar",
    vibrate: [120, 60, 120],
    tag: data.tag || "qr-notify",
    renotify: true,
    data: { url: data.url || "https://www.qrawi.com/" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "https://www.qrawi.com/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
