/**
 * The browser build under the policy it will be served with.
 *
 * Vite's preview sends no Content-Security-Policy, so every other browser check
 * runs with none, and a policy that blocks the image worker, the WebAssembly or
 * pdf.js's worker would first be noticed on the server. This serves the built
 * `dist` itself, with the headers read out of deploy/web/Caddyfile — the file
 * the server uses — and drives the parts that lean on the policy: a picture
 * edited through the worker and the module, a PDF drawn by pdf.js, text read
 * off a picture by the OCR workers. Every `securitypolicyviolation` the page
 * raises is collected, and one is a failure.
 *
 *   node tools/wasm-assets.mjs && node tools/ocr-assets.mjs
 *   pnpm --filter @uleditor/shell-ui build
 *   node tools/verify-web-csp.mjs
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makePdf } from './fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'packages/shell-ui/dist');

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

/* ── the policy, from the server's own file ──────────────────────────── */

const caddyfile = readFileSync(resolve(ROOT, 'deploy/web/Caddyfile'), 'utf8');
const policy = /Content-Security-Policy "([^"]+)"/.exec(caddyfile)?.[1];
check('deploy/web/Caddyfile states a policy', !!policy, policy?.slice(0, 60));
if (!policy || !existsSync(join(DIST, 'index.html'))) {
  if (policy) check('a built dist to serve', false, 'none — build packages/shell-ui first');
  finish();
}
/* The desktop policy less Tauri's own sources is what it claims to be; if the
   two drift, the browser build is running under rules nobody wrote down. */
const desktop = JSON.parse(readFileSync(resolve(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')).app.security.csp;
const directives = (text) =>
  Object.fromEntries(
    text
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...sources]) => [name, sources.filter((s) => s !== 'ipc:' && s !== 'http://ipc.localhost').sort().join(' ')]),
  );
const web = directives(policy);
const drift = Object.entries(directives(desktop)).filter(([name, sources]) => web[name] !== sources);
check(
  'every desktop directive is the same on the web, less Tauri’s own',
  drift.length === 0,
  drift.map(([n]) => n).join(', ') || Object.keys(directives(desktop)).join(' '),
);

/* ── a static server with those headers ─────────────────────────────── */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.gz': 'application/gzip',
};
const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
  let file = normalize(join(DIST, path));
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  response.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Content-Security-Policy': policy,
  });
  response.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

/* ── the parts that lean on it ───────────────────────────────────────── */

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.addInitScript((pdf) => {
  window.__violations = [];
  document.addEventListener('securitypolicyviolation', (e) =>
    window.__violations.push(`${e.violatedDirective} ${e.blockedURI}`),
  );
  window.showDirectoryPicker = async () => {
    const storage = await navigator.storage.getDirectory();
    await storage.removeEntry('csp', { recursive: true }).catch(() => {});
    const root = await storage.getDirectoryHandle('csp', { create: true });
    const write = async (name, data) => {
      const out = await (await root.getFileHandle(name, { create: true })).createWritable();
      await out.write(data);
      await out.close();
    };
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 200;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 900, 200);
    ctx.fillStyle = '#000';
    ctx.font = '600 64px Georgia, serif';
    ctx.fillText('POLICY HOLDS', 40, 120);
    await write('natpis.png', await new Promise((r) => canvas.toBlob(r, 'image/png')));
    await write('dokument.pdf', new Uint8Array(pdf));
    return root;
  };
}, [...Buffer.from(makePdf('Policy holds'), 'latin1')]);

const violations = () => page.evaluate(() => window.__violations);
const open = async (name) => {
  await page.keyboard.press('Control+p');
  await page.locator('.palette input').fill(name);
  await page.locator('.palette-item').first().waitFor({ timeout: 10_000 });
  await page.keyboard.press('Enter');
};

try {
  await page.goto(url);
  await page.waitForSelector('.shell', { timeout: 30_000 });
  await page.keyboard.press('Control+k');
  await page.getByText('natpis.png').first().waitFor({ timeout: 10_000 });

  // A picture, turned and written: the worker and the WebAssembly.
  await open('natpis.png');
  await page.waitForSelector('.ul-img img', { timeout: 20_000 });
  const pane = page.locator('.ul-img:visible');
  await pane.locator('.ul-img-rotate-right').click();
  await page.keyboard.press('Control+s');
  const written = await page
    .waitForFunction(() => [...document.querySelectorAll('.ul-img img')].some((i) => i.naturalHeight === 900), null, {
      timeout: 20_000,
    })
    .then(() => true)
    .catch(() => false);
  check('a picture is edited under the policy', written);

  // Text off the picture: the OCR workers and their model, from the same origin.
  await pane.locator('.ul-img-language').selectOption('eng');
  await pane.locator('.ul-img-ocr').click();
  const read = await page
    .waitForSelector('.split .cm-content', { timeout: 180_000 })
    .then(() => page.locator('.split .cm-content').innerText())
    .catch(() => '');
  check('text is read off it under the policy', read.toUpperCase().includes('POLICY'), read.slice(0, 40) || 'nothing');

  // A PDF: pdf.js and its worker.
  await open('dokument.pdf');
  const drawn = await page
    .waitForSelector('.ul-pdf-page[data-rendered="true"]', { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  check('a PDF is drawn under the policy', drawn);

  const blocked = await violations();
  check('the policy blocked nothing the program does', blocked.length === 0, blocked.slice(0, 4).join(' | ') || 'no violations');
  check('nothing threw in the page', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message.split('\n')[0] : String(err));
} finally {
  await browser.close();
  server.close();
}

finish();
