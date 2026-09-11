/**
 * The lines of a Word document, in the editor a person types into — Enter,
 * Backspace and Delete where they are pressed.
 *
 * [`verify-docx-join.mjs`](./verify-docx-join.mjs) and
 * [`verify-docx-split.mjs`](./verify-docx-split.mjs) prove what the writer
 * does with a plan. This proves the plan the keys make, which is the harder
 * half: one key at a line's edge means four different things depending on
 * what the boundary is — two lines Enter made of one paragraph, two lines
 * added here, a line added here after one of the file, or two paragraphs of
 * the file — and Backspace after an empty line means a fifth, because Word
 * removes the empty one there instead of joining it.
 *
 * Every save is compared with the page: the lines a person sees, in order,
 * against the paragraphs of the file that would be written. What stands on
 * the page is what the file will hold, or the view is lying about the file.
 * The save is taken by handing the editor a stand-in for the file system —
 * the one thing a page in a browser cannot give it; the trip to the disk is
 * `verify-office-editing.mjs`, in the real application.
 *
 *   node tools/verify-docx-lines.mjs [--url http://localhost:5273] [--headed]
 */

import { chromium } from 'playwright';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

import { makeDocx } from './fixtures.mjs';

const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5273';
const headed = args.includes('--headed');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── the document ────────────────────────────────────────────────────── */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (text, props = '') => `<w:p>${props}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const LIST = '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>';
const NUMBERED = '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr>';
/* A bulleted list and a numbered one — the numbered one because its numbers
   are what a join changes where anyone can see it. */
const NUMBERING =
  `<?xml version="1.0" encoding="UTF-8"?>\n<w:numbering ${'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'}>` +
  '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>' +
  '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>' +
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>';
const BODY =
  p('Naslov dokumenta', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>') +
  p('Prvi odlomak teksta.') +
  p('Drugi odlomak teksta.') +
  '<w:p/>' +
  p('Podnaslov', '<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>') +
  '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Treći odlomak </w:t></w:r><w:r><w:t>s dva runa.</w:t></w:r></w:p>' +
  `<w:tbl><w:tr><w:tc>${p('Ćelija')}</w:tc></w:tr></w:tbl>` +
  p('Zadnji odlomak.') +
  '<w:p><w:r><w:t xml:space="preserve">Vidi </w:t></w:r><w:hyperlink w:anchor="cilj"><w:r><w:t>poveznicu</w:t></w:r></w:hyperlink></w:p>' +
  p('Prva stavka', LIST) +
  p('Druga stavka', LIST) +
  p('Poslije liste.') +
  p('Prva točka', NUMBERED) +
  p('Druga točka', NUMBERED) +
  p('Između točaka.') +
  p('Treća točka', NUMBERED);

const docx = zipSync({
  ...unzipSync(makeDocx()),
  'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<w:document ${W}><w:body>${BODY}<w:sectPr/></w:body></w:document>`),
  'word/numbering.xml': strToU8(NUMBERING),
});

/* ── the page ────────────────────────────────────────────────────────── */

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

/** The lines a person sees, in order: the kind of line and its text. */
const lines = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.ul-office-doc [data-paragraph], .ul-office-doc [data-piece-of], .ul-office-doc [data-new]')]
      .filter((el) => !el.closest('.is-removed, .is-joined'))
      .map((el) => `${el.tagName}:${el.textContent}`),
  );
const texts = async () => (await lines()).map((line) => line.slice(line.indexOf(':') + 1));
const status = () =>
  page.evaluate(async () => {
    const { useWorkspace, activeTabId } = await import('/src/state/workspace.ts');
    return useWorkspace.getState().tabs.find((tab) => tab.id === activeTabId())?.status ?? '';
  });
/** Where the caret is, when something is being typed into: the text and the offset in it. */
const caret = () =>
  page.evaluate(() => {
    const active = document.activeElement;
    const selection = document.getSelection();
    if (!active?.isContentEditable || !selection?.rangeCount || !selection.isCollapsed) return null;
    const before = document.createRange();
    before.selectNodeContents(active);
    before.setEnd(selection.anchorNode, selection.anchorOffset);
    return { text: active.textContent, at: before.toString().length };
  });
const typingAt = async (text, at) => {
  const now = await caret();
  return now !== null && now.text === text && now.at === at;
};
const caretSays = async () => JSON.stringify(await caret());

/**
 * The body paragraphs of the file a save would write, outside tables: their
 * style, when they have one, and their text.
 */
const saved = async () => {
  const b64 = await page.evaluate(async () => {
    const { activeInstance } = await import('/src/state/workspace.ts');
    const instance = activeInstance();
    let written = null;
    instance.host = { ...instance.host, fs: { ...instance.host.fs, writeBytes: async (_uri, data) => { written = data; } } };
    await instance.save();
    let text = '';
    for (const byte of written) text += String.fromCharCode(byte);
    return btoa(text);
  });
  const xml = strFromU8(unzipSync(Buffer.from(b64, 'base64'))['word/document.xml']).replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, '');
  return [...xml.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)].map((m) => {
    const inner = m[1] ?? '';
    const props = /^<w:pPr>[\s\S]*?<\/w:pPr>/.exec(inner)?.[0] ?? '';
    const kind = /<w:pStyle w:val="([^"]+)"/.exec(props)?.[1] ?? (props.includes('<w:numPr>') ? 'List' : '');
    return { kind, text: [...inner.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join('') };
  });
};
/** Whether the page shows exactly the paragraphs the file would hold, in order. */
const agrees = async (file) => JSON.stringify(await texts()) === JSON.stringify(file.map((one) => one.text));

const run = (text) => page.locator('.ul-office-doc .ul-office-run', { hasText: text }).first();
/** Double-clicks a piece of text and puts the caret at its start or its end, with keys. */
const typeIn = async (text, where) => {
  await run(text).dblclick();
  await page.keyboard.press(where === 'end' ? 'End' : 'Home');
};
const done = () => page.evaluate(() => document.activeElement?.blur?.());
const press = async (key) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(120);
};
const JOINED = 'Paragraphs joined — Ctrl+Z splits them again.';

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shell', { timeout: 20000 });
  await page.evaluate((bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'spajanje.docx'));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, Array.from(docx));
  await page.waitForSelector('.ul-office-doc', { timeout: 20000 });

  const original = await lines();
  check(
    'the document is open, a line for every paragraph of its body',
    original.length === 15 && original[3] === 'P:' && original[8] === 'LI:Prva stavka' && original[11] === 'LI:Prva točka',
    JSON.stringify(original),
  );
  const dirty = async () => (await page.locator('.tab[data-dirty="true"]').count()) === 1;

  /* ── two paragraphs of the file ─────────────────────────────────────── */

  await typeIn('Drugi odlomak', 'start');
  await press('Backspace');
  check(
    'Backspace at the start of a paragraph joins it onto the one above',
    JSON.stringify((await texts()).slice(1, 3)) === JSON.stringify(['Prvi odlomak teksta.Drugi odlomak teksta.', '']),
    JSON.stringify(await texts()),
  );
  check('and says what it did, and how to take it back', (await status()) === JOINED, await status());
  check('and the document has a change to save, though not a letter of it was typed', await dirty());
  check('and the typing goes on, from where the two meet', await typingAt('Drugi odlomak teksta.', 0), await caretSays());

  await page.keyboard.type('Č');
  let file = await saved();
  check(
    'what is typed there is written there, in one paragraph where there were two',
    file[1]?.text === 'Prvi odlomak teksta.ČDrugi odlomak teksta.' && file.length === original.length - 1,
    JSON.stringify(file.slice(0, 3)),
  );
  check('and the page shows exactly what the file holds', await agrees(file));

  await done();
  await press('Control+Z');
  await press('Control+Z');
  check('Ctrl+Z takes back the typing and then the join', JSON.stringify(await lines()) === JSON.stringify(original), JSON.stringify(await texts()));

  await typeIn('Prvi odlomak', 'end');
  await press('Delete');
  check(
    'Delete at the end of a paragraph joins the next one onto it, the caret staying where it was',
    (await texts())[1] === 'Prvi odlomak teksta.Drugi odlomak teksta.' && (await typingAt('Prvi odlomak teksta.', 20)),
    await caretSays(),
  );
  await done();

  /* Delete, Delete, Delete: the empty line after it joins the line, and then
     the heading after that — a chain, gathered into its first paragraph. */
  await typeIn('Drugi odlomak', 'end');
  await press('Delete');
  await press('Delete');
  file = await saved();
  check(
    'Delete on at the end of a joined line takes in the empty line after it and then the heading',
    (await lines())[1] === 'P:Prvi odlomak teksta.Drugi odlomak teksta.Podnaslov' &&
      file[1]?.text === 'Prvi odlomak teksta.Drugi odlomak teksta.Podnaslov' &&
      file.length === original.length - 3,
    JSON.stringify(file.slice(0, 3)),
  );
  check('and the page shows exactly what the file holds', await agrees(file));
  await done();
  await press('Control+Z');
  await press('Control+Z');
  await press('Control+Z');
  check('and three Ctrl+Z give the four lines back', JSON.stringify(await lines()) === JSON.stringify(original), JSON.stringify(await texts()));

  /* Short of a line's edge, the keys are the browser's: one character. */
  await run('s dva runa').dblclick();
  await page.keyboard.press('Home');
  await press('Backspace');
  check(
    'Backspace at the start of a piece of text with another before it on the line joins nothing',
    JSON.stringify(await lines()) === JSON.stringify(original) && (await typingAt('s dva runa.', 0)),
    await caretSays(),
  );
  await done();
  await typeIn('Vidi', 'end');
  await press('Delete');
  check(
    'and nor does Delete at the end of one with another after it',
    JSON.stringify(await lines()) === JSON.stringify(original) && (await typingAt('Vidi ', 5)),
    await caretSays(),
  );
  await done();

  /* ── an empty line ──────────────────────────────────────────────────── */

  await typeIn('Podnaslov', 'start');
  await press('Backspace');
  check(
    'Backspace after an empty line removes the empty line, and the heading below stays a heading — as Word does',
    JSON.stringify((await lines()).slice(2, 4)) === JSON.stringify(['P:Drugi odlomak teksta.', 'H2:Podnaslov']),
    JSON.stringify(await lines()),
  );
  check('and says so', (await status()) === 'The empty line was removed — Ctrl+Z brings it back.', await status());
  await press('Backspace');
  file = await saved();
  check(
    'Backspace again joins the heading onto the line above, which keeps its own properties',
    (await lines())[2] === 'P:Drugi odlomak teksta.Podnaslov' && file[2]?.kind === '' && !file.some((one) => one.kind === 'Heading2'),
    JSON.stringify(file.slice(1, 4)),
  );
  check('and the page shows exactly what the file holds', await agrees(file));
  await done();
  await press('Control+Z');
  await press('Control+Z');

  /* A line that shows nothing and is not one paragraph's own — a paragraph
     with an empty one joined onto it, its own text then typed away — is
     not what Word's "the first is empty" means, and is refused. */
  await typeIn('Drugi odlomak', 'end');
  await press('Delete');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await done();
  await typeIn('Podnaslov', 'start');
  await press('Backspace');
  check(
    'an empty line made by a join is not joined onto — undoing comes first',
    (await status()).startsWith('That empty line was made by joining or splitting lines') && (await lines())[3] === 'H2:Podnaslov',
    await status(),
  );
  await done();
  await press('Control+Z');
  await press('Control+Z');
  check('and two Ctrl+Z give it back', JSON.stringify(await lines()) === JSON.stringify(original), JSON.stringify(await texts()));

  /* ── lines Enter made ───────────────────────────────────────────────── */

  await typeIn('Prvi odlomak', 'start');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await press('Enter');
  await press('Backspace');
  /* Where the caret is, asked before the save: a save finishes the typing. */
  check(
    'Enter in the middle of a sentence and Backspace at the start of the new line: one line again',
    (await texts())[1] === 'Prvi odlomak teksta.' && (await typingAt('Prvi odlomak teksta.', 5)),
    await caretSays(),
  );
  file = await saved();
  check(
    'and nothing is left to write — the division was taken back, not joined over',
    JSON.stringify(file.map((one) => one.text)) === JSON.stringify(original.map((line) => line.slice(line.indexOf(':') + 1))),
  );
  await done();

  await typeIn('Prvi odlomak', 'end');
  await press('Enter');
  await page.keyboard.type('abc');
  await page.keyboard.press('Home');
  await press('Backspace');
  check('and the caret stands where the two met', await typingAt('Prvi odlomak teksta.abc', 20), await caretSays());
  file = await saved();
  check(
    'a line added with Enter and typed into, joined back: its text goes onto the piece above it',
    (await texts())[1] === 'Prvi odlomak teksta.abc' && file[1]?.text === 'Prvi odlomak teksta.abc' && file.length === original.length,
    JSON.stringify(file.slice(0, 3)),
  );
  await done();

  /* A line Enter made between two others, typed empty and joined back: the
     typing that leaves it takes the emptied part away by itself, and the join
     must not then take the line after it as well. */
  await typeIn('Zadnji odlomak', 'start');
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight');
  await press('Enter');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await press('Enter');
  await done();
  await page.locator('.ul-office-doc .ul-office-run').filter({ hasText: /^odl$/ }).dblclick();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await press('Backspace');
  check(
    'a line Enter made, typed empty, and Backspace: that line goes, the one after it stays, the caret at the end of the one above',
    JSON.stringify((await texts()).slice(6, 8)) === JSON.stringify(['Zadnji ', 'omak.']) && (await typingAt('Zadnji ', 7)),
    `${JSON.stringify((await texts()).slice(6, 8))} ${await caretSays()}`,
  );
  await done();
  /* Three steps to take back: two divisions, and the part the typing took away. */
  await press('Control+Z');
  await press('Control+Z');
  await press('Control+Z');
  check(
    'and three Ctrl+Z give the sentence back whole',
    (await texts()).includes('Zadnji odlomak.') && (await texts())[1] === 'Prvi odlomak teksta.abc',
    JSON.stringify(await texts()),
  );

  await typeIn('Drugi odlomak', 'end');
  await press('Enter');
  await press('Backspace');
  check(
    'Enter at the end and Backspace in the empty new line: no new line, and the caret back at the end of the one above',
    (await lines()).length === original.length && (await typingAt('Drugi odlomak teksta.', 21)),
    await caretSays(),
  );

  await press('Enter');
  await page.keyboard.type('x');
  await press('Enter');
  await page.keyboard.type('y');
  await page.keyboard.press('Home');
  await press('Backspace');
  check(
    'two lines added here, joined: one line with both texts',
    (await texts())[3] === 'xy' && (await typingAt('xy', 1)),
    JSON.stringify(await texts()),
  );
  await done();

  await typeIn('Drugi odlomak', 'end');
  await press('Delete');
  file = await saved();
  check(
    'Delete at the end of a paragraph with a line added after it: that line continues the paragraph',
    (await texts())[2] === 'Drugi odlomak teksta.xy' && file[2]?.text === 'Drugi odlomak teksta.xy',
    JSON.stringify(file.slice(1, 4)),
  );
  check('and the page shows exactly what the file holds', await agrees(file));
  await done();

  /* ── what is refused, and says why ─────────────────────────────────── */

  const before = await lines();
  await typeIn('Zadnji odlomak', 'start');
  await press('Backspace');
  check(
    'a paragraph after a table is not joined across it',
    (await status()).startsWith('A table stands between') && JSON.stringify(await lines()) === JSON.stringify(before),
    await status(),
  );
  check('and the typing is left where it was', await typingAt('Zadnji odlomak.', 0), await caretSays());
  await done();

  await typeIn('Treća točka', 'end');
  await press('Delete');
  check('the last paragraph has nothing to take in', (await status()) === 'Nothing follows this paragraph to join to it.', await status());
  await done();

  /* A line ending in a link: text typed on the line after it took the
     formatting of the last run of the paragraph itself, not the link's, so it
     cannot become part of the link. */
  await typeIn('poveznicu', 'end');
  await press('Enter');
  await page.keyboard.type('t');
  await page.keyboard.press('Home');
  await press('Backspace');
  check(
    'a line added after a link is not joined onto the link',
    (await status()).startsWith('The line this would join ends in something that cannot be continued') &&
      (await texts()).includes('t'),
    await status(),
  );
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await done();

  await typeIn('Drugi odlomak', 'end');
  await press('Enter');
  await page.keyboard.type('novi');
  await done();
  await typeIn('Podnaslov', 'start');
  await press('Backspace');
  await press('Backspace');
  check(
    'a paragraph of the file is not joined onto a line added here',
    (await status()) === 'A line added here cannot be joined with a paragraph the file already has.',
    await status(),
  );
  await done();
  await run('novi').dblclick();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await press('Delete');
  check(
    'but emptied, the added line goes with Delete, and the caret to the start of the line below',
    !(await texts()).includes('novi') && (await typingAt('Podnaslov', 0)),
    await caretSays(),
  );
  await done();

  /* ── a paragraph typed empty ─────────────────────────────────────────── */

  await typeIn('Prvi odlomak', 'end');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await press('Delete');
  check('and the caret goes to the start of the line below', await typingAt('Drugi odlomak teksta.xy', 0), await caretSays());
  file = await saved();
  check(
    'a paragraph whose text was typed away, and Delete: it goes, as an empty one does in Word',
    !(await texts()).some((line) => line.startsWith('Prvi')) && !file.some((one) => one.text.startsWith('Prvi')) && (await agrees(file)),
    JSON.stringify(file.slice(0, 3)),
  );
  await done();

  /* ── headings, and lines divided after a join ───────────────────────── */

  await typeIn('Drugi odlomak', 'start');
  await press('Backspace');
  check(
    'a paragraph joined onto a heading is part of the heading',
    (await lines())[0] === 'H1:Naslov dokumentaDrugi odlomak teksta.xy',
    (await lines())[0],
  );
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
  await press('Enter');
  file = await saved();
  check(
    'and Enter in its part divides the heading into two headings, on the page and in the file',
    JSON.stringify((await lines()).slice(0, 2)) === JSON.stringify(['H1:Naslov dokumentaDrugi ', 'H1:odlomak teksta.xy']) &&
      file[0]?.kind === 'Heading1' &&
      file[1]?.kind === 'Heading1',
    JSON.stringify(file.slice(0, 2)),
  );
  check('and the page shows exactly what the file holds', await agrees(file));
  await done();

  await run('s dva runa').dblclick();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await press('Enter');
  await done();
  await typeIn('Treći odlomak', 'start');
  await press('Backspace');
  check(
    'a divided paragraph is not joined onto a heading — its lines would change their formatting',
    (await status()).startsWith('Joining here would change the formatting'),
    await status(),
  );
  await done();

  /* ── a list ─────────────────────────────────────────────────────────── */

  const MERGED = 'Prva stavkaDruga stavkaPoslije liste.';
  await typeIn('Druga stavka', 'start');
  await press('Backspace');
  await page.keyboard.press('End');
  await press('Delete');
  file = await saved();
  check(
    'two list items joined are one item, and the paragraph after the list joined onto it is part of it',
    (await lines()).includes(`LI:${MERGED}`) && file.some((one) => one.kind === 'List' && one.text === MERGED),
    JSON.stringify(file.find((one) => one.text === MERGED)),
  );
  check('and the list counts one item where there were two', (await page.locator('.ul-office-doc ul > li:not(.is-joined)').count()) === 1);
  await done();

  await run('Prva stavka').click();
  await press('Control+Shift+Backspace');
  check(
    'a line joined from several paragraphs is not removed as if it were one',
    (await status()).startsWith('This line was joined from several paragraphs'),
    await status(),
  );
  await run('Prva stavka').click();
  await press('Control+Enter');
  await page.keyboard.type('iza');
  await done();
  file = await saved();
  const shown = await lines();
  const at = file.findIndex((one) => one.text === MERGED);
  check(
    'a new paragraph after a joined line comes after all of it, and continues its properties',
    shown[shown.indexOf(`LI:${MERGED}`) + 1] === 'LI:iza' && file[at + 1]?.text === 'iza' && file[at + 1]?.kind === 'List',
    JSON.stringify(file.slice(at, at + 2)),
  );
  check('and the page shows exactly what the file holds', await agrees(file));

  /* One `numId` is one counter in Word, however many groups it is drawn in:
     two numbered items joined are one number fewer, a paragraph later too. */
  const starts = () => page.evaluate(() => [...document.querySelectorAll('.ul-office-doc ol')].map((ol) => ol.getAttribute('start')));
  const numberedBefore = await starts();
  await typeIn('Druga točka', 'start');
  await press('Backspace');
  check(
    'two numbered items joined: the list after the paragraph between goes on from one number fewer',
    JSON.stringify(numberedBefore) === JSON.stringify([null, '3']) && JSON.stringify(await starts()) === JSON.stringify([null, '2']),
    `${JSON.stringify(numberedBefore)} → ${JSON.stringify(await starts())}`,
  );
  await done();

  for (let guard = 0; guard < 40 && (await page.evaluate(async () => (await import('/src/state/workspace.ts')).activeInstance()?.canUndo())); guard++) {
    await page.keyboard.press('Control+Z');
  }
  await page.waitForTimeout(200);
  check('and undoing all of it gives the document back as it was opened', JSON.stringify(await lines()) === JSON.stringify(original), JSON.stringify(await texts()));
  check('without an error on the way', errors.length === 0, errors.slice(0, 3).join(' · '));
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
}

const failed = checks.filter((one) => !one.passed).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
