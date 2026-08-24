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

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { plainFormula, serialFromDate } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-office/src/odf.ts')).href
);
const { convertedName } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-office/src/xlsx-write.ts')).href
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

/* ── where a converted file goes ─────────────────────────────────────── */

check(
  'an .ods converts to an .xlsx of the same name',
  convertedName('prodaja.ods') === 'prodaja.xlsx',
  convertedName('prodaja.ods'),
);
check(
  'a spreadsheet template converts too',
  convertedName('predložak.ots') === 'predložak.xlsx',
  convertedName('predložak.ots'),
);
check(
  'and a name with a dot that is not an extension keeps every character',
  convertedName('popis.2026.tablica') === 'popis.2026.tablica.xlsx',
  convertedName('popis.2026.tablica'),
);

/* ── summary ─────────────────────────────────────────────────────────── */

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
