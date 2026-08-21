/**
 * Runtime provjera čitaonice i Office pregleda.
 *
 * Odvojena od `verify-ui.mjs` jer testira drugu tvrdnju: ne "shell radi", nego
 * "dokument se stvarno može pročitati". Datoteke ulaze kroz pravi `drop`
 * event, istim putem kao iz sistemskog dijaloga.
 *
 *   node tools/verify-reading.mjs [--url http://localhost:5273] [--headed]
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeDocx, makeEpub, makeMultiPagePdf, makeXlsx } from './fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = resolve(ROOT, 'tools/screenshots');

const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5273';
const headed = args.includes('--headed');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

async function dropFile(page, name, content) {
  const bytes = typeof content === 'string' ? null : Array.from(content);
  await page.evaluate(
    async ([fileName, text, byteArray]) => {
      const body = byteArray ? new Uint8Array(byteArray) : text;
      const file = new File([body], fileName);
      const transfer = new DataTransfer();
      transfer.items.add(file);
      window.dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
      );
    },
    [name, typeof content === 'string' ? content : '', bytes],
  );
}

/** Pretraga preko ploče — ista za sve formate, u tome je i poanta. */
async function search(page, term) {
  await page.keyboard.press('Control+Shift+F');
  await page.locator('.findpanel-bar input').fill(term);
  await page.waitForTimeout(400);
  const hits = await page.locator('.findpanel-hit').count();
  await page.keyboard.press('Escape');
  return hits;
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

  /* ── e-knjiga ──────────────────────────────────────────────────────── */

  await dropFile(page, 'knjiga.epub', makeEpub({ chapters: 4, title: 'Testna knjiga' }));
  await page.waitForSelector('.ul-book', { timeout: 20000 });
  check('EPUB otvoren', true);

  check(
    'naslov i autor iz metapodataka',
    (await page.locator('.ul-book-toc h2').innerText()) === 'Testna knjiga' &&
      (await page.locator('.ul-book-toc header p').innerText()) === 'Josko',
  );

  const tocCount = await page.locator('.ul-book-toc-list button').count();
  check('sadržaj iz EPUB 3 navigacije', tocCount === 4, `${tocCount} poglavlja`);

  const chapterVisible = await page.locator('.ul-book-chapter h1').first().isVisible();
  check('tekst poglavlja prikazan', chapterVisible);

  const formatTag = await page.locator('.tab[data-active="true"] .name').innerText();
  check('kartica nosi ime knjige', formatTag === 'knjiga.epub');

  /* ── čitaonica ─────────────────────────────────────────────────────── */

  await page.keyboard.press('Control+Shift+R');
  await page.waitForSelector('.reader', { timeout: 10000 });
  check('način čitanja se otvara tipkom', true);

  for (const [label, selector] of [
    ['naslovna traka', '.titlebar'],
    ['aktivnosna traka', '.activitybar'],
    ['traka kartica', '.tabbar'],
    ['statusna traka', '.statusbar'],
  ]) {
    check(`${label} skrivena u čitanju`, !(await page.locator(selector).isVisible()));
  }

  check('bočni sadržaj knjige skriven u čitanju', !(await page.locator('.ul-book-toc').isVisible()));

  const flow = await page.locator('.ul-book').getAttribute('data-flow');
  check('zadani tok su stranice', flow === 'paged', `data-flow=${flow}`);

  const columns = await page.evaluate(
    () => getComputedStyle(document.querySelector('.ul-book-flow')).columnCount,
  );
  check('tekst prelomljen u stupce', columns !== 'auto' && Number(columns) >= 1, `column-count=${columns}`);

  const firstLabel = await page.locator('.reader-status span').first().innerText();
  await page.locator('.reader-nav button').nth(1).click();
  await page.waitForTimeout(350);
  const secondLabel = await page.locator('.reader-status span').first().innerText();
  check('listanje mijenja stranicu', firstLabel !== secondLabel, `${firstLabel} → ${secondLabel}`);

  const scrolled = await page.evaluate(() => document.querySelector('.ul-book-view').scrollLeft);
  check('prijelom se stvarno pomiče', scrolled > 0, `scrollLeft=${scrolled}`);

  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(350);
  const backLabel = await page.locator('.reader-status span').first().innerText();
  check('strelica lijevo vraća stranicu', backLabel === firstLabel, backLabel);

  check(
    'procjena preostalog vremena',
    /~\d+ min left/.test(await page.locator('.reader-left').innerText()),
    await page.locator('.reader-left').innerText(),
  );

  /* — sadržaj iz čitaonice — */
  await page.locator('.reader-btn', { hasText: 'Contents' }).click();
  await page.waitForSelector('.reader-outline', { timeout: 5000 });
  const outlineCount = await page.locator('.reader-outline button').count();
  check('sadržaj u čitaonici', outlineCount === 4, `${outlineCount} stavki`);

  await page.locator('.reader-outline button').nth(2).click();
  await page.waitForTimeout(400);
  const jumped = await page.locator('.reader-status span').first().innerText();
  // Naslov poglavlja dolazi iz same knjige, ne iz sučelja — ostaje kakav jest.
  check('a jump to a chapter from the contents', jumped.includes('Chapter 3'), jumped);

  /* — tipografija — */
  await page.locator('.reader-btn', { hasText: 'Layout' }).click();
  await page.waitForSelector('.reader-type', { timeout: 5000 });

  await page.locator('.reader-seg button', { hasText: 'Night' }).click();
  await page.waitForTimeout(250);
  const tint = await page.locator('.ul-book').getAttribute('data-tint');
  check('podloga "noć" primijenjena', tint === 'night', `data-tint=${tint}`);
  await page.screenshot({ path: resolve(SHOTS, 'citanje-noc.png') });

  const sizeBefore = await page.evaluate(
    () => getComputedStyle(document.querySelector('.ul-book-view')).fontSize,
  );
  await page.locator('.reader-type input[type="range"]').first().fill('26');
  await page.waitForTimeout(300);
  const sizeAfter = await page.evaluate(
    () => getComputedStyle(document.querySelector('.ul-book-view')).fontSize,
  );
  check('veličina slova se mijenja', sizeBefore !== sizeAfter, `${sizeBefore} → ${sizeAfter}`);

  await page.locator('.reader-seg button', { hasText: 'Scroll' }).click();
  await page.waitForTimeout(300);
  const scrollFlow = await page.locator('.ul-book').getAttribute('data-flow');
  const allChapters = await page.locator('.ul-book-chapter').count();
  check('prebacivanje u svitak', scrollFlow === 'scroll', `data-flow=${scrollFlow}`);
  check('svitak montira sva poglavlja', allChapters === 4, `${allChapters} poglavlja`);

  await page.locator('.reader-seg button', { hasText: 'Pages' }).click();
  await page.locator('.reader-seg button', { hasText: 'Day' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS, 'citanje.png') });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Escape izlazi iz čitanja', await page.locator('.tabbar').isVisible());
  check('sadržaj knjige se vraća', await page.locator('.ul-book-toc').isVisible());

  /* — pretraga po cijeloj knjizi — */
  const bookHits = await search(page, 'uniquechapter3');
  check('pretraga nalazi tekst u dubljem poglavlju', bookHits === 1, `${bookHits} pogodaka`);

  /* ── Word ──────────────────────────────────────────────────────────── */

  await dropFile(page, 'izvjestaj.docx', makeDocx());
  await page.waitForSelector('.ul-office-doc', { timeout: 20000 });
  check('DOCX otvoren', true);

  const heading = await page.locator('.ul-office-doc h1').innerText();
  check('the heading is mapped to an h1', heading === 'Fidelity report', heading);

  check('podnaslovi mapirani', (await page.locator('.ul-office-doc h2').count()) === 2);
  check('podebljano zadržano', (await page.locator('.ul-office-doc strong').count()) === 1);
  check('the italic was kept', (await page.locator('.ul-office-doc em').count()) === 1);

  const bullets = await page.locator('.ul-office-doc ul li').count();
  check('lista prepoznata kao lista', bullets === 2, `${bullets} stavki`);

  const rows = await page.locator('.ul-office-doc table tr').count();
  check('tablica prepoznata', rows === 3, `${rows} redaka`);

  check(
    'dijakritici čitljivi',
    (await page.locator('.ul-office-doc p').first().innerText()).includes('čćšžđ'),
  );

  check('pregled se izjašnjava kao samo za čitanje', await page.locator('.ul-office-notes').isVisible());
  check(
    'kartica označena kao samo za čitanje',
    await page.locator('.statusbar').innerText().then((t) => t.length > 0),
  );

  const docxHits = await search(page, 'uniqueword');
  check('pretraga radi nad Word pregledom', docxHits === 1, `${docxHits} pogodaka`);

  await page.keyboard.press('Control+Shift+R');
  await page.waitForSelector('.reader', { timeout: 10000 });
  const docxReading = await page.locator('.ul-office').getAttribute('data-reading');
  check('Word se može čitati kao knjiga', docxReading === 'true');
  await page.locator('.reader-btn', { hasText: 'Contents' }).click();
  const docxOutline = await page.locator('.reader-outline button').count();
  check('sadržaj iz naslova dokumenta', docxOutline === 3, `${docxOutline} naslova`);
  await page.screenshot({ path: resolve(SHOTS, 'word.png') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  /* ── Excel ─────────────────────────────────────────────────────────── */

  await dropFile(page, 'promet.xlsx', makeXlsx());
  await page.waitForSelector('.ul-sheet', { timeout: 20000 });
  check('XLSX otvoren', true);

  const sheetTabs = await page.locator('.ul-sheet-tabs button').count();
  check('listovi radne knjige', sheetTabs === 2, `${sheetTabs} lista`);

  const cell = (row, col) => page.locator(`.ul-sheet td[data-ref="${row},${col}"]`);

  const cellA2 = await cell(1, 0).innerText();
  check('the shared strings were resolved', cellA2 === 'January', cellA2);

  const cellB2 = await cell(1, 1).innerText();
  check('broj formatiran po formatu ćelije', cellB2.includes('1.234,50'), cellB2);

  const cellC2 = await cell(1, 2).innerText();
  check('serijski broj prikazan kao datum', /^\d{2}\.\d{2}\.\d{4}\.$/.test(cellC2), cellC2);

  const formulaTitle = await cell(3, 1).getAttribute('title');
  check('formula vidljiva u opisu ćelije', formulaTitle === '=SUM(B2:B3)', String(formulaTitle));

  const boolCell = await cell(4, 0).innerText();
  check('logička vrijednost prevedena', boolCell === 'TRUE', boolCell);

  const merged = await cell(4, 0).getAttribute('colspan');
  check('spojene ćelije zadržane', merged === '2', `colspan=${merged}`);

  const headers = await page.locator('.ul-sheet thead th').count();
  check('oznake stupaca prikazane', headers >= 3, `${headers} zaglavlja`);

  await page.screenshot({ path: resolve(SHOTS, 'excel.png') });

  const xlsxHits = await search(page, 'uniqueexcel');
  check('pretraga prelazi preko listova', xlsxHits === 1, `${xlsxHits} pogodaka`);

  /* ── PDF u čitaonici ───────────────────────────────────────────────── */

  await dropFile(page, 'knjizica.pdf', new TextEncoder().encode(makeMultiPagePdf(5)));
  await page.waitForSelector('.mount:visible .ul-pdf', { timeout: 20000 });

  await page.keyboard.press('Control+Shift+R');
  await page.waitForSelector('.reader', { timeout: 10000 });
  check('PDF se otvara u čitaonici', await page.locator('.ul-pdf[data-reading="true"]').isVisible());
  check(
    'alatna traka PDF-a skrivena u čitanju',
    !(await page.locator('.mount:visible .ul-pdf-toolbar').isVisible()),
  );

  await page.locator('.reader-nav button').nth(1).click();
  await page.waitForTimeout(600);
  const pdfLabel = await page.locator('.reader-status span').first().innerText();
  check('listanje po stranicama PDF-a', pdfLabel.includes('2/5'), pdfLabel);

  await page.locator('.reader-btn', { hasText: 'Layout' }).click();
  await page.locator('.reader-seg button', { hasText: 'Night' }).click();
  await page.waitForTimeout(300);
  const pdfFilter = await page.evaluate(() => {
    const canvas = document.querySelector('.mount:not([style*="none"]) .ul-pdf-page canvas');
    return canvas ? getComputedStyle(canvas).filter : '';
  });
  check('noćni prikaz invertira stranicu', pdfFilter.includes('invert'), pdfFilter.slice(0, 40));
  await page.screenshot({ path: resolve(SHOTS, 'pdf-citanje.png') });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(
    'izlazak vraća alatnu traku PDF-a',
    await page.locator('.mount:visible .ul-pdf-toolbar').isVisible(),
  );

  /* — spajanje i izdvajanje su u traci sa stranicama — */
  await page.locator('.mount:visible .ul-pdf-toolbar .ul-pdf-btn').first().click();
  await page.waitForTimeout(400);
  check(
    'traka sa stranicama nudi umetanje PDF-a',
    await page.locator('.ul-pdf-rail-actions button', { hasText: 'Insert PDF' }).isVisible(),
  );
  check(
    'traka sa stranicama nudi izdvajanje',
    await page.locator('.ul-pdf-rail-actions button', { hasText: 'Extract' }).isVisible(),
  );

  /* ── konzola ───────────────────────────────────────────────────────── */

  const ignorable = (text) =>
    text.includes('Download the React DevTools') || text.includes('[vite]');
  const real = consoleErrors.filter((t) => !ignorable(t));
  check('no console errors', real.length === 0, real.slice(0, 3).join(' | '));
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await page.screenshot({ path: resolve(SHOTS, 'failure-reading.png') }).catch(() => {});
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.passed);
await writeFile(
  resolve(SHOTS, 'report-reading.json'),
  JSON.stringify({ checks, consoleErrors }, null, 2),
);

console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
