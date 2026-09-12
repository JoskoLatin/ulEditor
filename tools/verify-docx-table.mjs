/**
 * A row added to a table, in the editor a person types into.
 *
 * [`verify-docx-rows.mjs`](./verify-docx-rows.mjs) proves what the writer
 * makes of a plan, against rows Word wrote itself. This proves the plan the
 * key makes: Ctrl+Enter with the cursor in a cell means a row below the row
 * it is in — the same key that means a paragraph below the paragraph it is
 * in everywhere else — and every cell of that row has to be typeable, the
 * row has to be drawn where the file will hold it, and a row nobody typed
 * into has to leave as quietly as it arrived.
 *
 * Every save is compared with the page, the way the lines are: the rows a
 * person sees, in order, against the rows of the file that would be written.
 * The save is taken by handing the editor a stand-in for the file system.
 *
 *   node tools/verify-docx-table.mjs [--url http://localhost:5273] [--headed]
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
const width = (w) => `<w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>`;
const td = (text, props = width(3000), pPr = '') => `<w:tc>${props}<w:p>${pPr}<w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;

/* A price list: a heading row that repeats and is bold to the paragraph mark,
   two ordinary rows, and a row whose first cell is merged with the one under
   it — the case where Word puts a new row below the merge rather than inside
   it. */
const HEAD = '<w:trPr><w:tblHeader/></w:trPr>';
const BOLD = '<w:pPr><w:rPr><w:b/></w:rPr></w:pPr>';
const TABLE =
  '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
  '<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
  `<w:tr>${HEAD}${td('Artikl', width(3000), BOLD)}${td('Količina', width(3000), BOLD)}${td('Cijena', width(3000), BOLD)}</w:tr>` +
  `<w:tr>${td('Šećer')}${td('2')}${td('3,50')}</w:tr>` +
  `<w:tr>${td('Čaj')}${td('1')}${td('12,00')}</w:tr>` +
  `<w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:vMerge w:val="restart"/></w:tcPr>${p('Kava')}</w:tc>${td('3')}${td('9,90')}</w:tr>` +
  /* The merge's last row puts its other two cells together — so the row a new
     one is copied from has a different shape from the row the cursor is in. */
  `<w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:vMerge/></w:tcPr><w:p/></w:tc>` +
  `<w:tc><w:tcPr><w:tcW w:w="6000" w:type="dxa"/><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>4 po 9,90</w:t></w:r></w:p></w:tc></w:tr>` +
  '</w:tbl>';

/* A second table whose only row a reviewer is recorded as having inserted —
   the refusal with a reason. */
const TRACKED =
  '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4600"/></w:tblGrid>' +
  `<w:tr><w:trPr><w:ins w:id="31" w:author="Recenzent" w:date="2026-09-01T10:00:00Z"/></w:trPr>${td('Praćeni redak', width(4600))}</w:tr>` +
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

/** The rows of the first table as a person sees them: the cells' texts. */
const shown = (table = 0) =>
  page.evaluate(
    (which) =>
      [...document.querySelectorAll('.ul-office-doc table')][which]
        ? [...[...document.querySelectorAll('.ul-office-doc table')][which].rows].map((row) =>
            [...row.cells].map((cell) => `${cell.textContent}${cell.colSpan > 1 ? `×${cell.colSpan}` : ''}`).join('|'),
          )
        : [],
    table,
  );

/**
 * Everything the status line has said since it was last cleared.
 *
 * Read rather than sampled, because the reading flow writes the words-and-
 * minutes line over whatever stands there as soon as the page's height
 * changes — and adding a row changes it. What is being asked is whether the
 * program said what it did, not how long the sentence stayed up.
 */
const listen = () =>
  page.evaluate(async () => {
    const { activeInstance } = await import('/src/state/workspace.ts');
    window.__said = [];
    activeInstance().onStatusChange((line) => window.__said.push(line));
  });
const clear = () => page.evaluate(() => { window.__said = []; });
const said = () => page.evaluate(() => window.__said ?? []);

const caret = () =>
  page.evaluate(() => {
    const active = document.activeElement;
    const selection = document.getSelection();
    if (!active?.isContentEditable || !selection?.rangeCount) return null;
    const cell = active.closest('[data-cell]');
    return { text: active.textContent, cell: cell ? Number(cell.dataset.cell) : null, row: cell?.closest('tr')?.dataset.newRow ?? null };
  });

/** The file a save would write: its rows, and the paragraphs outside them. */
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
        text: [...cellText[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(''),
        /* A cell carrying a merge on from the row above is not drawn again:
           the view gives the cell that started it a `rowspan` instead. */
        continues: /<w:vMerge\/>/.test(cellText[0]),
      })),
    ),
  );
  return {
    xml,
    tables: tables.map((rows) => rows.map((cells) => cells.map((one) => one.text))),
    /** The same rows as the view would draw them. */
    drawn: tables.map((rows) => rows.map((cells) => cells.filter((one) => !one.continues).map((one) => one.text).join('|'))),
  };
};

const dirty = () =>
  page.evaluate(async () => {
    const { activeInstance } = await import('/src/state/workspace.ts');
    return activeInstance().isDirty();
  });

const cellRun = (text) => page.locator('.ul-office-doc table .ul-office-run').filter({ hasText: new RegExp(`^${text}$`) }).first();
const done = () => page.evaluate(() => document.activeElement?.blur?.());
const press = async (key) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(150);
};
const ADDED = 'Row added — type into its cells; Ctrl+Z takes it back.';

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

  /* ── the table as it opens ─────────────────────────────────────────── */

  const opened = await shown();
  check(
    'the table opens with its rows, the merged cell spanning two of them',
    opened.length === 5 && opened[0] === 'Artikl|Količina|Cijena' && opened[4] === '4 po 9,90×2',
    JSON.stringify(opened),
  );
  check(
    'every row of the file carries the ordinal a new row names',
    (await page.locator('.ul-office-doc table tr[data-row]').count()) === 6,
    `${await page.locator('.ul-office-doc table tr[data-row]').count()} rows marked`,
  );
  check('the note says the key adds a row', (await page.locator('.ul-office-notes').innerText()).includes('Ctrl+Enter'));

  /* ── a row below the one the cursor is in ──────────────────────────── */

  await clear();
  await cellRun('Šećer').dblclick();
  await press('Control+Enter');
  check('Ctrl+Enter in a cell adds a row below that row', JSON.stringify(await shown()) !== JSON.stringify(opened));
  const added = await shown();
  check(
    'it is drawn below the row the cursor was in, with a cell for every cell',
    added.length === 6 && added[1] === 'Šećer|2|3,50' && added[2] === '||',
    JSON.stringify(added),
  );
  check('the status line says what happened', (await said()).includes(ADDED), JSON.stringify(await said()));
  check('the caret is in its first cell', JSON.stringify(await caret()) === JSON.stringify({ text: '', cell: 0, row: '0' }), JSON.stringify(await caret()));

  await page.keyboard.type('Med');
  await done();
  await page.waitForTimeout(150);
  check('what is typed into a cell stays in it', (await shown())[2] === 'Med||', JSON.stringify(await shown()));
  check('the document is unsaved', await dirty());

  await cellRun('Med').dblclick();
  await page.keyboard.press('End');
  await page.keyboard.type('ljak');
  await done();
  await page.waitForTimeout(150);
  check('a cell of the new row can be retyped', (await shown())[2] === 'Medljak||');

  /* The second and third cells, by clicking into the empty boxes the new row
     draws — the whole point of drawing a run in every cell. */
  const boxes = page.locator('[data-new-row="0"] .ul-office-run');
  await boxes.nth(1).dblclick();
  await page.keyboard.type('5');
  await boxes.nth(2).dblclick();
  await page.keyboard.type('7,20');
  await done();
  await page.waitForTimeout(150);
  check('and so can the cells beside it', (await shown())[2] === 'Medljak|5|7,20', JSON.stringify(await shown()));

  /* ── what the save writes ──────────────────────────────────────────── */

  let file = await saved();
  check(
    'the file holds the row where the page shows it',
    JSON.stringify(file.tables[0]) ===
      JSON.stringify([
        ['Artikl', 'Količina', 'Cijena'],
        ['Šećer', '2', '3,50'],
        ['Medljak', '5', '7,20'],
        ['Čaj', '1', '12,00'],
        ['Kava', '3', '9,90'],
        ['', '4 po 9,90'],
      ]),
    JSON.stringify(file.tables[0]),
  );
  check(
    'the page and the file show the same rows, in the same order',
    JSON.stringify((await shown()).map((row) => row.replace(/×\d+/g, ''))) === JSON.stringify(file.drawn[0]),
    JSON.stringify(await shown()),
  );
  check('saving twice writes the same file', (await saved()).xml === file.xml);
  check('the document is saved', !(await dirty()));

  /* ── below a merge, not inside it ──────────────────────────────────── */

  await cellRun('Kava').dblclick();
  await press('Control+Enter');
  await page.keyboard.type('Sol');
  await done();
  await page.waitForTimeout(150);
  const merged = await shown();
  check(
    'a row asked for inside a merge is drawn below the last row the merge reaches',
    merged.length === 7 && merged[6] === 'Sol|×2' && merged[5] === '4 po 9,90×2',
    JSON.stringify(merged),
  );
  const solRow = page.locator('[data-new-row]').filter({ hasText: 'Sol' });
  check(
    'and it is the shape of the row it is copied from, not of the row the cursor was in',
    (await solRow.locator('td').count()) === 2 && (await solRow.locator('td').nth(1).getAttribute('colspan')) === '2',
    `${await solRow.locator('td').count()} cells`,
  );
  file = await saved();
  check(
    'and the file has it there too, with the merge untouched',
    JSON.stringify(file.tables[0].at(-1)) === JSON.stringify(['Sol', '']) &&
      (file.xml.match(/<w:vMerge/g) ?? []).length === 2 &&
      (file.xml.match(/<w:gridSpan w:val="2"\/>/g) ?? []).length === 2,
    JSON.stringify(file.tables[0]),
  );
  check(
    'the new row does not carry the merge into itself',
    !/<w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"\/><w:vMerge\/><\/w:tcPr><w:p\/><\/w:tc><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"\/><\/w:tcPr><w:p><w:r><w:t xml:space="preserve">Sol/.test(file.xml),
  );

  /* ── a heading row's own formatting ────────────────────────────────── */

  await cellRun('Artikl').dblclick();
  await press('Control+Enter');
  await page.keyboard.type('Novi');
  await done();
  await page.waitForTimeout(150);
  file = await saved();
  const heading = /<w:tbl>[\s\S]*?<\/w:tbl>/.exec(file.xml)[0];
  const second = heading.split('</w:tr>')[1] + '</w:tr>';
  check(
    'a row added under the heading row is a heading row too, and what is typed into it is bold',
    second.includes('<w:tblHeader/>') && second.includes('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Novi</w:t></w:r>'),
    second,
  );
  check(
    'and the view draws its cells as heading cells',
    (await page.locator('[data-new-row] th').count()) === 3,
    `${await page.locator('[data-new-row] th').count()} heading cells`,
  );

  /* ── taking it back ────────────────────────────────────────────────── */

  const before = await shown();
  await press('Control+z');
  check('Ctrl+Z takes the row back', (await shown()).length === before.length - 1, JSON.stringify(await shown()));
  await press('Control+y');
  check('and Ctrl+Y brings it back, with what was typed into it', (await shown()).includes('Novi||'), JSON.stringify(await shown()));

  /* ── a row nobody typed into ───────────────────────────────────────── */

  const kept = await shown();
  await cellRun('Čaj').dblclick();
  await press('Control+Enter');
  check('a row asked for is drawn at once', (await shown()).length === kept.length + 1);
  await done();
  await page.waitForTimeout(150);
  check(
    'a row nobody typed into leaves as quietly as it arrived',
    JSON.stringify(await shown()) === JSON.stringify(kept),
    JSON.stringify(await shown()),
  );

  /* ── a row behind a row, and a paragraph that is still a paragraph ─── */

  await cellRun('Medljak').dblclick();
  await press('Control+Enter');
  await page.keyboard.type('Prva');
  await press('Control+Enter');
  await page.keyboard.type('Druga');
  await done();
  await page.waitForTimeout(150);
  const behind = await shown();
  check(
    'a row asked for from inside a new row goes behind it',
    behind.indexOf('Prva||') !== -1 && behind.indexOf('Druga||') === behind.indexOf('Prva||') + 1,
    JSON.stringify(behind),
  );

  await page.locator('.ul-office-doc .ul-office-run').filter({ hasText: /^Prvi odlomak teksta\.$/ }).first().dblclick();
  await press('Control+Enter');
  await page.keyboard.type('Dodani odlomak');
  await done();
  await page.waitForTimeout(150);
  check(
    'Ctrl+Enter outside a table still adds a paragraph',
    (await page.locator('.ul-office-doc [data-new]').count()) === 1 &&
      (await page.locator('.ul-office-doc [data-new]').innerText()) === 'Dodani odlomak',
  );

  /* ── removing one, and a refusal with a reason ─────────────────────── */

  const withRows = await shown();
  await clear();
  await page.locator('[data-new-row] .ul-office-run').filter({ hasText: /^Druga$/ }).first().dblclick();
  await page.keyboard.press('Control+Shift+Backspace');
  await page.waitForTimeout(150);
  check(
    'Ctrl+Shift+Backspace in a row the plan added takes that row away',
    (await shown()).length === withRows.length - 1 && !(await shown()).includes('Druga||'),
    JSON.stringify(await shown()),
  );
  check('and says so', (await said()).includes('Row removed — Ctrl+Z brings it back.'), JSON.stringify(await said()));

  await clear();
  await page.locator('.ul-office-doc table .ul-office-run').filter({ hasText: /^Praćeni redak$/ }).first().dblclick();
  await press('Control+Enter');
  check(
    'a row a reviewer is recorded as having inserted refuses, with the reason',
    (await said()).some((line) => line.startsWith('A tracked change is recorded on this row')),
    JSON.stringify(await said()),
  );
  check('and nothing was added to that table', (await shown(1)).length === 1, JSON.stringify(await shown(1)));
  await done();

  /* ── the file, once more, with everything in it ────────────────────── */

  file = await saved();
  check(
    'every row the page shows is a row of the file, and no other',
    file.tables[0].length === (await shown()).length &&
      file.tables[1].length === 1 &&
      file.xml.includes('<w:t xml:space="preserve">Dodani odlomak</w:t>'),
    `${file.tables[0].length} rows written, ${(await shown()).length} shown`,
  );
  check('the page reported no errors', errors.length === 0, errors.slice(0, 3).join(' · '));
} finally {
  await browser.close();
}

const failed = checks.filter((one) => !one.passed).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
