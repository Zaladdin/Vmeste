const ROOT = new URL("./", self.registration.scope).pathname;
const PREFIX = `vmeste-shell:${ROOT}:`;
const CACHE = `${PREFIX}v4`;
const asset = (name) => `${ROOT}${name}`;
const shellAssets = ["istanbul.png", "icon.svg", "manifest.webmanifest"].map(
  asset,
);
function isBundle(value) {
  try {
    const url = new URL(value);
    return (
      url.origin === self.location.origin &&
      url.pathname.startsWith(asset("_next/static/"))
    );
  } catch {
    return false;
  }
}
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(PREFIX) && key !== CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  ),
);
self.addEventListener("message", (event) => {
  if (event.data?.type !== "CACHE_SHELL" || !Array.isArray(event.data.urls))
    return;
  event.waitUntil(
    (async () => {
      try {
        const urls = event.data.urls.filter(
          (value) => typeof value === "string" && isBundle(value),
        );
        const cache = await caches.open(CACHE);
        await cache.addAll([...new Set([ROOT, ...shellAssets, ...urls])]);
        event.source?.postMessage({ type: "OFFLINE_READY" });
      } catch {
        event.source?.postMessage({ type: "OFFLINE_UNAVAILABLE" });
      }
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (
    request.mode === "navigate" &&
    (url.pathname === ROOT || url.pathname === ROOT.slice(0, -1))
  ) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(CACHE);
            await cache.put(ROOT, response.clone());
          }
          return response;
        } catch {
          const cache = await caches.open(CACHE);
          return (await cache.match(ROOT)) || Response.error();
        }
      })(),
    );
  } else if (isBundle(url.href) || shellAssets.includes(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) {
          await cache.put(request, response.clone());
        }
        return response;
      })(),
    );
  }
});
