/*
 * The service worker of the browser build — what lets a reload without a
 * network still open a document (ADR 0002, step 6).
 *
 * Hand-written and small on purpose: what it keeps is the security question,
 * and every rule is here to be read. sw/plugin.ts fills in the four names
 * below at build time and writes the result to dist/sw.js.
 *
 * What it keeps, and nothing else:
 * - the program itself — index.html and the chunks the editors are made of,
 *   fetched when it is installed (the list is PRECACHE);
 * - the rest of /assets/, /wasm/ and /ocr/ once the program has asked for it:
 *   the diagrams, the PDF worker, the image module and the OCR models.
 * Never a document: those come from the disk through File System Access and
 * never cross the network. Never another origin: a font fetched from Google
 * for a PDF line goes past untouched. Never a failed answer, and never a file
 * whose bytes are not the ones this build wrote (DIGESTS) — nor, under a name
 * in /assets/ this build knows, is one of those ever answered, from the
 * network either. Every answer from the cache carries the build's own
 * headers (HEADERS), never the ones kept beside it.
 *
 * Cache Storage is shared with every page on the origin, so what is kept is
 * checked each time it is read, not only when it is written: an entry that
 * does not match its digest is deleted and the network asked instead. Without
 * that, one script that ran here once could leave its own code to be served
 * on every later start, past redeploys and rollbacks.
 *
 * The way to switch it off from the server is sw/off.js, deployed in its place
 * (`tools/deploy-web.ps1 -ServiceWorkerOff`). It clears Cache Storage, not the
 * browser's HTTP cache, where a compromised server could have pinned any file
 * with the Cache-Control of its choice. That is why the page is always asked
 * for past it, and a file in /assets/, /wasm/ or /ocr/ that is not this
 * build's is asked for again past it.
 */

const VERSION = '__UL_VERSION__';
const PRECACHE = __UL_PRECACHE__;
const DIGESTS = __UL_DIGESTS__;
const HEADERS = __UL_HEADERS__;

const PREFIX = 'uleditor-';
const CACHE = PREFIX + VERSION;

/* Everything or nothing: `addAll` fails on the first bad answer, the install
   fails with it, and the worker already in charge stays in charge. It starts
   from an empty cache, so nothing put there under this name before is kept.
   `no-cache` asks the server again rather than trusting the HTTP cache. */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .delete(CACHE)
      .then(() => caches.open(CACHE))
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'no-cache' })))),
  );
});

/* There is no `skipWaiting`: a tab keeps the build it was opened with until it
   closes. A new worker taking over an open tab would answer its lazy imports
   from a cache that holds another build's chunks. The price is that a deploy
   reaches the person once every ulEditor tab has been closed. */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith(PREFIX) && n !== CACHE).map((n) => caches.delete(n)))),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(page(request));
    return;
  }
  // Nothing the program asks for carries a query, and every distinct query
  // would be one more copy kept: a document could fill the disk with them.
  if (url.search) return;
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(named(event, url.pathname));
  } else if (url.pathname.startsWith('/wasm/') || url.pathname.startsWith('/ocr/')) {
    event.respondWith(unnamed(event, url.pathname));
  }
});

/* The page from the server while it answers. Without one — no network, or a
   5xx from a server that is there but not well — the index.html of this
   worker's own build, never one written in later, which would name chunks
   this cache does not have. */
async function page(request) {
  let response;
  try {
    // Past the HTTP cache: a page it held could carry any Cache-Control that
    // was sent with it once. It is 700 bytes.
    response = await fetch(request, { cache: 'reload' });
    if (response.status < 500) return response;
  } catch (error) {
    response = error;
  }
  const kept = await fromCache('/index.html', '/index.html');
  if (kept) return kept;
  if (response instanceof Response) return response;
  throw response;
}

/* Vite names every file in /assets/ after its content, so a name that is kept
   is kept correctly for good — and a name this build knows has exactly one
   right answer, from the network too. The server sends /assets/ as immutable
   for a year, so wrong bytes it sent once would otherwise be answered from
   the HTTP cache long after the server is clean: they are asked for again
   past that cache, and if they are still wrong, not served at all. A name
   this build does not know (a tab still on the next build) goes through. */
async function named(event, path) {
  const kept = await fromCache(event.request, path);
  if (kept) return kept;
  const response = await fetch(event.request);
  if (!DIGESTS[path] || !response.ok) return response;
  const again = () => fetch(event.request, { cache: 'reload' }).catch(() => null);
  for (const ask of [() => response, again]) {
    const attempt = await ask();
    if (!attempt?.ok) continue;
    const body = await attempt.arrayBuffer();
    if ((await digest(body)) !== DIGESTS[path]) continue;
    const answer = rebuilt(body, path);
    event.waitUntil(caches.open(CACHE).then((cache) => cache.put(path, rebuilt(body, path))));
    return answer;
  }
  return Response.error();
}

/* /wasm/ and /ocr/ keep one name across builds, so the server decides while it
   answers; the kept copy is only for when it does not. */
async function unnamed(event, path) {
  let response;
  try {
    response = await fetch(event.request);
    // Not this build's bytes: asked once more past the HTTP cache, where a
    // wrong answer could have been left pinned. Then whatever comes is
    // answered — a newer build is entitled to different bytes here — and
    // kept only if it is this build's.
    if (DIGESTS[path] && response.ok && (await digest(await response.clone().arrayBuffer())) !== DIGESTS[path]) {
      response = await fetch(event.request, { cache: 'reload' });
    }
    if (response.status < 500) {
      keep(event, path, response);
      return response;
    }
  } catch (error) {
    response = error;
  }
  const kept = await fromCache(event.request, path);
  if (kept) return kept;
  if (response instanceof Response) return response;
  throw response;
}

/* A kept answer, only if its bytes are this build's. The body has to be read
   to be checked, so it is answered anew. */
async function fromCache(request, path) {
  const cache = await caches.open(CACHE);
  const kept = await cache.match(request);
  if (!kept) return null;
  const body = await kept.arrayBuffer();
  if (DIGESTS[path] && (await digest(body)) === DIGESTS[path]) return rebuilt(body, path);
  await cache.delete(request);
  return null;
}

/* The headers are the build's, never the ones kept with the body: whatever
   wrote the entry could have added a `Refresh` to another site, or taken the
   policy away. HEADERS is the Caddyfile's own `header` block; the type comes
   from the name, as Caddy's does. */
const TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  wasm: 'application/wasm',
  json: 'application/json',
  ttf: 'font/ttf',
  gz: 'application/gzip',
};
function rebuilt(body, path) {
  const type = TYPES[path.slice(path.lastIndexOf('.') + 1)] ?? 'application/octet-stream';
  return new Response(body, { status: 200, headers: { ...HEADERS, 'Content-Type': type } });
}

function keep(event, path, response) {
  if (!response.ok || response.type !== 'basic' || !DIGESTS[path]) return;
  const copy = response.clone();
  event.waitUntil(
    (async () => {
      const body = await copy.arrayBuffer();
      if ((await digest(body)) !== DIGESTS[path]) return;
      await (await caches.open(CACHE)).put(path, rebuilt(body, path));
    })(),
  );
}

async function digest(body) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}
