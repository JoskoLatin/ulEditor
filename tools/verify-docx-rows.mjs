/**
 * A new row in a table — what Ctrl+Enter does with the cursor in a cell.
 *
 * The question a file cannot answer is **what the new row looks like**, and
 * Word was asked over COM, on tables Word had made itself: a heading row that
 * repeats on every page, a row with a fixed height that may not break across
 * pages, cells with a shading, a width, a merge across columns, a merge down
 * the rows, a centred paragraph, a bulleted list, a `Heading 1` style, two
 * paragraphs in one cell. Word's own answer is the row above, emptied: the
 * `w:tblPrEx`, the `w:trPr`, every cell's `w:tcPr` and every cell's **first**
 * paragraph's `w:pPr`, each byte for byte — and no content, no bookmarks, no
 * vertical merge. A cell whose paragraph had no properties is written
 * `<w:p/>`. Text typed into a new cell takes the paragraph mark's own
 * `w:rPr`, which is what Word gives it.
 *
 * Two answers were surprises worth keeping. A style is **not** resolved
 * through `w:next` the way a new paragraph's is — a row under a cell styled
 * `Heading 1` is a cell styled `Heading 1`. And a row asked for below a cell
 * merged downwards arrives below the **last** row that merge reaches, not
 * inside it: a merged cell stands in every row it spans.
 *
 * The rows Word wrote are recorded below, and the writer has to produce them
 * from the rows Word wrote before them. Everything else is built here without
 * the writer — the original's own bytes, with the expected row written out by
 * hand.
 *
 *   node tools/verify-docx-rows.mjs
 */

import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const {
  findRows,
  findRuns,
  findParagraphs,
  anchorRow,
  rowRefusal,
  rowShape,
  rowMarkup,
  applyDocxEdits,
  runText,
} = await import(pathToFileURL(resolve(ROOT, 'packages/editor-office/src/docx-edit.ts')).href);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const contrive = (body) => `<w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`;
const read = (xml) => ({ xml, rows: findRows(xml), runs: findRuns(xml), paragraphs: findParagraphs(xml) });

/** The whole plan applied, as a save applies it. */
const write = (doc, rowInserts, rest = {}) =>
  applyDocxEdits(doc.xml, doc.runs, rest.edits ?? [], {
    paragraphs: doc.paragraphs,
    succession: rest.succession ?? { next: new Map(), fallback: '' },
    inserts: rest.inserts ?? [],
    removals: rest.removals,
    cuts: rest.cuts,
    joins: rest.joins,
    rows: doc.rows,
    rowInserts,
  });

/** The row of a document at an ordinal, as text. */
const rowAt = (doc, index) => {
  const span = doc.rows.find((one) => one.index === index);
  return span ? doc.xml.slice(span.start, span.end) : '';
};

/* ── what Word wrote ─────────────────────────────────────────────────── */

/**
 * Word's own rows, from documents Word made, inserted into and saved on
 * 12 September 2026 — `Selection.InsertRowsBelow` over COM, both files read
 * back out of the package. The bookkeeping Word rewrites on every save —
 * `w:rsidR`, `w14:paraId` and their kind — is taken out of both sides; it
 * says nothing about what a row looks like.
 */
const WORD_WROTE = [
  {
    name: 'a plain row',
    rows:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>R2C1</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>R2C2</w:t></w:r></w:p></w:tc></w:tr>',
    cursor: 0,
    word:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p/></w:tc><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p/></w:tc></w:tr>',
  },
  {
    name: 'a heading row that repeats on every page',
    rows:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:trPr><w:tblHeader/></w:trPr><w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="E6E6E6"/></w:tcPr><w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>R1C1</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3120" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="E6E6E6"/></w:tcPr><w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>R1C2</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3120" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="E6E6E6"/></w:tcPr><w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>R1C3</w:t></w:r></w:p></w:tc></w:tr>',
    cursor: 0,
    word:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:trPr><w:tblHeader/></w:trPr><w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="E6E6E6"/></w:tcPr><w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3120" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="E6E6E6"/></w:tcPr><w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3120" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="E6E6E6"/></w:tcPr><w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr></w:p></w:tc></w:tr>',
  },
  {
    name: 'a row with a height that may not break across pages',
    rows:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:trPr><w:cantSplit/><w:trHeight w:val="800"/></w:trPr><w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>R2C1</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3120" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>R2C2</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3120" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:rPr><w:i/></w:rPr></w:pPr><w:r><w:rPr><w:i/></w:rPr><w:t>R2C3</w:t></w:r></w:p></w:tc></w:tr>',
    cursor: 0,
    word:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:trPr><w:cantSplit/><w:trHeight w:val="800"/></w:trPr><w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p/></w:tc><w:tc><w:tcPr><w:tcW w:w="3120" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3120" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:rPr><w:i/></w:rPr></w:pPr></w:p></w:tc></w:tr>',
  },
  {
    name: 'a cell holding a list item',
    rows:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>R2C1</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>R2C2</w:t></w:r></w:p></w:tc></w:tr>',
    cursor: 0,
    word:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p/></w:tc></w:tr>',
  },
  {
    name: 'a cell styled Heading 1, beside a cell of two paragraphs',
    rows:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>styled</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>first</w:t></w:r></w:p><w:p><w:pPr><w:spacing w:after="360"/></w:pPr><w:r><w:t>second</w:t></w:r></w:p></w:tc></w:tr>',
    cursor: 0,
    word:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:jc w:val="right"/></w:pPr></w:p></w:tc></w:tr>',
  },
  {
    name: 'a cell merged across two columns',
    rows:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:tc><w:tcPr><w:tcW w:w="6240" w:type="dxa"/><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>R2C1</w:t></w:r></w:p><w:p><w:r><w:t>R2C2</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3120" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>R2C3</w:t></w:r></w:p></w:tc></w:tr>',
    cursor: 0,
    word:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:tc><w:tcPr><w:tcW w:w="6240" w:type="dxa"/><w:gridSpan w:val="2"/></w:tcPr><w:p/></w:tc><w:tc><w:tcPr><w:tcW w:w="3120" w:type="dxa"/></w:tcPr><w:p/></w:tc></w:tr>',
  },
  {
    name: 'the last row a cell merged downwards reaches',
    rows:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>R1C1</w:t></w:r></w:p><w:p><w:r><w:t>R2C1</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>R1C2</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>R2C2</w:t></w:r></w:p></w:tc></w:tr>',
    cursor: 1,
    word:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p/></w:tc><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p/></w:tc></w:tr>',
  },
  {
    name: 'the first row of a cell merged downwards — and the row lands below the last',
    rows:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>R1C1</w:t></w:r></w:p><w:p><w:r><w:t>R2C1</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>R1C2</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>R2C2</w:t></w:r></w:p></w:tc></w:tr>',
    cursor: 0,
    anchor: 1,
    word:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p/></w:tc><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p/></w:tc></w:tr>',
  },
  {
    name: 'a row of a table inside a cell',
    rows:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>R2C1</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="2232"/><w:gridCol w:w="2232"/></w:tblGrid><w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:tc><w:tcPr><w:tcW w:w="2232" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>inner</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="2232" w:type="dxa"/></w:tcPr><w:p/></w:tc></w:tr></w:tbl><w:p/></w:tc></w:tr>',
    cursor: 1,
    word:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:tc><w:tcPr><w:tcW w:w="2232" w:type="dxa"/></w:tcPr><w:p/></w:tc><w:tc><w:tcPr><w:tcW w:w="2232" w:type="dxa"/></w:tcPr><w:p/></w:tc></w:tr>',
  },
  {
    name: 'typed into, under a bold heading row',
    rows:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:trPr><w:tblHeader/></w:trPr><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>R1C1</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>R1C2</w:t></w:r></w:p></w:tc></w:tr>',
    cursor: 0,
    cells: ['typed one', 'typed two'],
    word:
      '<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:trPr><w:tblHeader/></w:trPr><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>typed one</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>typed two</w:t></w:r></w:p></w:tc></w:tr>',
  },
];

/* The one place this writer differs from Word on purpose: every `w:t` it
   writes carries `xml:space="preserve"`, because without it Word discards a
   leading or trailing space — so "Ukupno " would quietly become "Ukupno".
   Word writes the attribute only when it is needed. Compared without it here,
   and required by a check of its own below. */
const asWord = (markup) => markup.replace(/ xml:space="preserve"/g, '');

let reproduced = 0;
for (const one of WORD_WROTE) {
  const doc = read(contrive(`<w:tbl>${one.rows}</w:tbl>`));
  const span = doc.rows.find((row) => row.index === one.cursor);
  const anchor = span ? anchorRow(doc.xml, doc.rows, span) : null;
  const cells = one.cells ?? (anchor ? rowShape(doc.xml, anchor).map(() => '') : []);
  const ours = anchor ? rowMarkup(doc.xml, anchor, cells) : '(no row)';
  const same = asWord(ours) === one.word;
  if (same) reproduced++;
  if (one.anchor !== undefined) {
    check(
      `the row lands below the last row the merge reaches — ${one.name}`,
      anchor?.index === one.anchor,
      `anchor ${anchor?.index} of ${doc.rows.length} rows`,
    );
  }
  check(`Word's own new row, written again: ${one.name}`, same, same ? '' : `ours: ${ours}`);
}
check(
  "every row Word wrote is the row this writer writes",
  reproduced === WORD_WROTE.length,
  `${reproduced}/${WORD_WROTE.length}`,
);

/* ── the shape of the write ──────────────────────────────────────────── */

const cell = (text, tcPr = '', pPr = '') =>
  `<w:tc>${tcPr}<w:p>${pPr}<w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
const width = '<w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr>';
const grid = '<w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4680"/><w:gridCol w:w="4680"/></w:tblGrid>';
const table = (...rows) => `<w:tbl>${grid}${rows.join('')}</w:tbl>`;
const plainRow = (a, b) => `<w:tr>${cell(a, width)}${cell(b, width)}</w:tr>`;

{
  const doc = read(contrive(`<w:p><w:r><w:t>prije</w:t></w:r></w:p>${table(plainRow('A1', 'A2'), plainRow('B1', 'B2'))}<w:p><w:r><w:t>poslije</w:t></w:r></w:p>`));
  const out = write(doc, [{ after: 0, cells: ['novo', ''] }]);

  /* Written here by hand, from the original's own bytes: the row's closing
     tag, then the row the rules say, then the rest of the file. */
  const anchor = doc.rows[0];
  const expected =
    doc.xml.slice(0, anchor.end) +
    `<w:tr><w:tc>${width}<w:p><w:r><w:t xml:space="preserve">novo</w:t></w:r></w:p></w:tc><w:tc>${width}<w:p/></w:tc></w:tr>` +
    doc.xml.slice(anchor.end);
  check('the new row goes after the row above it, and nothing else moves', out === expected, out === expected ? '' : out);

  check('a second save writes the same bytes', write(doc, [{ after: 0, cells: ['novo', ''] }]) === out);

  const back = read(out);
  check(
    'the file reads back with one row more, in the same table',
    back.rows.length === doc.rows.length + 1 && back.rows[1].table === back.rows[0].table,
    `${doc.rows.length} → ${back.rows.length}`,
  );
  check(
    'the text typed into a cell is the text the reader reads back',
    back.runs.some((run) => runText(out, run) === 'novo'),
  );
  check(
    'a cell nobody typed into is written as the empty paragraph Word writes',
    out.includes('<w:p/></w:tc>'),
  );
  check('a row nobody typed into anywhere is not written', write(doc, [{ after: 0, cells: ['', ''] }]) === doc.xml);
  check('a row named after a row that is not there is not written', write(doc, [{ after: 99, cells: ['x'] }]) === doc.xml);
}

{
  /* A file that binds the namespace to another prefix — the writer reads the
     prefix from the row it copies rather than assuming `w:`. */
  const xml = '<x:document xmlns:x="w"><x:body><x:tbl><x:tr><x:tc><x:p><x:r><x:t>A</x:t></x:r></x:p></x:tc></x:tr></x:tbl></x:body></x:document>';
  const doc = read(xml);
  const out = write(doc, [{ after: 0, cells: ['novo'] }]);
  check(
    "the new row is written with the file's own prefix",
    out.includes('<x:tr><x:tc><x:p><x:r><x:t xml:space="preserve">novo</x:t></x:r></x:p></x:tc></x:tr>') && !out.includes('<w:'),
    out.slice(out.indexOf('</x:tr>') + 7, out.indexOf('</x:tbl>')),
  );
}

{
  const doc = read(contrive(table(plainRow('A1', 'A2'))));
  const out = write(doc, [{ after: 0, cells: ['R&D <ključ>', 'razmak '] }]);
  check('the typed text is escaped', out.includes('<w:t xml:space="preserve">R&amp;D &lt;ključ&gt;</w:t>'));
  check(
    'every text this writer writes keeps its spaces',
    out.includes('<w:t xml:space="preserve">razmak </w:t>'),
    'xml:space="preserve", which Word omits when it is not needed',
  );
}

/* ── what is copied, and what is not ─────────────────────────────────── */

{
  const tracked =
    '<w:tr><w:trPr><w:ins w:id="1" w:author="netko"/></w:trPr>' + cell('A', width) + '</w:tr>';
  const doc = read(contrive(table(tracked, plainRow('B1', 'B2'))));
  check(
    'a row Word records as inserted by a reviewer is refused',
    rowRefusal(doc.xml, doc.rows, 0) === 'a tracked change is recorded on the row',
    rowRefusal(doc.xml, doc.rows, 0) ?? 'allowed',
  );
  check('and the writer refuses it too', write(doc, [{ after: 0, cells: ['novo'] }]) === doc.xml);
}

{
  const deleted = '<w:tr><w:trPr><w:del w:id="2" w:author="netko"/></w:trPr>' + cell('A', width) + '</w:tr>';
  const changed = '<w:tr><w:trPr><w:trPrChange w:id="3" w:author="netko"><w:trPr/></w:trPrChange></w:trPr>' + cell('A', width) + '</w:tr>';
  const doc = read(contrive(table(deleted, changed)));
  check(
    'a row recorded as deleted, and one whose properties a reviewer changed, are refused',
    rowRefusal(doc.xml, doc.rows, 0) === 'a tracked change is recorded on the row' &&
      rowRefusal(doc.xml, doc.rows, 1) === 'a tracked change is recorded on the row',
  );
}

{
  const merged =
    '<w:tr>' +
    `<w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/><w:vMerge w:val="restart"/><w:shd w:val="clear" w:fill="EEEEEE"/></w:tcPr><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>` +
    cell('B', width) +
    '</w:tr>';
  const doc = read(contrive(table(merged)));
  const out = rowMarkup(doc.xml, doc.rows[0], ['', '']);
  check(
    'the vertical merge is left behind, and the rest of the cell properties are copied',
    !out.includes('vMerge') && out.includes('<w:shd w:val="clear" w:fill="EEEEEE"/>'),
    out,
  );
}

{
  const recorded =
    '<w:tr>' +
    '<w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/><w:tcPrChange w:id="4" w:author="netko"><w:tcPr/></w:tcPrChange><w:cellIns w:id="5" w:author="netko"/></w:tcPr>' +
    '<w:p><w:pPr><w:jc w:val="center"/><w:pPrChange w:id="6" w:author="netko"><w:pPr/></w:pPrChange><w:rPr><w:b/><w:ins w:id="7" w:author="netko"/></w:rPr></w:pPr><w:r><w:t>A</w:t></w:r></w:p></w:tc>' +
    '</w:tr>';
  const doc = read(contrive(table(recorded)));
  const out = rowMarkup(doc.xml, doc.rows[0], ['tekst']);
  check(
    "a reviewer's record of the cell it was copied from is not copied with it",
    !/tcPrChange|cellIns|pPrChange|<w:ins /.test(out),
    out,
  );
  check(
    'the properties themselves are kept, and the typed text takes the mark’s own formatting',
    out.includes('<w:jc w:val="center"/>') && out.includes('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">tekst</w:t></w:r>'),
    out,
  );
}

{
  /* A cell whose first child is a table: its own first paragraph is the one
     after that table, and the properties of a paragraph inside the inner
     table belong to a grid of its own. */
  const inner = `<w:tbl>${grid}<w:tr><w:tc><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>unutra</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
  const outer = `<w:tr><w:tc>${width}${inner}<w:p><w:pPr><w:jc w:val="center"/></w:pPr></w:p></w:tc></w:tr>`;
  const doc = read(contrive(table(outer)));
  const out = rowMarkup(doc.xml, doc.rows[0], ['tekst']);
  check(
    "a cell holding a table takes its own paragraph's properties, not the inner table's",
    out.includes('<w:jc w:val="center"/>') && !out.includes('<w:jc w:val="right"/>'),
    out,
  );
}

{
  const doc = read(contrive(table(`<w:tr><w:trPr/><w:tc><w:tcPr/><w:p/></w:tc></w:tr>`)));
  const out = rowMarkup(doc.xml, doc.rows[0], ['']);
  check(
    'properties emptied of everything are left out entirely',
    out === '<w:tr><w:tc><w:p/></w:tc></w:tr>',
    out,
  );
}

/* ── where the row goes ──────────────────────────────────────────────── */

{
  /* The merge is below, not here: the row goes where it was asked for. */
  const restart = `<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc>${cell('B2', width)}</w:tr>`;
  const carries = `<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>${cell('C2', width)}</w:tr>`;
  const doc = read(contrive(table(plainRow('A1', 'A2'), restart, carries)));
  check(
    'a merge that starts in the row below does not move the new row',
    anchorRow(doc.xml, doc.rows, doc.rows[0]).index === 0,
  );
  check(
    'and one that starts here carries it past its last row',
    anchorRow(doc.xml, doc.rows, doc.rows[1]).index === 2,
  );
  const out = write(doc, [{ after: 1, cells: ['novo', ''] }]);
  check(
    'the plan puts it there too, not inside the merge',
    out.indexOf('novo') > out.indexOf('C2'),
    out.slice(out.indexOf('<w:tbl'), out.indexOf('</w:tbl>')).replace(/<w:tblPr>.*<\/w:tblGrid>/, ''),
  );
}

{
  /* The next row in the file is not the next row of this table. A merge
     carrying on in the table below must not pull the new row into it. */
  const carries = `<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>${cell('B2', width)}</w:tr>`;
  const doc = read(contrive(`${table(plainRow('A1', 'A2'))}${table(carries, plainRow('C1', 'C2'))}`));
  check(
    "a merge in the next table does not carry the new row out of this one",
    anchorRow(doc.xml, doc.rows, doc.rows[0]).index === 0,
    `anchor ${anchorRow(doc.xml, doc.rows, doc.rows[0]).index}`,
  );
  const out = write(doc, [{ after: 0, cells: ['novo', ''] }]);
  check('and the row is written into the first table', out.indexOf('novo') < out.indexOf('B2'));
}

{
  /* The row the cursor is in is clean; the one the copy comes from is not. */
  const restart = `<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>${cell('A2', width)}</w:tr>`;
  const tracked = `<w:tr><w:trPr><w:ins w:id="9" w:author="netko"/></w:trPr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>${cell('B2', width)}</w:tr>`;
  const doc = read(contrive(table(restart, tracked)));
  check(
    'a tracked change on the row the copy would come from refuses it as well',
    rowRefusal(doc.xml, doc.rows, 0) === 'a tracked change is recorded on the row',
    rowRefusal(doc.xml, doc.rows, 0) ?? 'allowed',
  );
}

{
  const spanning = `<w:tr><w:tc><w:tcPr><w:tcW w:w="6240" w:type="dxa"/><w:gridSpan w:val="3"/></w:tcPr><w:p/></w:tc>${cell('B', width)}</w:tr>`;
  const doc = read(contrive(table(spanning)));
  check('a cell spanning columns is reported as that many columns wide', JSON.stringify(rowShape(doc.xml, doc.rows[0])) === '[3,1]');
}

{
  const first = table(plainRow('A1', 'A2'), plainRow('A3', 'A4'));
  const second = table(plainRow('B1', 'B2'));
  const doc = read(contrive(`${first}<w:p><w:r><w:t>između</w:t></w:r></w:p>${second}`));
  const out = write(doc, [{ after: 2, cells: ['novo', ''] }]);
  const back = read(out);
  check(
    'a row added to the second table lands in the second table',
    back.rows.length === 4 && back.rows[3].table === back.rows[2].table && out.indexOf('novo') > out.indexOf('između'),
  );
}

{
  const inner = `<w:tbl>${grid}<w:tr><w:tc><w:p><w:r><w:t>unutra</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/>`;
  const doc = read(contrive(table(`<w:tr><w:tc>${width}${inner}</w:tc></w:tr>`, plainRow('B1', 'B2'))));
  const out = write(doc, [{ after: 1, cells: ['novo'] }]);
  const back = read(out);
  check(
    'a row added to a table inside a cell lands in that table',
    back.rows.length === 4 && back.rows[2].table === back.rows[1].table && back.rows[2].end < back.rows[0].end,
    `${doc.rows.length} → ${back.rows.length} rows`,
  );
}

{
  const doc = read(contrive(table(plainRow('A1', 'A2'))));
  const out = write(doc, [
    { after: 0, cells: ['prvi', ''] },
    { after: 0, cells: ['drugi', ''] },
  ]);
  check(
    'two rows added after the same row keep the order they were added in',
    out.indexOf('prvi') < out.indexOf('drugi'),
  );
}

/* ── refused ─────────────────────────────────────────────────────────── */

{
  const inBox = `<w:p><w:r><w:drawing><wp:inline><a:graphic><wp:txbxContent>${table(plainRow('A', 'B'))}</wp:txbxContent></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const doc = read(contrive(inBox));
  check(
    'a row of a table in a text box is refused',
    rowRefusal(doc.xml, doc.rows, 0) === 'the table is not in the body of the document',
    rowRefusal(doc.xml, doc.rows, 0) ?? 'allowed',
  );
}

{
  const wrapped = `<w:tbl>${grid}<w:sdt><w:sdtContent>${plainRow('A', 'B')}</w:sdtContent></w:sdt></w:tbl>`;
  const doc = read(contrive(wrapped));
  check(
    'a row wrapped in a content control is refused',
    rowRefusal(doc.xml, doc.rows, 0) === 'the row is not a row of a table',
    rowRefusal(doc.xml, doc.rows, 0) ?? 'allowed',
  );
}

{
  const doc = read(contrive(table('<w:tr/>', plainRow('A', 'B'))));
  check(
    'a row with no cells is refused',
    rowRefusal(doc.xml, doc.rows, 0) === 'the row has no cells',
    rowRefusal(doc.xml, doc.rows, 0) ?? 'allowed',
  );
  check('and an ordinal that is no row at all', rowRefusal(doc.xml, doc.rows, 7) === 'there is no such row');
  check('the row beside it is offered', rowRefusal(doc.xml, doc.rows, 1) === null);
}

/* ── in the same save as everything else ─────────────────────────────── */

{
  const body =
    '<w:p><w:r><w:t>Prvi odlomak</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Drugi odlomak</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Treći odlomak</w:t></w:r></w:p>' +
    table(plainRow('A1', 'A2'), plainRow('B1', 'B2')) +
    '<w:p><w:r><w:t>Zadnji odlomak</w:t></w:r></w:p>';
  const doc = read(contrive(body));
  const out = write(doc, [{ after: 1, cells: ['u tablici', ''] }], {
    edits: [{ index: 0, text: 'Prepisani odlomak' }],
    /* After the last body paragraph — the ordinals count the cells' paragraphs too. */
    inserts: [{ after: 7, text: 'Dodani odlomak' }],
    removals: [2],
    cuts: [{ run: 1, parts: ['Drugi', ' odlomak'] }],
  });
  const back = read(out);
  check(
    'a new row is written in the same save as a rewrite, an insertion, a removal and a split',
    out.includes('Prepisani odlomak') &&
      out.includes('Dodani odlomak') &&
      !out.includes('Treći odlomak') &&
      out.includes('<w:t xml:space="preserve">Drugi</w:t>') &&
      out.includes('<w:t xml:space="preserve">u tablici</w:t>') &&
      back.rows.length === 3,
    `${back.rows.length} rows, ${back.paragraphs.length} paragraphs`,
  );
  check(
    'and the table it was added to is otherwise untouched',
    out.includes(rowAt(doc, 0)) && out.includes(rowAt(doc, 1)),
  );
}

{
  /* A run inside the row the new one is copied from is editable like any
     other, and rewriting it must not move the row under the insertion. */
  const doc = read(contrive(table(plainRow('A1', 'A2'))));
  const cellRun = doc.runs.findIndex((run) => runText(doc.xml, run) === 'A2');
  const out = write(doc, [{ after: 0, cells: ['novo', ''] }], {
    edits: [{ index: cellRun, text: 'prepisano' }],
  });
  check(
    'a cell of that row can be retyped in the same save',
    out.includes('<w:t xml:space="preserve">prepisano</w:t>') && out.includes('<w:t xml:space="preserve">novo</w:t>') && read(out).rows.length === 2,
    out.slice(out.indexOf('<w:tbl'), out.indexOf('</w:tbl>')),
  );
}

/* ── every real document ─────────────────────────────────────────────── */

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, depth + 1);
    else if (/\.docx$/i.test(entry.name) && !entry.name.startsWith('~$')) out.push(full);
  }
  return out;
}

const corpus = process.env.UL_CORPUS ?? join(process.env.USERPROFILE ?? '', 'Documents');
const files = walk(corpus);
check(
  'a corpus of real documents was walked',
  files.length > 0,
  files.length ? `${files.length} .docx under ${corpus}` : `nothing under ${corpus} — set UL_CORPUS`,
);

let withTables = 0;
let tables = 0;
let allRows = 0;
let offered = 0;
let belowMerge = 0;
let spanning = 0;
let swept = 0;
const reasons = new Map();
const damaged = [];

for (const path of files) {
  const name = path.slice(corpus.length + 1);
  let xml;
  try {
    const archive = unzipSync(readFileSync(path));
    if (!archive['word/document.xml']) continue;
    xml = strFromU8(archive['word/document.xml']);
  } catch {
    continue;
  }

  const doc = read(xml);
  if (doc.rows.length === 0) continue;
  withTables++;
  tables += new Set(doc.rows.map((row) => row.table)).size;
  allRows += doc.rows.length;

  const candidates = [];
  for (const row of doc.rows) {
    const why = rowRefusal(xml, doc.rows, row.index);
    if (why !== null) {
      reasons.set(why, (reasons.get(why) ?? 0) + 1);
      continue;
    }
    offered++;
    const anchor = anchorRow(xml, doc.rows, row);
    if (anchor.index !== row.index) belowMerge++;
    if (rowShape(xml, anchor).some((one) => one > 1)) spanning++;
    candidates.push(row);
  }
  if (candidates.length === 0) continue;

  /* From the middle of the document rather than its front — an offset fault
     shows itself late in a long file. */
  const row = candidates[Math.floor(candidates.length / 2)];
  const anchor = anchorRow(xml, doc.rows, row);
  swept++;

  const cells = rowShape(xml, anchor).map((_, k) => (k === 0 ? 'ćelija' : ''));
  const out = write(doc, [{ after: row.index, cells }]);

  /* The original, with one row in it and not a byte else: taking the new row
     back out again has to give the file it was written from. */
  const without = out.slice(0, anchor.end) + out.slice(out.indexOf('</w:tr>', anchor.end) + '</w:tr>'.length);
  if (without !== xml) {
    damaged.push(`${name}: something outside the new row moved`);
    continue;
  }
  const back = read(out);
  if (back.rows.length !== doc.rows.length + 1) {
    damaged.push(`${name}: ${doc.rows.length} → ${back.rows.length} rows`);
    continue;
  }
  const fresh = back.rows.find((one) => one.start === anchor.end);
  if (!fresh || fresh.table !== anchor.table || rowRefusal(out, back.rows, fresh.index) !== null) {
    damaged.push(`${name}: the new row is not a row of the same table`);
    continue;
  }
  if (!back.runs.some((one) => runText(out, one) === 'ćelija')) {
    damaged.push(`${name}: the typed text is not readable in the new row`);
    continue;
  }
  if (write(doc, [{ after: row.index, cells }]) !== out) damaged.push(`${name}: a second save wrote something else`);
}

check(
  'a row is added to a table of every real document that has one, and nothing else moves',
  swept > 0 && damaged.length === 0,
  damaged.length ? damaged.slice(0, 4).join(' · ') : `${swept}/${withTables} documents with a table, of ${files.length}`,
);

console.log(
  `\n${withTables} of ${files.length} real documents hold a table: ${tables} tables, ${allRows} rows.` +
    ` ${offered} may take a new row after them — ${belowMerge} of those put it below a merge,` +
    ` ${spanning} have a cell spanning columns.` +
    (reasons.size ? ' Refused:' : ' Nothing refused.'),
);
for (const [why, count] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(5)} · ${why}`);

const failed = checks.filter((one) => !one.passed).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
