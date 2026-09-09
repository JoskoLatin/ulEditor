/**
 * The cross-format clipboard, end to end in a browser.
 *
 * The claim being checked is the one in the project's own thesis: a range copied
 * out of a spreadsheet arrives in a document as **a table**, not as
 * tab-separated mush. Both editors are real, the bridge between them is real,
 * and the only thing synthesised is the pair of events — a `copy` and a `paste`
 * carrying exactly what the first one put on the clipboard. That is deliberate:
 * driving the operating system's clipboard through a headless browser tests
 * Chromium, while dispatching the two events tests the wire this repository
 * actually wrote.
 *
 * The second half matters as much as the first. **A paste that does not match
 * what was copied here must not be interfered with**: the held payload is only
 * allowed to contribute when its text is letter for letter what arrived. Without
 * that rule, a table copied an hour ago would land in place of the sentence
 * somebody copied out of their browser a moment ago.
 *
 *   node tools/verify-clipboard.mjs [--url http://localhost:5273] [--headed]
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeXlsx } from './fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = resolve(ROOT, 'tools/screenshots');

const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5273';
const headed = args.includes('--headed');

const NOTE = ['# Bilješke', '', 'Tablica ide ispod:', '', ''].join('\n');

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

  /* ── a range in a spreadsheet ──────────────────────────────────────── */

  await dropFile(page, 'prodaja.xlsx', makeXlsx());
  await page.waitForSelector('table.ul-sheet', { timeout: 20000 });
  check('the spreadsheet is open', true);

  /* Two rows selected the way a person selects them, with a range over the
     cells — the editor reads `window.getSelection()`, so nothing else would
     produce the payload it produces. */
  const copied = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('table.ul-sheet tbody tr')].slice(0, 2);
    if (rows.length < 2) return null;

    const range = document.createRange();
    range.setStartBefore(rows[0]);
    range.setEndAfter(rows[1]);

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    const text = selection.toString();
    document.dispatchEvent(new ClipboardEvent('copy', { bubbles: true }));
    return text;
  });

  check('a range is selected and copied', Boolean(copied && copied.trim()), JSON.stringify(copied ?? '').slice(0, 70));

  // The payload is fetched a tick after the event; nobody can type that fast.
  await page.waitForTimeout(400);

  /* ── and it lands in a document as a table ─────────────────────────── */

  await dropFile(page, 'biljeske.md', NOTE);
  await page.waitForSelector('.ul-md', { timeout: 20000 });

  const pane = page.locator('.ul-md:visible');
  await pane.locator('.ul-md-source .cm-content').click();
  await page.keyboard.press('Control+End');

  const pasteInto = async (text) =>
    await page.evaluate((body) => {
      const target = document.querySelector('.ul-md:not([style*="none"]) .cm-content') ??
        document.querySelector('.cm-content');
      const data = new DataTransfer();
      data.setData('text/plain', body);
      const event = new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    }, text);

  await pasteInto(copied);
  await page.waitForTimeout(400);

  const source = await pane.locator('.ul-md-source .cm-content').innerText();

  const pipeLines = source.split('\n').filter((line) => line.trim().startsWith('|'));
  check(
    'the range arrived as a Markdown table',
    pipeLines.length >= 3,
    pipeLines.slice(0, 2).join('  //  '),
  );
  check(
    'with the header rule a Markdown table needs',
    pipeLines.some((line) => /^\|\s*---/.test(line.trim())),
    pipeLines.find((line) => /---/.test(line))?.trim() ?? '(none)',
  );
  check(
    'and the cells that were selected',
    source.includes('Month') && source.includes('Amount'),
    pipeLines.join(' ').slice(0, 80),
  );

  const rendered = await pane.locator('.ul-md-preview table').count();
  check('the preview draws it as a table', rendered > 0, `${rendered} table(s)`);

  await page.screenshot({ path: resolve(SHOTS, 'clipboard.png') });

  /* ── something copied elsewhere is left alone ──────────────────────── */

  /* `defaultPrevented` cannot answer this: CodeMirror prevents every paste it
     handles itself, so the flag says nothing about who took the event. The
     outcome does — the sentence has to arrive as a sentence. */
  const SENTENCE = 'a sentence from somebody else’s browser';
  await pasteInto(SENTENCE);
  await page.waitForTimeout(300);
  const after = await pane.locator('.ul-md-source .cm-content').innerText();

  check('a paste from outside arrives as itself', after.includes(SENTENCE), SENTENCE);
  check(
    'and not as the table that was still being held',
    after.split('\n').filter((line) => line.trim().startsWith('|')).length === pipeLines.length,
    `${pipeLines.length} table rows before and after`,
  );

  const ignorable = (text) =>
    text.includes('Download the React DevTools') || text.includes('[vite]');
  const real = consoleErrors.filter((t) => !ignorable(t));
  check('no console errors', real.length === 0, real.slice(0, 3).join(' | '));
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await page.screenshot({ path: resolve(SHOTS, 'failure-clipboard.png') }).catch(() => {});
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.passed);
await writeFile(
  resolve(SHOTS, 'report-clipboard.json'),
  JSON.stringify({ checks, consoleErrors }, null, 2),
);

console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
