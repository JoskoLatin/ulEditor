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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { referencesOf, dependency, evaluate, parseA1, recalculate } = await import(
  pathToFileURL(join(ROOT, 'packages/editor-office/src/formula.ts')).href
);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── what it reads ───────────────────────────────────────────────────── */

const refs = (formula) =>
  referencesOf(formula)
    .map((one) => `${one.sheet ?? ''}${one.sheet ? '!' : ''}${one.from.row},${one.from.col}:${one.to.row},${one.to.col}`)
    .join(' ');

check('A1 is row 0, column 0', JSON.stringify(parseA1('A1')) === JSON.stringify({ row: 0, col: 0 }));
check('AA10 counts past Z', JSON.stringify(parseA1('AA10')) === JSON.stringify({ row: 9, col: 26 }));
check('a dollar holds a place, it is not part of the name', JSON.stringify(parseA1('$B$3')) === JSON.stringify({ row: 2, col: 1 }));

check('a range is one rectangle', refs('SUM(B2:B9)') === '1,1:8,1', refs('SUM(B2:B9)'));
check('a range written backwards is the same rectangle', refs('SUM(B9:B2)') === '1,1:8,1', refs('SUM(B9:B2)'));
check('two cells are two references', refs('A1+B1') === '0,0:0,0 0,1:0,1', refs('A1+B1'));
check('a sheet name is kept, not followed', refs("'Drugi list'!A1") === 'Drugi list!0,0:0,0', refs("'Drugi list'!A1"));
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
  ['1,2', null],
]);
const valueAt = (row, col) => (sheet.has(`${row},${col}`) ? sheet.get(`${row},${col}`) : undefined);
const got = (formula) => evaluate(formula, valueAt);

check('a sum over a range', got('SUM(B2:B5)') === 10, String(got('SUM(B2:B5)')));
check('a sum over arguments', got('SUM(B2,B3,10)') === 13, String(got('SUM(B2,B3,10)')));
check('a sum passes over text and empty cells', got('SUM(B2:D5)') === 10, String(got('SUM(B2:D5)')));
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

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
