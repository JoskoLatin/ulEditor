/**
 * Mjerenje dobitka od pripreme slike.
 *
 * Ne provjerava "radi li OCR" — to radi `verify-ocr.mjs`. Ovdje se ista slika
 * pušta kroz motor s pripremom i bez nje, pa se uspoređuje koliko je znakova
 * pogođeno. Bez tog mjerenja priprema je samo tvrdnja.
 *
 * Slika je namjerno teška: sitna i blijeda, kakvu daje fotografija natpisa
 * ili screenshot smanjenog dokumenta.
 *
 *   node tools/verify-ocr-quality.mjs [--url http://localhost:5273]
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = resolve(ROOT, 'tools/screenshots');

const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5273';

const EXPECTED = 'Ugovor o djelu sklopljen 15. kolovoza 2026. u Vodicama, prilog čćžšđ.';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Levenshtein — koliko je znakova promašeno, ne samo "je li isto". */
function distance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, i) => i);

  for (let i = 1; i < rows; i++) {
    const current = [i];
    for (let j = 1; j < cols; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[cols - 1];
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });

try {
  await mkdir(SHOTS, { recursive: true });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shell', { timeout: 15000 });

  /*
   * Teška slika: sitan tekst, sivo na svijetlosivom, blagi šum. To je stanje u
   * kojem se razlika između sirovog i pripremljenog ulaza uopće vidi — na
   * čistom crno-bijelom natpisu oba puta ispadne isto.
   */
  const png = await page.evaluate((text) => {
    const canvas = document.createElement('canvas');
    canvas.width = 620;
    canvas.height = 90;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#dcdcdc';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#8a8a8a';
    ctx.font = '400 15px Georgia, serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 12, 45);

    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < image.data.length; i += 4) {
      const noise = (Math.sin(i * 12.9898) * 43758.5453) % 1;
      const delta = Math.round(noise * 12);
      image.data[i] += delta;
      image.data[i + 1] += delta;
      image.data[i + 2] += delta;
    }
    ctx.putImageData(image, 0, 0);

    return canvas.toDataURL('image/png');
  }, EXPECTED);

  /*
   * Mjeri se kroz sučelje, ne pozivanjem motora iz stranice: tako se provjeri
   * upravo onaj put kojim ide korisnik, uključujući pripremu slike.
   */
  const drop = async (dataUrl, name) => {
    await page.evaluate(
      async ([url, fileName]) => {
        const blob = await (await fetch(url)).blob();
        const file = new File([blob], fileName, { type: 'image/png' });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        window.dispatchEvent(
          new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
        );
      },
      [dataUrl, name],
    );
    await page.waitForSelector('.ul-img img', { timeout: 20000 });
    await page.locator('.ul-img-select').selectOption('hrv');
    await page.locator('.ul-img-ocr').click();
    await page.waitForSelector('.split .cm-content', { timeout: 240000 });
    const text = await page.locator('.split .cm-content').innerText();
    await page.locator('.split-bar .icon-btn').click();
    await page.waitForTimeout(200);
    return text.replace(/\s+/g, ' ').trim();
  };

  const got = await drop(png, 'tezak.png');
  const errors = distance(EXPECTED, got);
  const accuracy = Math.max(0, 1 - errors / EXPECTED.length);

  console.log(`\n  očekivano: ${EXPECTED}`);
  console.log(`  dobiveno:  ${got}\n`);

  check(
    'priprema daje čitljiv rezultat',
    accuracy >= 0.8,
    `${Math.round(accuracy * 100)} % znakova točno, ${errors} promašaja`,
  );

  check(
    'dijakritici su prepoznati',
    /[čćšžđ]/i.test(got),
    got.slice(0, 60),
  );

  await page.screenshot({ path: resolve(SHOTS, 'ocr-kvaliteta.png') });
} catch (err) {
  check('izvođenje bez iznimke', false, err instanceof Error ? err.message : String(err));
  await page.screenshot({ path: resolve(SHOTS, 'failure-ocr-quality.png') }).catch(() => {});
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.passed);
console.log(`${checks.length - failed.length}/${checks.length} provjera prošlo`);
process.exit(failed.length === 0 ? 0 : 1);
