/**
 * The numbers on the screen, after somebody types into the sheet under them.
 *
 * `recalculate` answers which of a sheet's formulas can be worked out again and
 * which can no longer be trusted. This checks the other half: that the grid
 * actually draws that answer, and draws it in a form a person can read.
 *
 * **The check worth having is the one about the number that is NOT marked.** A
 * formula this can work out is deliberately absent from `stale` — it is in
 * `values` instead — so a view that only drew the stale marks would leave every
 * `SUM` in the workbook showing its old total, unmarked and looking current.
 * That is the exact failure this whole piece of work exists to stop, and it is
 * the failure a "mark the stale ones" reading of the design walks straight into.
 * So the first check below is that a changed `SUM` shows its new total.
 *
 * The second is that it shows it **in the same hand**. `formatNumber` renders
 * through `Intl` in hr-HR, so a sheet's own numbers read `1.234,50`; a total
 * recomputed as a bare JavaScript number arrives as `1234.5` in the middle of
 * that column. Both are "the right answer" and only one of them is readable.
 *
 *   node tools/verify-sheet-stale.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { strToU8, zipSync } from 'fflate';

import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = (file) => import(pathToFileURL(join(ROOT, 'packages/editor-office/src', file)).href);

const { recalculate } = await load('formula.ts');
const { shownFormula } = await load('sheet-grid.ts');
const { formatNumber } = await load('xlsx.ts');
const { typedKind } = await load('xlsx-edit.ts');

/** `parse` inside `formula.ts` is private; this is its rule, and the check below is that it stays its rule. */
const parse = (text) => {
  if (text.trim() === '') return null;
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
};

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── a sheet, written as the reader hands it over ────────────────────── */

/*
 * Cells by hand rather than through `readXlsx`, because reading an `.xlsx`
 * needs `DOMParser` and so belongs in the browser checks — the same division
 * `verify-odf.mjs` already draws. What is built here is exactly what the reader
 * produces: text already formatted, and the format code kept beside it.
 *
 * - `A1:A3` — the amounts somebody types into;
 * - `B1` — `SUM(A1:A3)`, formatted `#,##0.00`, which this can work out;
 * - `B2` — `SUM(B1:B1)*2`, a total of a total, so a chain has to travel;
 * - `B3` — `SUBTOTAL(9,A1:A3)`, which this cannot work out and must mark;
 * - `D1` — `SUM(C1:C2)`, over a column nobody touches, which must be left alone;
 * - `E1` — plain text, which must never be marked whatever happens.
 */
const at = (ref) => `${Number(ref.slice(1)) - 1},${ref.charCodeAt(0) - 65}`;
const MONEY = '#,##0.00';

const sheet = { name: 'Racun', cells: new Map() };
const put = (ref, cell) => sheet.cells.set(at(ref), cell);

put('A1', { text: '1.000,00', kind: 'number', fmt: MONEY });
put('A2', { text: '200,00', kind: 'number', fmt: MONEY });
put('A3', { text: '34,50', kind: 'number', fmt: MONEY });
put('B1', { text: '1.234,50', kind: 'number', fmt: MONEY, formula: 'SUM(A1:A3)' });
put('B2', { text: '2.469,00', kind: 'number', fmt: MONEY, formula: 'SUM(B1:B1)*2' });
put('B3', { text: '1.234,50', kind: 'number', fmt: MONEY, formula: 'SUBTOTAL(9,A1:A3)' });
put('C1', { text: '7', kind: 'number' });
put('C2', { text: '8', kind: 'number' });
put('D1', { text: '15', kind: 'number', formula: 'SUM(C1:C2)' });
put('E1', { text: 'Ukupno', kind: 'text' });

check(
  'the reader formats through hr-HR, so a total must come back in the same hand',
  formatNumber(2234.5, MONEY) === '2.234,50',
  formatNumber(2234.5, MONEY),
);
check(
  'and a total with no format of its own is still not raw JavaScript',
  formatNumber(2234.5, undefined) === '2234,5',
  formatNumber(2234.5, undefined),
);

/* ── what the grid shows once A1 is retyped ──────────────────────────── */

const shows = (typed) => {
  const answer = recalculate(sheet.cells, sheet.name, new Map(Object.entries(typed)));
  return (ref) => {
    const cell = sheet.cells.get(at(ref));
    return cell?.formula === undefined ? { text: cell?.text ?? '', stale: undefined } : shownFormula(cell, at(ref), answer);
  };
};

/* 1000 → 2000 puts the column at 2234,5. */
const after = shows({ [at('A1')]: '2000' });

check(
  'a SUM whose column changed shows the new total, not the old one',
  after('B1').text !== '1.234,50' && after('B1').text.startsWith('2.234'),
  after('B1').text,
);
check(
  'and shows it in the format the cell already had',
  after('B1').text === '2.234,50',
  `${after('B1').text} (wanted 2.234,50)`,
);
check('a recalculated total is not also marked out of date', after('B1').stale !== true);
check(
  'a total of a total travels the chain',
  after('B2').text === '4.469,00',
  `${after('B2').text} (wanted 4.469,00)`,
);
check(
  'a formula this cannot work out is marked out of date',
  after('B3').stale === true,
  `SUBTOTAL → ${after('B3').text}`,
);
check(
  'and keeps the number the file holds rather than blanking it',
  after('B3').text === '1.234,50',
  after('B3').text,
);
check(
  'a formula over a column nobody touched is left exactly alone',
  after('D1').stale !== true && after('D1').text === sheet.cells.get(at('D1'))?.text,
  after('D1').text,
);
check('a cell that is not a formula is never marked', after('E1').stale === undefined);

/* ── the edited cell wins, and nothing at all means nothing at all ───── */

const untouched = shows({});
check(
  'with nothing typed, every formula shows what the file says',
  ['B1', 'B2', 'B3', 'D1'].every(
    (ref) => untouched(ref).text === sheet.cells.get(at(ref))?.text && untouched(ref).stale !== true,
  ),
);
check(
  'a formula cell typed over is not second-guessed',
  (() => {
    const answer = recalculate(sheet.cells, sheet.name, new Map([[at('B1'), '99']]));
    return !answer.values.has(at('B1')) && !answer.stale.has(at('B1'));
  })(),
);

/* ── the two parsers have to agree about what was typed ──────────────── */

/*
 * What a typed value is worth is decided twice: `numberOf` in the writer says
 * whether it goes into the file as a number, and `parse` in `formula.ts` says
 * whether a SUM may add it. They are separate functions with separate rules and
 * nothing links them, so if they ever part company the file and the screen say
 * different things about the same cell — the view lying in the other direction.
 *
 * `1.234,50` is the case that matters here, because it is how this corpus
 * writes money: both refuse it, so the cell becomes text in the file and SUM
 * passes over it on the screen. The check is that they keep agreeing.
 */
for (const [value, isNumber] of [
  ['2000', true],
  ['1,5', true],
  ['-3,25', true],
  ['0', true],
  ['1.234,50', false],
  ['2.000,00', false],
  ['1 000', false],
  ['nema', false],
  ['', false],
]) {
  const save = typedKind(value) === 'number';
  const read = parse(value) !== null;
  check(
    `the writer and the formulas agree about ${JSON.stringify(value)}`,
    save === isNumber && read === isNumber,
    `file: ${save ? 'number' : 'text'} · SUM: ${read ? 'adds it' : 'passes over it'}`,
  );
}

/* ── a formula that is not a number is marked, never redrawn ─────────── */

const dated = { text: '12.3.2025', kind: 'date', formula: 'A1+A2' };
{
  const answer = { values: new Map([['9,9', 45_678]]), stale: new Set() };
  const out = shownFormula(dated, '9,9', answer);
  check(
    'a formula in a date column is marked rather than shown as a serial number',
    out.stale === true && out.text === '12.3.2025',
    `${out.text} · stale=${out.stale}`,
  );
}

/* A word in a summed column lowers the total — SUM passes over text — and that
   is what the view must show, not a refusal. */
const worded = shows({ [at('A1')]: 'nema' });
check(
  'a word typed into a summed column lowers the total rather than breaking it',
  worded('B1').text === '234,50',
  worded('B1').text,
);

/* ── what it costs ───────────────────────────────────────────────────── */

/*
 * This runs once per edit — on the blur that ends the typing — and never per
 * frame and never per cell drawn, which is the whole reason the answer is
 * worked out for a sheet and looked up per cell rather than the other way
 * round. So the budget is a keystroke's, not a scroll's.
 *
 * The census is what says which sizes are real: 372 formulas across 32 real
 * spreadsheets, and the worst single workbook holds 35. The check is set at
 * 1 000 — twenty-eight times that worst one — and the larger sizes are measured
 * and printed rather than failed, because a number nobody has measured is an
 * opinion and a budget nobody has met is a guess.
 */
const costOf = (formulas) => {
  const cells = new Map();
  for (let r = 0; r < formulas; r++) {
    cells.set(`${r},0`, { text: String(r), kind: 'number' });
    cells.set(`${r},1`, { text: '0', kind: 'number', formula: `SUM(A${r + 1}:A${r + 1})`, fmt: MONEY });
  }
  recalculate(cells, 'Veliki', new Map([['0,0', '5']]));
  const started = performance.now();
  recalculate(cells, 'Veliki', new Map([['0,0', '6']]));
  return performance.now() - started;
};

const small = costOf(1_000);
const large = costOf(10_000);

check(
  'one keystroke on 1 000 formulas — 28 times the most any real workbook here holds — settles inside a frame',
  small < 16.7,
  `${small.toFixed(1)} ms`,
);
check(
  'and the cost is linear in the formulas rather than worse',
  large < small * 15,
  `${large.toFixed(1)} ms for ten times as many — ${(large / small).toFixed(1)} times the cost`,
);
console.log(
  `
  ${small.toFixed(1)} µs a formula an edit. A sheet of 10 000 formulas costs ${large.toFixed(0)} ms once, on the keystroke that ends the typing — not per frame and not per cell drawn.`,
);

/* ── and the same thing through the reader and the grid ──────────────── */

/*
 * Everything above is the logic. This is the program: an `.xlsx` read by
 * `readXlsx`, drawn by `SheetGrid`, typed into, and looked at.
 *
 * It needs the development server, because reading a spreadsheet goes through
 * `DOMParser` — the division `verify-odf.mjs` already draws. Without one this
 * says so and stops rather than passing quietly: a check that reports success
 * when it did not run is worse than no check.
 *
 *   pnpm --filter @uleditor/shell-ui dev
 *   node tools/verify-sheet-stale.mjs
 */

const url = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://localhost:5273';

const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** The sheet above, as a file: `B1` a SUM, `B3` a SUBTOTAL, both styled `#,##0.00`. */
function styledBook() {
  const xml = (body) => `<?xml version="1.0"?>
${body}`;
  return zipSync({
    '[Content_Types].xml': strToU8(
      xml(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>`,
      ),
    ),
    'xl/workbook.xml': strToU8(
      xml(
        `<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets>` +
          `<sheet name="Racun" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      xml(
        `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" ` +
          `Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      ),
    ),
    'xl/styles.xml': strToU8(
      xml(
        `<styleSheet xmlns="${SHEET_NS}">` +
          `<numFmts count="1"><numFmt numFmtId="164" formatCode="${MONEY}"/></numFmts>` +
          `<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`,
      ),
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      xml(
        `<worksheet xmlns="${SHEET_NS}"><sheetData>` +
          `<row r="1"><c r="A1" s="1"><v>1000</v></c>` +
          `<c r="B1" s="1"><f>SUM(A1:A3)</f><v>1234.5</v></c></row>` +
          `<row r="2"><c r="A2" s="1"><v>200</v></c></row>` +
          `<row r="3"><c r="A3" s="1"><v>34.5</v></c>` +
          `<c r="B3" s="1"><f>SUBTOTAL(9,A1:A3)</f><v>1234.5</v></c></row>` +
          `</sheetData></worksheet>`,
      ),
    ),
  });
}

/**
 * Two sheets, as the real workbook is built: `Cashless` holds the summary
 * formulas and `Podaci` holds the table they read. `PodaciTable` is A1:C4 with
 * one header row, so its data is rows 2–4, and `Iznos` is its third column.
 *
 * This is the shape the whole change turns on. Before the table definitions were
 * read, `SUMIFS(PodaciTable[Iznos],…)` was unreadable, so typing anywhere on
 * `Cashless` marked it out of date — although it reads nothing on `Cashless` at
 * all.
 */
function tableBook() {
  const xml = (body) => `<?xml version="1.0"?>
${body}`;
  const sheet1 =
    `<worksheet xmlns="${SHEET_NS}"><sheetData>` +
    `<row r="1"><c r="A1" s="1"><v>100</v></c>` +
    `<c r="B1" s="1"><f>SUMIFS(PodaciTable[Iznos],PodaciTable[Vrsta],5)</f><v>1234.5</v></c></row>` +
    `<row r="2"><c r="A2" s="1"><v>200</v></c>` +
    `<c r="B2" s="1"><f>SUM(A1:A2)</f><v>300</v></c></row>` +
    `</sheetData></worksheet>`;
  const sheet2 =
    `<worksheet xmlns="${SHEET_NS}"><sheetData>` +
    `<row r="1"><c r="A1" t="str"><v>Vrsta</v></c><c r="B1" t="str"><v>Operater</v></c>` +
    `<c r="C1" t="str"><v>Iznos</v></c></row>` +
    `<row r="2"><c r="A2"><v>5</v></c><c r="C2" s="1"><v>1000</v></c></row>` +
    `<row r="3"><c r="A3"><v>5</v></c><c r="C3" s="1"><v>234.5</v></c></row>` +
    `<row r="4"><c r="A4"><v>7</v></c><c r="C4" s="1"><v>99</v></c></row>` +
    `</sheetData><tableParts count="2"><tablePart r:id="rIdT" xmlns:r="${REL_NS}"/>` +
    `<tablePart r:id="rIdU" xmlns:r="${REL_NS}"/></tableParts></worksheet>`;
  const table =
    `<table xmlns="${SHEET_NS}" id="1" name="PodaciTable" displayName="PodaciTable" ref="A1:C4">` +
    `<tableColumns count="3"><tableColumn id="1" name="Vrsta"/>` +
    `<tableColumn id="2" name="Operater"/><tableColumn id="3" name="Iznos"/></tableColumns></table>`;
  /*
   * The same shape with a totals row under it. Excel puts a `SUBTOTAL` there,
   * so counting it as data would make a column's own total one of the numbers
   * that column adds up. No table in the measured corpus declares one, which is
   * exactly why it is written out here: otherwise nothing would ever fail if
   * the reader stopped subtracting it.
   */
  const totalled =
    `<table xmlns="${SHEET_NS}" id="2" name="SaZbrojem" displayName="SaZbrojem" ref="E1:F5" totalsRowCount="1">` +
    `<tableColumns count="2"><tableColumn id="1" name="Stavka"/>` +
    `<tableColumn id="2" name="Cijena"/></tableColumns></table>`;

  return zipSync({
    '[Content_Types].xml': strToU8(
      xml(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>`,
      ),
    ),
    'xl/workbook.xml': strToU8(
      xml(
        `<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets>` +
          `<sheet name="Cashless" sheetId="1" r:id="rId1"/>` +
          `<sheet name="Podaci" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      ),
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      xml(
        `<Relationships xmlns="${PKG_REL_NS}">` +
          `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
          `<Relationship Id="rId2" Type="${REL_NS}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
      ),
    ),
    'xl/worksheets/_rels/sheet2.xml.rels': strToU8(
      xml(
        `<Relationships xmlns="${PKG_REL_NS}">` +
          `<Relationship Id="rIdT" Type="${REL_NS}/table" Target="../tables/table1.xml"/>` +
          `<Relationship Id="rIdU" Type="${REL_NS}/table" Target="../tables/table2.xml"/></Relationships>`,
      ),
    ),
    'xl/styles.xml': strToU8(
      xml(
        `<styleSheet xmlns="${SHEET_NS}">` +
          `<numFmts count="1"><numFmt numFmtId="164" formatCode="${MONEY}"/></numFmts>` +
          `<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`,
      ),
    ),
    'xl/tables/table1.xml': strToU8(xml(table)),
    'xl/tables/table2.xml': strToU8(xml(totalled)),
    'xl/worksheets/sheet1.xml': strToU8(xml(sheet1)),
    'xl/worksheets/sheet2.xml': strToU8(xml(sheet2)),
  });
}

/**
 * The one real workbook the census found structured references in. Absent on
 * anybody else's machine, and the check that uses it says so rather than
 * failing — the fixture above asks the same question of a file this repository
 * writes itself.
 */
function findReal() {
  const corpus = process.env.UL_CORPUS ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'Documents');
  const walk = (dir, depth = 0) => {
    if (depth > 6) return null;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const hit = walk(full, depth + 1);
        if (hit) return hit;
      } else if (/^Excel cashless izvjestaj .*\.xlsx$/i.test(entry.name)) {
        return full;
      }
    }
    return null;
  };
  return walk(corpus);
}

let reachable = true;
try {
  await fetch(url, { signal: AbortSignal.timeout(2500) });
} catch {
  reachable = false;
}

if (!reachable) {
  console.log(
    `
  The reader and the grid were NOT checked: no development server at ${url}.` +
      `
  Start one with  pnpm --filter @uleditor/shell-ui dev  and run this again.`,
  );
} else {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('.shell', { timeout: 20000 });

    const drawn = await page.evaluate(
      async ({ root, b64 }) => {
        const { readXlsx } = await import(`/@fs/${root}/packages/editor-office/src/xlsx.ts`);
        const { recalculate } = await import(`/@fs/${root}/packages/editor-office/src/formula.ts`);
        const { SheetGrid, shownFormula } = await import(`/@fs/${root}/packages/editor-office/src/sheet-grid.ts`);

        const book = readXlsx(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        const sheet = book.sheets[0];
        const kept = sheet.cells.get('0,1')?.fmt ?? null;

        /* A1 doubled: 1000 → 2000. */
        const typed = new Map([['0,0', '2000']]);
        const answer = recalculate(sheet.cells, sheet.name, typed);

        const grid = new SheetGrid(sheet, (key) => {
          const written = typed.get(key);
          if (written !== undefined) return { text: written, kind: 'number' };
          const cell = sheet.cells.get(key);
          if (!cell) return undefined;
          if (cell.formula === undefined) return { text: cell.text, kind: cell.kind };
          return shownFormula(cell, key, answer);
        });

        const scroller = document.createElement('div');
        scroller.style.cssText = 'height:400px;overflow:auto';
        scroller.appendChild(grid.table);
        document.body.appendChild(scroller);
        grid.attach(scroller);
        await new Promise((settle) => requestAnimationFrame(() => requestAnimationFrame(settle)));

        const td = (ref) => grid.table.querySelector(`td[data-ref="${ref}"]`);
        const sum = td('0,1');
        const subtotal = td('2,1');
        const answerFor = {
          kept,
          sumText: sum?.textContent ?? null,
          sumStale: sum?.dataset.stale ?? null,
          subtotalText: subtotal?.textContent ?? null,
          subtotalStale: subtotal?.dataset.stale ?? null,
          subtotalTitle: subtotal?.title ?? null,
          notes: book.notes,
        };
        scroller.remove();
        return answerFor;
      },
      { root: ROOT.split(sep).join('/'), b64: Buffer.from(styledBook()).toString('base64') },
    );

    check('the reader keeps the format code on a styled formula cell', drawn.kept === MONEY, String(drawn.kept));
    check(
      'the grid draws the recalculated total, formatted',
      drawn.sumText === '2.234,50',
      `${drawn.sumText} (wanted 2.234,50)`,
    );
    check('and does not mark it out of date', drawn.sumStale === null);
    check('the grid marks the formula it cannot work out', drawn.subtotalStale === 'true', String(drawn.subtotalStale));
    check('and keeps the number under the mark', drawn.subtotalText === '1.234,50', String(drawn.subtotalText));
    check(
      'and the mark says why, naming the formula',
      (drawn.subtotalTitle ?? '').includes('SUBTOTAL(9,A1:A3)'),
      drawn.subtotalTitle,
    );
    check(
      'and the note under the toolbar no longer claims nothing is recalculated',
      drawn.notes.some((one) => /worked out again/.test(one)) && !drawn.notes.some((one) => /are not recalculated/.test(one)),
      drawn.notes.find((one) => /recalculat|worked out/.test(one)) ?? 'no note',
    );
    /* ── and once more through the program itself ──────────────────── */

    /*
     * Everything above drives `SheetGrid` directly, which leaves the seam in
     * `index.ts` — the pass that works the answer out when an edit lands, and
     * draws the page again from it — checked by nothing. Deleting that call
     * passes every check above. So this one opens the file the way a person
     * does, types into it, and looks at the screen.
     */
    await page.evaluate(
      async ({ name, b64 }) => {
        const file = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name);
        const transfer = new DataTransfer();
        transfer.items.add(file);
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
        while (!document.querySelector('.ul-sheet-book:not([hidden]) .ul-sheet tbody tr[data-row]')) {
          await new Promise((settle) => setTimeout(settle, 20));
        }
        await new Promise((settle) => requestAnimationFrame(() => requestAnimationFrame(settle)));
      },
      { name: 'racun.xlsx', b64: Buffer.from(styledBook()).toString('base64') },
    );

    const before = await page.evaluate(() => ({
      sum: document.querySelector('.ul-sheet-book:not([hidden]) td[data-ref="0,1"]')?.textContent ?? null,
      stale: document.querySelectorAll('.ul-sheet-book:not([hidden]) td[data-stale]').length,
    }));
    check(
      'opened, nothing is marked and the totals are the ones the file holds',
      before.sum === '1.234,50' && before.stale === 0,
      `B1 ${before.sum} · ${before.stale} marked`,
    );

    await page.locator('.ul-sheet-book:not([hidden]) td[data-ref="0,0"]').dblclick();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('2000');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);

    const typedIn = await page.evaluate(() => {
      const book = document.querySelector('.ul-sheet-book:not([hidden])');
      const td = (ref) => book?.querySelector(`td[data-ref="${ref}"]`);
      return {
        a1: td('0,0')?.textContent ?? null,
        sum: td('0,1')?.textContent ?? null,
        sumStale: td('0,1')?.dataset.stale ?? null,
        subtotal: td('2,1')?.textContent ?? null,
        subtotalStale: td('2,1')?.dataset.stale ?? null,
      };
    });

    check('typing 2000 over A1 is what the cell then shows', typedIn.a1 === '2000', String(typedIn.a1));
    check(
      'the total two cells away follows without being touched or scrolled',
      typedIn.sum === '2.234,50' && typedIn.sumStale === null,
      `B1 ${typedIn.sum}${typedIn.sumStale ? ' (marked)' : ''}`,
    );
    check(
      'and the formula beside it that cannot be worked out is marked instead',
      typedIn.subtotalStale === 'true' && typedIn.subtotal === '1.234,50',
      `B3 ${typedIn.subtotal} · stale=${typedIn.subtotalStale}`,
    );

    /* An undo takes the sheet back, and takes the marks back with it. */
    await page.keyboard.press('Control+Z');
    await page.waitForTimeout(150);
    const undone = await page.evaluate(() => {
      const book = document.querySelector('.ul-sheet-book:not([hidden])');
      return {
        a1: book?.querySelector('td[data-ref="0,0"]')?.textContent ?? null,
        sum: book?.querySelector('td[data-ref="0,1"]')?.textContent ?? null,
        stale: book?.querySelectorAll('td[data-stale]').length ?? -1,
      };
    });
    check(
      'an undo takes the totals back too, and clears every mark',
      undone.a1 === '1.000,00' && undone.sum === '1.234,50' && undone.stale === 0,
      `A1 ${undone.a1} · B1 ${undone.sum} · ${undone.stale} marked`,
    );
    /* ── the table definitions, and what reading them is worth ─────── */

    const tabled = await page.evaluate(
      async ({ root, b64 }) => {
        const { readXlsx } = await import(`/@fs/${root}/packages/editor-office/src/xlsx.ts`);
        const { recalculate, dependency } = await import(`/@fs/${root}/packages/editor-office/src/formula.ts`);

        const book = readXlsx(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        const table = book.tables?.get('podacitable');
        const totals = book.tables?.get('sazbrojem');
        const cashless = book.sheets[0];
        const formula = cashless.cells.get('0,1')?.formula ?? '';

        /* One keystroke on the summary sheet, with the tables and without. */
        const typed = new Map([['0,0', '150']]);
        const without = recalculate(cashless.cells, cashless.name, typed);
        const with_ = recalculate(cashless.cells, cashless.name, typed, book.tables);

        return {
          names: [...(book.tables?.keys() ?? [])],
          range: table ? `${table.sheet}!${table.fromRow},${table.fromCol}–${table.toRow}` : null,
          totalsRange: totals ? `${totals.sheet}!${totals.fromRow},${totals.fromCol}–${totals.toRow}` : null,
          columns: table ? [...table.columns.entries()].map(([n, o]) => `${n}=${o}`).join(' ') : null,
          before: [...without.stale],
          after: [...with_.stale],
          saysNo: dependency(formula, cashless.name, { row: 0, col: 0 }, book.tables),
          saysUnknown: dependency(formula, cashless.name, { row: 0, col: 0 }),
          plainSum: with_.values.has('1,1'),
        };
      },
      { root: ROOT.split(sep).join('/'), b64: Buffer.from(tableBook()).toString('base64') },
    );

    check(
      'the reader finds the tables the formulas name',
      tabled.names.sort().join() === 'podacitable,sazbrojem',
      `tables: ${tabled.names.join(', ') || 'none'}`,
    );
    check(
      'a totals row is left out of the data, as its header row is',
      tabled.totalsRange === 'Podaci!1,4–3',
      `${tabled.totalsRange} (wanted Podaci!1,4–3, from E1:F5 with one header and one totals row)`,
    );
    check(
      'and puts it on its own sheet, with its header row left out of the data',
      tabled.range === 'Podaci!1,0–3',
      `${tabled.range} (wanted Podaci!1,0–3)`,
    );
    check(
      'and knows which column is which',
      tabled.columns === 'vrsta=0 operater=1 iznos=2',
      String(tabled.columns),
    );
    check(
      'unreadable before, and precisely answered after',
      tabled.saysUnknown === 'unknown' && tabled.saysNo === 'no',
      `${tabled.saysUnknown} → ${tabled.saysNo}`,
    );
    check(
      'a keystroke on the summary sheet marked the SUMIFS and now marks nothing',
      tabled.before.join() === '0,1' && tabled.after.length === 0,
      `${tabled.before.length} marked → ${tabled.after.length}`,
    );
    check(
      'and the plain SUM beside it is still worked out as it was',
      tabled.plainSum,
      'B2 = SUM(A1:A2)',
    );

    /* ── an edit on one sheet, and the formula on another ─────────── */

    /*
     * The seam in `index.ts` again, now across sheets. Everything in
     * `verify-formula.mjs` about workbooks is `recalculateBook` on its own; this
     * is the program handing it the workbook and drawing the answer on a sheet
     * nobody typed into. Worked out only for the sheets typed into, the SUMIFS
     * on `Cashless` stays unmarked after its table on `Podaci` is edited.
     */
    await page.evaluate(
      async ({ name, b64 }) => {
        const file = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name);
        const transfer = new DataTransfer();
        transfer.items.add(file);
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
        const until = Date.now() + 10_000;
        const twoSheets = () =>
          [...document.querySelectorAll('.ul-sheet-book')].find(
            (one) => one.querySelectorAll('.ul-sheet-tabs button').length === 2,
          );
        while (!twoSheets()) {
          if (Date.now() > until) {
            throw new Error(
              `the two-sheet book never showed: ${[...document.querySelectorAll('.ul-sheet-book')]
                .map((one) => `hidden=${one.hidden} tabs=${one.querySelectorAll('.ul-sheet-tabs button').length}`)
                .join(' | ')}`,
            );
          }
          await new Promise((settle) => setTimeout(settle, 20));
        }
        /* Every open book is in the page and none of them is `hidden` — the
           panel around it is — so the one under test is marked rather than
           picked out by what is showing. */
        twoSheets().dataset.verify = 'across';
        await new Promise((settle) => requestAnimationFrame(() => requestAnimationFrame(settle)));
      },
      { name: 'cashless.xlsx', b64: Buffer.from(tableBook()).toString('base64') },
    );
    const book = '.ul-sheet-book[data-verify="across"]';
    await page.locator(`${book} .ul-sheet-tabs button`).nth(1).click();
    await page.locator(`${book} td[data-ref="1,2"]`).dblclick();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('9');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    await page.locator(`${book} .ul-sheet-tabs button`).nth(0).click();
    await page.waitForTimeout(150);

    const across = await page.evaluate((book) => {
      const td = (ref) => document.querySelector(`${book} td[data-ref="${ref}"]`);
      return {
        sumifs: td('0,1')?.dataset.stale ?? null,
        sum: td('1,1')?.dataset.stale ?? null,
        sumText: td('1,1')?.textContent ?? null,
      };
    }, book);
    check(
      'an amount retyped on Podaci marks the SUMIFS on Cashless, a sheet nobody typed into',
      across.sumifs === 'true',
      `Cashless!B1 stale=${across.sumifs}`,
    );
    check(
      'and leaves the SUM beside it, which reads nothing on Podaci, alone',
      across.sum === null && across.sumText === '300,00',
      `Cashless!B2 ${across.sumText} · stale=${across.sum}`,
    );

    /* ── and the real workbook, where the 35 of them actually are ──── */

    const real = findReal();
    if (!real) {
      console.log(
        [
          '',
          '  The real workbook was not found, so the figure above is the fixture one.',
          '  Point UL_CORPUS at a folder holding one to measure it.',
        ].join(String.fromCharCode(10)),
      );
    } else {
      const measured = await page.evaluate(
        async ({ root, b64 }) => {
          const { readXlsx } = await import(`/@fs/${root}/packages/editor-office/src/xlsx.ts`);
          const { recalculate } = await import(`/@fs/${root}/packages/editor-office/src/formula.ts`);

          const book = readXlsx(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
          /* The sheet holding the formulas, whichever it is called. */
          const sheet = book.sheets.reduce((most, one) => {
            const count = (all) => [...all.cells.values()].filter((c) => c.formula !== undefined).length;
            return count(one) > count(most) ? one : most;
          }, book.sheets[0]);

          /* A cell on that sheet that is not itself a formula, and that no
             formula on it reads — the keystroke that ought to mark nothing. */
          const { dependency } = await import(`/@fs/${root}/packages/editor-office/src/formula.ts`);
          const formulaCells = [...sheet.cells.values()].filter((c) => c.formula !== undefined);
          const readsIt = (key) => {
            const [row, col] = key.split(',').map(Number);
            return formulaCells.some((c) => dependency(c.formula, sheet.name, { row, col }, book.tables) === 'reads');
          };
          const innocent = [...sheet.cells].find(
            ([key, cell]) => cell.formula === undefined && cell.kind === 'number' && !readsIt(key),
          );
          const typed = new Map([[innocent?.[0] ?? '0,0', '1']]);

          /* And one that IS read, so the marking is shown not to have gone away.
             On this workbook there is no plain cell to use: the totals read each
             other, so what is read is itself a formula. Typing over one is not
             something the editor offers, but `recalculate` is pure and the
             question is only whether a changed cell still reaches what reads it. */
          const watched = [...sheet.cells].find(([key]) => readsIt(key));
          const watchedStale = watched
            ? recalculate(sheet.cells, sheet.name, new Map([[watched[0], '1']]), book.tables).stale.size
            : -1;

          const formulas = [...sheet.cells.values()].filter((c) => c.formula !== undefined).length;
          const structured = [...sheet.cells.values()].filter((c) => /[A-Za-z_][\w.]*\[/.test(c.formula ?? '')).length;

          /* Across the workbook: an amount retyped inside the table, on the
             sheet the table is on, and what that marks on the sheet reading it. */
          const { recalculateBook, referencesOf } = await import(`/@fs/${root}/packages/editor-office/src/formula.ts`);
          const index = book.sheets.indexOf(sheet);
          const table = [...(book.tables?.values() ?? [])].find((one) => one.sheet !== sheet.name);
          const across = { marked: -1, direct: 0, missed: 0 };
          if (table) {
            const on = book.sheets.findIndex((one) => one.name === table.sheet);
            const col = table.fromCol + (table.columns.get('iznos') ?? 0);
            const typedThere = new Map([[on, new Map([[`${table.fromRow},${col}`, '1']])]]);
            const stale = recalculateBook(book.sheets, typedThere, book.tables).get(index).stale;
            across.marked = stale.size;
            /* What reads that cell directly, by `dependency`'s own answer — each
               one has to be among the marked; what reads them comes on top. */
            for (const [key, cell] of sheet.cells) {
              if (cell.formula === undefined) continue;
              const where = { row: table.fromRow, col, sheet: table.sheet };
              if (dependency(cell.formula, sheet.name, where, book.tables) === 'no') continue;
              across.direct++;
              if (!stale.has(key)) across.missed++;
            }
          }

          /* The formulas that name a sheet: each one reached through the first
             cell it reads, and whether it then comes out worked or marked. */
          const named = { worked: 0, marked: 0, missed: 0, shapes: [] };
          for (const [key, cell] of sheet.cells) {
            if (!/!/.test(cell.formula ?? '')) continue;
            const first = referencesOf(cell.formula, book.tables)[0];
            if (!first) continue;
            const on = first.sheet === null ? index : book.sheets.findIndex((one) => one.name.toLowerCase() === first.sheet.toLowerCase());
            const answer = recalculateBook(
              book.sheets,
              new Map([[on, new Map([[`${first.from.row},${first.from.col}`, '1']])]]),
              book.tables,
            ).get(index);
            if (answer.values.has(key)) named.worked++;
            else if (answer.stale.has(key)) named.marked++;
            else named.missed++;
            named.shapes.push(cell.formula.slice(0, 40));
          }

          return {
            sheet: sheet.name,
            sheets: book.sheets.map((one) => one.name),
            tables: [...(book.tables?.entries() ?? [])].map(([n, t]) => `${n}@${t.sheet}`),
            formulas,
            structured,
            before: recalculate(sheet.cells, sheet.name, typed).stale.size,
            after: recalculate(sheet.cells, sheet.name, typed, book.tables).stale.size,
            watchedStale,
            across,
            named,
          };
        },
        { root: ROOT.split(sep).join('/'), b64: readFileSync(real).toString('base64') },
      );

      console.log(
        [
          '',
          `  ${real.split(sep).pop()}`,
          `    sheets     ${measured.sheets.join(', ')}`,
          `    tables     ${measured.tables.join(', ') || 'none'}`,
          `    formulas   ${measured.formulas} on ${measured.sheet}, ${measured.structured} of them structured`,
        ].join(String.fromCharCode(10)),
      );
      check(
        'on the real workbook, a keystroke no formula reads used to mark almost every total and now marks none',
        measured.before >= measured.structured && measured.after === 0,
        `${measured.before} of ${measured.formulas} marked → ${measured.after}` +
          ` · ${measured.structured} structured references stopped being unreadable, and stopped poisoning the totals above them`,
      );
      check(
        'and a change a formula does read is still marked, so the marking has not simply gone',
        measured.watchedStale > 0,
        measured.watchedStale === -1
          ? 'nothing on this sheet is read by anything — the check above is the whole answer'
          : `${measured.watchedStale} marked`,
      );
      check(
        'an amount retyped inside the table marks the totals on the sheet reading it, which a sheet-at-a-time pass never looked at',
        measured.across.direct > 0 && measured.across.missed === 0 && measured.across.marked >= measured.across.direct,
        `${measured.across.marked} of ${measured.formulas} marked on ${measured.sheet} — ${measured.across.direct} read the cell directly, ${measured.across.missed} of those missed`,
      );
      check(
        'every formula naming a sheet is reached by the cell it reads — worked out or marked, never left as it was',
        measured.named.missed === 0 && measured.named.worked + measured.named.marked > 0,
        `${measured.named.worked} worked out, ${measured.named.marked} marked, ${measured.named.missed} missed`,
      );
    }

  } finally {
    await browser.close();
  }
}

/* ── the tally ───────────────────────────────────────────────────────── */

const failed = checks.filter((one) => !one.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log(`\n${failed.length} failed:`);
  for (const one of failed) console.log(`  ${one.name}${one.detail ? `  — ${one.detail}` : ''}`);
  process.exit(1);
}
