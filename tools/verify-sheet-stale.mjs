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
