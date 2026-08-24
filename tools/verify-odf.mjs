/**
 * The two OpenDocument routines that go wrong quietly.
 *
 * Reading an `.odt` or an `.ods` needs a browser — both build their view
 * through `DOMParser` — so the readers themselves are checked in
 * `verify-ui.mjs`, against files this repository assembles by hand
 * (`makeOds`, `makeOdt` in fixtures.mjs). What is left here is the pair the
 * page cannot see into:
 *
 * - **The date.** ODF writes `2026-06-15`; a converted `.xlsx` needs the number
 *   Excel counts days with. One out and the invoice is simply dated yesterday —
 *   nothing looks broken, and the page can only tell that the cell says "date".
 * - **The formula.** `of:=SUM([.B2:.B3])` is put in front of a person when a
 *   cell refuses to open, and turning it into something readable is a chain of
 *   substitutions over somebody else's string.
 *
 *   node tools/verify-odf.mjs
 */

import { strFromU8, unzipSync } from 'fflate';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeOds } from './fixtures.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { plainFormula, serialFromDate } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-office/src/odf.ts')).href
);
const { convertedName } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-office/src/xlsx-write.ts')).href
);
const { applyOdsEdits, findOdsCells, writeOds } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-office/src/ods-edit.ts')).href
);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── dates ───────────────────────────────────────────────────────────── */

/*
 * The reference numbers are Excel's own, not ones worked out from the same
 * formula being tested. 25569 is the epoch every serialisation library agrees
 * on; 1 is the day Excel believes 1900 started with; 60 is the day that never
 * existed — 29 February 1900 — which is the whole reason the offset is 25569
 * and not 25568.
 */
check('1900-01-01 is day 1', serialFromDate('1900-01-01') === 1, String(serialFromDate('1900-01-01')));
check(
  'the leap day Excel invented keeps its place',
  serialFromDate('1900-03-01') === 61,
  String(serialFromDate('1900-03-01')),
);
check('the Unix epoch is day 25569', serialFromDate('1970-01-01') === 25569, String(serialFromDate('1970-01-01')));
check(
  'a date in the fixture lands where Excel puts it',
  serialFromDate('2026-06-15') === 46188,
  String(serialFromDate('2026-06-15')),
);
check(
  'a time of day is the fraction after the day',
  serialFromDate('2026-06-15T06:00:00') === 46188.25,
  String(serialFromDate('2026-06-15T06:00:00')),
);
check(
  'a date Excel cannot store is refused rather than moved a century',
  serialFromDate('1899-12-31') === null,
  String(serialFromDate('1899-12-31')),
);
check(
  'and something that is not a date is refused rather than guessed at',
  serialFromDate('') === null && serialFromDate('15.06.2026.') === null,
);

/* ── formulas ────────────────────────────────────────────────────────── */

check(
  'the formula language prefix and the brackets go',
  plainFormula('of:=SUM([.B2:.B3])') === 'SUM(B2:B3)',
  plainFormula('of:=SUM([.B2:.B3])'),
);
check(
  'a reference to another sheet keeps the sheet',
  plainFormula('of:=[$Prodaja.A1]+1') === 'Prodaja!A1+1',
  plainFormula('of:=[$Prodaja.A1]+1'),
);
check(
  'a range across sheets keeps both halves',
  plainFormula('of:=SUM([$Prodaja.B2:.B3])') === 'SUM(Prodaja!B2:B3)',
  plainFormula('of:=SUM([$Prodaja.B2:.B3])'),
);
check(
  'absolute references lose only their dollars',
  plainFormula('of:=[.$B$2]') === 'B2',
  plainFormula('of:=[.$B$2]'),
);
check(
  'arguments are separated the way a spreadsheet elsewhere expects',
  plainFormula('of:=IF([.A1]>0;[.B1];0)') === 'IF(A1>0,B1,0)',
  plainFormula('of:=IF([.A1]>0;[.B1];0)'),
);
check(
  'an older writer names its language differently and is still handled',
  plainFormula('oooc:=SUM([.A1:.A2])') === 'SUM(A1:A2)',
  plainFormula('oooc:=SUM([.A1:.A2])'),
);

check(
  'a name with a dot that is not an extension keeps every character',
  convertedName('popis.2026.tablica') === 'popis.2026.tablica.xlsx',
  convertedName('popis.2026.tablica'),
);

/* ── editing the cells ───────────────────────────────────────────────── */

/*
 * This half needs no browser at all: the writer works on the text of
 * `content.xml`, not on a parsed tree, which is the whole point of editing by
 * byte range. So the file the reader is checked against in the page can be run
 * through the writer here, and the result read back character by character.
 */
const content = strFromU8(unzipSync(makeOds())['content.xml']);
const tables = findOdsCells(content);

check(
  'both sheets are found, in order',
  tables.length === 2 && tables[0].name === 'Prodaja' && tables[1].name === 'Biljeske',
  tables.map((t) => t.name).join(', '),
);

const sales = tables[0];
check(
  'the row that repeats a million times is one element, and says so',
  sales.rows.length === 6 && sales.rows[5].repeat === 1048570,
  `${sales.rows.length} rows, last repeats ${sales.rows[5]?.repeat}`,
);
check(
  'the empty tail of a row is one cell standing for a thousand',
  sales.rows[0].cells.length === 4 && sales.rows[0].cells[3].repeat === 1021,
  `${sales.rows[0].cells.length} cells, last repeats ${sales.rows[0].cells[3]?.repeat}`,
);
check(
  'a formula cell is marked as one',
  sales.rows[3].cells[1].formula === true,
);

/* An ordinary cell: the amount in B2. */
const retyped = applyOdsEdits(content, [{ sheet: 0, row: 1, col: 1, value: '2000' }]);
check(
  'a retyped amount lands as a number, not as text',
  retyped.includes('office:value-type="float" office:value="2000"'),
);
check(
  'and keeps the style that decides how it is drawn',
  /table:style-name="ce1"[^>]*office:value="2000"/.test(retyped),
);
check(
  'the cell beside it is not touched',
  retyped.includes('<text:p>Siječanj</text:p>'),
);
check(
  'and neither is the other sheet',
  retyped.includes('<text:p>uniqueods</text:p>'),
);

/*
 * The heart of it: a value written into a cell that is one of a thousand
 * identical empty ones. The group has to split, and the counts either side have
 * to add up to what it stood for before — 1021, now 2 + the cell + 1018.
 */
const inRepeat = applyOdsEdits(content, [{ sheet: 0, row: 0, col: 5, value: 'Napomena' }]);
const firstRow = inRepeat.slice(
  inRepeat.indexOf('<table:table-row>'),
  inRepeat.indexOf('</table:table-row>'),
);
const repeats = [...firstRow.matchAll(/table:number-columns-repeated="(\d+)"/g)].map((m) =>
  Number(m[1]),
);
check(
  'a value inside a repeated group splits it',
  firstRow.includes('<text:p>Napomena</text:p>'),
);
check(
  'and the counts either side still add up to what it stood for',
  repeats.length === 2 && repeats[0] === 2 && repeats[1] === 1018,
  JSON.stringify(repeats),
);

/* A row that repeats: the same problem one dimension up. */
const inRepeatedRow = applyOdsEdits(content, [{ sheet: 0, row: 100, col: 0, value: 'kasnije' }]);
const rowRepeats = [...inRepeatedRow.matchAll(/table:number-rows-repeated="(\d+)"/g)].map((m) =>
  Number(m[1]),
);
check(
  'a value in a repeated row splits the row too',
  inRepeatedRow.includes('<text:p>kasnije</text:p>'),
);
check(
  'and the rows either side account for every one of them',
  // The sheet's own tail (1048570) split at row 100, which is 95 rows in, plus
  // the untouched tail of the second sheet.
  rowRepeats.includes(95) && rowRepeats.includes(1048474),
  JSON.stringify(rowRepeats),
);

/* A date typed the way a person writes one. */
const dated = applyOdsEdits(content, [{ sheet: 0, row: 2, col: 2, value: '15.6.2026.' }]);
check(
  'a date typed as a date is stored as one — no serial, no epoch bug',
  dated.includes('office:value-type="date" office:date-value="2026-06-15"'),
);

/* A formula cell must come back untouched. */
const refused = applyOdsEdits(content, [{ sheet: 0, row: 3, col: 1, value: '999' }]);
check(
  'a formula cell is refused, not overwritten',
  refused === content,
  refused === content ? '' : 'the content changed',
);

/* Two edits in the same repeated group — the case a single pass gets wrong. */
const twice = applyOdsEdits(content, [
  { sheet: 0, row: 0, col: 5, value: 'prva' },
  { sheet: 0, row: 0, col: 7, value: 'druga' },
]);
check(
  'two values in the same repeated group both land',
  twice.includes('<text:p>prva</text:p>') && twice.includes('<text:p>druga</text:p>'),
);
const twiceRow = twice.slice(twice.indexOf('<table:table-row>'), twice.indexOf('</table:table-row>'));
const twiceRepeats = [...twiceRow.matchAll(/table:number-columns-repeated="(\d+)"/g)].map((m) =>
  Number(m[1]),
);
check(
  'and the row still stands for exactly as many columns as before',
  twiceRepeats.reduce((sum, n) => sum + n, 0) + (twiceRow.match(/<table:table-cell/g).length - twiceRepeats.length) === 1024,
  `${JSON.stringify(twiceRepeats)} + singles`,
);

/* ── the archive that comes back ─────────────────────────────────────── */

const archive = unzipSync(makeOds());
const saved = writeOds(archive, retyped);
const reopened = unzipSync(saved);

check(
  'the saved file still declares what it is in its first bytes',
  new TextDecoder().decode(saved.subarray(0, 128)).includes(
    'mimetypeapplication/vnd.oasis.opendocument.spreadsheet',
  ),
);
check(
  'every other part of the archive comes through byte for byte',
  Object.keys(archive)
    .filter((path) => path !== 'content.xml')
    .every(
      (path) =>
        reopened[path] &&
        reopened[path].length === archive[path].length &&
        reopened[path].every((byte, i) => byte === archive[path][i]),
    ),
  Object.keys(archive).join(', '),
);
check(
  'and the edited part is the one that changed',
  strFromU8(reopened['content.xml']).includes('office:value="2000"'),
);

/* ── summary ─────────────────────────────────────────────────────────── */

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
