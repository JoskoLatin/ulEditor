/**
 * The round trip proving typed text survives: write → save → open afresh.
 *
 * `verify-pdf-text.mjs` inspects the structure of the written PDF, but it works
 * on bytes in memory. Here the same thing is driven through **the real desktop
 * application**, out to disk and back, because between the two lies everything
 * the structure does not cover: saving through the Rust VFS, reopening and — most
 * importantly — whether pdf.js reads back what pdf-lib wrote.
 *
 * That last one is no formality. `/FreeText` is the only annotation we write that
 * readers draw solely from the appearance stream attached to it; had we omitted
 * that stream, the file would still be a valid PDF and would still contain the
 * text — only nobody would see it.
 *
 *   node tools/verify-pdf-editing.mjs
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makePdf } from './fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9334;
const TYPED = 'Vodice, 15 August — čćžšđ';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const workspace = await mkdtemp(join(tmpdir(), 'ul-pdf-text-'));
const file = join(workspace, 'form.pdf');
await writeFile(file, makePdf());
const originalSize = (await readFile(file)).length;

/** A second document, for rewriting an existing line. */
const contract = join(workspace, 'contract.pdf');
await writeFile(contract, makePdf('Name and surname'));

/** A third, for the rewrite that stays in the document's own font. */
const invoice = join(workspace, 'invoice.pdf');
await writeFile(invoice, makePdf('Total 100 EUR'));

const app = spawn('pnpm', ['--filter', '@uleditor/desktop', 'dev'], {
  cwd: ROOT,
  shell: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  },
  stdio: 'ignore',
});

async function connect(timeoutMs) {
  const until = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < until) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastError ?? new Error('the CDP endpoint never opened');
}

let browser;
let page;

/** Opens a document from the workspace through quick open. */
async function open(name) {
  await page.keyboard.press('Control+P');
  await page.waitForSelector('.palette-input input', { timeout: 10000 });
  await page.locator('.palette-input input').fill(name);
  await page.waitForSelector('.palette-item', { timeout: 15000 });
  await page.locator('.palette-item').first().click();
  await page.waitForSelector('.ul-pdf-page[data-rendered="true"]', { timeout: 30000 });
}

try {
  browser = await connect(240000);
  const contexts = browser.contexts();
  page = contexts[0]?.pages()[0] ?? (await contexts[0].waitForEvent('page'));
  await page.waitForSelector('.shell', { timeout: 30000 });
  check('attached to the desktop application', true);

  /* Closes whatever is left over from the previous run. */
  for (let guard = 0; guard < 20 && (await page.locator('.tab').count()) > 0; guard++) {
    await page.locator('.tab .close').first().click();
    await page.waitForTimeout(200);
  }

  await page.evaluate(
    (dir) => window.__TAURI_INTERNALS__.invoke('adopt_paths', { paths: [dir] }),
    workspace,
  );

  await open('form.pdf');
  check('the PDF is open from the workspace', true);

  /* ── typing ────────────────────────────────────────────────────────── */

  await page.locator('.ul-pdf-tool[title*="Add text"]').click();
  await page.locator('.ul-pdf-page').first().click({ position: { x: 80, y: 140 } });
  await page.waitForSelector('.ul-pdf-text-input', { timeout: 15000 });
  await page.locator('.ul-pdf-text-input').pressSequentially(TYPED);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ul-pdf-ann-text', { timeout: 5000 });
  check('the text was typed into the document', true);

  /* ── saving ────────────────────────────────────────────────────────── */

  await page.keyboard.press('Control+S');
  await page.waitForFunction(() => document.querySelectorAll('.tab[data-dirty="true"]').length === 0, {
    timeout: 30000,
  });

  const saved = await readFile(file);
  const raw = new TextDecoder('latin1').decode(saved);
  check('the file on disk grew', saved.length > originalSize, `${originalSize} → ${saved.length} B`);
  check('a FreeText was written', raw.includes('/FreeText'));
  check('the font is embedded in the file', raw.includes('/FontFile2'));

  /* ── reopening ─────────────────────────────────────────────────────── */

  await page.locator('.tab .close').first().click();
  await page.waitForTimeout(400);
  await open('form.pdf');

  /*
   * This is the real check: the box here is not drawn from our own state but
   * from what pdf.js read out of the file. Were the appearance stream or the
   * contents missing, there would be nothing here.
   */
  await page.waitForSelector('.ul-pdf-ann-text', { timeout: 20000 });
  const reopened = await page.locator('.ul-pdf-ann-text').first().innerText();
  check('the text was read back out of the file', reopened === TYPED, JSON.stringify(reopened));

  check(
    'a reopened document is not immediately modified',
    (await page.locator('.tab[data-dirty="true"]').count()) === 0,
  );

  /* ── deleting existing text ────────────────────────────────────────── */

  /*
   * The text is targeted through the layer pdf.js builds over the page: it sits
   * exactly where the glyphs are, so dragging across it is the same thing the
   * user would do with the mouse.
   */
  const span = await page.locator('.ul-pdf-text span').first().boundingBox();
  check('the existing text is on the page', !!span && span.width > 10, `${Math.round(span?.width ?? 0)}px`);

  await page.locator('.ul-pdf-tool[title*="Erase text"]').click();
  await page.mouse.move(span.x - 2, span.y - 2);
  await page.mouse.down();
  await page.mouse.move(span.x + span.width + 2, span.y + span.height + 2, { steps: 8 });
  await page.mouse.up();

  await page.waitForSelector('.ul-pdf-redaction', { timeout: 10000 });
  const toast = await page
    .locator('.toast p', { hasText: /\d/ })
    .last()
    .innerText()
    .catch(() => '');
  check('the number of characters going is announced', /\d+/.test(toast), toast.slice(0, 80));
  check('the document is modified again', (await page.locator('.tab[data-dirty="true"]').count()) === 1);

  await page.keyboard.press('Control+S');
  await page.waitForFunction(() => document.querySelectorAll('.tab[data-dirty="true"]').length === 0, {
    timeout: 30000,
  });

  /*
   * The check that tells deletion apart from covering up: the byte sequence
   * itself is searched for in the file. Had a rectangle merely been drawn over
   * the text, it would still be written here — and would come out by selecting
   * it in any reader.
   */
  const erased = new TextDecoder('latin1').decode(await readFile(file));
  check('the deleted text is no longer in the file', !erased.includes('ulEditor PDF'));
  check('the typed text survived the deletion', erased.includes('/FreeText'));

  await page.locator('.tab .close').first().click();
  await page.waitForTimeout(400);
  await open('form.pdf');
  const remaining = await page.locator('.ul-pdf-text').innerText();
  check(
    'a reopened document no longer holds that text',
    !remaining.includes('ulEditor PDF'),
    JSON.stringify(remaining.replace(/\s+/g, ' ').slice(0, 40)),
  );

  /* ── rewriting a line in the document's own font ───────────────────── */

  /*
   * The ordinary case, and the one that has to look like nothing happened: a
   * figure corrected in a document whose font can write the new one. Nothing is
   * covered, nothing is added, and the page is redrawn from the edited bytes —
   * so everything asserted below is read back from the document itself, not
   * from a box we drew over it.
   */
  await page.locator('.tab .close').first().click();
  await page.waitForTimeout(400);
  await open('invoice.pdf');

  const figure = await page.locator('.ul-pdf-text span').first().boundingBox();
  await page.locator('.ul-pdf-tool[title*="Edit text"]').click();
  await page.mouse.click(figure.x + figure.width / 2, figure.y + figure.height / 2);
  await page.waitForSelector('.ul-pdf-text-input', { timeout: 15000 });

  check(
    'the field is prefilled from the page',
    (await page.locator('.ul-pdf-text-input').inputValue()) === 'Total 100 EUR',
    JSON.stringify(await page.locator('.ul-pdf-text-input').inputValue()),
  );
  check(
    'the line being replaced is covered while typing',
    (await page.locator('.ul-pdf-rewrite-cover').count()) === 1,
  );

  await page.locator('.ul-pdf-text-input').fill('Total 250 EUR');
  check(
    'nothing is said about fonts when the document can write it',
    await page.locator('.ul-pdf-text-warning').isHidden(),
  );

  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.querySelector('.ul-pdf-text')?.innerText.includes('Total 250 EUR'),
    { timeout: 30000 },
  );
  check('the line itself changed on the page', true);
  check(
    'the old figure is gone from the page as well',
    !(await page.locator('.ul-pdf-text').innerText()).includes('Total 100 EUR'),
  );
  check('nothing was covered over', (await page.locator('.ul-pdf-redaction').count()) === 0);
  check('and no box was added on top', (await page.locator('.ul-pdf-ann-text').count()) === 0);
  check(
    'the document is modified by it',
    (await page.locator('.tab[data-dirty="true"]').count()) === 1,
  );

  /* The edit is in the bytes rather than in a list of annotations, so undo has
     to reach the bytes too — and put the reader back where it was reading. */
  await page.keyboard.press('Control+Z');
  await page.waitForFunction(
    () => document.querySelector('.ul-pdf-text')?.innerText.includes('Total 100 EUR'),
    { timeout: 30000 },
  );
  check('undo brings the old line back', true);
  check(
    'and leaves nothing modified behind it',
    (await page.locator('.tab[data-dirty="true"]').count()) === 0,
  );

  await page.keyboard.press('Control+Shift+Z');
  await page.waitForFunction(
    () => document.querySelector('.ul-pdf-text')?.innerText.includes('Total 250 EUR'),
    { timeout: 30000 },
  );
  check('redo puts the new one back', true);

  await page.keyboard.press('Control+S');
  await page.waitForFunction(() => document.querySelectorAll('.tab[data-dirty="true"]').length === 0, {
    timeout: 30000,
  });

  const retyped = new TextDecoder('latin1').decode(await readFile(invoice));
  check('the old figure is not in the file', !retyped.includes('Total 100 EUR'));
  check('no annotation was written for it', !retyped.includes('/FreeText'));
  check('and no font was embedded to write it', !retyped.includes('/FontFile'));

  await page.locator('.tab .close').first().click();
  await page.waitForTimeout(400);
  await open('invoice.pdf');
  const invoiceText = await page.locator('.ul-pdf-text').innerText();
  check(
    'the new figure reads back out of the file',
    invoiceText.includes('Total 250 EUR'),
    JSON.stringify(invoiceText.replace(/\s+/g, ' ').slice(0, 40)),
  );

  /*
   * And the other side of the same door: a letter that font has no code for is
   * named while there is still time to do something about it.
   */
  const corrected = await page.locator('.ul-pdf-text span').first().boundingBox();
  await page.locator('.ul-pdf-tool[title*="Edit text"]').click();
  await page.mouse.click(corrected.x + corrected.width / 2, corrected.y + corrected.height / 2);
  await page.waitForSelector('.ul-pdf-text-input', { timeout: 15000 });
  await page.locator('.ul-pdf-text-input').fill('Cijena 250 EUR');
  check(
    'still nothing to warn about in plain letters',
    await page.locator('.ul-pdf-text-warning').isHidden(),
  );
  await page.locator('.ul-pdf-text-input').fill('Cijena 250 kuna čć');
  await page.waitForSelector('.ul-pdf-text-warning:not([hidden])', { timeout: 5000 });
  const said = await page.locator('.ul-pdf-text-warning').innerText();
  check('the letters it cannot write are named', said.includes('č') && said.includes('ć'), said.slice(0, 90));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ul-pdf-redaction[data-replaced="true"]', { timeout: 10000 });
  check('and that edit takes the other route instead', true);

  /* Undone rather than saved: what follows opens another document, and a tab
     left unsaved would ask about it. */
  await page.keyboard.press('Control+Z');
  await page.waitForFunction(() => document.querySelectorAll('.tab[data-dirty="true"]').length === 0, {
    timeout: 10000,
  });

  /* ── rewriting a line our font has to write ────────────────────────── */

  await page.locator('.tab .close').first().click();
  await page.waitForTimeout(400);
  await open('contract.pdf');

  const original = await page.locator('.ul-pdf-text span').first().boundingBox();
  /*
   * First the other half of that split. "Add text" over an existing line has to
   * open an **empty** box — a new one, on top. It used to open the line for
   * rewriting instead, which meant there was no way to write a note over
   * existing text at all, and no warning that the line had been taken over.
   */
  await page.locator('.ul-pdf-tool[title*="Add text"]').click();
  await page.mouse.click(original.x + original.width / 2, original.y + original.height / 2);
  await page.waitForSelector('.ul-pdf-text-input', { timeout: 15000 });
  check(
    'Add text over an existing line opens a new box, not that line',
    (await page.locator('.ul-pdf-text-input').inputValue()) === '',
    JSON.stringify(await page.locator('.ul-pdf-text-input').inputValue()),
  );
  await page.keyboard.press('Escape');
  check(
    'and it left the line alone',
    (await page.locator('.ul-pdf-redaction[data-replaced="true"]').count()) === 0,
  );

  /* Its own tool now. Rewriting used to hide inside "Add text", where clicking a
     line swallowed it and nothing said so. */
  await page.locator('.ul-pdf-tool[title*="Edit text"]').click();
  await page.mouse.click(original.x + original.width / 2, original.y + original.height / 2);

  await page.waitForSelector('.ul-pdf-text-input', { timeout: 15000 });

  /*
   * The field has to arrive **prefilled** with what the page says. An empty field
   * would mean the click opened a new box on top of the old text rather than an
   * edit of the existing one — and the old line would stay underneath.
   */
  const prefilled = await page.locator('.ul-pdf-text-input').inputValue();
  check('the field is prefilled with the existing text', prefilled === 'Name and surname', JSON.stringify(prefilled));

  const REPLACEMENT = 'Joško Latin — čćžšđ';
  await page.locator('.ul-pdf-text-input').fill(REPLACEMENT);
  await page.keyboard.press('Escape');

  await page.waitForSelector('.ul-pdf-redaction[data-replaced="true"]', { timeout: 5000 });
  check('the old line is marked for removal', true);
  check(
    'the new text stands on the page',
    (await page.locator('.ul-pdf-ann-text').first().innerText()) === REPLACEMENT,
  );

  await page.keyboard.press('Control+S');
  await page.waitForFunction(() => document.querySelectorAll('.tab[data-dirty="true"]').length === 0, {
    timeout: 30000,
  });

  const rewritten = new TextDecoder('latin1').decode(await readFile(contract));
  check('the source line is no longer in the file', !rewritten.includes('Name and surname'));
  check('the replacement was written as text', rewritten.includes('/FreeText'));

  await page.locator('.tab .close').first().click();
  await page.waitForTimeout(400);
  await open('contract.pdf');
  await page.waitForSelector('.ul-pdf-ann-text', { timeout: 20000 });
  check(
    'the rewritten line reads back out of the file',
    (await page.locator('.ul-pdf-ann-text').first().innerText()) === REPLACEMENT,
    JSON.stringify(await page.locator('.ul-pdf-ann-text').first().innerText()),
  );
  check(
    'the source text is not in the page layer either',
    !(await page.locator('.ul-pdf-text').innerText()).includes('Name and surname'),
  );

  await page.screenshot({ path: resolve(ROOT, 'tools/screenshots/desktop-pdf-text.png') });
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await page
    ?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-pdf-text.png') })
    .catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  app.kill();
  spawn('taskkill', ['/F', '/IM', 'uleditor-desktop.exe'], { shell: true, stdio: 'ignore' });
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
