/**
 * Runtime check of the reading room and the Office view.
 *
 * Kept apart from `verify-ui.mjs` because it tests a different claim: not "the
 * shell works" but "the document can really be read". Files come in through a
 * real `drop` event, by the same route as from the system dialog.
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

/** Search through the panel — the same for every format, which is the point. */
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

  /* ── the e-book ────────────────────────────────────────────────────── */

  await dropFile(page, 'book.epub', makeEpub({ chapters: 4, title: 'A test book' }));
  await page.waitForSelector('.ul-book', { timeout: 20000 });
  check('the EPUB is open', true);

  check(
    'the title and author come from the metadata',
    (await page.locator('.ul-book-toc h2').innerText()) === 'A test book' &&
      (await page.locator('.ul-book-toc header p').innerText()) === 'Josko',
  );

  const tocCount = await page.locator('.ul-book-toc-list button').count();
  check('the contents come from the EPUB 3 navigation', tocCount === 4, `${tocCount} chapters`);

  const chapterVisible = await page.locator('.ul-book-chapter h1').first().isVisible();
  check('the chapter text is displayed', chapterVisible);

  const formatTag = await page.locator('.tab[data-active="true"] .name').innerText();
  check('the tab carries the book file name', formatTag === 'book.epub');

  /* ── the reading room ──────────────────────────────────────────────── */

  await page.keyboard.press('Control+Shift+R');
  await page.waitForSelector('.reader', { timeout: 10000 });
  check('reading mode opens from the keyboard', true);

  for (const [label, selector] of [
    ['the title bar', '.titlebar'],
    ['the activity bar', '.activitybar'],
    ['the tab bar', '.tabbar'],
    ['the status bar', '.statusbar'],
  ]) {
    check(`${label} is hidden while reading`, !(await page.locator(selector).isVisible()));
  }

  check('the book contents sidebar is hidden while reading', !(await page.locator('.ul-book-toc').isVisible()));

  const flow = await page.locator('.ul-book').getAttribute('data-flow');
  check('the default flow is pages', flow === 'paged', `data-flow=${flow}`);

  const columns = await page.evaluate(
    () => getComputedStyle(document.querySelector('.ul-book-flow')).columnCount,
  );
  check('the text is broken into columns', columns !== 'auto' && Number(columns) >= 1, `column-count=${columns}`);

  const firstLabel = await page.locator('.reader-status span').first().innerText();
  await page.locator('.reader-nav button').nth(1).click();
  await page.waitForTimeout(350);
  const secondLabel = await page.locator('.reader-status span').first().innerText();
  check('turning pages changes the page', firstLabel !== secondLabel, `${firstLabel} → ${secondLabel}`);

  const scrolled = await page.evaluate(() => document.querySelector('.ul-book-view').scrollLeft);
  check('the flow really moves', scrolled > 0, `scrollLeft=${scrolled}`);

  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(350);
  const backLabel = await page.locator('.reader-status span').first().innerText();
  check('the left arrow brings the page back', backLabel === firstLabel, backLabel);

  check(
    'an estimate of the time left',
    /~\d+ min left/.test(await page.locator('.reader-left').innerText()),
    await page.locator('.reader-left').innerText(),
  );

  /* — the contents from the reading room — */
  await page.locator('.reader-btn', { hasText: 'Contents' }).click();
  await page.waitForSelector('.reader-outline', { timeout: 5000 });
  const outlineCount = await page.locator('.reader-outline button').count();
  check('the contents in the reading room', outlineCount === 4, `${outlineCount} entries`);

  await page.locator('.reader-outline button').nth(2).click();
  await page.waitForTimeout(400);
  const jumped = await page.locator('.reader-status span').first().innerText();
  // The chapter title comes from the book itself, not the interface — it stays as it is.
  check('a jump to a chapter from the contents', jumped.includes('Chapter 3'), jumped);

  /* — typography — */
  await page.locator('.reader-btn', { hasText: 'Layout' }).click();
  await page.waitForSelector('.reader-type', { timeout: 5000 });

  await page.locator('.reader-seg button', { hasText: 'Night' }).click();
  await page.waitForTimeout(250);
  const tint = await page.locator('.ul-book').getAttribute('data-tint');
  check('the "night" tint was applied', tint === 'night', `data-tint=${tint}`);
  await page.screenshot({ path: resolve(SHOTS, 'reading-night.png') });

  const sizeBefore = await page.evaluate(
    () => getComputedStyle(document.querySelector('.ul-book-view')).fontSize,
  );
  await page.locator('.reader-type input[type="range"]').first().fill('26');
  await page.waitForTimeout(300);
  const sizeAfter = await page.evaluate(
    () => getComputedStyle(document.querySelector('.ul-book-view')).fontSize,
  );
  check('the type size changes', sizeBefore !== sizeAfter, `${sizeBefore} → ${sizeAfter}`);

  await page.locator('.reader-seg button', { hasText: 'Scroll' }).click();
  await page.waitForTimeout(300);
  const scrollFlow = await page.locator('.ul-book').getAttribute('data-flow');
  const allChapters = await page.locator('.ul-book-chapter').count();
  check('switching to scroll', scrollFlow === 'scroll', `data-flow=${scrollFlow}`);
  check('scroll mounts every chapter', allChapters === 4, `${allChapters} chapters`);

  await page.locator('.reader-seg button', { hasText: 'Pages' }).click();
  await page.locator('.reader-seg button', { hasText: 'Day' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS, 'reading.png') });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Escape leaves reading mode', await page.locator('.tabbar').isVisible());
  check('the book contents come back', await page.locator('.ul-book-toc').isVisible());

  /* — search across the whole book — */
  const bookHits = await search(page, 'uniquechapter3');
  check('the search finds text in a deeper chapter', bookHits === 1, `${bookHits} hits`);

  /* ── Word ──────────────────────────────────────────────────────────── */

  await dropFile(page, 'report.docx', makeDocx());
  await page.waitForSelector('.ul-office-doc', { timeout: 20000 });
  check('the DOCX is open', true);

  const heading = await page.locator('.ul-office-doc h1').innerText();
  check('the heading is mapped to an h1', heading === 'Fidelity report', heading);

  check('the subheadings are mapped', (await page.locator('.ul-office-doc h2').count()) === 2);
  check('the bold was kept', (await page.locator('.ul-office-doc strong').count()) === 1);
  check('the italic was kept', (await page.locator('.ul-office-doc em').count()) === 1);

  const bullets = await page.locator('.ul-office-doc ul li').count();
  check('the list was recognised as a list', bullets === 2, `${bullets} items`);

  const rows = await page.locator('.ul-office-doc table tr').count();
  check('the table was recognised', rows === 3, `${rows} rows`);

  check(
    'the diacritics are legible',
    (await page.locator('.ul-office-doc p').first().innerText()).includes('čćšžđ'),
  );

  check('the view declares itself read-only', await page.locator('.ul-office-notes').isVisible());
  check(
    'the tab is marked read-only',
    await page.locator('.statusbar').innerText().then((t) => t.length > 0),
  );

  const docxHits = await search(page, 'uniqueword');
  check('the search works over the Word view', docxHits === 1, `${docxHits} hits`);

  await page.keyboard.press('Control+Shift+R');
  await page.waitForSelector('.reader', { timeout: 10000 });
  const docxReading = await page.locator('.ul-office').getAttribute('data-reading');
  check('Word can be read like a book', docxReading === 'true');
  await page.locator('.reader-btn', { hasText: 'Contents' }).click();
  const docxOutline = await page.locator('.reader-outline button').count();
  check('the contents come from the document headings', docxOutline === 3, `${docxOutline} headings`);
  await page.screenshot({ path: resolve(SHOTS, 'word.png') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  /* ── Excel ─────────────────────────────────────────────────────────── */

  await dropFile(page, 'sales.xlsx', makeXlsx());
  await page.waitForSelector('.ul-sheet', { timeout: 20000 });
  check('the XLSX is open', true);

  const sheetTabs = await page.locator('.ul-sheet-tabs button').count();
  check('the workbook sheets', sheetTabs === 2, `${sheetTabs} sheets`);

  const cell = (row, col) => page.locator(`.ul-sheet td[data-ref="${row},${col}"]`);

  const cellA2 = await cell(1, 0).innerText();
  check('the shared strings were resolved', cellA2 === 'January', cellA2);

  const cellB2 = await cell(1, 1).innerText();
  check('the number follows the cell format', cellB2.includes('1.234,50'), cellB2);

  const cellC2 = await cell(1, 2).innerText();
  check('the serial number is shown as a date', /^\d{2}\.\d{2}\.\d{4}\.$/.test(cellC2), cellC2);

  const formulaTitle = await cell(3, 1).getAttribute('title');
  check('the formula is visible in the cell tooltip', formulaTitle === '=SUM(B2:B3)', String(formulaTitle));

  const boolCell = await cell(4, 0).innerText();
  check('the boolean was rendered', boolCell === 'TRUE', boolCell);

  const merged = await cell(4, 0).getAttribute('colspan');
  check('the merged cells were kept', merged === '2', `colspan=${merged}`);

  const headers = await page.locator('.ul-sheet thead th').count();
  check('the column labels are shown', headers >= 3, `${headers} headers`);

  await page.screenshot({ path: resolve(SHOTS, 'excel.png') });

  const xlsxHits = await search(page, 'uniqueexcel');
  check('the search crosses the sheets', xlsxHits === 1, `${xlsxHits} hits`);

  /* ── a PDF in the reading room ─────────────────────────────────────── */

  await dropFile(page, 'booklet.pdf', new TextEncoder().encode(makeMultiPagePdf(5)));
  await page.waitForSelector('.mount:visible .ul-pdf', { timeout: 20000 });

  await page.keyboard.press('Control+Shift+R');
  await page.waitForSelector('.reader', { timeout: 10000 });
  check('the PDF opens in the reading room', await page.locator('.ul-pdf[data-reading="true"]').isVisible());
  check(
    'the PDF toolbar is hidden while reading',
    !(await page.locator('.mount:visible .ul-pdf-toolbar').isVisible()),
  );

  await page.locator('.reader-nav button').nth(1).click();
  await page.waitForTimeout(600);
  const pdfLabel = await page.locator('.reader-status span').first().innerText();
  check('turning the PDF pages', pdfLabel.includes('2/5'), pdfLabel);

  await page.locator('.reader-btn', { hasText: 'Layout' }).click();
  await page.locator('.reader-seg button', { hasText: 'Night' }).click();
  await page.waitForTimeout(300);
  const pdfFilter = await page.evaluate(() => {
    const canvas = document.querySelector('.mount:not([style*="none"]) .ul-pdf-page canvas');
    return canvas ? getComputedStyle(canvas).filter : '';
  });
  check('the night view inverts the page', pdfFilter.includes('invert'), pdfFilter.slice(0, 40));
  await page.screenshot({ path: resolve(SHOTS, 'pdf-reading.png') });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(
    'leaving brings the PDF toolbar back',
    await page.locator('.mount:visible .ul-pdf-toolbar').isVisible(),
  );

  /* — merging and extracting live in the page rail — */
  await page.locator('.mount:visible .ul-pdf-toolbar .ul-pdf-btn').first().click();
  await page.waitForTimeout(400);
  check(
    'the page rail offers inserting a PDF',
    await page.locator('.ul-pdf-rail-actions button', { hasText: 'Insert PDF' }).isVisible(),
  );
  check(
    'the page rail offers extracting',
    await page.locator('.ul-pdf-rail-actions button', { hasText: 'Extract' }).isVisible(),
  );

  /* ── the console ───────────────────────────────────────────────────── */

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
