/**
 * Checking that editing a spreadsheet touches **only what the user touched**.
 *
 * The same discipline as `verify-docx-edit.mjs`: the central check is not that
 * a value changed but that **everything else stayed the same** — every other
 * archive part byte for byte, and inside the sheet every character outside the
 * rebuilt elements. On top of that, what a spreadsheet adds of its own: a
 * formula must be refused, and a workbook holding formulas must come out
 * marked for a full recalculation, or Excel would show yesterday's totals over
 * today's numbers.
 *
 *   node tools/verify-xlsx-edit.mjs
 */

import { unzipSync, strFromU8 } from 'fflate';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeXlsx } from './fixtures.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { findCells, applyCellEdits, cellXml, markRecalc, parseCellRef, typedKind, writeXlsx } =
  await import(pathToFileURL(resolve(ROOT, 'packages/editor-office/src/xlsx-edit.ts')).href);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── reading the shape ───────────────────────────────────────────────── */

const original = makeXlsx();
const archive = unzipSync(original);
const xml = strFromU8(archive['xl/worksheets/sheet1.xml']);

const spans = findCells(xml);
check('the rows were found', spans.rows.length === 5, `${spans.rows.length}`);
check(
  'and the cells with them',
  spans.rows.reduce((n, row) => n + row.cells.length, 0) === 11,
  `${spans.rows.reduce((n, row) => n + row.cells.length, 0)}`,
);

const b4 = spans.rows.find((r) => r.r === 4)?.cells.find((c) => c.ref === 'B4');
check('the formula cell knows it holds a formula', b4?.formula === true);

const b2 = spans.rows.find((r) => r.r === 2)?.cells.find((c) => c.ref === 'B2');
check('the style index was read off the cell', b2?.style === '2', b2?.style ?? 'missing');

check(
  'a reference reads as a position',
  JSON.stringify(parseCellRef('AB12')) === '{"row":11,"col":27}',
  JSON.stringify(parseCellRef('AB12')),
);

/* ── what a typed value becomes ──────────────────────────────────────── */

check('a number stays a number', cellXml('B2', '2', '2000') === '<c r="B2" s="2"><v>2000</v></c>');
check(
  'a Croatian decimal comma becomes the decimal point',
  cellXml('B2', null, '12,5') === '<c r="B2"><v>12.5</v></c>',
  cellXml('B2', null, '12,5'),
);
check(
  'a date typed as a person writes one becomes a serial',
  cellXml('C2', '1', '15.6.2026.') === '<c r="C2" s="1"><v>46188</v></c>',
  cellXml('C2', '1', '15.6.2026.'),
);
check(
  'text becomes an inline string, not a shared one',
  cellXml('A2', null, 'Siječanj') ===
    '<c r="A2" t="inlineStr"><is><t xml:space="preserve">Siječanj</t></is></c>',
  cellXml('A2', null, 'Siječanj'),
);
check(
  'markup in a value is escaped, not interpreted',
  cellXml('A1', null, 'a < b & c').includes('a &lt; b &amp; c'),
  cellXml('A1', null, 'a < b & c'),
);
check('an emptied cell keeps its place and its style', cellXml('A3', '1', '') === '<c r="A3" s="1"/>');
check(
  'the kind the grid shows matches the decision',
  typedKind('2000') === 'number' && typedKind('15.6.2026.') === 'date' && typedKind('riječi') === 'text',
);

/* ── the surgical write ──────────────────────────────────────────────── */

{
  const edited = applyCellEdits(xml, spans, [{ ref: 'B2', value: '2000' }]);
  const cell = spans.rows.find((r) => r.r === 2).cells.find((c) => c.ref === 'B2');
  check(
    'everything before the edited cell is byte-identical',
    edited.startsWith(xml.slice(0, cell.start)),
  );
  check('and everything after it', edited.endsWith(xml.slice(cell.end)));
  check('the new value is in place', edited.includes('<c r="B2" s="2"><v>2000</v></c>'));
}

{
  const edited = applyCellEdits(xml, spans, [{ ref: 'B4', value: '9999' }]);
  check('a formula cell passes through unchanged', edited === xml);
}

{
  /* A cell the file does not have: D2 goes to the end of its row, A6 into a row
     of its own before `</sheetData>` — the order Excel silently relies on. */
  const edited = applyCellEdits(xml, spans, [
    { ref: 'D2', value: 'novo' },
    { ref: 'A6', value: '7' },
  ]);
  check(
    'a new cell lands at the end of its row',
    />(?:<c r="C2"[^>]*><v>45000<\/v><\/c>)<c r="D2"/.test(edited.replace(/\n/g, '')) ||
      edited.includes('<v>45000</v></c><c r="D2" t="inlineStr">'),
    edited.slice(edited.indexOf('C2'), edited.indexOf('C2') + 120),
  );
  check(
    'a new row lands before the end of the data',
    edited.includes('</row><row r="6"><c r="A6"><v>7</v></c></row></sheetData>'),
  );
  check('clearing a cell that does not exist changes nothing', applyCellEdits(xml, spans, [{ ref: 'F9', value: '' }]) === xml);
}

/* ── the recalculation mark ──────────────────────────────────────────── */

{
  const plain = '<workbook><sheets/></workbook>';
  check(
    'a workbook without calcPr gains one',
    markRecalc(plain) === '<workbook><sheets/><calcPr fullCalcOnLoad="1"/></workbook>',
  );
  const existing = '<workbook><calcPr calcId="1"/></workbook>';
  check(
    'an existing calcPr gains only the attribute',
    markRecalc(existing) === '<workbook><calcPr fullCalcOnLoad="1" calcId="1"/></workbook>',
    markRecalc(existing),
  );
  check('a marked workbook is left alone', markRecalc(markRecalc(plain)) === markRecalc(plain));
}

/* ── the archive as a whole ──────────────────────────────────────────── */

{
  const edited = applyCellEdits(xml, spans, [{ ref: 'B2', value: '2000' }]);
  const bytes = writeXlsx(archive, new Map([['xl/worksheets/sheet1.xml', edited]]));
  const reopened = unzipSync(bytes);

  const untouched = Object.keys(archive).filter(
    (path) => path !== 'xl/worksheets/sheet1.xml' && path !== 'xl/workbook.xml',
  );
  check(
    'every untouched part passes through byte for byte',
    untouched.every((path) => {
      const a = archive[path];
      const b = reopened[path];
      return b && a.length === b.length && a.every((byte, i) => byte === b[i]);
    }),
    `${untouched.length} parts`,
  );
  check(
    'the workbook holds formulas, so it comes out marked for recalculation',
    strFromU8(reopened['xl/workbook.xml']).includes('fullCalcOnLoad="1"'),
  );
  check(
    'the edited sheet carries the edit',
    strFromU8(reopened['xl/worksheets/sheet1.xml']).includes('<c r="B2" s="2"><v>2000</v></c>'),
  );

  /* The second sheet has no formulas of its own — but the workbook does, and
     the mark is about the workbook. Editing only sheet2 must mark it too. */
  const sheet2 = strFromU8(archive['xl/worksheets/sheet2.xml']);
  const spans2 = findCells(sheet2);
  const bytes2 = writeXlsx(
    archive,
    new Map([['xl/worksheets/sheet2.xml', applyCellEdits(sheet2, spans2, [{ ref: 'A1', value: 'x' }])]]),
  );
  check(
    'editing a formula-free sheet of a formula-bearing workbook still marks it',
    strFromU8(unzipSync(bytes2)['xl/workbook.xml']).includes('fullCalcOnLoad="1"'),
  );
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
