/**
 * Provjera da OCR radi **unutar desktop aplikacije**, gdje vrijedi CSP.
 *
 * `verify-ocr.mjs` vozi Vite dev server u pregledniku, gdje CSP-a nema. To je
 * dovoljno da se dokaže prepoznavanje, ali ne i da resursi prolaze kroz
 * `default-src 'self'` iz `tauri.conf.json`. Razlika je stvarna: dok je
 * Tesseract vukao worker i modele s CDN-a, u pregledniku je radio, a u
 * aplikaciji ne bi.
 *
 * Provjerava se i da je mreža uopće nepotrebna — svaki vanjski zahtjev se
 * presreće i broji.
 *
 *   node tools/verify-desktop-ocr.mjs
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDesktop, stopDesktop } from './desktop-session.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PHRASE = 'ULEDITOR OFFLINE OCR';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

let session;

try {
  session = await startDesktop({ port: 9335 });
  const { page } = session;
  check('spojen na desktop aplikaciju', true);

  /* Svaki zahtjev izvan aplikacije se bilježi; OCR ne smije nijedan napraviti. */
  const external = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!/^(http:\/\/(localhost|127\.0\.0\.1|192\.168\.|tauri\.localhost)|https:\/\/tauri\.localhost|data:|blob:|ipc:)/.test(url)) {
      external.push(url);
    }
  });

  const violations = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });

  /* Slika s poznatim tekstom, nacrtana u samoj aplikaciji. */
  const bytes = await page.evaluate(async (phrase) => {
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 180;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    ctx.font = '600 60px Georgia, serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(phrase, 30, 90);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, PHRASE);

  await page.evaluate((data) => {
    const file = new File([new Uint8Array(data)], 'offline.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    window.dispatchEvent(
      new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
    );
  }, bytes);

  await page.waitForSelector('.ul-img img', { timeout: 30000 });
  check('slika otvorena u aplikaciji', true);

  await page.locator('.ul-img-select').selectOption('eng');
  await page.locator('.ul-img-ocr').click();

  let recognised = true;
  try {
    await page.waitForSelector('.split', { timeout: 240000 });
  } catch {
    recognised = false;
  }

  if (!recognised) {
    const toast = await page.locator('.toast p').first().innerText().catch(() => '');
    check('OCR je prošao kroz CSP', false, toast.slice(0, 120) || 'bez poruke');
  } else {
    const text = await page.locator('.split .cm-content').innerText();
    check(
      'prepoznat je tekst unutar aplikacije',
      text.replace(/\s+/g, ' ').toUpperCase().includes(PHRASE),
      text.replace(/\s+/g, ' ').slice(0, 60),
    );
  }

  check('CSP nije ništa odbio', violations.length === 0, violations.slice(0, 2).join(' | '));
  check(
    'nijedan zahtjev nije izašao iz aplikacije',
    external.length === 0,
    external.slice(0, 3).join(' | ') || 'nema vanjskih zahtjeva',
  );

  await page.screenshot({ path: resolve(ROOT, 'tools/screenshots/desktop-ocr.png') });
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await session?.page
    ?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-desktop-ocr.png') })
    .catch(() => {});
} finally {
  await stopDesktop(session);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
