/**
 * The browser build without a network (ADR 0002, step 6).
 *
 * Serves the built `dist` the way deploy/web/Caddyfile does — its policy, its
 * caching headers, a 404 for a file that is not there — lets the service
 * worker install, then **stops the server** and reloads. The page has to come
 * back and open a `.docx` that was never opened while the server was up, so the
 * Word editor can only have come from the precache. `context.setOffline` is not
 * used: in Chromium it does not reach the service worker's own fetches.
 *
 * Along the way, what the worker keeps is checked against what it may keep:
 * the precache under its budget, nothing from another origin, never a failed
 * answer, never a URL with a query, and never bytes other than the build's own
 * — code written into its cache by something else on the origin is not run.
 * A server that answers 502 counts as no server. At the end sw/off.js is
 * served as /sw.js, and the worker has to remove itself and its caches.
 *
 *   pnpm --filter @uleditor/shell-ui build
 *   node tools/verify-web-offline.mjs
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeDocx } from './fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'packages/shell-ui/dist');
const OFF = resolve(ROOT, 'packages/shell-ui/sw/off.js');
/* The ADR's figure for what is fetched on install, measured on disk — what
   Cache Storage holds, not what the wire carries (that is about 40%). */
const BUDGET = 5 * 1024 * 1024;

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}
function finish() {
  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

/* ── the worker the build wrote ──────────────────────────────────────── */

const swFile = join(DIST, 'sw.js');
if (!existsSync(swFile)) {
  check('dist/sw.js exists', false, 'none — build packages/shell-ui first');
  finish();
}
const sw = readFileSync(swFile, 'utf8');
const literal = (name) => {
  const match = new RegExp(`const ${name} = ([\\s\\S]*?);\\r?\\n`).exec(sw);
  try {
    return match ? JSON.parse(match[1]) : null;
  } catch {
    return null;
  }
};
const version = literal('VERSION');
const precache = literal('PRECACHE');
const digests = literal('DIGESTS');
const swHeaders = literal('HEADERS');
check(
  'the build filled in a version, a precache list, digests and headers',
  /^[0-9a-f]{16}$/.test(version ?? '') && Array.isArray(precache) && !!digests && !!swHeaders,
  version ?? 'placeholders left',
);
if (!version || !Array.isArray(precache) || !digests) finish();

const missing = precache.filter((u) => !existsSync(join(DIST, u)));
check('every precached file is in the build', missing.length === 0, missing.join(', ') || `${precache.length} files`);
const bytes = precache.filter((u) => existsSync(join(DIST, u))).reduce((sum, u) => sum + statSync(join(DIST, u)).size, 0);
check('the precache stays under 5 MB', bytes < BUDGET, `${(bytes / 1024 / 1024).toFixed(2)} MB`);

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const wrong = Object.entries(digests).filter(([p, d]) => !existsSync(join(DIST, p)) || sha(join(DIST, p)) !== d);
check('every digest is of the bytes in dist', wrong.length === 0, wrong.map(([p]) => p).join(', ') || `${Object.keys(digests).length} files`);
const undigested = ['/wasm/ul_image_bg.wasm', '/ocr/manifest.json', ...precache].filter((p) => existsSync(join(DIST, p)) && !digests[p]);
check('public/ and the precache all have digests', undigested.length === 0, undigested.join(', '));

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const named = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
const unnamed = named.filter((u) => !precache.includes(u));
check('what index.html loads is precached', named.length > 0 && unnamed.length === 0, unnamed.join(', ') || named.join(' '));
const byUrl = precache.filter((u) => /pdf\.worker|\.ttf$/.test(u));
check('the PDF worker and its fonts are left for first use', byUrl.length === 0, byUrl.join(', '));
const entry = named.find((u) => u.endsWith('.js'));
const lazy = Object.keys(digests).find((p) => p.startsWith('/assets/') && p.endsWith('.js') && !precache.includes(p) && !p.includes('pdf.worker'));

/* ── a server that answers the way Caddy does ────────────────────────── */

const caddyfile = readFileSync(resolve(ROOT, 'deploy/web/Caddyfile'), 'utf8');
const policy = /Content-Security-Policy "([^"]+)"/.exec(caddyfile)?.[1];
check('the worker holds the policy the server sends', swHeaders?.['Content-Security-Policy'] === policy);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.ttf': 'font/ttf',
  '.gz': 'application/gzip',
};
/* 'up', or '502' for a server that is there and not well; `off` serves
   sw/off.js as /sw.js, the way `deploy-web.ps1 -ServiceWorkerOff` does. */
let mode = 'up';
let off = false;
/* Paths answered with other bytes and a year's Cache-Control, as a server in
   someone else's hands would: a chunk the build knows, the page, a module. */
const tampered = new Set();
const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
  const headers = { 'Content-Security-Policy': policy };
  if (mode === '502') {
    response.writeHead(502, headers);
    return response.end('Bad gateway');
  }
  if (tampered.has(path)) {
    const pinned = { 'Cache-Control': 'public, max-age=31536000, immutable' };
    if (path === '/') {
      response.writeHead(200, { ...pinned, 'Content-Type': 'text/html' });
      return response.end('<script>window.__pinned = 1</script>');
    }
    response.writeHead(200, { ...headers, ...pinned, 'Content-Type': 'text/javascript' });
    return response.end('window.__tampered = 1;');
  }
  let file = path === '/sw.js' && off ? OFF : normalize(join(DIST, path));
  const present = (file === OFF || file.startsWith(DIST + sep)) && existsSync(file) && !statSync(file).isDirectory();
  const kept = path.startsWith('/assets/');
  if (kept || path === '/sw.js' || path.startsWith('/wasm/') || path.startsWith('/ocr/')) {
    if (!present) {
      response.writeHead(404, { ...headers, 'Cache-Control': 'no-store' });
      return response.end('Not found');
    }
    headers['Cache-Control'] = kept ? 'public, max-age=31536000, immutable' : 'no-cache';
  } else {
    headers['Cache-Control'] = 'no-cache';
    if (!present) file = join(DIST, 'index.html');
  }
  response.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  response.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;

/* ── install, then take the network away ─────────────────────────────── */

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await context.addInitScript(async (docx) => {
  /* Before the worker exists, once: a cache left by an earlier build, which it
     has to clear, and one that is not its own, which it has to leave alone. */
  if (!localStorage.getItem('seeded') && window === window.top) {
    localStorage.setItem('seeded', '1');
    await (await caches.open('uleditor-0000earlierbuild')).put('/assets/old.js', new Response('old'));
    // Theirs has an index.html too, and it is older than ours: an offline
    // page must still be this build's own.
    const theirs = await caches.open('someone-else');
    await theirs.put('/theirs', new Response('theirs'));
    await theirs.put('/index.html', new Response('<p>not ulEditor</p>', { headers: { 'Content-Type': 'text/html' } }));
  }
  window.showDirectoryPicker = async () => {
    const storage = await navigator.storage.getDirectory();
    await storage.removeEntry('offline', { recursive: true }).catch(() => {});
    const root = await storage.getDirectoryHandle('offline', { create: true });
    const out = await (await root.getFileHandle('ugovor.docx', { create: true })).createWritable();
    await out.write(new Uint8Array(docx));
    await out.close();
    return root;
  };
}, [...makeDocx()]);

const kept = (on = page) =>
  on.evaluate(async () => {
    const out = {};
    for (const name of await caches.keys()) {
      out[name] = (await (await caches.open(name)).keys()).map((r) => r.url);
    }
    return out;
  });
const CACHE = `uleditor-${version}`;

try {
  await page.goto(`${origin}/`);
  await page.waitForSelector('.shell', { timeout: 30_000 });
  const state = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active;
    if (worker.state !== 'activated') {
      await new Promise((r) => worker.addEventListener('statechange', () => worker.state === 'activated' && r()));
    }
    return { scope: registration.scope, state: worker.state };
  });
  check('the worker installs, over the whole origin', state.scope === `${origin}/` && state.state === 'activated', `${state.state} ${state.scope}`);

  const caches0 = await kept();
  const names = Object.keys(caches0).sort();
  check(
    'one cache of its own, named after this build; another’s left alone',
    JSON.stringify(names) === JSON.stringify(['someone-else', CACHE]),
    names.join(', '),
  );
  const installed = (caches0[CACHE] ?? []).map((u) => u.slice(origin.length)).sort();
  check(
    'it holds the precache and nothing else',
    JSON.stringify(installed) === JSON.stringify([...precache].sort()),
    `${installed.length} of ${precache.length}`,
  );

  // Controlled from here on: what it keeps on first use, and what it refuses.
  // Another origin the policy lets the page reach, answered here rather than
  // by Google, on a path the worker would keep if it were this origin's.
  await context.route('https://fonts.gstatic.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '//', headers: { 'Access-Control-Allow-Origin': '*' } }),
  );
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 30_000 });
  const answers = await page.evaluate(async () => {
    const status = async (url) => (await fetch(url).catch(() => null))?.status ?? 'failed';
    const out = {
      controlled: !!navigator.serviceWorker.controller,
      manifest: await status('/wasm/manifest.json'),
      queried: await status('/wasm/manifest.json?n=1'),
      absent: await status('/assets/not-in-this-build.js'),
      absentWasm: await status('/wasm/not-in-this-build.wasm'),
      foreign: await status('https://fonts.gstatic.com/assets/font.js'),
    };
    await new Promise((r) => setTimeout(r, 500)); // keep() finishes in waitUntil
    return out;
  });
  check('a reload is answered by the worker', answers.controlled);
  const after = (await kept())[CACHE] ?? [];
  check('an unhashed file is kept once asked for', answers.manifest === 200 && after.includes(`${origin}/wasm/manifest.json`), `status ${answers.manifest}`);
  check('a URL with a query is never kept', answers.queried === 200 && !after.some((u) => u.includes('?')), `status ${answers.queried}`);
  check(
    'a 404 is never kept',
    answers.absent === 404 && answers.absentWasm === 404 && !after.some((u) => u.includes('not-in-this-build')),
    `status ${answers.absent}, ${answers.absentWasm}`,
  );
  check(
    'another origin is never kept',
    answers.foreign === 200 && after.every((u) => u.startsWith(`${origin}/`)),
    `status ${answers.foreign}, ${after.length} entries`,
  );

  // Playwright turns the HTTP cache off while any route is set, and the check
  // below needs it on: that cache is where wrong bytes would stay.
  await context.unroute('https://fonts.gstatic.com/**');

  // Code written into its cache by something else on the origin: never run,
  // and replaced by the build's own.
  await page.evaluate(
    async ([name, path]) => {
      const poison = new Response('window.__poisoned = 1;', { headers: { 'Content-Type': 'text/javascript' } });
      await (await caches.open(name)).put(path, poison);
    },
    [CACHE, entry],
  );
  const second = await context.newPage();
  await second.goto(`${origin}/`);
  const clean = await second
    .waitForSelector('.shell', { timeout: 30_000 })
    .then(() => second.evaluate(() => !window.__poisoned))
    .catch(() => false);
  const healed = await second.evaluate(
    async ([name, path]) => {
      await new Promise((r) => setTimeout(r, 500));
      const kept = await (await caches.open(name)).match(path);
      return kept ? (await kept.arrayBuffer()).byteLength : 0;
    },
    [CACHE, entry],
  );
  await second.close();
  check('code put in its cache by another script is not run', clean);
  check('and the build’s own is kept in its place', healed === statSync(join(DIST, entry)).size, `${healed} bytes`);

  // Wrong bytes from the server under a name this build knows, sent as
  // immutable: refused; and once the server is right again, the right ones,
  // past the browser's HTTP cache that still holds the wrong.
  tampered.add(lazy);
  const wrong = await page.evaluate((p) => fetch(p).then((r) => r.text().then((t) => t.length), () => 'refused'), lazy);
  tampered.delete(lazy);
  const righted = await page.evaluate((p) => fetch(p).then((r) => r.arrayBuffer().then((b) => b.byteLength), () => 'refused'), lazy);
  check('wrong bytes under a name the build knows are never answered', wrong === 'refused', `${lazy}: ${wrong}`);
  check('the right ones are, once the server has them again', righted === statSync(join(DIST, lazy)).size, `${righted} bytes`);

  // The page and a module pinned by the server the same way, then the server
  // clean again: the next start is the build's own. (Without the worker the
  // browser would go on answering both from its HTTP cache for a year.)
  const module = '/wasm/manifest.json';
  // A new tab and a plain navigation, as a person opens it: a reload would
  // revalidate on its own and prove nothing.
  tampered.add('/').add(module);
  const opened = await context.newPage();
  await opened.goto(`${origin}/`);
  await opened.evaluate((m) => fetch(m).catch(() => {}), module);
  tampered.clear();
  await opened.goto('about:blank');
  await opened.goto(`${origin}/`);
  const unpinned = await opened
    .waitForSelector('.shell', { timeout: 30_000 })
    .then(() => opened.evaluate(() => !window.__pinned))
    .catch(() => false);
  await opened.close();
  check('a page the server pinned in the HTTP cache is asked for again', unpinned);
  const moduleNow = await page.evaluate((m) => fetch(m).then((r) => r.text()), module);
  check('and so is a module that is not the build’s', moduleNow === readFileSync(join(DIST, module), 'utf8'), moduleNow.slice(0, 30));

  // A server that is there and not well is no server.
  mode = '502';
  await page.reload();
  const through502 = await page
    .waitForSelector('.shell', { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  check('a 502 from the server is answered from the cache', through502);
  const wasm502 = await page.evaluate(() => fetch('/wasm/manifest.json').then((r) => r.status, () => 'failed'));
  check('and so is an unhashed file', wasm502 === 200, `status ${wasm502}`);

  // The page's own bytes, kept with headers of someone else's choosing — a
  // Refresh to another place and no policy at all. It gets the build's.
  await page.evaluate(async (name) => {
    const ours = await caches.open(name);
    const original = await ours.match('/index.html');
    const headers = { 'Content-Type': 'text/html', Refresh: '0; url=/elsewhere' };
    await ours.put('/index.html', new Response(await original.arrayBuffer(), { headers }));
  }, CACHE);
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 30_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  const at = new URL(page.url()).pathname;
  const inline = await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__inline = 1';
    document.head.append(script);
    return !!window.__inline;
  });
  check(
    'headers kept beside the page are not the ones it gets',
    at === '/' && !inline,
    `at ${at}, an inline script ${inline ? 'ran' : 'was refused'}`,
  );
  mode = 'up';

  // No server at all, and nothing in the browser's HTTP cache either: it can
  // be evicted whenever the browser likes, and what has to carry the program
  // offline is the worker's own cache.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.clearBrowserCache');
  await cdp.detach();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  const down = await page.evaluate(() => fetch('/index.html', { cache: 'no-store' }).then(() => 'answered', () => 'unreachable'));
  check('the server is really gone', down === 'unreachable', down);

  await page.reload();
  const up = await page
    .waitForSelector('.shell', { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  check('the program comes back without a network', up);
  const offlineManifest = await page.evaluate(() => fetch('/wasm/manifest.json').then((r) => r.status, () => 'failed'));
  check('an unhashed file kept earlier is answered offline', offlineManifest === 200, `status ${offlineManifest}`);

  await page.keyboard.press('Control+k');
  await page.getByText('ugovor.docx').first().waitFor({ timeout: 10_000 });
  await page.keyboard.press('Control+p');
  await page.locator('.palette input').fill('ugovor.docx');
  await page.locator('.palette-item').first().waitFor({ timeout: 10_000 });
  await page.keyboard.press('Enter');
  const text = await page
    .waitForSelector('.ul-office-doc', { timeout: 20_000 })
    .then(() => page.locator('.ul-office-doc').first().innerText())
    .catch(() => '');
  check('a .docx never opened before opens offline', text.includes('Fidelity report') && text.includes('čćšžđ'), text.slice(0, 40) || 'nothing drawn');
  check('nothing threw in the page', errors.length === 0, errors.slice(0, 3).join(' | '));

  // The server back, with the off switch as /sw.js.
  off = true;
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
  const gone = await page
    .waitForFunction(
      async (name) => (await navigator.serviceWorker.getRegistrations()).length === 0 && !(await caches.keys()).includes(name),
      CACHE,
      { timeout: 20_000, polling: 250 },
    )
    .then(() => true)
    .catch(() => false);
  // Its reload of the tab lands, and the page registers /sw.js again — the
  // off switch, which removes itself at once and reloads nothing it did not
  // control, so there is no loop. Still off a few seconds later.
  await page.waitForSelector('.shell', { timeout: 30_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  const settled = await page.evaluate(async () => ({
    registrations: (await navigator.serviceWorker.getRegistrations()).length,
    controlled: !!navigator.serviceWorker.controller,
  }));
  const leftover = Object.keys(await kept());
  check(
    'the off switch unregisters it and deletes its caches, and it stays off',
    gone && settled.registrations === 0 && !settled.controlled && !leftover.includes(CACHE),
    `${leftover.join(', ')}; ${settled.registrations} registrations`,
  );
  check('and leaves another’s alone', leftover.includes('someone-else'));
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message.split('\n')[0] : String(err));
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}

finish();
