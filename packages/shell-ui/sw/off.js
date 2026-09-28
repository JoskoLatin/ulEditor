/*
 * The off switch for the browser build's service worker.
 *
 * Deleting sw.js from the server does not stop a worker already installed:
 * an update that finds no script fails, and the registration stays. What does
 * stop it is a new worker at the same URL that removes itself — this one,
 * deployed as /sw.js by `tools/deploy-web.ps1 -ServiceWorkerOff`.
 *
 * It takes over at once, which sw.js deliberately does not: there is nothing
 * left for an open tab to lose. It deletes ulEditor's caches (no one else's)
 * and the folders it kept across visits, unregisters, and reloads each open tab, which then comes from the server —
 * by way of the browser's HTTP cache, which this cannot clear: any file the
 * server once sent wrong, with a long Cache-Control, stays there. After a
 * known compromise the person also clears the site's data and the browser's
 * cached images and files; the worker itself, while it runs, asks for the page
 * and for any file that is not its build's past that cache.
 */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('uleditor-')).map((n) => caches.delete(n)));
      // The folders kept across visits (host/root-store.ts) go too: a handle
      // left there is access to somebody's folder for whatever runs here next.
      // Not waited on past "blocked" — it completes once open tabs let go.
      await new Promise((done) => {
        const request = indexedDB.deleteDatabase('uleditor');
        request.onsuccess = request.onerror = request.onblocked = done;
      });
      await self.registration.unregister();
      const tabs = await self.clients.matchAll({ type: 'window' });
      await Promise.all(tabs.map((tab) => tab.navigate(tab.url).catch(() => {})));
    })(),
  );
});
