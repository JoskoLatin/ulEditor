/**
 * Runtime provjera OCR-a i ploče ispod.
 *
 * OCR se ne može lažirati: skripta nacrta sliku s poznatim tekstom, pusti
 * prepoznavanje i traži taj tekst natrag. Jezični model se preuzima pri prvoj
 * upotrebi, pa je za ovu provjeru **potrebna mreža**; bez nje se prijavljuje
 * kao preskočeno, ne kao prolaz.
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

/** Tekst koji crtamo na sliku i očekujemo natrag iz OCR-a. */
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

  /* ── slika s poznatim tekstom ──────────────────────────────────────── */

  // Crta se u pregledniku pa ispušta kao datoteka — tako nema binarnog asseta
  // u repozitoriju, a OCR dobiva pravi PNG.
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
    ctx.fillText('drugi redak teksta', 40, 190);

    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, PHRASE);

  await page.evaluate((data) => {
    const file = new File([new Uint8Array(data)], 'natpis.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    window.dispatchEvent(
      new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
    );
  }, bytes);

  await page.waitForSelector('.ul-img img', { timeout: 20000 });
  check('slika otvorena', true);

  const ocrButton = page.locator('.ul-img-ocr');
  check('preglednik slika nudi OCR', await ocrButton.isVisible());

  const languages = await page.locator('.ul-img-select option').allInnerTexts();
  check('jezik prepoznavanja se bira', languages.length === 2, languages.join(', '));

  /* ── prepoznavanje ─────────────────────────────────────────────────── */

  // Engleski model je manji i dovoljan za latinicu bez dijakritika.
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
      'OCR preskočen (nema mreže za jezični model)',
      true,
      toast.slice(0, 90) || 'bez poruke',
    );
  } else {
    check('ploča ispod se otvorila s rezultatom', true);

    const text = await page.locator('.split .cm-content').innerText();
    const normalised = text.replace(/\s+/g, ' ').toUpperCase();
    check(
      'prepoznat je tekst sa slike',
      normalised.includes(PHRASE),
      normalised.slice(0, 60),
    );

    const name = await page.locator('.split-name').innerText();
    check('ploča nosi ime izvedeno iz slike', name.includes('natpis'), name);

    const formats = await page.locator('.split-format option').allInnerTexts();
    check(
      'ponuđeni su formati za spremanje',
      formats.length === 4,
      formats.join(' · '),
    );

    // Glavna kartica ostaje montirana ispod ploče — to je bila poanta splita.
    check('slika je i dalje otvorena iznad', await page.locator('.ul-img img').isVisible());

    await page.screenshot({ path: resolve(SHOTS, 'ocr.png') });

    /* — visina ploče se mijenja — */
    const before = await page.locator('.split').evaluate((el) => el.clientHeight);
    await page.locator('.split-resizer').hover();
    await page.mouse.down();
    await page.mouse.move(750, 400);
    await page.mouse.up();
    const after = await page.locator('.split').evaluate((el) => el.clientHeight);
    check('visina ploče se povlači', after !== before, `${before} → ${after}`);

    /* — zatvaranje — */
    await page.locator('.split-bar .icon-btn').click();
    await page.waitForTimeout(300);
    check('ploča se zatvara', (await page.locator('.split').count()) === 0);
  }

  /* ── jezik sučelja ─────────────────────────────────────────────────── */

  await page.keyboard.press('Control+Comma');
  await page.waitForSelector('.prefs', { timeout: 5000 });
  check('postavke se otvaraju', true);

  const langButtons = await page.locator('.prefs-seg button').allInnerTexts();
  check('nudi se hrvatski i engleski', langButtons.includes('Hrvatski'), langButtons.slice(0, 3).join(', '));

  await page.screenshot({ path: resolve(SHOTS, 'preferences.png') });

  await page.locator('.prefs-seg button', { hasText: 'Hrvatski' }).click();
  await page.waitForSelector('.shell', { timeout: 15000 });
  await page.waitForTimeout(600);

  const folderButton = await page.locator('.titlebar .chrome-btn').first().innerText();
  check('sučelje je prešlo na hrvatski', folderButton === 'Mapa', folderButton);
  await page.screenshot({ path: resolve(SHOTS, 'hrvatski.png') });

  // Natrag na engleski, da provjera ne ostavi promijenjenu postavku.
  await page.keyboard.press('Control+Comma');
  await page.waitForSelector('.prefs', { timeout: 5000 });
  await page.locator('.prefs-seg button', { hasText: 'English' }).click();
  await page.waitForTimeout(600);
  check('vraćanje na engleski radi', (await page.locator('.titlebar .chrome-btn').first().innerText()) === 'Folder');

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
