/**
 * What a formula reads, and what it comes to — and what it refuses.
 *
 * The refusals are the half worth checking hardest. A wrong sum is a wrong
 * number on a screen; a formula wrongly reported as *not* reading the cell
 * somebody just changed leaves a total sitting there looking current when it is
 * not, which is the failure this whole piece of work exists to stop.
 *
 * So `dependency` answers three ways, and the third is `'unknown'` — and every
 * check below that expects `'unknown'` is checking that this module admits what
 * it cannot read rather than guessing `'no'`.
 *
 * Given a folder it also runs `evaluate` over **every formula in real
 * spreadsheets** and reports what it could and could not work out. That number
 * is not a pass mark: it is the census again, measured through the thing the
 * census was taken for.
 *
 *   node tools/verify-formula.mjs
 *   node tools/verify-formula.mjs "C:/Users/you/Documents"
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { unzipSync, strFromU8 } from 'fflate';

import './ts-resolve.mjs';
import { EXCEL_ANSWERS, EXCEL_DATA } from './formula-excel-cases.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { referencesOf, dependency, evaluate, parseA1, recalculate, recalculateBook } = await import(
  pathToFileURL(join(ROOT, 'packages/editor-office/src/formula.ts')).href
);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── what it reads ───────────────────────────────────────────────────── */

const refs = (formula, tables) =>
  referencesOf(formula, tables)
    .map((one) => `${one.sheet ?? ''}${one.sheet ? '!' : ''}${one.from.row},${one.from.col}:${one.to.row},${one.to.col}`)
    .join(' ');

check('A1 is row 0, column 0', JSON.stringify(parseA1('A1')) === JSON.stringify({ row: 0, col: 0 }));
check('AA10 counts past Z', JSON.stringify(parseA1('AA10')) === JSON.stringify({ row: 9, col: 26 }));
check('a dollar holds a place, it is not part of the name', JSON.stringify(parseA1('$B$3')) === JSON.stringify({ row: 2, col: 1 }));

check('a range is one rectangle', refs('SUM(B2:B9)') === '1,1:8,1', refs('SUM(B2:B9)'));
check('a range written backwards is the same rectangle', refs('SUM(B9:B2)') === '1,1:8,1', refs('SUM(B9:B2)'));
check('two cells are two references', refs('A1+B1') === '0,0:0,0 0,1:0,1', refs('A1+B1'));
check('a sheet name is kept, not followed', refs("'Drugi list'!A1") === 'Drugi list!0,0:0,0', refs("'Drugi list'!A1"));
/*
 * Whole columns and rows. `Podaci!M:M` is in the measured corpus — a
 * `COUNTA(UNIQUE(FILTER(Podaci!M:M, Podaci!C:C=5, "")))` on `Cashless` — and
 * nothing in it looks like `A1`, so it used to be read as reading nothing: an
 * edit anywhere in column M answered `'no'`.
 */
check('a whole column is every row of it', refs('SUM($B:$C)') === '0,1:1048575,2', refs('SUM($B:$C)'));
check('a whole row is every column of it', refs('SUM(2:4)') === '1,0:3,16383', refs('SUM(2:4)'));
check(
  'a whole column on another sheet keeps its sheet',
  refs('COUNTA(FILTER(Podaci!M:M,Podaci!C:C=5,""))') === 'Podaci!0,12:1048575,12 Podaci!0,2:1048575,2',
  refs('COUNTA(FILTER(Podaci!M:M,Podaci!C:C=5,""))'),
);
check('and an ordinary range is not also read as columns', refs('SUM(A1:B2)') === '0,0:1,1', refs('SUM(A1:B2)'));
check(
  'a column reference is read where it is, so an edit deep in it reaches the formula',
  dependency('SUM(A:A)', 'List1', { row: 90_000, col: 0 }) === 'reads' &&
    dependency('COUNTA(Podaci!M:M)', 'Cashless', { row: 5_000, col: 12, sheet: 'Podaci' }) === 'reads',
);
check(
  'but working it out is still refused — a column is a million cells, not a SUM to guess at',
  evaluate('SUM(A:A)', () => 1) === null,
);
check(
  'a reference inside a string is a word, not a reference',
  refs('IF(A1="B2",1,0)') === '0,0:0,0',
  refs('IF(A1="B2",1,0)'),
);

/* ── what reads what ─────────────────────────────────────────────────── */

const at = (row, col) => ({ row, col });

check("a total reads the column it totals", dependency('SUM(B2:B9)', 'List1', at(4, 1)) === 'reads');
check('and not the column beside it', dependency('SUM(B2:B9)', 'List1', at(4, 2)) === 'no');
check('nor the row below the range', dependency('SUM(B2:B9)', 'List1', at(9, 1)) === 'no');
check(
  "another sheet's cell is not this sheet's",
  dependency("SUM('Drugi list'!B2:B9)", 'List1', at(4, 1)) === 'no',
);
check(
  '…unless the name is this sheet, however it is spelled',
  dependency("SUM('list1'!B2:B9)", 'List1', at(4, 1)) === 'reads',
);

/*
 * The three that must answer `unknown`. Each is a real shape out of the census:
 * a structured table reference (35 of 372 formulas), a formula already carrying
 * an error, and a name this module has no way to resolve.
 */
check(
  'a structured table reference is admitted as unreadable',
  dependency('SUMIFS(PodaciTable[Iznos],PodaciTable[Vrsta],5)', 'List1', at(4, 1)) === 'unknown',
);
check(
  'a formula already broken is unreadable, not unrelated',
  dependency('SUM(#REF!)', 'List1', at(4, 1)) === 'unknown',
);
/*
 * Four shapes that used to answer `'no'` — a stale total left unmarked — all
 * found by review rather than by the corpus, which has none of them.
 */
check(
  'a defined name is admitted as unreadable, not read as reading nothing',
  dependency('SUM(Iznosi)', 'List1', at(4, 1)) === 'unknown' &&
    dependency('SUM(A1:A3,Iznosi)', 'List1', at(25, 25)) === 'unknown',
);
check(
  'a reference written in lower case is a reference',
  dependency('sum(a1:a5)', 'List1', at(2, 0)) === 'reads' && refs('sum(a1:a5)') === '0,0:4,0',
  refs('sum(a1:a5)'),
);
check(
  'but a name that merely ends like a cell is not one',
  refs('SUM(Range1)') === '' && dependency('SUM(Range1)', 'List1', at(0, 4)) === 'unknown',
  refs('SUM(Range1)') || 'no references',
);
check(
  'a function that reads cells its text does not name is unreadable',
  ['SUM(OFFSET(A1,1,0,3,1))', 'SUM(INDIRECT("B"&C1))', 'SUM(_xlfn.ANCHORARRAY(A1))', 'SUM(A1#)'].every(
    (formula) => dependency(formula, 'List1', at(4, 1)) === 'unknown',
  ),
);
check(
  'a sheet named in a way this does not read is not taken for this sheet',
  dependency(`SUM('${'1'.repeat(69)}'!A1:A3)`, 'List1', at(0, 0)) === 'unknown' &&
    dependency('SUM(2024!A1:A3)', 'List1', at(0, 0)) === 'unknown',
);
check(
  'a reference into another workbook is unreadable, not read as this one’s sheet of the same name',
  dependency('SUM([1]Podaci!A1:A3)', 'List1', { row: 0, col: 0, sheet: 'Podaci' }) === 'unknown',
);
check(
  'this row of a table, with no table named, is unreadable',
  dependency('[@Iznos]*2', 'List1', at(0, 0)) === 'unknown',
);
check(
  'the … the reader writes for a formula it could not recover is unreadable',
  dependency('…', 'List1', at(0, 0)) === 'unknown',
);
check(
  'and what is understood is still read precisely — functions, numbers, truth values',
  dependency('IF(A1>1E3,SUM(B1:B3)*0.5,TRUE)', 'List1', at(9, 9)) === 'no' &&
    dependency('_xlfn.XLOOKUP(A1,B1:B3,C1:C3)', 'List1', at(9, 9)) === 'no',
);

{
  /* Scanned from every letter to the end, one long word cost 100 ms a call at
     Excel's limit of 8 192 characters, and a formula past it is not Excel's. */
  const word = 'a'.repeat(8_000);
  const started = performance.now();
  const answer = dependency(`SUM(${word})`, 'List1', at(0, 0));
  const long = performance.now() - started;
  const huge = performance.now();
  const hugeAnswer = dependency(`SUM(A1)+${'a'.repeat(1_000_000)}`, 'List1', at(0, 0));
  const hugeMs = performance.now() - huge;
  check(
    'a formula of one long word is read in a few milliseconds, not a tenth of a second',
    answer === 'unknown' && long < 10,
    `${long.toFixed(1)} ms`,
  );
  check(
    'and one past Excel’s own limit is unreadable without being read',
    hugeAnswer === 'unknown' && hugeMs < 5,
    `${hugeMs.toFixed(2)} ms`,
  );
}
check(
  'a table reference is unknown even when a plain range beside it misses',
  dependency('SUM(Z100:Z200)+SUM(Tablica1[Iznos])', 'List1', at(4, 1)) === 'unknown',
);

/* ── what it comes to ────────────────────────────────────────────────── */

/** A little sheet: B2..B5 hold 1,2,3,4; C2 holds a word; D2 is not there at all. */
const sheet = new Map([
  ['1,1', 1],
  ['2,1', 2],
  ['3,1', 3],
  ['4,1', 4],
  ['1,2', 'nema'],
]);
const valueAt = (row, col) => (sheet.has(`${row},${col}`) ? sheet.get(`${row},${col}`) : undefined);
const got = (formula) => evaluate(formula, valueAt);

check('a sum over a range', got('SUM(B2:B5)') === 10, String(got('SUM(B2:B5)')));
check('a sum over arguments', got('SUM(B2,B3,10)') === 13, String(got('SUM(B2,B3,10)')));
check('a sum passes over text and empty cells', got('SUM(B2:D5)') === 10, String(got('SUM(B2:D5)')));
check(
  'a date or an error inside a SUM refuses it rather than being passed over',
  evaluate('SUM(A1:A3)', (row) => (row === 1 ? null : 1)) === null,
);
check('arithmetic', got('B2+B3*2') === 5, String(got('B2+B3*2')));
check('brackets change the order', got('(B2+B3)*2') === 6, String(got('(B2+B3)*2')));
check('a minus in front', got('-B3+10') === 8, String(got('-B3+10')));
check('an empty cell is zero in arithmetic', got('B2+D9') === 1, String(got('B2+D9')));
check('a word in arithmetic is refused, not counted as nothing', got('C2*2') === null, String(got('C2*2')));
check('dividing by zero is refused rather than shown', got('B2/0') === null, String(got('B2/0')));
check('a whole range in arithmetic is refused', got('B2:B5+1') === null, String(got('B2:B5+1')));
check('a function nobody measured is refused', got('AVERAGE(B2:B5)') === null, String(got('AVERAGE(B2:B5)')));
check('a structured reference is refused', got('SUM(Tablica1[Iznos])') === null);
check("another sheet's cells are refused", got("SUM('Drugi'!B2:B5)") === null);
check('a total of nothing is nothing, not a refusal', got('SUM(Z1:Z9)') === 0, String(got('SUM(Z1:Z9)')));
check('rubbish is refused', got('SUM(B2:B5') === null && got('') === null && got('B2 B3') === null);

/* ── what changed because somebody typed ─────────────────────────────── */

/**
 * A price list, as the file holds it.
 *
 *        A          B            C
 *  1   Artikl     Količina     (nothing)
 *  2   Šećer      2
 *  3   Čaj        3
 *  4   Ukupno     =SUM(B2:B3)  → 5
 *  5   PDV        =B4*0.25     → 1.25
 *  6   Sve        =B4+B5       → 6.25
 *  7   Drugdje    =SUMIFS(Tablica1[Iznos],…)  → 99
 *  8   Sa strane  =SUM(D2:D3)  → 0
 */
const held = new Map([
  ['0,0', { text: 'Artikl', kind: 'text' }],
  ['0,1', { text: 'Količina', kind: 'text' }],
  ['1,0', { text: 'Šećer', kind: 'text' }],
  ['1,1', { text: '2', kind: 'number' }],
  ['2,0', { text: 'Čaj', kind: 'text' }],
  ['2,1', { text: '3', kind: 'number' }],
  ['3,0', { text: 'Ukupno', kind: 'text' }],
  ['3,1', { text: '5', kind: 'number', formula: 'SUM(B2:B3)' }],
  ['4,1', { text: '1.25', kind: 'number', formula: 'B4*0.25' }],
  ['5,1', { text: '6.25', kind: 'number', formula: 'B4+B5' }],
  ['6,1', { text: '99', kind: 'number', formula: 'SUMIFS(Tablica1[Iznos],Tablica1[Vrsta],5)' }],
  ['7,1', { text: '0', kind: 'number', formula: 'SUM(D2:D3)' }],
]);

const after = (typed) => recalculate(held, 'List1', new Map(Object.entries(typed)));

{
  const out = after({ '1,1': '10' });
  check('the total is worked out afresh', out.values.get('3,1') === 13, String(out.values.get('3,1')));
  check('and so is the total that reads it', out.values.get('4,1') === 3.25, String(out.values.get('4,1')));
  check('and the one that reads both', out.values.get('5,1') === 16.25, String(out.values.get('5,1')));
  check(
    'a formula reaching a column nobody touched is left alone',
    !out.values.has('7,1') && !out.stale.has('7,1'),
  );
  check(
    'a formula this cannot read is stale rather than quietly wrong',
    out.stale.has('6,1'),
    [...out.stale].join(' '),
  );
}

{
  /* A word typed where a number stood LOWERS the total rather than breaking
     it, because SUM passes over text — which is Excel's own answer, and the
     reason a total under a column of headings works at all. */
  const out = after({ '1,1': 'nema' });
  check('a word typed into a summed column lowers the total', out.values.get('3,1') === 3, String(out.values.get('3,1')));
  check('and what reads that total follows it down', out.values.get('4,1') === 0.75, String(out.values.get('4,1')));

  /* Arithmetic is the other rule: `=B4*0.25` over a word is #VALUE! in Excel,
     so a word typed into a cell read that way is stale rather than counted. */
  const arithmetic = new Map([
    ['0,1', { text: '4', kind: 'number' }],
    ['1,1', { text: '1', kind: 'number', formula: 'B1*0.25' }],
    ['2,1', { text: '1', kind: 'number', formula: 'B2+1' }],
  ]);
  const word = recalculate(arithmetic, 'List1', new Map([['0,1', 'nema']]));
  check('a word read by arithmetic is stale, not zero', word.stale.has('1,1') && !word.values.has('1,1'));
  check('and what reads that is stale too', word.stale.has('2,1'), [...word.stale].join(' '));
}

{
  /* The same sheet without the one formula this cannot read. */
  const plain = new Map([...held].filter(([at]) => at !== '6,1'));
  const out = recalculate(plain, 'List1', new Map([['0,0', 'Roba']]));
  check(
    'typing in a cell no formula reads changes nothing',
    out.values.size === 0 && out.stale.size === 0,
    `${out.values.size} worked out, ${out.stale.size} stale`,
  );
}

{
  /*
   * And the cost of being honest, named rather than hidden: a formula this
   * cannot read goes stale on ANY edit to the sheet, because there is no way
   * to tell whether it read that cell. In the one real workbook that has them
   * there are 35, so one keystroke marks all 35. The alternative is showing a
   * number that may be wrong, and between annoying and wrong this picks
   * annoying — but it is a cost, and the way out is resolving the table ranges
   * out of `xl/tables/*.xml`, not a rule guessed here.
   */
  const out = after({ '0,0': 'Roba' });
  check(
    'a formula this cannot read goes stale on any edit at all',
    out.stale.has('6,1') && out.stale.size === 1,
    [...out.stale].join(' '),
  );
}

{
  /*
   * A summary at the TOP, with its data below it — which is how a great many
   * sheets are laid out, and the case one pass in document order cannot settle:
   * B1 reads B2, and B2 is only worked out after B1 has already been looked at.
   */
  const summary = new Map([
    ['0,1', { text: '5', kind: 'number', formula: 'B2*2' }],
    ['1,1', { text: '5', kind: 'number', formula: 'SUM(B3:B4)' }],
    ['2,1', { text: '2', kind: 'number' }],
    ['3,1', { text: '3', kind: 'number' }],
  ]);
  const out = recalculate(summary, 'List1', new Map([['2,1', '10']]));
  check('a total below its own summary still reaches it', out.values.get('1,1') === 13, String(out.values.get('1,1')));
  check(
    'and the summary above follows, which one pass could not do',
    out.values.get('0,1') === 26,
    String(out.values.get('0,1')),
  );
}

{
  /* A ring: B10 = B11, B11 = B10. Excel refuses to resolve one; this must stop
     rather than go round for ever. */
  const ring = new Map([
    ['0,1', { text: '1', kind: 'number' }],
    ['9,1', { text: '0', kind: 'number', formula: 'B12+B1' }],
    ['11,1', { text: '0', kind: 'number', formula: 'B10' }],
  ]);
  const out = recalculate(ring, 'List1', new Map([['0,1', '5']]));
  check('a ring of formulas stops rather than going round for ever', out.values.size + out.stale.size > 0);
  {
    /* A chain longer than the rounds, running against the file's order:
       A1 = A2+1 … A70 = A71+1, and A71 retyped. The rounds run out partway
       up, and what they never reached was shown as current. */
    const chain = new Map([['70,0', { text: '0', kind: 'number', raw: 0 }]]);
    for (let r = 0; r < 70; r++) {
      chain.set(`${r},0`, { text: String(70 - r), kind: 'number', raw: 70 - r, formula: `A${r + 2}+1` });
    }
    const long = recalculate(chain, 'List1', new Map([['70,0', '100']]));
    const untouched = [...Array(70).keys()].filter((r) => !long.values.has(`${r},0`) && !long.stale.has(`${r},0`));
    check(
      'a chain longer than the rounds ends marked where they ran out, never shown as it was',
      untouched.length === 0,
      `${long.values.size} worked out, ${long.stale.size} marked, ${untouched.length} left as the file had them`,
    );
  }
  check(
    'and ends marked, because what a ring comes to is not an answer',
    out.stale.has('9,1') && out.stale.has('11,1') && !out.values.has('9,1'),
    `${[...out.stale].join(' ')} marked`,
  );
}

{
  /*
   * A total that reads a subtotal and something worked out from that same
   * subtotal, with the subtotal last in the file's order:
   *
   *    B1  =SUM(B10:B12)   105
   *    B2  =B1+B3          131,25   — Ukupno
   *    B3  =B1*0.25        26,25    — PDV
   *
   * B2 used to be settled against the old B3 and never looked at again when
   * B3 moved a moment later: B10 retyped to 101 showed 132,25 as current.
   * Excel: 132,5. Found by review, and it was already in 0.6.0.
   */
  const money = (value, formula) => ({ text: String(value), kind: 'number', raw: value, ...(formula ? { formula } : {}) });
  const ukupno = new Map([
    ['0,1', money(105, 'SUM(B10:B12)')],
    ['1,1', money(131.25, 'B1+B3')],
    ['2,1', money(26.25, 'B1*0.25')],
    ['9,1', money(100)],
    ['10,1', money(3)],
    ['11,1', money(2)],
  ]);
  const out = recalculate(ukupno, 'List1', new Map([['9,1', '101']]));
  check(
    'a total that reads a subtotal and a figure worked out from it waits for both',
    out.values.get('1,1') === 132.5 && !out.stale.has('1,1'),
    `B2 ${out.values.get('1,1')} (Excel: 132.5)`,
  );

  /* The same across two sheets: the subtotal on Podaci, the rest on Sazetak. */
  const podaci = new Map([
    ['6,11', money(105, 'SUM(L1:L3)')],
    ['0,11', money(100)],
    ['1,11', money(3)],
    ['2,11', money(2)],
  ]);
  const sazetak = new Map([
    ['0,0', money(131.25, 'Podaci!L7+A5')],
    ['4,0', money(26.25, 'Podaci!L7*0.25')],
  ]);
  const across = recalculateBook(
    [
      { name: 'Podaci', cells: podaci },
      { name: 'Sazetak', cells: sazetak },
    ],
    new Map([[0, new Map([['0,11', '101']])]]),
  ).get(1);
  check(
    'and across two sheets',
    across?.values.get('0,0') === 132.5,
    `Sazetak!A1 ${across?.values.get('0,0')} (Excel: 132.5)`,
  );
}

{
  /*
   * A number as the reader hands it over: formatted for a person, `1.000,00`,
   * with the number itself beside it. Read from the text, that is not a number
   * at all, and a SUM passed over it — retyping A2 showed 334,50 as the
   * current total where Excel says 1.334,50. It shipped in 0.6.0.
   */
  const money = new Map([
    ['0,0', { text: '1.000,00', kind: 'number', raw: 1000 }],
    ['1,0', { text: '200,00', kind: 'number', raw: 200 }],
    ['2,0', { text: '34,50', kind: 'number', raw: 34.5 }],
    ['0,1', { text: '1.234,50', kind: 'number', raw: 1234.5, formula: 'SUM(A1:A3)' }],
    ['1,1', { text: '1.234,50', kind: 'number', raw: 1234.5, formula: 'SUM(C1:C2)' }],
    ['0,2', { text: '1.234,50', kind: 'number', raw: 1234.5 }],
    ['0,3', { text: '1.234,50', kind: 'number', raw: 1234.5, formula: 'SUBTOTAL(9,B2)' }],
  ]);
  const out = recalculate(money, 'List1', new Map([['1,0', '300']]));
  check(
    'a number written with a thousands separator is still counted, from the number the file stores',
    out.values.get('0,1') === 1334.5,
    `${out.values.get('0,1')} (Excel: 1334.5)`,
  );
  check(
    'and a total that came out the same is not news, so what reads it is not marked',
    (() => {
      /* C1 retyped to the value it had: B2 works out to what it was, and the
         SUBTOTAL over B2 has nothing to be out of date about. */
      const unchanged = recalculate(money, 'List1', new Map([['0,2', '1234.5']]));
      return unchanged.values.get('1,1') === 1234.5 && !unchanged.stale.has('0,3');
    })(),
    'D1 = SUBTOTAL(9,B2)',
  );
}

/* ── across the sheets of a workbook ─────────────────────────────────── */

/*
 * A formula reading another sheet is the one a sheet-at-a-time pass cannot
 * see: the sheet typed into is not the sheet holding the formula, so the total
 * sat there unmarked. Six plain `SUM`s in the measured corpus read another sheet
 * by name, and all 35 `SUMIFS` read a table on another sheet.
 */
{
  const drugi = (row, col) => (row === 1 && col === 1 ? 7 : undefined);
  const books = (name) => (name.toLowerCase() === 'drugi list' || name === "Joško's" ? drugi : null);
  check(
    'given the workbook, another sheet is read',
    evaluate("SUM('Drugi list'!B2:B5)+B2", valueAt, books) === 8,
    String(evaluate("SUM('Drugi list'!B2:B5)+B2", valueAt, books)),
  );
  check(
    'an escaped quote in a sheet name is unescaped before the sheet is looked up',
    evaluate("'Joško''s'!B2*2", valueAt, books) === 14,
    String(evaluate("'Joško''s'!B2*2", valueAt, books)),
  );
  check(
    'a sheet the workbook does not have is refused, not read as empty',
    evaluate('SUM(Nema!B2:B5)', valueAt, books) === null && evaluate('Nema!B2+1', valueAt, books) === null,
  );
  check(
    'and without the workbook, even this sheet named is refused rather than guessed at',
    evaluate("SUM('Drugi list'!B2:B5)", valueAt) === null,
  );

  const on = (row, col, sheet) => ({ row, col, sheet });
  check(
    'a total on one sheet reads the cell on the sheet it names',
    dependency('SUM(Racun!A1:A3)', 'Sazetak', on(0, 0, 'racun')) === 'reads',
  );
  check(
    'and not the same cell on its own sheet',
    dependency('SUM(Racun!A1:A3)', 'Sazetak', on(0, 0, 'Sazetak')) === 'no',
  );
  check(
    'a reference with no sheet in it is its own sheet, not the one typed into',
    dependency('SUM(A1:A3)', 'Sazetak', on(0, 0, 'Racun')) === 'no',
  );
  check(
    'a span of sheets is admitted as unreadable rather than read as its last sheet',
    dependency('SUM(Jan:Mar!B2)', 'Sazetak', on(1, 1, 'Feb')) === 'unknown' &&
      dependency("SUM('Jan:Mar'!B2)", 'Sazetak', on(1, 1, 'Feb')) === 'unknown',
  );
}

{
  /*
   * Two sheets that read each other.
   *
   *   Racun    A1..A3  1000, 200, 34.5     B1 =SUM(A1:A3)  B3 =SUBTOTAL(9,A1:A3)
   *            D1      =Sazetak!A1+1       — back again, a third hop
   *   Sazetak  A1      =SUM(Racun!A1:A3)*2
   *            A2      =Racun!B3+1         — reads a number this cannot keep current
   *            A3      =SUM(C1:C2)         — reads nothing anybody touched
   *            B1      =Racun!C1+Racun!A1, and Racun C1 =Sazetak!B1 — a ring across the two
   */
  const racun = new Map([
    ['0,0', { text: '1000', kind: 'number' }],
    ['1,0', { text: '200', kind: 'number' }],
    ['2,0', { text: '34.5', kind: 'number' }],
    ['0,1', { text: '1234.5', kind: 'number', formula: 'SUM(A1:A3)' }],
    ['2,1', { text: '1234.5', kind: 'number', formula: 'SUBTOTAL(9,A1:A3)' }],
    ['0,2', { text: '0', kind: 'number', formula: 'Sazetak!B1' }],
    ['0,3', { text: '2470', kind: 'number', formula: 'Sazetak!A1+1' }],
  ]);
  const sazetak = new Map([
    ['0,0', { text: '2469', kind: 'number', formula: 'SUM(Racun!A1:A3)*2' }],
    ['1,0', { text: '1235.5', kind: 'number', formula: 'Racun!B3+1' }],
    ['2,0', { text: '0', kind: 'number', formula: 'SUM(C1:C2)' }],
    ['0,1', { text: '0', kind: 'number', formula: 'Racun!C1+Racun!A1' }],
    /* B3 here is empty; B3 on Racun is the SUBTOTAL that goes stale. */
    ['3,0', { text: '2469', kind: 'number', formula: 'B3+A1' }],
  ]);
  const book = [
    { name: 'Racun', cells: racun },
    { name: 'Sazetak', cells: sazetak },
  ];
  const out = recalculateBook(book, new Map([[0, new Map([['0,0', '2000']])]]));
  const first = out.get(0);
  const second = out.get(1);

  check('every sheet gets an answer, not only the one typed into', first !== undefined && second !== undefined);
  check(
    'a total on another sheet follows the cell it reads',
    second?.values.get('0,0') === 4469 && !second?.stale.has('0,0'),
    `Sazetak!A1 ${second?.values.get('0,0')}${second?.stale.has('0,0') ? ' (marked)' : ''}`,
  );
  check(
    'and a total reading that one, back on the first sheet, follows it again',
    first?.values.get('0,3') === 4470,
    String(first?.values.get('0,3')),
  );
  check(
    'a number on another sheet that cannot be kept current makes what reads it stale too',
    first?.stale.has('2,1') && second?.stale.has('1,0') && !second?.values.has('1,0'),
    `Racun: ${[...(first?.stale ?? [])].join(' ')} · Sazetak: ${[...(second?.stale ?? [])].join(' ')}`,
  );
  check(
    'and a cell of the same address on a different sheet is not the stale one',
    second?.values.get('3,0') === 4469 && !second?.stale.has('3,0'),
    `Sazetak!A4 ${second?.values.get('3,0')}${second?.stale.has('3,0') ? ' (marked)' : ''}`,
  );
  check(
    'a formula on the other sheet over cells nobody touched is left alone',
    !second?.values.has('2,0') && !second?.stale.has('2,0'),
  );
  check(
    'a ring running through two sheets stops rather than going round for ever',
    second?.values.has('0,1') || second?.stale.has('0,1'),
  );

  /* E1 reads A1 here and a cell on a sheet this one call knows nothing about. */
  const both = new Map([...racun, ['0,4', { text: '1000', kind: 'number', formula: 'Sazetak!A1*0+A1' }]]);
  const alone = recalculate(both, 'Racun', new Map([['0,0', '2000']]));
  check(
    'one sheet on its own has no other sheet to read, so a formula naming one is marked, never worked out',
    alone.stale.has('0,4') && !alone.values.has('0,4') && alone.values.get('0,1') === 2234.5,
    `${[...alone.stale].join(' ')} marked`,
  );
}

{
  /*
   * The real shape: the `SUMIFS` on `Cashless`, the table it reads on `Podaci`.
   * Resolving the table said which sheet the 35 of them read; this is the edit
   * on that sheet, which no pass over `Cashless` ever looked at.
   */
  const tables = new Map([
    [
      'podacitable',
      { sheet: 'Podaci', fromRow: 1, toRow: 3, fromCol: 0, columns: new Map([['vrsta', 0], ['iznos', 2]]) },
    ],
  ]);
  const book = [
    {
      name: 'Cashless',
      cells: new Map([
        ['0,0', { text: '100', kind: 'number' }],
        ['0,1', { text: '1234.5', kind: 'number', formula: 'SUMIFS(PodaciTable[Iznos],PodaciTable[Vrsta],5)' }],
        ['1,1', { text: '100', kind: 'number', formula: 'SUM(A1:A1)' }],
      ]),
    },
    {
      name: 'Podaci',
      cells: new Map([
        ['1,0', { text: '5', kind: 'number' }],
        ['1,2', { text: '1000', kind: 'number' }],
      ]),
    },
  ];
  const inTable = recalculateBook(book, new Map([[1, new Map([['1,2', '9']])]]), tables).get(0);
  check(
    'an amount retyped inside the table reaches the SUMIFS on the sheet that reads it, and works it out',
    inTable?.values.get('0,1') === 9 && inTable.stale.size === 0,
    `Cashless!B1 ${inTable?.values.get('0,1')}${inTable?.stale.size ? ` · ${[...inTable.stale].join(' ')} marked` : ''}`,
  );
  const unlisted = recalculateBook(book, new Map([[1, new Map([['1,2', '9']])]])).get(0);
  check(
    'and without the table declared it is marked, never worked out',
    unlisted?.stale.has('0,1') && !unlisted.values.has('0,1'),
  );
  const beside = recalculateBook(book, new Map([[1, new Map([['9,9', '9']])]]), tables).get(0);
  check(
    'and a cell on that sheet outside the table marks nothing',
    beside?.stale.size === 0 && beside.values.size === 0,
    `${beside?.stale.size} marked`,
  );
}

{
  /*
   * A sheet the reader cut short at 256 columns: what lies past that was never
   * read, and `SUM(A1:IW1)` over it came out as the first 256 columns' total,
   * shown as current.
   */
  const wide = new Map([
    ['0,0', { text: '1', kind: 'number', raw: 1 }],
    ['1,0', { text: '1', kind: 'number', raw: 1, formula: 'SUM(A1:IW1)' }],
    ['2,0', { text: '1', kind: 'number', raw: 1, formula: 'SUM(A1:B1)' }],
  ]);
  const cut = recalculateBook([{ name: 'Siroki', cells: wide, readTo: 256 }], new Map([[0, new Map([['0,0', '5']])]])).get(0);
  check(
    'on a sheet cut short, a total reaching past the cut is marked, and one inside it is worked out',
    cut?.stale.has('1,0') && cut.values.get('2,0') === 5,
    `${[...(cut?.stale ?? [])].join(' ')} marked · A3 ${cut?.values.get('2,0')}`,
  );

  /*
   * Two sheets whose names differ only in a way lower-casing erases — `kilo`
   * and `Kilo` written with the Kelvin sign. Read through one map, the second
   * won, and a total read the wrong sheet's numbers as current: 2000 where the
   * sheet it meant made it 10.
   */
  const number = (value, formula) => ({ text: String(value), kind: 'number', raw: value, ...(formula ? { formula } : {}) });
  const twice = recalculateBook(
    [
      { name: 'kilo', cells: new Map([['0,0', number(1)]]) },
      { name: 'Kilo', cells: new Map([['0,0', number(1000)]]) },
      { name: 'S', cells: new Map([['0,0', number(2, 'kilo!A1*2')]]) },
    ],
    new Map([[0, new Map([['0,0', '5']])]]),
  ).get(2);
  check(
    'a sheet name that is two sheets at once is read from neither',
    twice?.stale.has('0,0') && !twice.values.has('0,0'),
    `S!A1 ${twice?.values.get('0,0') ?? 'marked'}`,
  );
}

/* ── SUMIFS and COUNTIFS, as Excel answered them ─────────────────────── */

/*
 * The rules of a criterion are not the kind to recall — blanks, text that is a
 * number, case, the locale — so they were measured: this sheet was written to
 * a file, opened in Excel 16, recalculated in full, and every answer read back
 * (`tools/verify-formula-excel.mjs` does it again on any machine with Excel).
 * `null` is where Excel has an answer this refuses to reproduce: a wildcard, a
 * text comparison, a number written with a separator, or Excel's own #VALUE!.
 *
 *        A oznaka  B as text  C način          D iznos  E fee
 *    2   5         "5"        Gotovina         10       0
 *    3   5         "5"        gotovina         20
 *    4   7         "7"        K – kartice      30       1.5
 *    5   7         "7"        K - kartice      40       0
 *    6   1         "1"                         50       2
 *    7   5         "5"        Cashless         -5
 *    8   0         "0"        Gotovina         "n/a"    0
 *    9                        "Gotovina "               3
 */
{
  const podaci = (row, col) => {
    const value = EXCEL_DATA[row - 1]?.[col];
    return value === null || value === undefined ? undefined : value;
  };
  const book = (name) => (name === 'Podaci' ? podaci : null);
  for (const [formula, excel, ours = excel] of EXCEL_ANSWERS) {
    const got = evaluate(formula, () => undefined, book);
    check(
      ours === null
        ? excel === '#VALUE!'
          ? `refused, where Excel answers #VALUE!: ${formula}`
          : `refused where Excel reads it through rules not measured here: ${formula}`
        : `as Excel answers: ${formula}`,
      got === ours,
      `${got} (Excel: ${excel})`,
    );
  }
  check(
    'a date or an error in a summed row refuses the formula rather than being passed over',
    evaluate('SUMIFS(Podaci!D2:D3,Podaci!A2:A3,5)', () => undefined, () => (row, col) => (col === 3 ? null : 5)) === null,
  );
  check(
    'a criterion that is a cell is refused rather than read',
    evaluate('COUNTIFS(Podaci!A2:A9,Podaci!A2)', () => undefined, book) === null,
  );
  check(
    'a date or an error in a criteria column refuses the formula',
    evaluate('COUNTIFS(Podaci!A2:A3,5)', () => undefined, () => () => null) === null,
  );
  check(
    'and a SUMIFS alone, handed no workbook, is refused as before',
    evaluate('SUMIFS(Podaci!D2:D9,Podaci!A2:A9,5)', () => undefined) === null,
  );
  check(
    'a range too large to walk on a keystroke is refused, not walked',
    evaluate('SUM(A1:XFD1048576)', () => 1) === null && evaluate('SUM(A1:A1048576)', () => undefined) === 0,
  );
  {
    /* The cap is the formula's, not each reference's: sixteen whole-column
       ranges were sixteen million lookups, and seconds on a keystroke. */
    const column = (letter) => `${letter}1:${letter}1048576`;
    const many = `SUM(${'ABCDEFGHIJKLMNOP'.split('').map(column).join(',')})`;
    const started = performance.now();
    const refused = evaluate(many, () => undefined);
    const ms = performance.now() - started;
    check('sixteen whole columns in one SUM are refused as a whole, quickly', refused === null && ms < 1_000, `${ms.toFixed(0)} ms`);
    check(
      'and a COUNTIFS over whole columns counts every range it reads',
      evaluate(`COUNTIFS(${column('A')},1,${column('B')},1)`, () => 1) === null &&
        evaluate('COUNTIFS(A1:A1000,1,B1:B1000,1)', () => 1) === 1000,
    );
  }
}

/* ── and over real spreadsheets, if there are any ────────────────────── */

const folder = process.argv.slice(2).find((one) => !one.startsWith('--')) ?? null;

if (folder) {
  const NOISE = new Set(['node_modules', '.git', 'target', 'dist', '__pycache__']);
  function* walk(dir, depth = 0) {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('~$')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!NOISE.has(entry.name)) yield* walk(path, depth + 1);
      } else if (['.xlsx', '.xlsm'].includes(extname(path).toLowerCase())) {
        yield path;
      }
    }
  }

  let seen = 0;
  let readable = 0;
  const refused = new Map();
  for (const path of walk(resolve(folder))) {
    let zip;
    try {
      zip = unzipSync(new Uint8Array(readFileSync(path)));
    } catch {
      continue;
    }
    for (const [name, part] of Object.entries(zip)) {
      if (!/^xl\/worksheets\/[^/]+\.xml$/.test(name)) continue;
      for (const match of strFromU8(part).matchAll(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/g)) {
        const text = match[1]
          .trim()
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"');
        if (text === '') continue;
        seen++;
        /* Every cell empty: this is asking whether the SHAPE can be worked out,
           not whether these numbers are right. A formula that comes back with a
           number over an empty sheet is one the editor can keep current. */
        if (evaluate(text, () => undefined) !== null) readable++;
        else {
          const which = /^([A-Z][A-Z0-9._]*)\s*\(/.exec(text)?.[1] ?? '(arithmetic or a reference)';
          refused.set(which, (refused.get(which) ?? 0) + 1);
        }
      }
    }
  }

  const share = seen > 0 ? ((readable / seen) * 100).toFixed(1) : '0.0';
  console.log(`\n  Over ${resolve(folder)}: ${readable} of ${seen} formulas can be worked out — ${share}%`);
  if (refused.size > 0) {
    console.log('  Refused, by what they name:');
    for (const [name, count] of [...refused].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(count).padStart(5)}  ${name}`);
    }
  }
  check('the census and this agree that most formulas are workable', readable / Math.max(1, seen) > 0.5, `${share}%`);
} else {
  console.log('\n  No folder given, so this ran on the shapes above.');
  console.log('  Give it one to measure how much of real spreadsheets it can keep current.');
}

/* ── a structured reference, once somebody says what the table is ────── */

/*
 * `PodaciTable[Iznos]` is not a range until the table definition says where the
 * table begins and which column is `Iznos`. Given that, `dependency` can answer
 * precisely instead of shrugging — and answering precisely is the one move in
 * this module that goes in the dangerous direction, because it turns an
 * `'unknown'` into a `'no'`. A `'no'` that should have been `'unknown'` is a
 * stale total sitting on the screen with nothing to say it is stale.
 *
 * So the checks that matter most below are the refusals: every bracketed shape
 * ECMA-376 allows other than a plain declared column name must still come back
 * `'unknown'`.
 *
 * The table here is the real one, measured: `PodaciTable`, A1:N5417 on the
 * sheet `Podaci`, one header row, 14 columns — and the formulas that read it
 * are on `Cashless`, which is the finding that made this worth doing.
 */
const podaci = {
  sheet: 'Podaci',
  fromRow: 1,
  toRow: 5416,
  fromCol: 0,
  columns: new Map([
    ['vrsta transakcije', 0],
    ['vrsta transakcije - filter', 1],
    ['vrsta transakcije - oznaka', 2],
    ['iznos', 3],
    ['način plaćanja', 11],
  ]),
};
/* A table with no header row at all — `NarukviceKarticeTable`, B22:D25, real. */
const narukvice = {
  sheet: 'Cashless',
  fromRow: 21,
  toRow: 24,
  fromCol: 1,
  columns: new Map([
    ['column1', 0],
    ['column2', 1],
    ['column3', 2],
  ]),
};
const tables = new Map([
  ['podacitable', podaci],
  ['narukvicekarticetable', narukvice],
]);

const REAL = 'SUMIFS(PodaciTable[Iznos],PodaciTable[Vrsta transakcije - oznaka],5,PodaciTable[Način plaćanja],"Gotovina")';

check(
  'a declared column becomes the rectangle the table says it is',
  refs(REAL, tables) === 'Podaci!1,3:5416,3 Podaci!1,2:5416,2 Podaci!1,11:5416,11',
  refs(REAL, tables),
);
check(
  'the table name is matched without case, as a spreadsheet matches it',
  refs('SUM(podacitable[iznos])', tables) === 'Podaci!1,3:5416,3',
  refs('SUM(podacitable[iznos])', tables),
);
check(
  'a header row is left out of the range, and a table declaring none keeps its first row',
  refs('SUM(NarukviceKarticeTable[Column2])', tables) === 'Cashless!21,2:24,2',
  refs('SUM(NarukviceKarticeTable[Column2])', tables),
);

/* The whole point: the sheet the formula stands on is not the sheet it reads. */
check(
  'the real formula reads nothing at all on the sheet it is written on',
  dependency(REAL, 'Cashless', at(6, 3), tables) === 'no',
  dependency(REAL, 'Cashless', at(6, 3), tables),
);
check(
  'and reads the table where the table actually is',
  dependency(REAL, 'Podaci', at(100, 3), tables) === 'reads',
  dependency(REAL, 'Podaci', at(100, 3), tables),
);
check(
  'a cell below the table is not in it',
  dependency(REAL, 'Podaci', at(5417, 3), tables) === 'no',
  dependency(REAL, 'Podaci', at(5417, 3), tables),
);
check(
  'and neither is the header row above the data',
  dependency(REAL, 'Podaci', at(0, 3), tables) === 'no',
  dependency(REAL, 'Podaci', at(0, 3), tables),
);
check(
  'without the tables it is what it always was — unreadable',
  dependency(REAL, 'Cashless', at(6, 3)) === 'unknown',
  dependency(REAL, 'Cashless', at(6, 3)),
);

/* ── and everything else in brackets is still refused ────────────────── */

for (const [shape, why] of [
  ['SUM(PodaciTable[#All])', 'the whole table including its header'],
  ['SUM(PodaciTable[#Headers])', 'the header row'],
  ['SUM(PodaciTable[#Totals])', 'a totals row'],
  ['SUM(PodaciTable[#Data])', 'the data body written out'],
  ['SUM(PodaciTable[@Iznos])', 'this row only'],
  ['SUM(PodaciTable[[Iznos]:[Operater]])', 'a span of columns'],
  ['SUM(PodaciTable[Nepostojeci])', 'a column nobody declared'],
  ['SUM(NepoznataTablica[Iznos])', 'a table nobody declared'],
  ["SUM(PodaciTable['[Iznos])", 'an escaped bracket in a column name'],
]) {
  check(`refused, and so still unknown: ${why}`, dependency(shape, 'Cashless', at(6, 3), tables) === 'unknown', shape);
}

check(
  'one refused reference makes the whole formula unknown, however many resolve beside it',
  dependency('SUMIFS(PodaciTable[Iznos],PodaciTable[#Totals],5)', 'Cashless', at(6, 3), tables) === 'unknown',
);
check(
  'a plain range beside a resolved one is still read',
  dependency('SUM(PodaciTable[Iznos])+SUM(B2:B4)', 'Cashless', at(2, 1), tables) === 'reads',
);
check(
  'working it out needs the tables and the sheet they are on — without either it is refused',
  evaluate(REAL, () => 1) === null && evaluate(REAL, () => 1, undefined, tables) === null,
);
check(
  'and a bracketed shape the tables do not resolve is refused even with them',
  evaluate('SUMIFS(PodaciTable[Iznos],PodaciTable[#Totals],5)', () => 1, () => () => 1, tables) === null &&
    evaluate('SUM(PodaciTable[@Iznos])', () => 1, () => () => 1, tables) === null,
);

/*
 * A resolved reference is taken out of the text and a space left where it was,
 * and the space is not decoration. Take it out leaving nothing and `A$` on one
 * side joins `1` on the other into `A$1` — a reference to a cell the formula
 * never named, which would then make the formula depend on a cell nobody wrote.
 * No valid formula can be written this way, since a structured reference is an
 * operand and an operand does not sit against `$`; the rule is kept because it
 * costs one character and proving it unreachable costs an argument.
 */
check(
  'taking a reference out cannot invent one that was never written',
  refs('A$PodaciTable[Iznos]1', tables) === 'Podaci!1,3:5416,3',
  refs('A$PodaciTable[Iznos]1', tables),
);

/* And a whole sheet: the 35 that used to be marked by any keystroke. */
{
  const cells = new Map([['0,0', { text: '1', kind: 'number' }]]);
  for (let i = 0; i < 35; i++) cells.set(`${10 + i},3`, { text: '0', kind: 'number', formula: REAL });
  const typed = new Map([['0,0', '2']]);
  const before = recalculate(cells, 'Cashless', typed).stale.size;
  const after = recalculate(cells, 'Cashless', typed, tables).stale.size;
  check(
    'one keystroke on the summary sheet marked all 35 and now marks none',
    before === 35 && after === 0,
    `${before} → ${after}`,
  );
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
