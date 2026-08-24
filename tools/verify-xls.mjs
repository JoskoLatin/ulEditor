/**
 * The old binary Excel reader, checked against a file built byte by byte.
 *
 * The fixture is assembled by hand (see `makeXls` in fixtures.mjs), so every
 * assertion here reads back something that was deliberately put in: the shared
 * strings — one of them cut in half by a CONTINUE record, which is the split
 * that garbles real workbooks — the number under its format, the date packed
 * as an RK integer, the merge, and the two honest refusals: a BIFF5 file and
 * a compound file with no workbook in it.
 *
 *   node tools/verify-xls.mjs
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeXls } from './fixtures.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { readXls } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-office/src/xls.ts')).href
);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── the whole file, read back ───────────────────────────────────────── */

const workbook = readXls(makeXls());
const sheet = workbook.sheets[0];

check('the sheet is found under its name', sheet?.name === 'List1', sheet?.name);
check('the workbook admits it is read-only', typeof workbook.readonly === 'string');
check('and carries no archive to write back', workbook.archive === undefined);

const text = (row, col) => sheet.cells.get(`${row},${col}`)?.text;
const kind = (row, col) => sheet.cells.get(`${row},${col}`)?.kind;

check('a compressed shared string arrives', text(0, 0) === 'Mjesec', text(0, 0));
check('a wide one keeps its diacritics', text(1, 0) === 'Siječanj', text(1, 0));
check(
  'the amount is drawn under its number format',
  text(1, 1) === '1.234,50' && kind(1, 1) === 'number',
  `${text(1, 1)} (${kind(1, 1)})`,
);
check(
  'an RK integer under a date format is a date',
  text(1, 2) === '15.06.2026.' && kind(1, 2) === 'date',
  `${text(1, 2)} (${kind(1, 2)})`,
);
check('the merge is carried over', JSON.stringify(sheet.merges[0]) === '{"row":2,"col":0,"rows":1,"cols":2}', JSON.stringify(sheet.merges[0]));

/* ── the split string ────────────────────────────────────────────────── */

/* A shared string cut mid-word by a CONTINUE record, resuming under its own
   flags byte. Reading the table as one flat buffer garbles exactly this. */
const split = readXls(makeXls({ splitSst: true }));
const splitSheet = split.sheets[0];
check(
  'a string cut in half by a CONTINUE comes back whole',
  splitSheet.cells.get('1,0')?.text === 'Siječanj',
  splitSheet.cells.get('1,0')?.text,
);
check(
  'and the string after the cut is not shifted',
  splitSheet.cells.get('3,0')?.text === 'uniquexls',
  splitSheet.cells.get('3,0')?.text,
);

/* ── the refusals ────────────────────────────────────────────────────── */

{
  let message = '';
  try {
    readXls(makeXls({ biff5: true }));
  } catch (err) {
    message = err.message;
  }
  check('a BIFF5 file is refused with directions', /Excel 5\.0\/95/.test(message), message);
}

{
  let message = '';
  try {
    readXls(new Uint8Array(600));
  } catch (err) {
    message = err.message;
  }
  check('a file with no workbook stream says so', message.length > 0, message);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
