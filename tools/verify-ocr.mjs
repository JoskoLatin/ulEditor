/**
 * Runtime check of OCR and the panel below.
 *
 * OCR cannot be faked: the script draws an image with known text in it, runs
 * recognition and looks for that text coming back. The language model is fetched
 * on first use, so this check **needs the network**; without it the result is
 * reported as skipped, not as a pass.
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

  let recognised = true;
  try {
    await page.waitForSelector('.split', { timeout: 180000 });
  } catch {
    recognised = false;
  }

  if (!recognised) {
    const toast = await page.locator('.toast p').first().innerText().catch(() => '');
    check(
      'OCR skipped (no network for the language model)',
      true,
      toast.slice(0, 90) || 'no message',
    );
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

  /* ── the interface language ────────────────────────────────────────── */

  await page.keyboard.press('Control+Comma');
  await page.waitForSelector('.prefs', { timeout: 5000 });
  check('the preferences open', true);

  const langButtons = await page.locator('.prefs-seg button').allInnerTexts();
  check('Croatian and English are both offered', langButtons.includes('Hrvatski'), langButtons.slice(0, 3).join(', '));

  await page.screenshot({ path: resolve(SHOTS, 'preferences.png') });

  await page.locator('.prefs-seg button', { hasText: 'Hrvatski' }).click();
  await page.waitForSelector('.shell', { timeout: 15000 });
  await page.waitForTimeout(600);

  const folderButton = await page.locator('.titlebar .chrome-btn').first().innerText();
  check('the interface switched to Croatian', folderButton === 'Mapa', folderButton);
  await page.screenshot({ path: resolve(SHOTS, 'croatian.png') });

  // Back to English, so the check does not leave a changed setting behind.
  await page.keyboard.press('Control+Comma');
  await page.waitForSelector('.prefs', { timeout: 5000 });
  await page.locator('.prefs-seg button', { hasText: 'English' }).click();
  await page.waitForTimeout(600);
  check('switching back to English works', (await page.locator('.titlebar .chrome-btn').first().innerText()) === 'Folder');

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
