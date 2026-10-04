/**
 * Pasting several lines into a Word or OpenDocument text, in a browser, with
 * the real clipboard and Ctrl+V.
 *
 * One line was always the browser's to paste, and it did it right. Several
 * were not: the browser put the line breaks into the run as characters, a
 * line break inside a run is a space to Word and nothing to OpenDocument, and
 * the lines that were on the screen were one line in the saved file. Now:
 *
 * - in a Word document each pasted line is a paragraph of its own, the way
 *   Enter makes them, and Ctrl+Z takes the paste back in one step;
 * - where a paragraph cannot be divided — an OpenDocument text — the lines
 *   are joined with a space, and the status bar says so;
 * - one line is still left to the browser.
 *
 * What a division writes into the file is held by verify-docx-split and
 * verify-office-editing; this holds the paste that leads to it.
 *
 *   node tools/verify-office-paste.mjs [--url http://localhost:5273]
 */

import { chromium } from 'playwright';

import { makeDocx, makeOdt } from './fixtures.mjs';

const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5273';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForSelector('.shell', { timeout: 30000 });

  const drop = (name, bytes) =>
    page.evaluate(
      ([fileName, byteArray]) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(byteArray)], fileName));
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      },
      [name, Array.from(bytes)],
    );
  const paste = async (text) => {
    await page.evaluate((value) => navigator.clipboard.writeText(value), text);
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(400);
  };
  const status = () => page.locator('.statusbar').innerText();

  /** Opens the second run of the document for typing, with the caret at its end. */
  const typeInto = async () => {
    const view = page.locator('.ul-office-doc:visible').first();
    await view.locator('.ul-office-run').first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(600);
    const run = view.locator('.ul-office-run').nth(1);
    const before = await run.innerText();
    await run.dblclick();
    await page.keyboard.press('End');
    return { view, before };
  };

  /* ── Word: each line a paragraph ───────────────────────────────────── */

  await drop('lijepljenje.docx', makeDocx());
  const word = await typeInto();
  await paste(' JEDAN');
  const single = await page.locator(':focus').evaluate((el) => el.textContent ?? '');
  check('one line is pasted where the caret is', single === `${word.before} JEDAN`, single);

  await paste('\nDRUGI ODLOMAK\nTREĆI ODLOMAK — čćžšđ');
  const lines = await word.view.locator('[data-part-of]').evaluateAll((els) => els.map((el) => el.textContent));
  check(
    'several lines in a Word document are paragraphs of their own',
    lines.includes('DRUGI ODLOMAK') && lines.includes('TREĆI ODLOMAK — čćžšđ'),
    JSON.stringify(lines),
  );
  check(
    'and no line break is left inside a run',
    await word.view.locator('.ul-office-run').evaluateAll((els) => els.every((el) => !(el.textContent ?? '').includes('\n'))),
  );
  check('the status bar says how many', /3 paragraphs pasted/.test(await status()), (await status()).slice(0, 120));

  await page.mouse.click(5, 400);
  await page.locator('button[title="Undo (Ctrl+Z)"]').click();
  await page.waitForTimeout(400);
  const undone = await word.view.locator('[data-part-of]').evaluateAll((els) => els.map((el) => el.textContent));
  check(
    'Ctrl+Z takes the pasted paragraphs back in one step',
    !undone.includes('DRUGI ODLOMAK') && !undone.includes('TREĆI ODLOMAK — čćžšđ'),
    JSON.stringify(undone),
  );

  /* ── OpenDocument: joined, and said so ─────────────────────────────── */

  await drop('lijepljenje.odt', makeOdt());
  const odt = await typeInto();
  await paste('\nRED DVA\nRED TRI');
  const joined = await page.locator(':focus').evaluate((el) => el.textContent ?? '');
  check(
    'where a paragraph cannot be divided the lines are joined with a space',
    joined === `${odt.before} RED DVA RED TRI`,
    JSON.stringify(joined),
  );
  check('and the status bar says so', /joined into one/.test(await status()), (await status()).slice(0, 120));
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
