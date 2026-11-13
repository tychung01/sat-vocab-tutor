// Service worker for the study app: when a page can't load because there's no
// internet, show offline.html instead of the browser's error page. Everything
// else goes to the network as usual, so the app is never served stale.

const CACHE = "offline-v1";
const OFFLINE_FILES = ["offline.html", "icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(OFFLINE_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Firebase's sign-in pages (/__/auth/...) handle themselves.
  if (url.origin !== location.origin || url.pathname.startsWith("/__/")) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("offline.html")));
  } else if (OFFLINE_FILES.some((f) => url.pathname.endsWith(f))) {
    // The offline page's icon, when the network is gone.
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
  }
});
