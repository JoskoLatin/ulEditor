/**
 * Checking that OCR works **inside the desktop application**, where the CSP
 * applies.
 *
 * `verify-ocr.mjs` drives the Vite dev server in a browser, where there is no
 * CSP. That is enough to prove recognition, but not that the assets get through
 * `default-src 'self'` from `tauri.conf.json`. The difference is real: while
 * Tesseract was pulling its worker and models from a CDN, it worked in the
 * browser and would not have worked in the application.
 *
 * It also checks that the network is unnecessary at all — every external request
 * is intercepted and counted.
 *
 *   node tools/verify-desktop-ocr.mjs
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isLocal, startDesktop, stopDesktop, openFromOutside } from './desktop-session.mjs';

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
  check('attached to the desktop application', true);

  /* Every request leaving the application is recorded; OCR must make none. */
  const external = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!isLocal(url)) external.push(url);
  });

  const violations = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });

  /* An image with known text in it, drawn inside the application itself. */
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

  /* Opened from disk, the way verify-desktop-image does it. An HTML `drop` on the
     window used to stand in for the gesture, but on the desktop the shell takes
     dropped files only from Tauri's `onDragDropEvent` (`App.tsx`) — the HTML
     listener exists on the web alone — so the picture never opened and the check
     timed out before it reached OCR at all. */
  const workspace = await mkdtemp(join(tmpdir(), 'ul-ocr-'));
  await writeFile(join(workspace, 'offline.png'), Buffer.from(bytes));
  await openFromOutside(page, [workspace]);
  await page.keyboard.press('Control+P');
  await page.waitForSelector('.palette-input input', { timeout: 10000 });
  await page.locator('.palette-input input').fill('offline.png');
  await page.waitForSelector('.palette-item', { timeout: 15000 });
  await page.locator('.palette-item').first().click();

  await page.waitForSelector('.ul-img img', { timeout: 30000 });
  check('the image is open in the application', true);

  await page.locator('.ul-img-language').selectOption('eng');
  await page.locator('.ul-img-ocr').click();

  let recognised = true;
  try {
    await page.waitForSelector('.split', { timeout: 240000 });
  } catch {
    recognised = false;
  }

  if (!recognised) {
    const toast = await page.locator('.toast p').first().innerText().catch(() => '');
    check('OCR got through the CSP', false, toast.slice(0, 120) || 'no message');
  } else {
    const text = await page.locator('.split .cm-content').innerText();
    check(
      'text was recognised inside the application',
      text.replace(/\s+/g, ' ').toUpperCase().includes(PHRASE),
      text.replace(/\s+/g, ' ').slice(0, 60),
    );
  }

  check('the CSP refused nothing', violations.length === 0, violations.slice(0, 2).join(' | '));
  check(
    'no request left the application',
    external.length === 0,
    external.slice(0, 3).join(' | ') || 'no external requests',
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
