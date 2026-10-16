/**
 * What comes out of the printer.
 *
 * Without a print of its own the webview printed the window: title bar, tabs,
 * side panel, and of a PDF the one page on screen, cut at the zoom it was read
 * at. Here the print is started the way a person starts it, from the palette,
 * and Chromium's own `page.pdf()` — which lays the page out for print exactly
 * as the dialog would — stands in for the paper. `window.print` is replaced so
 * the dialog does not wait for a click nobody will make.
 *
 *   node tools/verify-print.mjs [--url http://localhost:5273] [--file some.pdf] [--headed]
 *
 * With `--file` the PDF is a real one; without it, a three-page fixture whose
 * pages say `PAGE n`.
 */

import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MD_SOURCE, makeMultiPagePdf } from './fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = resolve(ROOT, 'tools/screenshots');

const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5273';
const file = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;
const headed = args.includes('--headed');

const requireFromPdf = createRequire(resolve(ROOT, 'packages/editor-pdf/package.json'));
const pdfjs = await import(pathToFileURL(requireFromPdf.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

async function until(condition, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Pages, their text, and how many pictures each one carries. */
async function readPrintout(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const text = content.items.map((i) => ('str' in i ? i.str : '')).join(' ').replace(/\s+/g, ' ').trim();
    const ops = await page.getOperatorList();
    const images = ops.fnArray.filter((fn) => fn === pdfjs.OPS.paintImageXObject).length;
    pages.push({ text, images });
  }
  await doc.destroy();
  return pages;
}

async function pageCountOf(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  const n = doc.numPages;
  await doc.destroy();
  return n;
}

async function dropFile(page, name, bytes) {
  await page.evaluate(
    async ([fileName, byteArray]) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(byteArray)], fileName));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    },
    [name, Array.from(bytes)],
  );
}

async function runPrint(page) {
  await page.keyboard.press('Control+Shift+P');
  await page.waitForSelector('.palette', { timeout: 5000 });
  await page.locator('.palette-input input').pressSequentially('Print');
  const row = page.locator('.palette-item', { hasText: 'Print' });
  await row.first().waitFor({ timeout: 5000 });
  await page.keyboard.press('Enter');
}

const CHROME_WORDS = ['Save', 'File', 'Edit', 'View', 'Preferences', 'Help', 'Explorer'];

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shell', { timeout: 20000 });
  await page.evaluate(() => {
    window.__printCalls = 0;
    window.print = () => {
      window.__printCalls++;
    };
  });

  /* — a PDF: every page, nothing of the program — */

  const source = file ? new Uint8Array(await readFile(file)) : new TextEncoder().encode(makeMultiPagePdf(3));
  const expected = await pageCountOf(source);
  await dropFile(page, file ? basename(file) : 'three-pages.pdf', source);
  await page.waitForSelector('.ul-pdf-page', { timeout: 20000 });

  await runPrint(page);
  const called = await until(() => page.evaluate(() => window.__printCalls === 1), 60000);
  check('the print command reaches window.print', called);

  const sheets = await page.locator('.print-sheets .print-sheet img').count();
  check('one sheet per page of the document', sheets === expected, `${sheets} of ${expected}`);

  const decoded = await page.evaluate(() =>
    [...document.querySelectorAll('.print-sheets img')].every((img) => img.complete && img.naturalWidth > 0),
  );
  check('every sheet is decoded before the dialog opens', decoded);

  await mkdir(SHOTS, { recursive: true });
  await page.emulateMedia({ media: 'print' });
  await page.screenshot({ path: resolve(SHOTS, 'print-pdf.png') });
  await page.emulateMedia({ media: null });

  const printout = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  await writeFile(resolve(SHOTS, 'print-pdf.pdf'), printout);
  const out = await readPrintout(printout);
  check('the printout has as many pages as the document', out.length === expected, `${out.length} of ${expected}`);
  check(
    'every printed page carries its picture',
    out.every((p) => p.images === 1),
    out.map((p) => p.images).join(','),
  );
  const leaked = out.flatMap((p) => CHROME_WORDS.filter((w) => p.text.includes(w)));
  check('nothing of the program is on paper', out.every((p) => p.text === ''), leaked.join(', ') || 'no text at all');

  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  check(
    'the sheets are gone after the print',
    await until(() => page.evaluate(() => !document.querySelector('.print-sheets') && !document.body.dataset.printing)),
  );

  /* — an editor with no sheets of its own: its area, without the frame — */

  await dropFile(page, 'notes.md', new TextEncoder().encode(MD_SOURCE));
  await until(() => page.locator('.tab', { hasText: 'notes.md' }).count().then((n) => n > 0));
  await page.waitForTimeout(800);
  await runPrint(page);
  check('the fallback prints too', await until(() => page.evaluate(() => window.__printCalls === 2)));
  const fallback = await readPrintout(await page.pdf({ printBackground: true }));
  const text = fallback.map((p) => p.text).join(' ');
  const firstLine = MD_SOURCE.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').trim() ?? '';
  check('the document is on paper', text.includes(firstLine), firstLine);
  const tabsOnPaper = text.includes('three-pages.pdf') || text.includes(file ? basename(file) : '\u0000');
  check('the tab bar is not', !tabsOnPaper);
  check('the menu bar is not', !/\bPreferences\b/.test(text) && !/\bHelp\b/.test(text));

  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.passed).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
