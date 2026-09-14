/**
 * Cells merged across, against the cells Word merges itself.
 *
 * The rule was not reasoned out here. Word was asked over COM, on tables Word
 * had made itself, and its answer is one sentence: **the first cell's
 * properties, and every cell's content.**
 *
 * - `w:gridSpan` is the sum of what the merged cells spanned — two cells of one
 *   column give `w:val="2"`, and merging that with a third gives `w:val="3"`;
 * - `w:tcW` is the sum of the widths they declared — 3120 and 3120 give 6240;
 * - everything else in the `w:tcPr` is the first cell's: two cells shaded
 *   differently give the first one's shading, and the second's is gone;
 * - the content of every cell is kept, paragraph after paragraph, in order — a
 *   merge joins what is written rather than choosing between it;
 * - except that a cell showing nothing brings nothing, so an empty cell merged
 *   with one holding a sentence gives one paragraph, not two;
 * - and `w:tblGrid` is not touched at all. The grid declares the columns it
 *   always did; what changed is how many of them one cell covers.
 *
 * Two ways to run it. With no argument it asserts the rules on tables built
 * here — instant, no Word, and what CI can run. Given a folder of pairs it does
 * the thing that actually proves something: takes Word's own document from
 * **before** a merge, merges it here, and requires the result to be Word's own
 * document from **after** it.
 *
 *   node tools/verify-docx-merge.mjs
 *   node tools/verify-docx-merge.mjs --pairs <folder of NAME-before.docx / NAME-after.docx>
 *
 * The comparison ignores `w:rsid*`, `w14:paraId` and `w14:textId`, which Word
 * regenerates on every save: they identify an editing session, not a table, and
 * requiring them to match would be requiring Word to have been us.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { unzipSync, strFromU8 } from 'fflate';

import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = pathToFileURL(join(ROOT, 'packages/editor-office/src/docx-edit.ts')).href;

const { findRows, findRuns, findParagraphs, applyDocxEdits, mergeRefusal, mergeMarkup, rowShape } =
  await import(SOURCE);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/** The part of a `.docx` every one of these questions is about. */
function documentXml(path) {
  const zip = unzipSync(new Uint8Array(readFileSync(path)));
  const part = zip['word/document.xml'];
  if (!part) throw new Error(`${path} holds no word/document.xml`);
  return strFromU8(part);
}

/** A table with the marks of an editing session taken out of it. */
function settled(xml) {
  const table = /<w:tbl>[\s\S]*<\/w:tbl>/.exec(xml);
  return (table ? table[0] : xml)
    .replace(/\s+w:rsid[A-Za-z]*="[^"]*"/g, '')
    .replace(/\s+w14:(?:paraId|textId)="[^"]*"/g, '');
}

/** Everything `applyDocxEdits` needs to know to merge and nothing else. */
function merged(xml, merge) {
  return applyDocxEdits(xml, findRuns(xml), [], {
    paragraphs: findParagraphs(xml),
    succession: { next: new Map(), styles: new Map() },
    inserts: [],
    rows: findRows(xml),
    merges: [merge],
  });
}

/* ── the rules, on tables built here ─────────────────────────────────── */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const wrap = (rows) => `<w:document ${W}><w:body><w:tbl><w:tblGrid><w:gridCol w:w="3120"/><w:gridCol w:w="3120"/><w:gridCol w:w="3120"/></w:tblGrid>${rows}</w:tbl></w:body></w:document>`;
const cell = (text, extra = '', width = 3120) =>
  `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${extra}</w:tcPr><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;

{
  const xml = wrap(`<w:tr>${cell('A', '<w:shd w:val="clear" w:fill="E6E6E6"/>')}${cell('B', '<w:shd w:val="clear" w:fill="FFFF00"/>')}${cell('C')}</w:tr>`);
  const out = merged(xml, { row: 0, from: 0, count: 2 });

  check('two cells become one', (out.match(/<w:tc>/g) ?? []).length === 2, `${(out.match(/<w:tc>/g) ?? []).length} cells`);
  check('the span is the sum', out.includes('<w:gridSpan w:val="2"/>'));
  check('the width is the sum', out.includes('<w:tcW w:w="6240" w:type="dxa"/>'));
  check('the first cell’s shading is kept', out.includes('E6E6E6'));
  check('the second cell’s shading is gone', !out.includes('FFFF00'));
  check('both cells’ content is kept', out.includes('>A<') && out.includes('>B<'));
  check('the cell beside them is untouched', out.includes(cell('C')));
  check('the grid is not touched', (out.match(/<w:gridCol /g) ?? []).length === 3);
  check(
    'w:tcW comes before w:gridSpan, as the schema declares them',
    out.indexOf('<w:tcW') < out.indexOf('<w:gridSpan'),
  );
}

{
  const xml = wrap(`<w:tr>${cell('A')}${cell('B')}${cell('C')}</w:tr>`);
  const out = merged(xml, { row: 0, from: 0, count: 3 });
  check('a whole row merges into one cell', (out.match(/<w:tc>/g) ?? []).length === 1);
  check('and spans the whole grid', out.includes('<w:gridSpan w:val="3"/>') && out.includes('<w:tcW w:w="9360"'));
}

{
  const empty = '<w:tc><w:tcPr><w:tcW w:w="3120" w:type="dxa"/></w:tcPr><w:p/></w:tc>';
  const xml = wrap(`<w:tr>${empty}${cell('ONLY')}${cell('C')}</w:tr>`);
  const out = merged(xml, { row: 0, from: 0, count: 2 });
  const cellText = /<w:tc>[\s\S]*?<\/w:tc>/.exec(out)[0];
  check(
    'a cell showing nothing brings nothing into the merge',
    (cellText.match(/<w:p[ />]/g) ?? []).length === 1 && cellText.includes('>ONLY<'),
    `${(cellText.match(/<w:p[ />]/g) ?? []).length} paragraph(s)`,
  );
}

{
  const xml = wrap(`<w:tr>${cell('A')}${cell('B')}${cell('C')}</w:tr>`);
  const rows = findRows(xml);
  check('one cell is not a merge', mergeRefusal(xml, rows, { row: 0, from: 0, count: 1 }) !== null);
  check('cells the row does not have are refused', mergeRefusal(xml, rows, { row: 0, from: 2, count: 2 }) !== null);
  check('a row that is not there is refused', mergeRefusal(xml, rows, { row: 9, from: 0, count: 2 }) !== null);

  const down = wrap(`<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>${cell('B')}${cell('C')}</w:tr>`);
  check(
    'a cell already merged down is refused, and says so',
    /merged down/.test(mergeRefusal(down, findRows(down), { row: 0, from: 0, count: 2 }) ?? ''),
    mergeRefusal(down, findRows(down), { row: 0, from: 0, count: 2 }) ?? 'allowed',
  );

  const tracked = wrap(`<w:tr>${cell('A', '<w:cellIns w:id="1" w:author="netko"/>')}${cell('B')}${cell('C')}</w:tr>`);
  check(
    'a cell somebody is recorded as having inserted is refused',
    mergeRefusal(tracked, findRows(tracked), { row: 0, from: 0, count: 2 }) !== null,
  );
}

{
  /* A merge is a plan over the file as it was opened, like every other step
     here: applying it twice writes the same bytes. */
  const xml = wrap(`<w:tr>${cell('A')}${cell('B')}${cell('C')}</w:tr>`);
  const merge = { row: 0, from: 0, count: 2 };
  check('merging twice writes the same bytes', merged(xml, merge) === merged(xml, merge));
  check(
    'a merge nobody asked for changes nothing',
    applyDocxEdits(xml, findRuns(xml), [], {
      paragraphs: findParagraphs(xml),
      succession: { next: new Map(), styles: new Map() },
      inserts: [],
      rows: findRows(xml),
      merges: [],
    }) === xml,
  );
}

/* ── and against Word's own merge, when there is one to compare with ─── */

const flag = process.argv.indexOf('--pairs');
const folder = flag >= 0 ? process.argv[flag + 1] : null;

if (folder && existsSync(folder)) {
  /* Which cells each pair merges — the same run this file's fixtures use,
     named here because a `.docx` does not say what was done to it. */
  const asked = {
    'p1-two-shaded': { row: 1, from: 0, count: 2 },
    'p2-whole-row': { row: 1, from: 0, count: 3 },
    'p3-empty-first': { row: 0, from: 0, count: 2 },
    'p4-heading-row': { row: 0, from: 0, count: 2 },
  };

  const names = readdirSync(folder)
    .filter((name) => name.endsWith('-before.docx'))
    .map((name) => name.replace(/-before\.docx$/, ''));

  for (const name of names) {
    const before = documentXml(join(folder, `${name}-before.docx`));
    const after = documentXml(join(folder, `${name}-after.docx`));
    const merge = asked[name];
    if (!merge) {
      check(`${name}: the pair names cells to merge`, false, 'not in the table above');
      continue;
    }
    const ours = settled(merged(before, merge));
    const theirs = settled(after);
    check(`${name}: our merge is Word's`, ours === theirs, ours === theirs ? '' : firstDifference(ours, theirs));
  }
} else if (folder) {
  check('the folder of pairs exists', false, folder);
} else {
  console.log('\n  No --pairs folder given, so this ran on tables built here.');
  console.log("  That proves the rules still hold, not that they are Word's.");
}

/** Where two tables stop agreeing, with enough either side to see why. */
function firstDifference(a, b) {
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  return `at ${at}: ours ${JSON.stringify(a.slice(at, at + 60))} vs Word ${JSON.stringify(b.slice(at, at + 60))}`;
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
