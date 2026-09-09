/**
 * Runtime check of OCR and the panel below.
 *
 * OCR cannot be faked: the script draws an image with known text in it, runs
 * recognition and looks for that text coming back.
 *
 * **It needs no network, and that is checked first.** Tesseract's own default is
 * to pull its worker, wasm core and language models off a CDN;
 * `tools/ocr-assets.mjs` copies them into `public/ocr/` instead, so the
 * application serves them itself — which is what the desktop CSP requires and
 * what makes the feature work on a plane. A build that skipped that step used to
 * make this check report a network problem and **pass**, which is the one
 * outcome a check must never have. So the assets are confirmed to be served
 * before anything is recognised, and a recognition that does not finish is a
 * failure.
 *
 *   node tools/verify-ocr.mjs [--url http://localhost:5273] [--headed]
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = resolve(ROOT, 'tools/screenshots');

const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5273';
const headed = args.includes('--headed');

/** The text drawn onto the image and expected back out of OCR. */
const PHRASE = 'ULEDITOR OCR TEST';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

try {
  await mkdir(SHOTS, { recursive: true });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shell', { timeout: 15000 });

  /* ── the assets are the application's own ──────────────────────────── */

  // A missing path is not a 404 here: a single-page application answers one
  // with its own index.html and a 200, so the status alone would call every
  // absent file present. The content type is what tells them apart — the
  // manifest comes back as JSON, the worker as JavaScript, a model with none at
  // all, and the fallback as HTML.
  const served = async (path) => {
    const res = await fetch(new URL(path, url), { method: 'HEAD' }).catch(() => null);
    const type = res?.headers.get('content-type') ?? '';
    return Boolean(res?.ok) && !type.startsWith('text/html');
  };

  const manifest = await fetch(new URL('/ocr/manifest.json', url))
    .then((r) => (r.ok && r.headers.get('content-type')?.includes('json') ? r.json() : null))
    .catch(() => null);

  check(
    'the application serves the OCR assets itself',
    manifest !== null,
    manifest
      ? `${manifest.files.length} files · ${manifest.languages.join(', ')}`
      : 'no /ocr/manifest.json — run `node tools/ocr-assets.mjs`, then build again',
  );

  if (manifest) {
    const missing = [];
    for (const file of manifest.files) if (!(await served(`/ocr/${file}`))) missing.push(file);
    check(
      'every file the manifest names is there',
      missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : manifest.files.join(' · '),
    );
  }

  /* ── an image with known text ──────────────────────────────────────── */

  // It is drawn in the browser and then dropped as a file — that way there is no
  // binary asset in the repository, and OCR gets a real PNG.
  const bytes = await page.evaluate(async (phrase) => {
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 260;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    ctx.font = '600 64px Georgia, serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(phrase, 40, 90);
    ctx.font = '400 44px Georgia, serif';
    ctx.fillText('a second line of text', 40, 190);

    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, PHRASE);

  await page.evaluate((data) => {
    const file = new File([new Uint8Array(data)], 'sign.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    window.dispatchEvent(
      new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
    );
  }, bytes);

  await page.waitForSelector('.ul-img img', { timeout: 20000 });
  check('the image is open', true);

  const ocrButton = page.locator('.ul-img-ocr');
  check('the image viewer offers OCR', await ocrButton.isVisible());

  const languages = await page.locator('.ul-img-select option').allInnerTexts();
  check('the recognition language can be chosen', languages.length === 2, languages.join(', '));

  /* ── recognition ───────────────────────────────────────────────────── */

  // The English model is smaller and enough for Latin script without diacritics.
  await page.locator('.ul-img-select').selectOption('eng');
  await ocrButton.click();

  // Recognition is given three minutes, because a runner is slow and the model
  // is a few megabytes to load. With the assets missing it is given fifteen
  // seconds: there is nothing for it to succeed with, and the check above has
  // already said why.
  let recognised = true;
  try {
    await page.waitForSelector('.split', { timeout: manifest ? 180000 : 15000 });
  } catch {
    recognised = false;
  }

  if (!recognised) {
    // Nothing is fetched from outside, so there is no longer an excuse to
    // accept: whatever the program said while failing is the whole report.
    const toast = await page.locator('.toast p').first().innerText().catch(() => '');
    check('recognition finished', false, toast.slice(0, 90) || 'no message, and no panel');
  } else {
    check('the panel below opened with the result', true);

    const text = await page.locator('.split .cm-content').innerText();
    const normalised = text.replace(/\s+/g, ' ').toUpperCase();
    check(
      'the text was recognised off the image',
      normalised.includes(PHRASE),
      normalised.slice(0, 60),
    );

    const name = await page.locator('.split-name').innerText();
    check('the panel carries a name derived from the image', name.includes('sign'), name);

    const formats = await page.locator('.split-format option').allInnerTexts();
    check(
      'the save formats are offered',
      formats.length === 4,
      formats.join(' · '),
    );

    // The main tab stays mounted under the panel — that was the point of the split.
    check('the image is still open above', await page.locator('.ul-img img').isVisible());

    await page.screenshot({ path: resolve(SHOTS, 'ocr.png') });

    /* — the panel height changes — */
    const before = await page.locator('.split').evaluate((el) => el.clientHeight);
    await page.locator('.split-resizer').hover();
    await page.mouse.down();
    await page.mouse.move(750, 400);
    await page.mouse.up();
    const after = await page.locator('.split').evaluate((el) => el.clientHeight);
    check('the panel height can be dragged', after !== before, `${before} → ${after}`);

    /* — closing — */
    await page.locator('.split-bar .icon-btn').click();
    await page.waitForTimeout(300);
    check('the panel closes', (await page.locator('.split').count()) === 0);
  }

  const ignorable = (text) =>
    text.includes('Download the React DevTools') || text.includes('[vite]');
  const real = consoleErrors.filter((t) => !ignorable(t));
  check('no console errors', real.length === 0, real.slice(0, 3).join(' | '));
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await page.screenshot({ path: resolve(SHOTS, 'failure-ocr.png') }).catch(() => {});
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.passed);
await writeFile(resolve(SHOTS, 'report-ocr.json'), JSON.stringify({ checks, consoleErrors }, null, 2));

console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
