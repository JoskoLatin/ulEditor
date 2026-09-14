/**
 * `Ctrl+M` in the editor a person types into: cells selected, cells merged.
 *
 * [verify-docx-merge.mjs](verify-docx-merge.mjs) proves the WRITER against
 * Word's own merges and never opens a browser. This asks the other half of the
 * question, and it is the half that could not be asked until now: **does the
 * gesture name the cells the person actually pointed at?**
 *
 * That is not a formality here. Every gesture before this one needed a caret,
 * and read it with `getSelection().anchorNode` — one node, the end the drag
 * began at. Merging needs a range, and a range across table cells is reported
 * by Chromium as one ordinary range whose ends sit in the text of the first and
 * last cell. Two things follow, and both are measured here rather than argued:
 *
 * - **A selection can contain a whole row without anybody having selected it.**
 *   Drag from the paragraph above a table into its third cell — or press
 *   `Ctrl+A` — and every cell of that row answers `containsNode(cell, true)`.
 *   "All hit cells are of one row" would merge a row nobody pointed at.
 * - **Adjacent on the screen is not adjacent in the file.** A cell carrying a
 *   vertical merge on from the row above is drawn by that row and has no
 *   element of its own, so the cells either side of it look neighbouring and
 *   are two `w:tc` apart. The fixture below has exactly that row.
 *
 * It drives the running dev server, the way its sibling checks do, and compares
 * what the page draws with the bytes a save would write — every time, because a
 * view and a writer that disagree about which cells went together is the whole
 * failure this is here to catch.
 *
 *   pnpm dev          # in another terminal
 *   node tools/verify-docx-cells.mjs [--url http://localhost:5273] [--headed]
 *
 * Close ulEditor first: a second copy hands its arguments to the first and
 * exits, and this then waits for a debugging port that never opens.
 */

import { chromium } from 'playwright';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

import { makeDocx } from './fixtures.mjs';

const argv = process.argv.slice(2);
const url = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'http://localhost:5273';
const headed = argv.includes('--headed');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── the document ────────────────────────────────────────────────────── */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (text, props = '') => `<w:p>${props}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const width = (w) => `<w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>`;
const td = (text, props = width(3000), pPr = '') => `<w:tc>${props}<w:p>${pPr}<w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;

const HEAD = '<w:trPr><w:tblHeader/></w:trPr>';
const BOLD = '<w:pPr><w:rPr><w:b/></w:rPr></w:pPr>';

/*
 * A price list, and the awkward part is deliberate: the fourth row starts a
 * vertical merge in its MIDDLE column, so the fifth row's cells are
 * `w:tc` 0 — visible, `w:tc` 1 — the continuation, drawn by the row above and
 * given no element at all, `w:tc` 2 — visible.
 *
 * On the screen those two visible cells touch. In the file they are two apart.
 * A gesture that trusted the DOM would merge the wrong pair, or swallow a cell
 * nobody can see.
 */
const TABLE =
  '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
  '<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
  `<w:tr>${HEAD}${td('Artikl', width(3000), BOLD)}${td('Količina', width(3000), BOLD)}${td('Cijena', width(3000), BOLD)}</w:tr>` +
  `<w:tr>${td('Šećer')}${td('2')}${td('3,50')}</w:tr>` +
  `<w:tr>${td('Čaj')}${td('1')}${td('12,00')}</w:tr>` +
  `<w:tr>${td('Kava')}<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:vMerge w:val="restart"/></w:tcPr>${p('3')}</w:tc>${td('9,90')}</w:tr>` +
  `<w:tr>${td('Mlijeko')}<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:vMerge/></w:tcPr><w:p/></w:tc>${td('4,20')}</w:tr>` +
  '</w:tbl>';

/* A second table whose only row a reviewer is recorded as having inserted. */
const TRACKED =
  '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2300"/><w:gridCol w:w="2300"/></w:tblGrid>' +
  `<w:tr><w:trPr><w:ins w:id="31" w:author="Recenzent" w:date="2026-09-01T10:00:00Z"/></w:trPr>${td('Praćeni', width(2300))}${td('redak', width(2300))}</w:tr>` +
  '</w:tbl>';

const BODY =
  p('Cjenik', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>') +
  p('Prvi odlomak teksta.') +
  TABLE +
  p('Poslije tablice.') +
  TRACKED +
  p('Zadnji odlomak.');

const docx = zipSync({
  ...unzipSync(makeDocx()),
  'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<w:document ${W}><w:body>${BODY}<w:sectPr/></w:body></w:document>`),
});

/* ── the page ────────────────────────────────────────────────────────── */

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

/** The rows of a table as a person sees them, with any widening said out loud. */
const shown = (table = 0) =>
  page.evaluate(
    (which) =>
      [...document.querySelectorAll('.ul-office-doc table')][which]
        ? [...[...document.querySelectorAll('.ul-office-doc table')][which].rows].map((row) =>
            [...row.cells]
              .filter((cell) => !cell.hidden)
              .map((cell) => `${cell.textContent}${cell.colSpan > 1 ? `×${cell.colSpan}` : ''}`)
              .join('|'),
          )
        : [],
    table,
  );

const listen = () =>
  page.evaluate(async () => {
    const { activeInstance } = await import('/src/state/workspace.ts');
    window.__said = [];
    activeInstance().onStatusChange((line) => window.__said.push(line));
  });
const clear = () => page.evaluate(() => { window.__said = []; });
const said = () => page.evaluate(() => window.__said ?? []);

/** The file a save would write — the host's filesystem swapped out inside the page. */
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
  const xml = strFromU8(unzipSync(Buffer.from(b64, 'base64'))['word/document.xml']);
  const tables = [...xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map((tbl) =>
    [...tbl[0].matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)].map((row) =>
      [...row[1].matchAll(/<w:tc>[\s\S]*?<\/w:tc>|<w:tc\/>/g)].map((cellText) => ({
        text: [...cellText[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((one) => one[1]).join(''),
        span: Number(/<w:gridSpan w:val="(\d+)"\/>/.exec(cellText[0])?.[1] ?? 1),
        continues: /<w:vMerge\/>/.test(cellText[0]),
      })),
    ),
  );
  return {
    xml,
    /** The same rows as the view draws them: a continuation is not a cell on the page. */
    drawn: tables.map((rows) =>
      rows.map((cells) =>
        cells
          .filter((one) => !one.continues)
          .map((one) => `${one.text}${one.span > 1 ? `×${one.span}` : ''}`)
          .join('|'),
      ),
    ),
  };
};

const dirty = () =>
  page.evaluate(async () => {
    const { activeInstance } = await import('/src/state/workspace.ts');
    return activeInstance().isDirty();
  });

/**
 * Selects a run of cells the way a mouse drag does — one range, ends in the
 * text of the first and last cell.
 *
 * Built rather than dragged on purpose: a real drag in the paged flow can begin
 * on `.ul-read-edge`, the transparent page-turn button that lies over the
 * leftmost centimetre of the column, and this check is about what the editor
 * does with a selection rather than about where a button is. What it builds is
 * the range Chromium was measured to produce.
 */
const selectCells = (table, row, from, to) =>
  page.evaluate(
    ({ table, row, from, to }) => {
      const rows = [...document.querySelectorAll('.ul-office-doc table')][table].rows;
      const cells = [...rows[row].cells].filter((cell) => !cell.hidden);
      const range = document.createRange();
      range.setStart(cells[from], 0);
      range.setEnd(cells[to], cells[to].childNodes.length);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    },
    { table, row, from, to },
  );

/** …and a selection that reaches the row from outside it, which is the trap. */
const selectFromAbove = (table, row, to) =>
  page.evaluate(
    ({ table, row, to }) => {
      const body = document.querySelector('.ul-office-doc');
      const above = [...body.querySelectorAll('p')].find((one) => one.textContent?.includes('Prvi odlomak'));
      const rows = [...document.querySelectorAll('.ul-office-doc table')][table].rows;
      const cells = [...rows[row].cells].filter((cell) => !cell.hidden);
      const range = document.createRange();
      range.setStart(above, 0);
      range.setEnd(cells[to], cells[to].childNodes.length);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    },
    { table, row, to },
  );

const press = async (key) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(150);
};
const MERGED = 'Cells merged — Ctrl+Z takes it back.';

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shell', { timeout: 20000 });
  await page.evaluate((bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'cjenik.docx'));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, Array.from(docx));
  await page.waitForSelector('.ul-office-doc table', { timeout: 20000 });
  await listen();

  const opened = await shown(0);
  check('the table opens as the file has it', opened[1] === 'Šećer|2|3,50', opened[1] ?? '(nothing)');
  check(
    'the row under a merge draws two cells, not three',
    opened[4] === 'Mlijeko|4,20',
    opened[4] ?? '(nothing)',
  );

  /* ── the cells the person pointed at ───────────────────────────────── */

  await clear();
  await selectCells(0, 1, 0, 1);
  await press('Control+m');

  const after = await shown(0);
  check('two cells become one on the page', after[1] === 'Šećer2×2|3,50', after[1] ?? '(nothing)');
  check('and the program says so', (await said()).includes(MERGED), (await said()).join(' / ') || '(silence)');
  check('the document is dirty', (await dirty()) === true);

  const file = await saved();
  check('the save writes one cell where two stood', file.drawn[0][1] === 'Šećer2×2|3,50', file.drawn[0][1] ?? '(nothing)');
  check(
    'the page and the file agree, row for row',
    JSON.stringify(file.drawn[0]) === JSON.stringify(after),
    `file ${JSON.stringify(file.drawn[0])} vs page ${JSON.stringify(after)}`,
  );
  check('the rows nobody touched are untouched', file.drawn[0][2] === 'Čaj|1|12,00', file.drawn[0][2] ?? '');
  check('the width is summed', /<w:tcW w:w="6000" w:type="dxa"\/><w:gridSpan w:val="2"\/>/.test(file.xml));

  /* ── and Ctrl+Z takes it back ──────────────────────────────────────── */

  await press('Control+z');
  const undone = await shown(0);
  check('undo puts both cells back', undone[1] === 'Šećer|2|3,50', undone[1] ?? '(nothing)');
  /* Dirty AGAIN, and that is the right answer: the save above wrote the merge,
     so a plan without it no longer matches the file on disk. */
  check('and the document differs from what was saved', (await dirty()) === true);
  const back = await saved();
  check('the file it would write is the file it opened', back.drawn[0][1] === 'Šećer|2|3,50', back.drawn[0][1] ?? '');

  /* ── what it refuses, and whether it says why ──────────────────────── */

  const refuses = async (name, prepare, fragment) => {
    await clear();
    await prepare();
    await press('Control+m');
    const lines = await said();
    check(name, lines.some((line) => line.includes(fragment)), lines.join(' / ') || '(silence)');
    check(`${name}: and nothing moved`, (await dirty()) === false);
  };

  await refuses(
    'a selection reaching the row from outside it is refused',
    /* The FIRST row, so the selection hits no other row on its way and the
       one-row rule cannot fire first — leaving this guard the only thing
       standing between a dragged-in selection and a merge nobody asked for. */
    () => selectFromAbove(0, 0, 2),
    'reaches outside the row',
  );

  await refuses(
    'a selection crossing two rows is refused',
    () =>
      page.evaluate(() => {
        const rows = [...document.querySelectorAll('.ul-office-doc table')][0].rows;
        const range = document.createRange();
        range.setStart(rows[1].cells[0], 0);
        range.setEnd(rows[2].cells[1], rows[2].cells[1].childNodes.length);
        const selection = document.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }),
    'within one row',
  );

  /* The row under the merge: its two visible cells are `w:tc` 0 and 2, with
     the continuation between them. This is the case the DOM cannot see. */
  await refuses(
    'two cells touching on screen but two apart in the file are refused',
    () => selectCells(0, 4, 0, 1),
    'not next to each other in the file',
  );

  await refuses(
    'one cell is not a merge',
    () => selectCells(0, 1, 0, 0),
    'two cells or more',
  );

  await refuses(
    'a row a reviewer is recorded as having inserted is refused',
    () => selectCells(1, 0, 0, 1),
    'tracked change',
  );

  /* ── and one merge does not become two ─────────────────────────────── */

  await clear();
  await selectCells(0, 2, 0, 1);
  await press('Control+m');
  check('a second merge elsewhere is allowed', (await shown(0))[2] === 'Čaj1×2|12,00', (await shown(0))[2] ?? '');

  await clear();
  await selectCells(0, 2, 0, 1);
  await press('Control+m');
  check(
    'merging the same cells again is refused, out loud',
    (await said()).some((line) => line.includes('merged already')),
    (await said()).join(' / ') || '(silence)',
  );

  const both = await saved();
  check(
    'the save still writes what the page draws',
    JSON.stringify(both.drawn[0]) === JSON.stringify(await shown(0)),
    `file ${JSON.stringify(both.drawn[0])} vs page ${JSON.stringify(await shown(0))}`,
  );

  check('nothing threw in the page', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (error) {
  check('the run finished', false, String(error.message).split('\n')[0]);
  if (/ERR_CONNECTION_REFUSED|net::/.test(String(error.message))) {
    console.log(`\n  Nothing is serving ${url}. Start it with: pnpm dev`);
  }
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
