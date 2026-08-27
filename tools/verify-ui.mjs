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

import {
  BAT_SOURCE,
  MD_SOURCE,
  TS_SOURCE,
  makeAnnotatedPdf,
  makeDoc,
  makeFakeDocx,
  makeMultiPagePdf,
  makeOds,
  makeOdt,
  makePdf,
  makeRtf,
  makeSplitLinePdf,
  makeToUnicodePdf,
  makeXls,
  makeXlsx,
} from './fixtures.mjs';

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

/**
 * How much ink is inside a rectangle of the page as it is composited.
 *
 * There are things on a PDF page that no selector can reach. The reader paints
 * an annotation's appearance stream onto the canvas, and the editor draws its own
 * editable copy on top; while the two agree they look like one thing, and the
 * only way to tell them apart is to count the dark pixels where one of them used
 * to be. The screenshot is decoded by handing it back to the page, which is what
 * a person would be looking at.
 */
async function inkIn(page, clip) {
  const shot = (await page.screenshot({ clip })).toString('base64');
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) return -1;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 128 && data[i + 1] < 128 && data[i + 2] < 128) dark++;
    }
    return dark / (data.length / 4);
  }, shot);
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

  /*
   * A welcome taller than the window has to be reachable. It was not: the
   * surface is a flex box, it had no overflow, and the lower half of the
   * screen was simply outside the program. Both ends are checked, because
   * plain centring pushes the overflow out of *both* — fixing the bottom by
   * centring differently is how the top becomes unreachable instead.
   */
  await page.setViewportSize({ width: 1440, height: 420 });
  const reach = await page.evaluate(() => {
    const surface = document.querySelector('.welcome-surface');
    if (!surface) return null;
    surface.scrollTop = 0;
    const top = document.querySelector('.welcome-mark').getBoundingClientRect().top;
    surface.scrollTop = surface.scrollHeight;
    const lines = document.querySelectorAll('.welcome-formats .fmt-line');
    const bottom = lines[lines.length - 1].getBoundingClientRect().bottom;
    surface.scrollTop = 0;
    return {
      scrolls: surface.scrollHeight > surface.clientHeight,
      topReachable: Math.round(top) >= 0,
      bottomReachable: Math.round(bottom) <= Math.round(surface.getBoundingClientRect().bottom) + 1,
    };
  });
  check(
    'a welcome taller than the window scrolls, and both of its ends can be reached',
    reach?.scrolls && reach.topReachable && reach.bottomReachable,
    JSON.stringify(reach),
  );
  await page.setViewportSize({ width: 1440, height: 900 });

  /* — code — */
  await dropFile(page, 'example.ts', TS_SOURCE);
  await page.waitForSelector('.cm-editor', { timeout: 15000 });
  const highlighted = await page.locator('.cm-line span[class*="ͼ"]').count();
  check('CodeMirror is mounted', true);
  check('the syntax is coloured', highlighted > 0, `${highlighted} coloured tokens`);
  check('the tab got its name', (await page.locator('.tab .name').first().innerText()) === 'example.ts');

  /*
   * — a batch script, and a shell script —
   *
   * Both were grey text until the editor grew the modes for them: nothing had
   * ever connected the language the detector names to the set the editor can
   * load. Counting coloured tokens is the only way to tell a mode that loaded
   * from one that silently did not.
   */
  await dropFile(page, 'install.bat', BAT_SOURCE);
  await page.waitForSelector('.mount:visible .cm-editor', { timeout: 15000 });
  const batTokens = await until(
    async () => (await page.locator('.mount:visible .cm-line span[class*="ͼ"]').count()) > 4,
  );
  check(
    'a batch file is syntax coloured',
    batTokens,
    `${await page.locator('.mount:visible .cm-line span[class*="ͼ"]').count()} coloured tokens`,
  );

  await dropFile(
    page,
    'setup.sh',
    ['#!/bin/sh', 'set -eu', 'for f in *.txt; do', '  echo "$f"', 'done', ''].join('\n'),
  );
  await page.waitForSelector('.mount:visible .cm-editor', { timeout: 15000 });
  const shTokens = await until(
    async () => (await page.locator('.mount:visible .cm-line span[class*="ͼ"]').count()) > 3,
  );
  check('a shell script is syntax coloured', shTokens);

  /*
   * Both are closed again. The checks further down reach tabs by position —
   * `.tab` nth(2) is the PDF — so leaving two extra ones open moves every one of
   * them and the failure lands somewhere unrelated, as a click timing out on a
   * tab that is now something else.
   */
  for (const name of ['install.bat', 'setup.sh']) {
    const tab = page.locator('.tab', { hasText: name });
    await tab.hover();
    await tab.locator('.close').click();
  }
  const restored = await until(async () => (await page.locator('.tab').count()) === 1);
  check('the two script tabs closed again', restored, `${await page.locator('.tab').count()} left`);

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
  await until(async () => (await page.locator('.ul-pdf:visible').count()) === 1);

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
  await until(async () => (await page.locator('.ul-pdf-ann-note').count()) === 1);
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
  await until(
    async () => (await page.locator('.ul-pdf-ann-note').first().getAttribute('title')) === 'Note',
  );
  const titleAfterOne = await page.locator('.ul-pdf-ann-note').first().getAttribute('title');
  check('the first undo restores the note text', titleAfterOne === 'Note', String(titleAfterOne));

  await page.keyboard.press('Control+Z');
  await until(async () => (await page.locator('.ul-pdf-ann-note').count()) === 0);
  const notesLeft = await page.locator('.ul-pdf-ann-note').count();
  const highlightsLeft = await page.locator('.ul-pdf-ann-highlight').count();
  check(
    'the second undo removes the note, the highlight stays',
    notesLeft === 0 && highlightsLeft >= 1,
    `notes ${notesLeft}, highlights ${highlightsLeft}`,
  );

  // Redo has to bring the note back — otherwise undo is not reversible.
  await page.keyboard.press('Control+Shift+Z');
  const noteBack = await until(async () => (await page.locator('.ul-pdf-ann-note').count()) === 1);
  check('redo brings the note back', noteBack);

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
  /*
   * A pause, and it has to be one: this asserts that something does NOT appear,
   * and there is no condition to wait for. Waiting until the count matches
   * would be satisfied immediately and prove nothing — the delay is the check.
   */
  await page.waitForTimeout(250);
  check(
    'an empty box is not saved',
    (await page.locator('.ul-pdf-ann-text').count()) === boxesBefore,
    `${boxesBefore} before, ${await page.locator('.ul-pdf-ann-text').count()} after`,
  );

  await page.keyboard.press('Control+Z');
  const textGone = await until(async () => (await page.locator('.ul-pdf-ann-text').count()) === 0);
  check('undo removes the typed text', textGone);

  await page.keyboard.press('Control+Shift+Z');
  const textBack = await until(async () => (await page.locator('.ul-pdf-ann-text').count()) === 1);
  check('redo brings it back', textBack);

  /*
   * The same two steps from the bar. The keys have always done this, which is
   * everything to somebody who knows them and nothing to somebody who does not.
   * The buttons read the editor's own history rather than a copy of it, so what
   * is greyed out is what is genuinely unavailable.
   */
  const undoBtn = page.locator('.titlebar .chrome-btn[aria-label^="Undo"]');
  const redoBtn = page.locator('.titlebar .chrome-btn[aria-label^="Redo"]');
  check('the bar offers undo and redo', (await undoBtn.count()) === 1 && (await redoBtn.count()) === 1);
  check('undo is offered once there is something to undo', await undoBtn.isEnabled());
  check('and redo is not, at the end of the history', await redoBtn.isDisabled());

  await undoBtn.click();
  const undoneByButton = await until(
    async () => (await page.locator('.ul-pdf-ann-text').count()) === 0,
  );
  check('the undo button removes the typed text', undoneByButton);
  check('and redo is offered afterwards', await redoBtn.isEnabled());

  await redoBtn.click();
  const redoneByButton = await until(
    async () => (await page.locator('.ul-pdf-ann-text').count()) === 1,
  );
  check('the redo button brings it back', redoneByButton);

  await page.locator('.ul-pdf-tool[title*="Select"]').click();

  /* — a line the file keeps in pieces — */

  /*
   * What a click has to offer is the line as it reads, not the one instruction
   * it landed on. `E93.89` is the sign in one and the figure in another, and
   * `E 9` — which is what taking a single instruction gave — is not the amount.
   */
  await dropFile(page, 'row.pdf', new TextEncoder().encode(makeSplitLinePdf()));
  const row = page.locator('.ul-pdf:visible');
  await until(async () => (await page.locator('.tab').count()) === 6, 20000);
  await until(async () => (await row.locator('.ul-pdf-page[data-rendered="true"]').count()) > 0, 20000);
  await until(
    async () =>
      (await row.locator('.ul-pdf-text').innerText().catch(() => '')).includes('93.89'),
    20000,
  );

  const figure = await row.locator('.ul-pdf-text span', { hasText: '93.89' }).first().boundingBox();
  await row.locator('.ul-pdf-tool[title*="Edit text"]').click();
  await page.mouse.click(figure.x + Math.min(figure.width / 2, 20), figure.y + figure.height / 2);
  await page.waitForSelector('.ul-pdf-text-input', { timeout: 15000 });
  check(
    'clicking the figure offers the whole amount',
    (await page.locator('.ul-pdf-text-input').inputValue()) === 'E93.89',
    JSON.stringify(await page.locator('.ul-pdf-text-input').inputValue()),
  );

  /* The cover has to hide all of it, not only the piece that was clicked. */
  const cover = await page.locator('.ul-pdf-rewrite-cover').boundingBox();
  const sign = await row.locator('.ul-pdf-text span', { hasText: 'E' }).first().boundingBox();
  check(
    'and the whole of it is covered while typing',
    !!cover && cover.x <= sign.x + 1 && cover.x + cover.width >= figure.x + figure.width - 1,
    `cover ${Math.round(cover?.x ?? 0)}–${Math.round((cover?.x ?? 0) + (cover?.width ?? 0))}, line ${Math.round(sign.x)}–${Math.round(figure.x + figure.width)}`,
  );

  await page.locator('.ul-pdf-text-input').fill('E93.99');
  await page.keyboard.press('Escape');
  await until(
    async () => (await row.locator('.ul-pdf-text').innerText().catch(() => '')).includes('93.99'),
    20000,
  );
  const rowText = await row.locator('.ul-pdf-text').innerText();
  check('the amount is corrected on the page itself', rowText.includes('93.99'), JSON.stringify(rowText.replace(/\s+/g, ' ')));
  check('the label beside it is still there', rowText.includes('Total'));
  check('and no box was glued on top', (await row.locator('.ul-pdf-ann-text').count()) === 0);

  /* — the writing controls — */

  /*
   * The bar has to describe the text under the caret before it can change it.
   * A font name that is not the line's own, or a size that is not the line's
   * own, means every one of these controls is about to lie about its effect.
   */
  await row.locator('.ul-pdf-tool[title*="Edit text"]').click();
  await page.mouse.click(figure.x + Math.min(figure.width / 2, 20), figure.y + figure.height / 2);
  await page.waitForSelector('.ul-pdf-text-input', { timeout: 15000 });

  const family = row.locator('.ul-pdf-family');
  check(
    'the font list offers the document\u2019s own font first',
    (await family.inputValue()) === 'document' &&
      (await family.locator('option').first().innerText()) === 'Inter',
    `${await family.inputValue()} \u00b7 ${await family.locator('option').first().innerText()}`,
  );
  check(
    'and ours as the other choice',
    (await family.locator('option').nth(1).innerText()) === 'Liberation Sans',
    await family.locator('option').nth(1).innerText(),
  );
  check(
    'the size field shows the size the line is set in',
    (await row.locator('.ul-pdf-size').inputValue()) === '12',
    await row.locator('.ul-pdf-size').inputValue(),
  );

  const styleOf = async (prop) =>
    page.locator('.ul-pdf-text-input').evaluate(
      (el, name) => getComputedStyle(el).getPropertyValue(name),
      prop,
    );

  await row.locator('.ul-pdf-btn[title*="Bold"]').click();
  check('bold shows in the field while typing', (await styleOf('font-weight')) === '700', await styleOf('font-weight'));
  check(
    'and the font list says the cut cannot come from the document\u2019s font',
    (await family.inputValue()) === 'sans',
    await family.inputValue(),
  );

  await row.locator('.ul-pdf-btn[title*="Underline"]').click();
  check(
    'the rule shows in the field too',
    (await styleOf('text-decoration-line')) === 'underline',
    await styleOf('text-decoration-line'),
  );

  /* Against the field before the change, not against 20 px: the field is drawn at
     the page's zoom, and the page here is magnified more than three times. */
  const before = parseFloat(await styleOf('font-size'));
  await row.locator('.ul-pdf-size').fill('20');
  await row.locator('.ul-pdf-size').press('Enter');
  const after = parseFloat(await styleOf('font-size'));
  check(
    'and a size typed into the field is the size on the page',
    Math.abs(after / before - 20 / 12) < 0.02,
    `${before.toFixed(1)} → ${after.toFixed(1)} px, expected × ${(20 / 12).toFixed(2)}`,
  );

  /* Choosing the document's font back has to undo all three, or the choice would
     mean the original font at a weight and a size the line never had. */
  await family.selectOption('document');
  check(
    'going back to the document\u2019s font puts the cut back',
    (await styleOf('font-weight')) === '400',
    await styleOf('font-weight'),
  );
  check(
    'and the size with it',
    (await row.locator('.ul-pdf-size').inputValue()) === '12',
    await row.locator('.ul-pdf-size').inputValue(),
  );
  check(
    'and the rule',
    (await styleOf('text-decoration-line')) === 'none',
    await styleOf('text-decoration-line'),
  );

  /* Restyled, the line cannot go back into the page in its own letterforms — so
     it is replaced, and the box that replaces it carries the style. */
  await row.locator('.ul-pdf-btn[title*="Bold"]').click();
  await page.keyboard.press('Escape');
  await until(async () => (await row.locator('.ul-pdf-ann-text').count()) === 1, 15000);
  const restyled = row.locator('.ul-pdf-ann-text').first();
  check(
    'a restyled line comes back as bold text',
    (await restyled.evaluate((el) => getComputedStyle(el).fontWeight)) === '700',
    await restyled.evaluate((el) => getComputedStyle(el).fontWeight),
  );

  await page.keyboard.press('Control+Z');
  await page.keyboard.press('Control+Z');
  await until(async () => (await page.locator('.tab[data-dirty="true"]').count()) === 0);
  await page.locator('.tab').last().locator('.close').click();
  await until(async () => (await page.locator('.tab').count()) === 5);

  /* — a box that came out of the file — */

  /*
   * A document whose text box is already in it, with the appearance stream a
   * reader draws it from. That makes two drawings of the same words: the one the
   * reader painted onto the page, and ours on top of it. Identical, they look
   * like one — move the box and the painted one stays behind, which is how it
   * was reported: the same sentence twice, overlapping.
   */
  await dropFile(page, 'annotated.pdf', new TextEncoder().encode(makeAnnotatedPdf()));
  /* Every locator here is scoped to the visible editor: the other PDFs are still
     open in their tabs, and their pages and boxes are in the document too. */
  const shown = page.locator('.ul-pdf:visible');
  await until(async () => (await page.locator('.tab').count()) === 6, 20000);
  await until(async () => (await shown.locator('.ul-pdf-page[data-rendered="true"]').count()) > 0, 20000);
  /*
   * By its text, not by there being one: the PDF this replaced also has a box,
   * so "one box is showing" was true before this document had finished opening
   * — and the check then measured the wrong tab.
   */
  await until(
    async () =>
      (await shown
        .locator('.ul-pdf-ann-text')
        .first()
        .innerText()
        .catch(() => '')) === 'Josko Latin',
    20000,
  );

  const imported = await shown.locator('.ul-pdf-ann-text').first().boundingBox();
  const inked = await inkIn(page, imported);
  check('the box in the file is drawn on the page', inked > 0.02, inked.toFixed(4));

  await page.mouse.move(imported.x + imported.width / 2, imported.y + imported.height / 2);
  await page.mouse.down();
  await page.mouse.move(imported.x + imported.width / 2, imported.y + imported.height / 2 + 90, {
    steps: 12,
  });
  await page.mouse.up();
  const moved = await until(async () => {
    const now = await shown.locator('.ul-pdf-ann-text').first().boundingBox();
    return !!now && now.y - imported.y > 60;
  });
  check('it can be dragged somewhere else', moved);

  const leftBehind = await inkIn(page, imported);
  check(
    'and leaves nothing of itself where it was',
    leftBehind === 0,
    `${inked.toFixed(4)} → ${leftBehind.toFixed(4)} of the rectangle inked`,
  );

  await page.keyboard.press('Control+Z');
  await until(async () => (await page.locator('.tab[data-dirty="true"]').count()) === 0);
  await page.locator('.tab').last().locator('.close').click();
  await until(async () => (await page.locator('.tab').count()) === 5);

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
  const jumped = await until(
    async () => (await page.locator('.findpanel-hit[data-active="true"]').count()) === 1,
  );
  check('jumping to a hit works', jumped);

  // The same UI over a PDF — a format that otherwise has no search interface at all.
  await page.locator('.tab').nth(2).click();
  // The shortcut acts on whatever is in front, and a keystroke does not wait for
  // anything the way a click does.
  await until(async () => (await page.locator('.ul-pdf:visible').count()) === 1);
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
  /*
   * Another deliberate pause. The claim is that the old results are dropped at
   * once, so waiting until they are gone would turn a real failure — results
   * that linger for a second — into a pass.
   */
  await page.waitForTimeout(120);
  const staleWhere = await page.locator('.findpanel-hit .where').allInnerTexts();
  check(
    'results from another tab are not kept',
    !staleWhere.some((t) => t.includes('Page')),
    staleWhere.slice(0, 2).join(', ') || 'empty',
  );

  await page.keyboard.press('Escape');
  const closed = await until(async () => (await page.locator('.findpanel').count()) === 0);
  check('Esc closes the search', closed);

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
  await until(
    async () =>
      (await page.evaluate(() => document.documentElement.dataset.theme ?? 'system')) !== themeBefore,
  );
  const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme ?? 'system');
  check('the command changes the theme', themeBefore !== themeAfter, `${themeBefore} → ${themeAfter}`);

  /* — the menu bar — */

  /*
   * Alt belongs to Windows and to Linux. On a Mac the same key is Option, which
   * is how a person types é and £ and #, and a menu bar that answered to it
   * would take the third level of the keyboard away from them — so there it is
   * a bar you click, and `MenuBar.tsx` binds nothing. The runner tells us which
   * of the two we are, by the same test the component makes.
   */
  const onMac = await page.evaluate(() => /Mac/i.test(navigator.platform || navigator.userAgent));

  if (onMac) {
    await page.keyboard.press('Alt');
    await page.waitForTimeout(120);
    check(
      'Option is left to the person typing, and opens nothing',
      (await page.locator('.menu-panel').count()) === 0,
    );
  } else {
    /*
     * The whole reason the bar exists: everything the program can do was
     * reachable only by somebody who already knew it was there, and one key is
     * what turns that around.
     */
    await page.keyboard.press('Alt');
    const menuOpened = await until(async () => (await page.locator('.menu-panel').count()) === 1);
    check('Alt on its own opens the menu', menuOpened);
    check(
      'and the letters that open the others appear with it',
      (await page.locator('.menu-title u').count()) === 5,
      `${await page.locator('.menu-title u').count()} of 5 headings underlined`,
    );

    await page.keyboard.press('Escape');
    check(
      'Escape closes it',
      await until(async () => (await page.locator('.menu-panel').count()) === 0),
    );

    /*
     * AltGr is not Alt, and on a Croatian keyboard it is how @ and [ and € are
     * typed. Windows reports it as Ctrl and Alt together, so a menu bar that
     * reads Alt without looking at Ctrl opens a menu every time somebody types
     * an e-mail address.
     */
    await page.keyboard.press('Control+Alt+v');
    await page.waitForTimeout(80);
    check(
      'AltGr types a character rather than opening a menu',
      (await page.locator('.menu-panel').count()) === 0,
    );

    await page.keyboard.press('Alt+v');
    const viewOpened = await until(async () => (await page.locator('.menu-panel').count()) === 1);
    const openedLabel = await page.locator('.menu-panel').getAttribute('aria-label');
    check(
      'Alt and a letter open that menu directly',
      viewOpened && openedLabel === 'View',
      openedLabel,
    );
    await page.keyboard.press('Escape');
    await until(async () => (await page.locator('.menu-panel').count()) === 0);
  }

  /*
   * AltGr again, from the other side. The menu bar refuses it, and so must the
   * shortcuts underneath: Windows reports AltGr as Ctrl and Alt together, and
   * the shortcut table matches on the character the key produces. On a Croatian
   * keyboard AltGr+Q is a backslash and AltGr+7 is a backtick — one of them
   * moved the tab to the other side of the window and the other jumped to it,
   * and in both cases the character never reached the document.
   */
  {
    const before = await page.locator('.groups').getAttribute('data-split');
    await page.keyboard.press('Control+Alt+Backslash');
    await page.keyboard.press('Control+Alt+Backquote');
    await page.waitForTimeout(120);
    check(
      'AltGr does not reach the shortcuts either',
      (await page.locator('.groups').getAttribute('data-split')) === before &&
        (await page.locator('.menu-panel').count()) === 0,
      `split ${before} -> ${await page.locator('.groups').getAttribute('data-split')}`,
    );
  }

  /* The pointer reaches it everywhere, and the arrows walk it once it is open. */
  await page.locator('.menu-title', { hasText: 'View' }).click();
  await page.waitForSelector('.menu-panel', { timeout: 5000 });
  await page.keyboard.press('ArrowDown');
  check(
    'the arrows walk the rows',
    await until(async () => (await page.locator('.menu-row[data-active="true"]').count()) === 1),
  );
  await page.keyboard.press('Escape');
  await until(async () => (await page.locator('.menu-panel').count()) === 0);

  /*
   * Greyed and absent, side by side in one menu. Forgetting the recent files is
   * something this build can do and cannot do *now* — there is no such list in a
   * browser — so the row is drawn and out of reach. Exit needs a window to
   * close, which a browser tab does not have, so it is not drawn at all.
   */
  await page.locator('.menu-title').first().click();
  await page.waitForSelector('.menu-panel', { timeout: 5000 });
  const fileRows = await page.locator('.menu-panel .menu-row').allInnerTexts();
  check(
    'a row that cannot run now is drawn out of reach rather than removed',
    (await page.locator('.menu-panel .menu-row:disabled').count()) > 0,
    fileRows.join(' / '),
  );
  check(
    'and one this build has no use for is not drawn at all',
    !fileRows.some((row) => row.includes('Exit')),
    fileRows.join(' / '),
  );

  /* A click anywhere else is how a menu opened by accident is closed. */
  await page.locator('.titlebar-title').click({ force: true });
  check(
    'a click outside closes it',
    await until(async () => (await page.locator('.menu-panel').count()) === 0),
  );

  /*
   * The theme, from the menu — two clicks and no dialog. It used to be behind
   * Ctrl+comma or a name typed into the palette, both of which have to be known
   * about first.
   */
  await page.locator('.menu-title', { hasText: 'Preferences' }).click();
  await page.waitForSelector('.menu-panel', { timeout: 5000 });
  await page.locator('.menu-panel .menu-row', { hasText: 'Light' }).first().click();
  const light = await until(
    async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light',
  );
  check('the theme changes from the menu', light, await page.evaluate(() => document.documentElement.dataset.theme ?? 'system'));

  await page.locator('.menu-title', { hasText: 'Preferences' }).click();
  await page.waitForSelector('.menu-panel', { timeout: 5000 });
  const ticked = await page.evaluate(() =>
    [...document.querySelectorAll('.menu-panel .menu-row')]
      .filter((row) => row.querySelector('.menu-mark')?.textContent?.trim())
      .map((row) => row.querySelector('.menu-label')?.textContent ?? ''),
  );
  check(
    'and the menu says which one is in use',
    ticked.includes('Light') && ticked.length === 2,
    ticked.join(', '),
  );
  await page.keyboard.press('Escape');

  /* Which build is this — the first question of every bug report. */
  await page.locator('.menu-title', { hasText: 'Help' }).click();
  await page.locator('.menu-panel .menu-row', { hasText: 'About' }).first().click();
  const about = await until(async () => (await page.locator('.about').count()) === 1);
  const version = await page.locator('.about-facts dd').first().innerText();
  check('the About box names the version', about && /^\d+\.\d+\.\d+/.test(version), version);
  await page.keyboard.press('Escape');
  await until(async () => (await page.locator('.about').count()) === 0);

  /* — editing and the dirty flag — */
  await page.locator('.tab').first().click();
  await page.locator('.cm-content').first().click();
  await page.keyboard.type('// edit\n');
  // Two modified tabs: the code we have just typed and the PDF with annotations.
  await until(async () => (await page.locator('.tab[data-dirty="true"]').count()) === 2);
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
  const threeAgain = await until(async () => (await pdf.locator('.ul-pdf-thumb').count()) === 3);
  check('undo brings the deleted page back', threeAgain);

  await page.screenshot({ path: resolve(SHOTS, 'pages.png') });

  /* — a document font the screen does not have — */

  /*
   * Google Fonts is played by routes: the checks must not depend on a network,
   * and a real family could genuinely be installed on somebody's machine —
   * which would silently skip the very state being checked. `Downloadia` is
   * served (the bytes are Liberation Sans, which is beside the point);
   * `Fantomica` is not, so its button has to fall back to a browser search.
   */
  const ttf = await readFile(
    resolve(ROOT, 'packages/editor-pdf/node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'),
  );
  await page.route('https://fonts.googleapis.com/**', (route) => {
    if (route.request().url().includes('Downloadia')) {
      void route.fulfill({
        contentType: 'text/css',
        body: '@font-face { font-family: "Downloadia"; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/mock/regular.ttf) format("truetype"); }',
      });
    } else {
      /* Google answers an unknown family with a 400; an empty stylesheet takes
         the same no-faces path without a resource error in the console, which
         the last check reads as the page's own failure. */
      void route.fulfill({ contentType: 'text/css', body: '' });
    }
  });
  await page.route('https://fonts.gstatic.com/**', (route) => {
    void route.fulfill({ contentType: 'font/ttf', body: ttf });
  });

  const openLineOf = async (pane, text) => {
    await until(
      async () => (await pane.locator('.ul-pdf-text').innerText().catch(() => '')).includes(text),
      20000,
    );
    const line = await pane.locator('.ul-pdf-text span', { hasText: text }).first().boundingBox();
    await pane.locator('.ul-pdf-tool[title*="Edit text"]').click();
    await page.mouse.click(line.x + Math.min(line.width / 2, 20), line.y + line.height / 2);
    /* Scoped to the visible pane: the editor closed in a background tab keeps
       its textarea in the document, and the bare selector finds that one first. */
    await pane.locator('.ul-pdf-text-input').waitFor({ timeout: 15000 });
  };

  await dropFile(
    page,
    'downloadia.pdf',
    new TextEncoder().encode(makeToUnicodePdf('Set in a foreign font', { embedded: true, font: 'Downloadia' })),
  );
  const foreign = page.locator('.ul-pdf:visible');
  await openLineOf(foreign, 'foreign');

  const fetchButton = foreign.locator('.ul-pdf-fetch-font');
  check(
    'a font the screen does not have grows a download button',
    await fetchButton.isVisible(),
  );

  await fetchButton.click();
  /* Not `document.fonts.check` — that answers "is anything still loading?" and
     is true for a family it never heard of. The registered face itself is the
     evidence. */
  const fetched = await until(
    async () =>
      page.evaluate(() =>
        [...document.fonts].some(
          (f) => f.family.replace(/"/g, '') === 'Downloadia' && f.status === 'loaded',
        ),
      ),
    15000,
  );
  check('clicking it fetches the family from Google Fonts', fetched);
  const buttonGone = await until(async () => !(await fetchButton.isVisible()), 10000);
  check('and the button leaves once the screen has it', buttonGone);
  await page.keyboard.press('Escape');

  /* The other answer: a family Google Fonts does not carry. */
  await page.evaluate(() => {
    window.__opened = [];
    window.open = (target) => {
      window.__opened.push(String(target));
      return null;
    };
  });
  await dropFile(
    page,
    'fantomica.pdf',
    new TextEncoder().encode(makeToUnicodePdf('Nobody carries this one', { embedded: true, font: 'Fantomica' })),
  );
  const nowhere = page.locator('.ul-pdf:visible');
  await openLineOf(nowhere, 'carries');

  await nowhere.locator('.ul-pdf-fetch-font').click();
  const searched = await until(
    async () => page.evaluate(() => (window.__opened ?? []).length > 0),
    15000,
  );
  const openedUrl = await page.evaluate(() => window.__opened?.[0] ?? '');
  check(
    'a family Google Fonts does not carry goes to a browser search',
    searched && openedUrl.includes('google.com/search') && openedUrl.includes('Fantomica'),
    openedUrl,
  );
  check(
    'and the button stays, because the screen still does not have it',
    await nowhere.locator('.ul-pdf-fetch-font').isVisible(),
  );
  await page.keyboard.press('Escape');
  await page.unroute('https://fonts.googleapis.com/**');
  await page.unroute('https://fonts.gstatic.com/**');

  /* — retyping a spreadsheet cell — */

  /*
   * The logic is proven byte for byte in `verify-xlsx-edit.mjs`; what only the
   * page can prove is the seam between the grid and it: that a double-click
   * opens the one cell, that the tab admits to being dirty, and that a formula
   * refuses by name instead of quietly becoming a literal.
   */
  await dropFile(page, 'sales.xlsx', makeXlsx());
  const book = page.locator('.ul-sheet-book:visible');
  await book.locator('td[data-ref="1,1"]').waitFor({ timeout: 20000 });

  const amount = book.locator('td[data-ref="1,1"]');
  check('the amount arrives formatted', (await amount.innerText()) === '1.234,50', await amount.innerText());

  await amount.dblclick();
  check('a double-click opens the cell', await amount.evaluate((el) => el.isContentEditable));
  await amount.evaluate((el) => {
    el.textContent = '2000';
  });
  await amount.press('Enter');
  check('the retyped value stands in the grid', (await amount.innerText()) === '2000');
  const sheetDirty = await until(
    async () => (await page.locator('.tab[data-dirty="true"]').count()) > 0,
    10000,
  );
  check('and the tab admits to the change', sheetDirty);

  const total = book.locator('td[data-ref="3,1"]');
  await total.dblclick();
  check('a formula cell does not open', !(await total.evaluate((el) => el.isContentEditable)));
  check(
    'it refuses with the formula named',
    await until(
      async () => (await page.locator('.toast').last().innerText().catch(() => '')).includes('SUM(B2:B3)'),
      10000,
    ),
    await page.locator('.toast').last().innerText().catch(() => ''),
  );

  await page.keyboard.press('Control+Z');
  const sheetClean = await until(async () => (await amount.innerText()) === '1.234,50', 10000);
  check('undo puts the old amount back', sheetClean, await amount.innerText());

  /* — the old binary Excel — */

  /*
   * The bytes are proven in `verify-xls.mjs`; the page proves the routing and
   * the honesty: a `.xls` reaches the reader (not the .xlsx editor and its
   * "not a valid archive"), draws its values, and a double-click explains
   * itself instead of opening a cell it could never save.
   */
  await dropFile(page, 'stari-cjenik.xls', makeXls());
  const oldBook = page.locator('.ul-sheet-book:visible');
  await oldBook.locator('td[data-ref="1,0"]').waitFor({ timeout: 20000 });
  check(
    'the old binary Excel opens with its diacritics intact',
    (await oldBook.locator('td[data-ref="1,0"]').innerText()) === 'Siječanj',
    await oldBook.locator('td[data-ref="1,0"]').innerText(),
  );
  check(
    'and its amounts under their formats',
    (await oldBook.locator('td[data-ref="1,1"]').innerText()) === '1.234,50',
    await oldBook.locator('td[data-ref="1,1"]').innerText(),
  );

  /*
   * The old format is editable too — its save is a conversion, which is what
   * the bar above the grid says. The write itself needs a file system the web
   * build has not got, so what the page can prove is the half before it: the
   * cell opens, takes a value, and the tab admits the change.
   */
  check(
    'the bar says a save will write a new .xlsx',
    (await oldBook.locator('.ul-office-notes strong').innerText()).includes('.xlsx'),
    await oldBook.locator('.ul-office-notes strong').innerText(),
  );

  const oldCell = oldBook.locator('td[data-ref="1,1"]');
  await oldCell.dblclick();
  check('a cell of the old format opens for editing', await oldCell.evaluate((el) => el.isContentEditable));
  await oldCell.evaluate((el) => {
    el.textContent = '4321';
  });
  await oldCell.press('Enter');
  check('and takes the retyped value', (await oldCell.innerText()) === '4321', await oldCell.innerText());
  check(
    'the tab admits the change',
    await until(async () => (await page.locator('.tab[data-dirty="true"]').count()) > 0, 10000),
  );

  /* — OpenDocument — */

  /*
   * The two OpenDocument readers, which have no test outside this page: both
   * build their view through `DOMParser`, so there is no half of them that runs
   * in plain Node the way the `.xls` reader does.
   *
   * What is checked is what the format makes hard. The spreadsheet: that the
   * display text the writing program computed is what the grid shows, that a
   * date written as an ISO string arrives as a date, that a formula refuses by
   * name, and — the one that decides whether any of it is usable — that the
   * trailing repeat counts are a jump rather than a million rows. The document:
   * that a heading is a heading, that formatting held by a named style is
   * applied, that a run of spaces written as `<text:s>` survives, and that the
   * bar says the file is not going to be written.
   */
  await dropFile(page, 'prodaja.ods', makeOds());
  const odsBook = page.locator('.ul-sheet-book:visible');
  await odsBook.locator('td[data-ref="1,0"]').waitFor({ timeout: 20000 });

  check(
    'an .ods opens in the grid, diacritics intact',
    (await odsBook.locator('td[data-ref="1,0"]').innerText()) === 'Siječanj',
    await odsBook.locator('td[data-ref="1,0"]').innerText(),
  );
  check(
    'the amount is shown exactly as the writing program drew it',
    (await odsBook.locator('td[data-ref="1,1"]').innerText()) === '1.234,50',
    await odsBook.locator('td[data-ref="1,1"]').innerText(),
  );
  check(
    'a date written as an ISO string is a date',
    (await odsBook.locator('td[data-ref="1,2"]').getAttribute('data-kind')) === 'date',
    await odsBook.locator('td[data-ref="1,2"]').getAttribute('data-kind'),
  );

  /* A million empty rows are a cursor jump, not a million rows. Read literally
     the sheet below would be 1,048,575 rows tall and the tab would never open. */
  const odsStatus = await page.locator('.status-editor, .statusbar').first().innerText().catch(() => '');
  check(
    'the empty tail of the sheet costs nothing',
    (await odsBook.locator('tbody tr').count()) < 20,
    `${await odsBook.locator('tbody tr').count()} rows · ${odsStatus}`,
  );

  /* An `.ods` is written back into the file it came from, so the bar must not
     promise a converted copy the way the `.xls` one does. */
  check(
    'the bar does not promise a converted copy',
    !(await odsBook.locator('.ul-office-notes strong').innerText()).includes('.xlsx'),
    await odsBook.locator('.ul-office-notes strong').innerText(),
  );

  const odsTotal = odsBook.locator('td[data-ref="3,1"]');
  await odsTotal.dblclick();
  check('a formula cell does not open', !(await odsTotal.evaluate((el) => el.isContentEditable)));
  check(
    'and it refuses with the formula in plain form, not in the `of:` language',
    await until(
      async () => (await page.locator('.toast').last().innerText().catch(() => '')).includes('SUM(B2:B3)'),
      10000,
    ),
    await page.locator('.toast').last().innerText().catch(() => ''),
  );

  const odsCell = odsBook.locator('td[data-ref="1,1"]');
  await odsCell.dblclick();
  check('an ordinary cell opens for editing', await odsCell.evaluate((el) => el.isContentEditable));
  await odsCell.press('Escape');

  await dropFile(page, 'izvjestaj.odt', makeOdt());
  const odtView = page.locator('.ul-office-doc:visible').first();
  await odtView.locator('h1').first().waitFor({ timeout: 20000 });

  check(
    'an .odt opens with its heading',
    (await odtView.locator('h1').first().innerText()).includes('Izvjestaj'),
    await odtView.locator('h1').first().innerText(),
  );
  check(
    'formatting held by a named style is applied',
    (await odtView.locator('strong').first().innerText()).trim() === 'Podebljano' &&
      (await odtView.locator('em').first().innerText()).trim() === 'i ukoseno',
    `${await odtView.locator('strong').first().innerText()} / ${await odtView.locator('em').first().innerText()}`,
  );
  check(
    'the list and the table arrive',
    (await odtView.locator('ul li').count()) === 2 && (await odtView.locator('table th').count()) === 2,
    `${await odtView.locator('ul li').count()} items · ${await odtView.locator('table th').count()} headers`,
  );

  /*
   * `<text:s text:c="5"/>` is five spaces, and reading the DOM property alone
   * drops every one of them — "ImePrezime", which is what a column laid out
   * with spaces turns into.
   *
   * Asserted on the text the document holds, not on what the screen draws: HTML
   * collapses a run of spaces on display, here as in the Word view, and it is
   * the held text that search, copy, the word count and the export all read.
   */
  const spaced = await odtView
    .locator('p', { hasText: 'Prezime' })
    .first()
    .evaluate((el) => el.textContent ?? '');
  check('a run of spaces written as an element survives', /Ime {5}Prezime/.test(spaced), JSON.stringify(spaced));

  const odtBar = page.locator('.ul-office:visible .ul-office-notes').first();
  check(
    'and the bar says the document is shown, not written',
    !(await odtBar.locator('strong').innerText()).includes('retyped'),
    await odtBar.locator('strong').innerText(),
  );

  /* — the old binary Word — */

  /*
   * Until this reader existed, a `.doc` opened with the worst message in the
   * program: that the file was damaged. It was not; it was from before 2007.
   * What is checked here is the half that needs a browser — the elements. What
   * the bytes turn into before that is checked in verify-doc.mjs.
   */
  await dropFile(page, 'zapisnik.doc', makeDoc());
  const docView = page.locator('.ul-office-doc:visible').first();
  await docView.locator('h1').first().waitFor({ timeout: 20000 });

  check(
    'a .doc opens instead of being called damaged',
    (await docView.locator('h1').first().innerText()).trim() === 'Zapisnik',
    await docView.locator('h1').first().innerText(),
  );
  check(
    'a heading Word named by number and one named only in Croatian both arrive',
    (await docView.locator('h2').first().innerText()).trim() === 'Zaključci',
    await docView.locator('h2').first().innerText(),
  );
  check(
    'the CP1252 piece and the UTF-16 piece are both decoded',
    (await docView.innerText()).includes('održan') && (await docView.innerText()).includes('zaključak'),
  );
  /* Two bold words, written the two ways Word writes bold — plainly, and as a
     toggle against the style, which is what clicking the button produces. */
  check(
    'both spellings of bold reach the page',
    (await docView.locator('strong').allInnerTexts()).map((s) => s.trim()).join('|') === 'održan|Vodicama',
    (await docView.locator('strong').allInnerTexts()).join('|'),
  );
  check(
    'the table inferred from the cell marks has two rows of two',
    (await docView.locator('table tr').count()) === 2 && (await docView.locator('table td').count()) === 4,
    `${await docView.locator('table tr').count()} rows · ${await docView.locator('table td').count()} cells`,
  );
  check(
    'the list arrives with both of its items',
    (await docView.locator('ul li').count()) === 2,
    `${await docView.locator('ul li').count()}`,
  );
  check(
    'a field shows its result and not its instruction',
    (await docView.innerText()).includes('Stranica 2.') && !(await docView.innerText()).includes('PAGE'),
  );

  const docBar = page.locator('.ul-office:visible .ul-office-notes').first();
  check(
    'and the bar says this one is shown, not written either',
    !(await docBar.locator('strong').innerText()).includes('retyped'),
    await docBar.locator('strong').innerText(),
  );

  /* — Rich Text — */

  /*
   * The format this program could name and would not open. What is checked
   * here is the half that needs a browser; that the bytes come out as the right
   * letters at all is verify-rtf.mjs, where the two code pages are.
   *
   * The same reading room as the two above, on purpose: three formats that
   * share nothing — an archive of XML, a compound file of byte offsets, and a
   * stream of instructions — and one view that draws all of them.
   */
  await dropFile(page, 'upitnik.rtf', makeRtf());
  const rtfView = page.locator('.ul-office-doc:visible').first();
  await rtfView.locator('h1').first().waitFor({ timeout: 20000 });

  check(
    'an .rtf opens instead of being recognised and refused',
    (await rtfView.locator('h1').first().innerText()).trim() === 'Zapisnik',
    await rtfView.locator('h1').first().innerText(),
  );
  check(
    'the letters of both code pages reach the page',
    (await rtfView.innerText()).includes('zaključak') && (await rtfView.innerText()).includes('Café'),
  );
  check(
    'a heading that says so only with an outline level is drawn as one',
    (await rtfView.locator('h2').allInnerTexts()).some((text) => text.trim() === 'Prilozi'),
    (await rtfView.locator('h2').allInnerTexts()).join('|'),
  );
  check(
    'the table cut out of the cell marks has two rows of two',
    (await rtfView.locator('table tr').count()) === 2 && (await rtfView.locator('table td').count()) === 4,
    `${await rtfView.locator('table tr').count()} rows · ${await rtfView.locator('table td').count()} cells`,
  );
  check(
    'and nothing that is not the document came with it',
    !(await rtfView.innerText()).includes('Riched20') &&
      !(await rtfView.innerText()).includes('Times New Roman') &&
      !(await rtfView.innerText()).includes('skriveno'),
  );

  const rtfBar = page.locator('.ul-office:visible .ul-office-notes').first();
  check(
    'the bar names the picture it cannot draw',
    (await rtfBar.innerText()).includes('Slike') || (await rtfBar.innerText()).includes('Pictures'),
    await rtfBar.innerText(),
  );

  /* — what the platform draws for us — */

  /*
   * Parts of the interface are drawn by the operating system and not by our
   * CSS at all: the list a `<select>` opens, scrollbars, the checkbox tick.
   * The single thing that tells the platform which colours to use for them is
   * `color-scheme`, and when it disagrees with the theme those controls come
   * back in the other one — a dropdown of pale text on white, which is how it
   * was reported. Styling `option` directly is what causes that rather than
   * cures it: Windows takes the `color` and ignores the `background`.
   */
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
    check(`the platform is told the theme is ${theme}`, scheme === theme, scheme);
  }

  const optionRules = await page.evaluate(() =>
    [...document.styleSheets]
      .flatMap((sheet) => {
        try {
          return [...sheet.cssRules];
        } catch {
          return [];
        }
      })
      .filter((rule) => rule.selectorText?.includes('option') && /background|color/.test(rule.style?.cssText ?? ''))
      .map((rule) => rule.selectorText),
  );
  check(
    'and nothing tries to paint the list it opens',
    optionRules.length === 0,
    optionRules.join(', '),
  );

  /*
   * — screenshots —
   *
   * The pauses below stay pauses. Nothing is asserted after them: they are there
   * so the picture is taken after the paint, and "wait until it looks right" is
   * not a condition a script can evaluate.
   */
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
  /*
   * The bar used to carry `⌖`, `▬`, `〰` and `T✎` — typographic characters doing
   * the work of pictures, at the mercy of whatever font the system happens to
   * have. Every one of them is a drawing now, and this is what keeps it that way.
   */
  const bareButtons = await page.evaluate(() =>
    [...document.querySelectorAll('.ul-pdf-toolbar .ul-pdf-btn')]
      .filter((b) => !b.querySelector('svg'))
      .map((b) => b.title || b.textContent)
      .slice(0, 6),
  );
  const buttonCount = await page.locator('.ul-pdf-toolbar .ul-pdf-btn').count();
  check(
    'every button in the bar carries a drawn icon',
    buttonCount > 10 && bareButtons.length === 0,
    `${buttonCount} buttons${bareButtons.length ? ` — bare: ${bareButtons.join(', ')}` : ''}`,
  );

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
