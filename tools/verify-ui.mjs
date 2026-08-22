/**
 * Runtime check of the shell.
 *
 * Files are injected through a real `drop` event rather than the system dialog —
 * the File System Access API cannot be driven from a script, and a drop takes
 * exactly the same route: adoptFiles → detection → registry → lazy provider →
 * editor mount. So it tests what we care about.
 *
 *   node tools/verify-ui.mjs [--url http://localhost:5273] [--headed]
 */

import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = resolve(ROOT, 'tools/screenshots');

const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5273';
const headed = args.includes('--headed');

import { MD_SOURCE, TS_SOURCE, makeFakeDocx, makeMultiPagePdf, makePdf } from './fixtures.mjs';

/* ── helpers ─────────────────────────────────────────────────────────── */

/**
 * Waits for a condition instead of guessing how long it takes.
 *
 * A fixed sleep before an assertion is a check that passes on the machine it
 * was written on. This one cost a red build: the page rail was given 400 ms to
 * mark a rotated page, which is plenty here and was not enough on a loaded
 * Windows runner — the rotation had happened, the attribute simply had not been
 * read yet. Returns whether the condition came true, so the assertion below can
 * still report the real state rather than a timeout.
 */
async function until(condition, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  const mark = passed ? '  ok  ' : ' FAIL ';
  console.log(`[${mark}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/** `content` is a string, or an array of bytes for the binary formats. */
async function dropFile(page, name, content) {
  const bytes = typeof content === 'string' ? null : Array.from(content);
  await page.evaluate(
    async ([fileName, text, byteArray]) => {
      const body = byteArray ? new Uint8Array(byteArray) : text;
      const file = new File([body], fileName);
      const transfer = new DataTransfer();
      transfer.items.add(file);
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    },
    [name, typeof content === 'string' ? content : '', bytes],
  );
}

/* ── execution ───────────────────────────────────────────────────────── */

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

try {
  await mkdir(SHOTS, { recursive: true });
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  /* — okvir — */
  await page.waitForSelector('.shell', { timeout: 15000 });
  check('the shell renders', true);

  /*
   * The version beside the name. It is written into the bundle by Vite from
   * tauri.conf.json, and a build with that wiring broken renders the word
   * "undefined" in the corner of the window rather than failing — nothing else
   * would notice.
   */
  const shownVersion = (await page.locator('.brand small').innerText()).trim();
  const expectedVersion = JSON.parse(
    await readFile(resolve(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
  ).version;
  check(
    'the version beside the name is the one being built',
    shownVersion === expectedVersion,
    `${shownVersion} — tauri.conf.json says ${expectedVersion}`,
  );

  for (const [label, selector] of [
    ['title bar', '.titlebar'],
    ['activity bar', '.activitybar'],
    ['side panel', '.sidebar'],
    ['status bar', '.statusbar'],
    ['welcome screen', '.welcome'],
  ]) {
    check(`${label} exists`, await page.locator(selector).isVisible());
  }

  /* — code — */
  await dropFile(page, 'example.ts', TS_SOURCE);
  await page.waitForSelector('.cm-editor', { timeout: 15000 });
  const highlighted = await page.locator('.cm-line span[class*="ͼ"]').count();
  check('CodeMirror is mounted', true);
  check('the syntax is coloured', highlighted > 0, `${highlighted} coloured tokens`);
  check('the tab got its name', (await page.locator('.tab .name').first().innerText()) === 'example.ts');

  /* — markdown — */
  await dropFile(page, 'biljeske.md', MD_SOURCE);
  await page.waitForSelector('.ul-md', { timeout: 15000 });
  await page.waitForSelector('.ul-md-preview h1', { timeout: 10000 });
  const previewTitle = await page.locator('.ul-md-preview h1').first().innerText();
  check('the Markdown preview renders', previewTitle.trim() === 'ulEditor', previewTitle.trim());
  check('a table in the preview', (await page.locator('.ul-md-preview table').count()) === 1);

  /* — PDF — */
  await dropFile(page, 'dokument.pdf', makePdf());
  await page.waitForSelector('.ul-pdf', { timeout: 20000 });
  await page.waitForSelector('.ul-pdf-page[data-rendered="true"]', { timeout: 20000 });
  const canvasBox = await page.locator('.ul-pdf-page canvas').first().boundingBox();
  check('the PDF page was rendered', !!canvasBox && canvasBox.width > 50, `${Math.round(canvasBox?.width ?? 0)}px`);
  const textSpans = await page.locator('.ul-pdf-text span').count();
  check('text layer built', textSpans > 0, `${textSpans} fragments`);

  /* — a damaged file — */
  // A ZIP that is not one: the editor exists, but the content cannot be read. The
  // message has to be human, not whatever the unzip library threw.
  await dropFile(page, 'ugovor.docx', makeFakeDocx());
  await page.waitForSelector('.surface-error', { timeout: 10000 });
  const message = await page.locator('.surface-error p').innerText();
  check('a damaged DOCX gives a comprehensible message', message.includes('damaged'), message.slice(0, 70));

  /* — annotations over the PDF — */
  await page.locator('.tab').nth(2).click();
  await page.waitForTimeout(300);

  await page.locator('.ul-pdf-tool[title*="Highlight"]').click();
  // The selection is made programmatically: a real mouse drag across the invisible
  // text layer is not reliable on a single line of text.
  await page.evaluate(() => {
    const span = document.querySelector('.ul-pdf-text span');
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.querySelector('.ul-pdf-scroll').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.waitForSelector('.ul-pdf-ann-highlight', { timeout: 10000 });
  check('a highlight was created from the selection', (await page.locator('.ul-pdf-ann-highlight').count()) >= 1);
  check(
    'the PDF is marked as modified',
    (await page.locator('.tab[data-dirty="true"]').count()) >= 1,
    await page.locator('.ul-pdf-count').innerText(),
  );

  await page.locator('.ul-pdf-tool[title*="Note"]').click();
  await page.locator('.ul-pdf-page').first().click({ position: { x: 200, y: 60 } });
  await page.waitForSelector('.ul-pdf-note-popup', { timeout: 5000 });
  await page.locator('.ul-pdf-note-popup textarea').fill('Check čćžšđ');
  const noteBeforeSave = await page.locator('.ul-pdf-ann-note').count();
  await page.locator('.ul-pdf-note-popup button[data-primary="true"]').click();
  await page.waitForTimeout(250);
  const noteAfterSave = await page.locator('.ul-pdf-ann-note').count();
  check(
    'the note was placed',
    noteAfterSave === 1,
    `before save ${noteBeforeSave}, after ${noteAfterSave}, bar: ${await page
      .locator('.ul-pdf-count')
      .innerText()}`,
  );

  // Placing the note and typing its text are two separate history steps, so the
  // first undo restores the empty text and only the second removes the note.
  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(250);
  const titleAfterOne = await page.locator('.ul-pdf-ann-note').first().getAttribute('title');
  check('the first undo restores the note text', titleAfterOne === 'Note', String(titleAfterOne));

  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(250);
  const notesLeft = await page.locator('.ul-pdf-ann-note').count();
  const highlightsLeft = await page.locator('.ul-pdf-ann-highlight').count();
  check(
    'the second undo removes the note, the highlight stays',
    notesLeft === 0 && highlightsLeft >= 1,
    `notes ${notesLeft}, highlights ${highlightsLeft}`,
  );

  // Redo has to bring the note back — otherwise undo is not reversible.
  await page.keyboard.press('Control+Shift+Z');
  await page.waitForTimeout(250);
  check('redo brings the note back', (await page.locator('.ul-pdf-ann-note').count()) === 1);

  /* — text typed into the PDF — */
  await page.locator('.ul-pdf-tool[title*="Add text"]').click();
  check('the font settings appear only with the text tool', await page.locator('.ul-pdf-text-opts').isVisible());

  await page.locator('.ul-pdf-page').first().click({ position: { x: 90, y: 120 } });
  await page.waitForSelector('.ul-pdf-text-input', { timeout: 10000 });

  const TYPED = 'Vodice — čćžšđ';
  await page.locator('.ul-pdf-text-input').pressSequentially(TYPED);

  /*
   * The font the box is computed from has to be the one drawn on screen too.
   * Otherwise the box width and the text width would drift apart, and differently
   * per platform — barely on Windows, visibly on Android.
   */
  const usesEmbedded = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.ul-pdf-text-input')).fontFamily.includes(
      'ulEditor Sans',
    ),
  );
  check('the typing field uses the embedded font', usesEmbedded);

  const grew = await page.evaluate(() => {
    const input = document.querySelector('.ul-pdf-text-input');
    return input.getBoundingClientRect().width;
  });

  await page.keyboard.press('Escape');
  await page.waitForSelector('.ul-pdf-ann-text', { timeout: 5000 });
  const boxText = await page.locator('.ul-pdf-ann-text').first().innerText();
  check('the text stays on the page after typing', boxText === TYPED, JSON.stringify(boxText));
  check('the box grew with the text', grew > 40, `${Math.round(grew)}px`);

  // An empty box must not be left behind: clicking and then changing your mind is
  // the commonest move, and an invisible annotation in the document is junk.
  const boxesBefore = await page.locator('.ul-pdf-ann-text').count();
  await page.locator('.ul-pdf-page').first().click({ position: { x: 260, y: 200 } });
  await page.waitForSelector('.ul-pdf-text-input', { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check(
    'an empty box is not saved',
    (await page.locator('.ul-pdf-ann-text').count()) === boxesBefore,
    `${boxesBefore} before, ${await page.locator('.ul-pdf-ann-text').count()} after`,
  );

  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(250);
  check('undo removes the typed text', (await page.locator('.ul-pdf-ann-text').count()) === 0);

  await page.keyboard.press('Control+Shift+Z');
  await page.waitForTimeout(250);
  check('redo brings it back', (await page.locator('.ul-pdf-ann-text').count()) === 1);

  await page.locator('.ul-pdf-tool[title*="Select"]').click();

  /* — an image — */
  const png = await readFile(resolve(ROOT, 'apps/desktop/src-tauri/icons/128x128.png'));
  await dropFile(page, 'icon.png', png);
  await page.waitForSelector('.ul-img', { timeout: 15000 });
  await page.waitForSelector('.ul-img-frame img', { timeout: 10000 });
  const imgBox = await page.locator('.ul-img-frame img').boundingBox();
  check('the image is displayed', !!imgBox && imgBox.width > 10, `${Math.round(imgBox?.width ?? 0)}px`);
  const imgStatus = await page.locator('.statusbar').innerText();
  check('the dimensions are in the status bar', imgStatus.includes('128 × 128'), imgStatus.replace(/\s+/g, ' ').slice(0, 60));

  /* — tabs — */
  check('five open tabs', (await page.locator('.tab').count()) === 5);

  /* — two editor groups — */
  /*
   * Driven from the keyboard rather than the store, so what is checked is the
   * route a person takes: Ctrl+\\ moves the tab in front to the other side.
   */
  await page.locator('.tab').last().click();
  await page.keyboard.press('Control+\\');
  await page.waitForSelector('.group[data-split="true"]', { timeout: 5000 });
  check('the split opens with two groups', (await page.locator('.group').count()) === 2);
  check(
    'the tab moved rather than being copied',
    (await page.locator('.tab').count()) === 5,
    `${await page.locator('.group').nth(0).locator('.tab').count()} + ${await page
      .locator('.group')
      .nth(1)
      .locator('.tab')
      .count()}`,
  );
  check(
    'the side it moved to has the focus',
    (await page.locator('.group').nth(1).getAttribute('data-focused')) === 'true',
  );

  // Clicking into the other group moves the focus without changing which tab is
  // in front on either side.
  await page.locator('.group').first().locator('.tab').first().click();
  check(
    'clicking a tab moves the focus back',
    (await page.locator('.group').first().getAttribute('data-focused')) === 'true',
  );

  // Both documents are on screen at once — the whole point of the split.
  const leftBox = await page.locator('.group').nth(0).boundingBox();
  const rightBox = await page.locator('.group').nth(1).boundingBox();
  check(
    'both groups are visible side by side',
    !!leftBox && !!rightBox && leftBox.width > 50 && rightBox.width > 50 && rightBox.x > leftBox.x,
    `${Math.round(leftBox?.width ?? 0)} + ${Math.round(rightBox?.width ?? 0)} px`,
  );

  // Emptying a group closes the split rather than leaving half a blank window.
  await page.locator('.group').nth(1).locator('.tab').first().hover();
  await page.locator('.group').nth(1).locator('.tab .close').first().click();
  await page.waitForSelector('.group[data-split="false"]', { timeout: 5000 });
  check('closing the last tab of a group closes the split', (await page.locator('.group').count()) === 1);
  check('the remaining tabs are all still open', (await page.locator('.tab').count()) === 4);

  // Back to five, so the checks below see the workspace they expect.
  await dropFile(page, 'icon.png', png);
  await page.waitForSelector('.ul-img-frame img', { timeout: 15000 });

  /* — in-document search (the same contract for every format) — */
  await page.locator('.tab').first().click();
  await page.keyboard.press('Control+Shift+F');
  await page.waitForSelector('.findpanel', { timeout: 5000 });
  await page.locator('.findpanel-bar input').pressSequentially('formats');
  await page.waitForSelector('.findpanel-hit', { timeout: 10000 });
  const codeHits = await page.locator('.findpanel-hit').count();
  check('search in code', codeHits >= 2, `${codeHits} hits`);

  await page.locator('.findpanel-hit').nth(1).click();
  await page.waitForTimeout(200);
  check('jumping to a hit works', (await page.locator('.findpanel-hit[data-active="true"]').count()) === 1);

  // The same UI over a PDF — a format that otherwise has no search interface at all.
  await page.locator('.tab').nth(2).click();
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+Shift+F');
  await page.waitForSelector('.findpanel', { timeout: 5000 });
  // The query is deliberately kept across tabs, so we replace it here.
  await page.locator('.findpanel-bar input').fill('ulEditor');
  await page.waitForSelector('.findpanel-hit', { timeout: 15000 });
  const pdfHits = await page.locator('.findpanel-hit').count();
  const pdfLabel = await page.locator('.findpanel-hit .where').first().innerText();
  check('the same search works over a PDF', pdfHits > 0 && pdfLabel.includes('Page'), `${pdfHits} · ${pdfLabel}`);

  // Switching back to code has to clear the PDF results at once — a `reveal()` on
  // somebody else's result would jump into an editor that is not in front.
  await page.locator('.tab').first().click();
  await page.waitForTimeout(120);
  const staleWhere = await page.locator('.findpanel-hit .where').allInnerTexts();
  check(
    'results from another tab are not kept',
    !staleWhere.some((t) => t.includes('Page')),
    staleWhere.slice(0, 2).join(', ') || 'empty',
  );

  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('Esc closes the search', (await page.locator('.findpanel').count()) === 0);

  /* — paleta naredbi — */
  await page.keyboard.press('Control+Shift+P');
  await page.waitForSelector('.palette', { timeout: 5000 });
  const allCommands = await page.locator('.palette-item').count();

  const paletteInput = page.locator('.palette-input input');
  check('the palette focuses itself', await paletteInput.evaluate((el) => el === document.activeElement));

  await paletteInput.pressSequentially('cycle theme');
  const paletteHits = await page.locator('.palette-item').count();
  check(
    'the palette filters the commands',
    paletteHits > 0 && paletteHits < allCommands,
    `${allCommands} → ${paletteHits}`,
  );

  const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme ?? 'system');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme ?? 'system');
  check('the command changes the theme', themeBefore !== themeAfter, `${themeBefore} → ${themeAfter}`);

  /* — editing and the dirty flag — */
  await page.locator('.tab').first().click();
  await page.locator('.cm-content').first().click();
  await page.keyboard.type('// edit\n');
  await page.waitForTimeout(150);
  // Two modified tabs: the code we have just typed and the PDF with annotations.
  const dirty = await page.locator('.tab[data-dirty="true"]').count();
  check('the unsaved mark is on both modified tabs', dirty === 2, `${dirty}`);

  /* — page operations — */
  await dropFile(page, 'visestranicni.pdf', makeMultiPagePdf(3));
  await page.waitForSelector('.tab', { timeout: 10000 });
  await page.locator('.tab').nth(5).click();
  // Inactive tabs stay in the DOM (they are merely hidden), so from here on the
  // selectors have to be scoped to the visible pane.
  const pdf = page.locator('.mount:visible');
  await pdf.locator('.ul-pdf-page[data-rendered="true"]').first().waitFor({ timeout: 20000 });

  await pdf.locator('.ul-pdf-btn[title*="Pages"]').click();
  await pdf.locator('.ul-pdf-thumb').first().waitFor({ timeout: 10000 });
  check('the rail shows three pages', (await pdf.locator('.ul-pdf-thumb').count()) === 3);

  await pdf.locator('.ul-pdf-thumb').first().hover();
  await pdf.locator('.ul-pdf-thumb').first().locator('button[title*="Rotate right"]').click();
  const marked = await until(
    async () => (await pdf.locator('.ul-pdf-thumb .num[data-changed="true"]').count()) === 1,
  );
  check('a rotated page is marked as changed', marked);

  await pdf.locator('.ul-pdf-thumb').nth(1).hover();
  await pdf.locator('.ul-pdf-thumb').nth(1).locator('button[title*="Delete page"]').click();
  const twoLeft = await until(async () => (await pdf.locator('.ul-pdf-thumb').count()) === 2);
  check('deleting leaves two pages', twoLeft);
  check(
    'the page counter in the bar follows the deletion',
    (await pdf.locator('.ul-pdf-total').innerText()).includes('2'),
    await pdf.locator('.ul-pdf-total').innerText(),
  );
  check(
    'the page changes are described',
    (await pdf.locator('.ul-pdf-count').innerText()).includes('deleted'),
    await pdf.locator('.ul-pdf-count').innerText(),
  );

  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(600);
  check('undo brings the deleted page back', (await pdf.locator('.ul-pdf-thumb').count()) === 3);

  await page.screenshot({ path: resolve(SHOTS, 'pages.png') });

  /* — snimke — */
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(SHOTS, 'shell-dark.png') });

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(SHOTS, 'shell-light.png') });

  await page.locator('.tab').nth(1).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS, 'markdown.png') });

  await page.locator('.tab').nth(2).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: resolve(SHOTS, 'pdf.png') });

  await page.locator('.tab').nth(4).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS, 'image.png') });

  await page.locator('.tab').first().click();
  await page.keyboard.press('Control+Shift+F');
  await page.locator('.findpanel-bar input').fill('const');
  await page.waitForSelector('.findpanel-hit', { timeout: 10000 });
  // The panel's entrance animation takes 140 ms; a screenshot before that looks washed out.
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(SHOTS, 'find.png') });
  await page.keyboard.press('Escape');

  check('the screenshots are saved', true, 'tools/screenshots/');

  /* — konzola — */
  const ignorable = (text) => text.includes('Download the React DevTools') || text.includes('[vite]');
  const real = consoleErrors.filter((t) => !ignorable(t));
  check('no console errors', real.length === 0, real.slice(0, 3).join(' | '));
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await page.screenshot({ path: resolve(SHOTS, 'failure.png') }).catch(() => {});
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.passed);
await writeFile(resolve(SHOTS, 'report.json'), JSON.stringify({ checks, consoleErrors }, null, 2));

console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
