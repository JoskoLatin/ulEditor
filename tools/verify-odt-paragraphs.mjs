/**
 * Paragraphs added, taken away, divided and joined in an OpenDocument text —
 * and what the file looks like around them.
 *
 * The Word side of this is five harnesses (`verify-docx-insert`, `-delete`,
 * `-split`, `-join`, and `pnpm readback`); this is the same set of questions
 * asked of a format that keeps its formatting somewhere else:
 *
 * - is **everything else** byte for byte as it was — every other part of the
 *   archive, and `content.xml` outside the ranges the plan names;
 * - is the paragraph count what the plan says, exactly;
 * - does a new paragraph take the style its predecessor **hands on**
 *   (`style:next-style-name`, which lives in `styles.xml` on the common style
 *   an automatic style stands on), and never a page break or a master page;
 * - is no paragraph's opening tag ever copied — a copied `xml:id` is two
 *   paragraphs with one id;
 * - is every rule that refuses a step kept by the writer too, not only by the
 *   view that asks it first;
 * - and is the write idempotent — the plan applied twice to the original is
 *   the same bytes.
 *
 * Then the corpus. There are almost no real `.odt` files on this machine, so
 * the real Word documents in `Documents` are handed to LibreOffice, which
 * writes them as `.odt` — files from a real OpenDocument writer, with its
 * automatic styles, its self-closing blank lines and its master pages. Every
 * one of them is given a plan of each kind, and the same questions asked.
 *
 * And last, LibreOffice reads back what was written — the one reader here that
 * shares no code with the writer. It must open the file (an output exists and
 * is not empty: a part it cannot parse produces nothing), and the lines it
 * shows must be the lines the plan made: a new line where one was added, two
 * where one was divided, one where two were joined.
 *
 * It refuses to pass without LibreOffice or without a corpus, rather than
 * skipping: a check whose only failure mode is a pass has bitten this
 * repository before.
 *
 *   node tools/verify-odt-paragraphs.mjs
 */

import { unzipSync, strFromU8 } from 'fflate';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeOdtParagraphs, ODT_PARAGRAPHS as AT } from './fixtures.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const {
  findOdtPieces,
  findOdtParagraphs,
  readOdtStyles,
  startsPage,
  successorOf,
  paragraphOf,
  applyOdtEdits,
  odtRemovalRefusal,
  odtDivisionRefusal,
  odtJoinRefusal,
  odtShowsNothing,
  lastPieceOf,
  findOdtRows,
  anchorOdtRow,
  odtRowShape,
  odtRowRefusal,
  odtIsPlain,
  rootNamespaces,
  scannedElements,
} = await import(pathToFileURL(resolve(ROOT, 'packages/editor-office/src/odt-edit.ts')).href);
const { scanTags } = await import(pathToFileURL(resolve(ROOT, 'packages/editor-office/src/docx-edit.ts')).href);
const { writeOdf } = await import(pathToFileURL(resolve(ROOT, 'packages/editor-office/src/odf-package.ts')).href);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* Diacritics on purpose: a č is two bytes and one character, and the whole
   chain has to agree about that. */
const MARKER = 'Novi odlomak — čćžšđ ČĆŽŠĐ';

function open(bytes) {
  const archive = unzipSync(bytes);
  const xml = strFromU8(archive['content.xml']);
  const styles = archive['styles.xml'] ? strFromU8(archive['styles.xml']) : null;
  return {
    archive,
    xml,
    pieces: findOdtPieces(xml),
    paragraphs: findOdtParagraphs(xml),
    styles: readOdtStyles(xml, styles),
  };
}

function plan(doc, reshaping = {}, edits = []) {
  return applyOdtEdits(doc.xml, doc.pieces, edits, { paragraphs: doc.paragraphs, styles: doc.styles, ...reshaping });
}

/** Whether every open tag is closed in order — a cheap well-formedness bar; LibreOffice is the real one. */
function balanced(xml) {
  const stack = [];
  for (const tag of scanTags(xml)) {
    if (tag.selfClosing) continue;
    if (tag.closing) {
      if (stack.pop() !== tag.name) return false;
    } else {
      stack.push(tag.name);
    }
  }
  return stack.length === 0;
}

const count = (xml) => findOdtParagraphs(xml).length;

/** The text of a paragraph as a reader sees it — its own, not a comment's inside it. */
function textOf(xml, paragraph) {
  if (paragraph.selfClosing) return '';
  let inner = xml.slice(paragraph.start, paragraph.end);
  inner = inner.replace(/<office:annotation\b[\s\S]*?<\/office:annotation>/g, '');
  return inner
    .replace(/<[\w-]+:s(?:\s+[\w-]+:c="(\d+)")?\s*\/>/g, (_, n) => ' '.repeat(Number(n ?? 1)))
    .replace(/<[\w-]+:tab\s*\/>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const bodyTexts = (xml) =>
  findOdtParagraphs(xml)
    .filter((one) => one.refusal === null)
    .map((one) => textOf(xml, one));

/** The one stretch two strings differ in, from the front and from the back. */
function difference(before, after) {
  let head = 0;
  while (head < before.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return { at: head, removed: before.slice(head, before.length - tail), added: after.slice(head, after.length - tail) };
}

/* ── the fixture: where a paragraph stands ───────────────────────────── */

console.log('Paragraphs of an OpenDocument text — added, taken away, divided and joined.\n');

const doc = open(makeOdtParagraphs());
const P = doc.paragraphs;

check(
  'every paragraph is counted, nested ones too',
  P.length === Object.keys(AT).length,
  `${P.length} counted, ${Object.keys(AT).length} written`,
);
check(
  'a paragraph of the body may be reshaped',
  [AT.cover, AT.heading, AT.bold, AT.blank, AT.link, AT.last].every((i) => P[i].refusal === null),
);
check('one in a list is told apart, as a list', P[AT.listItem].refusal === 'the paragraph is in a list');
check(
  "one in a table cell, a comment or a tracked change's record is not the body's",
  [AT.cell, AT.commentInside, AT.deleted].every((i) => P[i].refusal === 'the paragraph is not in the body of the document'),
);
check('an empty paragraph written as one tag is a paragraph', P[AT.blank].selfClosing && P[AT.blank].refusal === null);

check('a master page on an automatic style starts a page', startsPage(doc.styles, P[AT.cover].style));
check('and so does a page break before', startsPage(doc.styles, P[AT.pageBreak].style));
check('a heading does not', !startsPage(doc.styles, P[AT.heading].style));

/* ── a new paragraph ─────────────────────────────────────────────────── */

/** What went in at `at`, when nothing else changed; `null` when something did. */
function addedAt(before, after, at) {
  const grown = after.length - before.length;
  if (grown < 0 || after.slice(0, at) !== before.slice(0, at) || after.slice(at + grown) !== before.slice(at)) return null;
  return after.slice(at, at + grown);
}

function inserted(after, text = MARKER) {
  const out = plan(doc, { inserts: [{ after, text }] });
  return { out, added: addedAt(doc.xml, out, P[after].end) ?? '' };
}

{
  const one = inserted(AT.bold);
  check('a new paragraph: the part is still well formed', balanced(one.out));
  check('the document is exactly one paragraph longer', count(one.out) === P.length + 1, `${P.length} → ${count(one.out)}`);
  check('nothing else changed, and it went in right after the paragraph', addedAt(doc.xml, one.out, P[AT.bold].end) !== null);
  check(
    'it continues the formatting of the text it follows — the same span, built rather than copied',
    one.added ===
      `<text:p text:style-name="Text_20_body"><text:span text:style-name="T1">${MARKER}</text:span></text:p>`,
    one.added,
  );
  check('and carries no id of the paragraph before it', !/xml:id|text:id/.test(one.added));

  const afterHeading = inserted(AT.heading);
  check(
    'after a heading comes the style the heading hands on — body text, not a second heading',
    afterHeading.added.startsWith('<text:p text:style-name="Text_20_body">'),
    afterHeading.added.slice(0, 60),
  );
  check(
    "and not the heading's own centring, which is its automatic style",
    !afterHeading.added.includes('"P2"'),
  );

  const afterCover = inserted(AT.cover);
  check(
    'after the paragraph a master page starts on, its common style — not a second page',
    afterCover.added.startsWith('<text:p text:style-name="Standard">'),
    afterCover.added.slice(0, 60),
  );
  const afterBreak = inserted(AT.pageBreak);
  check(
    'and the same after a page break',
    afterBreak.added.startsWith('<text:p text:style-name="Text_20_body">'),
    afterBreak.added.slice(0, 60),
  );

  const afterLink = inserted(AT.link);
  check(
    'a style that hands on nothing hands on itself, automatic style and all',
    afterLink.added === `<text:p text:style-name="P3">${MARKER}</text:p>`,
    afterLink.added,
  );

  const afterBlank = inserted(AT.blank);
  check('after an empty paragraph written as one tag', afterBlank.added.startsWith('<text:p') && count(afterBlank.out) === P.length + 1);

  const spaced = inserted(AT.bold, ' dva  razmaka');
  check(
    'spacing is written the way OpenDocument keeps it',
    spaced.added.includes('<text:s/>dva <text:s/>razmaka'),
    spaced.added,
  );

  check('a paragraph nobody typed into is not written', plan(doc, { inserts: [{ after: AT.bold, text: '' }] }) === doc.xml);
  check(
    'nor one after a list item, a cell or the inside of a comment',
    [AT.listItem, AT.cell, AT.commentInside].every((after) => plan(doc, { inserts: [{ after, text: MARKER }] }) === doc.xml),
  );

  const two = plan(doc, { inserts: [{ after: AT.bold, text: 'prvi' }, { after: AT.bold, text: 'drugi' }] });
  const texts = bodyTexts(two);
  const first = texts.indexOf('prvi');
  check('two new paragraphs after one keep the order they were added in', first !== -1 && texts[first + 1] === 'drugi');
  check(
    'and the plan applied twice gives the same bytes',
    plan(doc, { inserts: [{ after: AT.bold, text: 'prvi' }, { after: AT.bold, text: 'drugi' }] }) === two,
  );
}

/* ── taking a paragraph away ─────────────────────────────────────────── */

{
  const out = plan(doc, { removals: [AT.blank] });
  check(
    'a removal takes away exactly the paragraph',
    out === doc.xml.slice(0, P[AT.blank].start) + doc.xml.slice(P[AT.blank].end),
  );
  check('and the document is one paragraph shorter', count(out) === P.length - 1);

  const refusals = [
    ['the paragraph a master page starts on', AT.cover, 'the paragraph starts a page'],
    ['a paragraph with a page break', AT.pageBreak, 'the paragraph starts a page'],
    ['a list item', AT.listItem, 'the paragraph is in a list'],
    ['a table cell', AT.cell, 'the paragraph is not in the body of the document'],
    ["the paragraph a comment's range starts in", AT.commentStart, 'a marked stretch continues outside the paragraph'],
    ['and the one it ends in', AT.commentEnd, 'a marked stretch continues outside the paragraph'],
    ['a paragraph a tracked change is recorded in', AT.tracked, 'a tracked change is recorded in the paragraph'],
  ];
  /* A text box: paragraphs of its own, inside the one it is anchored in. */
  const boxedArchive = unzipSync(makeOdtParagraphs());
  const boxed = open(
    writeOdf(
      boxedArchive,
      strFromU8(boxedArchive['content.xml']).replace(
        '<text:p text:style-name="Text_20_body">Zadnji odlomak.</text:p>',
        '<text:p text:style-name="Text_20_body">Zadnji<draw:frame draw:name="okvir"><draw:text-box>' +
          '<text:p>skriveno</text:p><text:p>i ovo</text:p></draw:text-box></draw:frame></text:p>' +
          '<text:p text:style-name="Text_20_body">Poslije okvira.</text:p>',
      ),
    ),
  );
  check(
    'not removed: a paragraph a text box is anchored in, whose text the view does not draw',
    odtRemovalRefusal(boxed.xml, boxed.paragraphs, boxed.styles, AT.last) === 'the paragraph holds text the view does not show' &&
      plan(boxed, { removals: [AT.last] }) === boxed.xml,
  );
  for (const [label, index, reason] of refusals) {
    const why = odtRemovalRefusal(doc.xml, P, doc.styles, index);
    check(`not removed: ${label}`, why === reason && plan(doc, { removals: [index] }) === doc.xml, why ?? 'allowed');
  }

  const alone = new Set([AT.last]);
  check(
    'not the last paragraph standing',
    odtRemovalRefusal(doc.xml, P, doc.styles, AT.last, alone) === 'the last paragraph of the document',
  );
  const body = P.filter((one) => one.refusal === null).map((one) => one.index);
  const all = plan(doc, { removals: body });
  check(
    'and the writer keeps that too: asked to remove every one, it keeps one',
    findOdtParagraphs(all).filter((one) => one.refusal === null).length >= 1 && balanced(all),
  );

  const both = plan(doc, { removals: [AT.bold], inserts: [{ after: AT.bold, text: MARKER }] });
  const texts = bodyTexts(both);
  check(
    'a paragraph added after one taken away stays, where it was',
    texts.includes(MARKER) && !texts.some((one) => one.startsWith('Prvi odlomak')),
  );
  const boldPiece = doc.pieces.find((piece) => piece.text === 'podebljanim krajem');
  const dropped = plan(doc, { removals: [AT.bold] }, [{ index: boldPiece.index, text: 'izgubljeno' }]);
  check('a rewrite inside a paragraph taken away goes with it', !dropped.includes('izgubljeno') && balanced(dropped));
}

/* ── dividing a paragraph ────────────────────────────────────────────── */

const pieceOf = (text) => doc.pieces.find((piece) => piece.text === text);

{
  const bold = pieceOf('podebljanim krajem');
  const out = plan(doc, { cuts: [{ piece: bold.index, parts: ['podebljanim ', 'krajem'] }] });
  check('a division: still well formed', balanced(out));
  check('one paragraph more', count(out) === P.length + 1);
  check(
    'the cut closes the span and the line, and opens both again — the span by its style',
    out.includes(
      'podebljanim<text:s/></text:span></text:p><text:p text:style-name="Text_20_body"><text:span text:style-name="T1">krajem</text:span></text:p>',
    ),
    difference(doc.xml, out).added,
  );
  check('the id stays with the first half alone', (out.match(/xml:id="p2"/g) ?? []).length === 1);

  const heading = pieceOf('Poglavlje čćžšđ');
  const halves = plan(doc, { cuts: [{ piece: heading.index, parts: ['Poglavlje ', 'čćžšđ'] }] });
  check(
    'both halves of a heading are headings, of the same level and style',
    halves.includes('</text:h><text:h text:style-name="P2" text:outline-level="1">čćžšđ</text:h>'),
    difference(doc.xml, halves).added,
  );
  check('and the id stays with the first', (halves.match(/xml:id="h1"/g) ?? []).length === 1);

  const link = pieceOf('ovdje');
  check(
    'not inside a link, which a cut would make two',
    odtDivisionRefusal(doc.xml, P, doc.styles, link) === 'the text is inside an element a cut would tear in two',
  );
  const before = pieceOf('Desno, s poveznicom ');
  const linked = plan(doc, { cuts: [{ piece: before.index, parts: ['Desno,', ' s poveznicom '] }] });
  const linkedTexts = bodyTexts(linked);
  check(
    'before the link, the link goes whole with the second half',
    linkedTexts.includes('Desno,') && linkedTexts.includes(' s poveznicom ovdje i dalje.') && balanced(linked),
    JSON.stringify(linkedTexts.slice(4, 7)),
  );

  const refused = [
    ['the paragraph a master page starts on', pieceOf('Naslovna stranica'), 'the paragraph starts a page'],
    ['a paragraph with a page break', pieceOf('Nova stranica počinje ovdje.'), 'the paragraph starts a page'],
    ["before a comment's range that ends in the next paragraph", pieceOf('Komentar '), 'a marked stretch continues outside the paragraph'],
    ['a paragraph a tracked change is recorded in', pieceOf('Promjena '), 'a tracked change is recorded in the paragraph'],
    ['a list item', pieceOf('stavka popisa'), 'the paragraph is in a list'],
  ];
  for (const [label, piece, reason] of refused) {
    const why = odtDivisionRefusal(doc.xml, P, doc.styles, piece);
    check(
      `not divided: ${label}`,
      why === reason && plan(doc, { cuts: [{ piece: piece.index, parts: ['a', 'b'] }] }) === doc.xml,
      why ?? 'allowed',
    );
  }

  const first = pieceOf('Prvi odlomak s ');
  const three = plan(doc, { cuts: [{ piece: first.index, parts: ['Prvi', ' odlomak', ' s '] }] }, [{ index: bold.index, text: 'prepisano' }]);
  const threeTexts = bodyTexts(three);
  check('three parts, two paragraphs more', count(three) === P.length + 2 && balanced(three));
  check(
    'and a rewrite later in the same paragraph lands in the last of them',
    threeTexts.includes(' s prepisano'),
    JSON.stringify(threeTexts.slice(2, 6)),
  );
  check('a cut of one part is no cut', plan(doc, { cuts: [{ piece: bold.index, parts: ['x'] }] }) === doc.xml);
}

/* ── joining two paragraphs ──────────────────────────────────────────── */

{
  const headingAndBody = plan(doc, { joins: [AT.heading] });
  const joined = findOdtParagraphs(headingAndBody)[AT.heading];
  check('a join: still well formed', balanced(headingAndBody));
  check('one paragraph fewer', count(headingAndBody) === P.length - 1);
  check(
    "a body paragraph joined onto a heading closes as the heading — the line keeps the first one's tag",
    joined.kind === 'h' && textOf(headingAndBody, joined) === 'Poglavlje čćžšđPrvi odlomak s podebljanim krajem',
    headingAndBody.slice(joined.start, joined.end).slice(-80),
  );
  check("and the second one's id goes with its tag", !headingAndBody.includes('xml:id="p2"'));

  const coverOn = plan(doc, { joins: [AT.cover] });
  check(
    'a heading joined onto a body paragraph closes as a body paragraph',
    balanced(coverOn) && findOdtParagraphs(coverOn)[AT.cover].kind === 'p',
  );

  const blank = plan(doc, { joins: [AT.bold] });
  check(
    'an empty paragraph written as one tag joins onto the line before it',
    count(blank) === P.length - 1 && balanced(blank) && bodyTexts(blank).includes('Prvi odlomak s podebljanim krajem'),
  );

  const chain = plan(doc, { joins: [AT.bold, AT.blank] });
  check(
    'a chain — Delete, Delete — across an empty line makes one line',
    count(chain) === P.length - 2 &&
      balanced(chain) &&
      bodyTexts(chain).includes('Prvi odlomak s podebljanim krajemDesno, s poveznicom ovdje i dalje.'),
    JSON.stringify(bodyTexts(chain).slice(2, 4)),
  );

  check('an empty first line is not joined — Backspace there takes it away instead', plan(doc, { joins: [AT.blank] }) === doc.xml);
  check(
    "and the plan's question about it says it is empty",
    odtShowsNothing(doc.xml, doc.pieces, P[AT.blank]) && !odtShowsNothing(doc.xml, doc.pieces, P[AT.bold]),
  );
  check(
    'a line whose text was typed away is empty too',
    odtShowsNothing(doc.xml, doc.pieces, P[AT.last], new Map([[pieceOf('Zadnji odlomak.').index, '']])),
  );

  const across = plan(doc, { joins: [AT.bold], removals: [AT.blank] });
  check(
    'a join across a paragraph the plan takes away reaches the next one',
    count(across) === P.length - 2 && bodyTexts(across).includes('Prvi odlomak s podebljanim krajemDesno, s poveznicom ovdje i dalje.'),
  );

  const refused = [
    ['before a paragraph that starts a page', AT.link, 'the paragraph starts a page'],
    ['across a list', AT.pageBreak, 'something stands between the two paragraphs'],
    ['across a table', AT.commentEnd, 'something stands between the two paragraphs'],
    ['where a tracked change is recorded', AT.tracked, 'a tracked change is recorded where the paragraphs meet'],
    ['after the last paragraph', AT.last, 'nothing follows the paragraph'],
  ];
  for (const [label, index, reason] of refused) {
    const why = odtJoinRefusal(doc.xml, P, doc.styles, index);
    check(`not joined: ${label}`, why === reason && plan(doc, { joins: [index] }) === doc.xml, why ?? 'allowed');
  }
  check(
    'a join yields to a paragraph the plan adds after its first',
    !plan(doc, { joins: [AT.heading], inserts: [{ after: AT.heading, text: MARKER }] }).includes('čćžšđPrvi'),
  );
}

/* ── a new row in a table ────────────────────────────────────────────── */

/** Documents with a new row in them, for LibreOffice to read back below. */
const readableTables = [];

const cell = (text, attrs = '') =>
  `<table:table-cell table:style-name="C1" office:value-type="string"${attrs}><text:p text:style-name="Table_20_Contents">${text}</text:p></table:table-cell>`;
const TABLE =
  `<table:table table:name="Tablica"><table:table-column table:number-columns-repeated="2"/>` +
  `<table:table-header-rows><table:table-row table:style-name="R1">${cell('Glava A')}${cell('Glava B')}</table:table-row></table:table-header-rows>` +
  `<table:table-row>${cell('Spojeno dolje', ' table:number-rows-spanned="2"')}${cell('desno 1')}</table:table-row>` +
  `<table:table-row><table:covered-table-cell table:style-name="C2"/>${cell('desno 2')}</table:table-row>` +
  `<table:table-row>${cell('Široko', ' table:number-columns-spanned="2"')}<table:covered-table-cell/></table:table-row>` +
  `<table:table-row>${cell('isto', ' table:number-columns-repeated="2"')}</table:table-row>` +
  `<table:table-row table:number-rows-repeated="3">${cell('')}${cell('')}</table:table-row>` +
  `</table:table>`;
const ROW = { header: 0, merged: 1, covered: 2, wide: 3, repeatedCells: 4, repeated: 5 };

{
  const archive = unzipSync(makeOdtParagraphs());
  const xml = strFromU8(archive['content.xml']).replace(
    '<text:p text:style-name="Text_20_body">Zadnji odlomak.</text:p>',
    `${TABLE}<text:p text:style-name="Text_20_body">Zadnji odlomak.</text:p>`,
  );
  const tabled = open(writeOdf(archive, xml));
  const rows = findOdtRows(tabled.xml);
  const own = rows.filter((row) => row.table === rows[rows.length - 1].table);
  const R = (at) => own[at];
  const rowCount = (part) => findOdtRows(part).length;
  const withRows = (inserts) => plan(tabled, { rows, rowInserts: inserts });

  check('a row inside a merge is told apart from one beside it', R(ROW.covered).continued && !R(ROW.wide).continued);
  check('a new row below a merged cell goes below the last row it reaches', anchorOdtRow(rows, R(ROW.merged)) === R(ROW.covered));
  check(
    'and has a cell of its own where the merge covered one',
    JSON.stringify(odtRowShape(anchorOdtRow(rows, R(ROW.merged)))) === '[1,1]',
    JSON.stringify(odtRowShape(anchorOdtRow(rows, R(ROW.merged)))),
  );
  check('a cell spanning columns keeps its span', JSON.stringify(odtRowShape(R(ROW.wide))) === '[2]');
  check('a cell written once for two is two cells', JSON.stringify(odtRowShape(R(ROW.repeatedCells))) === '[1,1]');
  check(
    'a row written once for three is not added among them',
    odtRowRefusal(rows, R(ROW.repeated).index) === 'the row stands for several rows',
  );
  check(
    "a table cell's own table is the body's — a table in the text is not refused",
    odtRowRefusal(rows, R(ROW.header).index) === null,
  );

  const below = withRows([{ after: R(ROW.merged).index, cells: ['nova lijevo', 'nova desno'] }]);
  const added = addedAt(tabled.xml, below, R(ROW.covered).end);
  check('a new row: still well formed, one row more', balanced(below) && rowCount(below) === rows.length + 1);
  check(
    'it is the row it follows, emptied: styles built, the merge not carried down, the typed text in',
    added ===
      '<table:table-row><table:table-cell table:style-name="C2"><text:p>nova lijevo</text:p></table:table-cell>' +
        '<table:table-cell table:style-name="C1" office:value-type="string"><text:p text:style-name="Table_20_Contents">nova desno</text:p></table:table-cell></table:table-row>',
    added ?? 'something else changed',
  );
  const wide = addedAt(tabled.xml, withRows([{ after: R(ROW.wide).index, cells: ['široko novo'] }]), R(ROW.wide).end);
  check(
    'a row after a wide cell is as wide',
    wide !== null && wide.includes('table:number-columns-spanned="2"') && wide.includes('<table:covered-table-cell/>'),
    wide ?? '',
  );
  const header = addedAt(tabled.xml, withRows([{ after: R(ROW.header).index, cells: ['a', ''] }]), R(ROW.header).end);
  check(
    "a row after the header row takes the row's style, and an empty cell an empty paragraph",
    header !== null && header.startsWith('<table:table-row table:style-name="R1">') && header.includes('<text:p text:style-name="Table_20_Contents"/>'),
    header ?? '',
  );
  check('a row nobody typed into is not written', withRows([{ after: R(ROW.merged).index, cells: ['', ''] }]) === tabled.xml);
  check('nor one among repeated rows', withRows([{ after: R(ROW.repeated).index, cells: ['x', 'y'] }]) === tabled.xml);
  const two = withRows([
    { after: R(ROW.wide).index, cells: ['prvi'] },
    { after: R(ROW.wide).index, cells: ['drugi'] },
  ]);
  check('two new rows after one keep their order', two.indexOf('prvi') < two.indexOf('drugi') && two.indexOf('prvi') > 0);
  readableTables.push(writeOdf(tabled.archive, below));

  /* Somebody else's numbers: two hundred cells each claiming 64 repeats of
     1024 columns, spanning down, over two thousand rows. */
  const wideCell = `<table:table-cell table:number-columns-repeated="64" table:number-columns-spanned="1024" table:number-rows-spanned="9"/>`;
  const hostile =
    `<office:document-content xmlns:office="o" xmlns:table="t" xmlns:text="x"><office:body><office:text><table:table>` +
    `<table:table-row>${wideCell.repeat(200)}</table:table-row>` +
    `<table:table-row><table:table-cell/></table:table-row>`.repeat(2000) +
    `</table:table></office:text></office:body></office:document-content>`;
  const started = Date.now();
  const hostileRows = findOdtRows(hostile);
  const took = Date.now() - started;
  check(
    'a table claiming millions of columns is followed only so far, quickly, and takes no new row',
    took < 3000 && odtRowRefusal(hostileRows, 0) === 'the table is wider than this program follows',
    `${took} ms, ${hostileRows.length} rows`,
  );
}

/* ── what somebody else's file can do (the review of card 459) ───────── */

/** Every part the writer produced, for a real parser to read below. */
const written = [];
const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink"';
const part = (body, ns = NS, before = '') =>
  `<?xml version="1.0" encoding="UTF-8"?>${before}<office:document-content ${ns}><office:body><office:text>${body}</office:text></office:body></office:document-content>`;
{
  const ghost = part(
    '<text:p>Alpha</text:p><?x a><text:p>ghost</text:p>?><text:p>Bravo</text:p><text:p>Charlie</text:p>',
  );
  check(
    'a processing instruction hides nothing from the scan that a parser would see, and the reverse',
    JSON.stringify(findOdtParagraphs(ghost).map((one) => textOf(ghost, one))) === '["Alpha","Bravo","Charlie"]',
    JSON.stringify(findOdtParagraphs(ghost).map((one) => textOf(ghost, one))),
  );
  const hostile = [
    ['a processing instruction in the part', ghost, 'a processing instruction'],
    [
      'an entity a DTD declares',
      part('<text:p>A</text:p>&e;', NS, '<!DOCTYPE x [<!ENTITY e "<text:p>E</text:p>">]>'),
      'a document type declaration',
    ],
    [
      'the text namespace bound again inside the part',
      part('<text:p>A</text:p><x:p xmlns:x="urn:oasis:names:tc:opendocument:xmlns:text:1.0">B</x:p>'),
      'a namespace declared inside the part',
    ],
    [
      'a text:p of some other namespace',
      part('<text:p>A</text:p><text:p xmlns:text="urn:evil">B</text:p>'),
      'a namespace declared inside the part',
    ],
    ['a default namespace', part('<text:p>A</text:p>', `${NS} xmlns="urn:x"`), 'a default namespace'],
    [
      'the text namespace bound to two prefixes',
      part('<text:p>A</text:p><t:p>B</t:p>', `${NS} xmlns:t="urn:oasis:names:tc:opendocument:xmlns:text:1.0"`),
      'a namespace bound to two prefixes',
    ],
    ['an element whose prefix nobody declared', part('<text:p>A</text:p><foo:bar/>'), 'an element in an undeclared namespace'],
  ];
  for (const [label, xml, reason] of hostile) {
    check(`shown and not edited: ${label}`, odtIsPlain(xml) === reason, odtIsPlain(xml) ?? 'taken for plain');
  }
  check('and a part as LibreOffice writes it is plain', odtIsPlain(doc.xml) === null, odtIsPlain(doc.xml) ?? '');
  check(
    'shown and not edited: the drawing namespace bound to two prefixes',
    odtIsPlain(part('<text:p>A</text:p>', `${NS} xmlns:d2="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"`)) ===
      'a namespace bound to two prefixes',
  );

  /* The second review: a root attribute whose name is not ASCII, holding
     "declarations" in its value. The scan must read the root as a parser
     does — the value is a value — and count the paragraphs a parser counts. */
  const hidden = part(
    '<text:p>S0</text:p><t2:p>D0</t2:p><text:p>S1</text:p><t2:p>D1</t2:p>',
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
      'xmlns:text="urn:evil" xmlns:t2="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
      `čx=' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:t2="urn:other"'`,
  );
  check(
    'a declaration hidden in a value whose name is not ASCII is not taken for one: the scan counts what a parser counts',
    JSON.stringify(findOdtParagraphs(hidden).map((one) => textOf(hidden, one))) === '["D0","D1"]',
    JSON.stringify(findOdtParagraphs(hidden).map((one) => textOf(hidden, one))),
  );
  const ownStyle = part(`<text:p čx=" text:style-name='X'" text:style-name="Y">A</text:p>`);
  check('and an attribute is never read out of another one’s value', findOdtParagraphs(ownStyle)[0].style === 'Y');

  const faked = part('<text:p>A</text:p>', `note=' xmlns:fake="urn:oasis:names:tc:opendocument:xmlns:text:1.0"' ${NS}`);
  const fakeDoc = { xml: faked, pieces: findOdtPieces(faked), paragraphs: findOdtParagraphs(faked), styles: readOdtStyles(faked, null) };
  check(
    'a namespace written inside an attribute value is not taken for a declaration',
    plan(fakeDoc, { inserts: [{ after: 0, text: 'dva  razmaka' }] }).includes('<text:s/>'),
  );

  const pictured = part(
    '<text:p>Prije</text:p><text:p><draw:frame draw:name="slika"><draw:image xlink:href="Pictures/a.emf"/></draw:frame></text:p><text:p>Poslije</text:p>',
  );
  const pic = { xml: pictured, pieces: findOdtPieces(pictured), paragraphs: findOdtParagraphs(pictured), styles: readOdtStyles(pictured, null) };
  check(
    'not removed: a line holding only a picture the view may not draw',
    odtRemovalRefusal(pictured, pic.paragraphs, pic.styles, 1) === 'the paragraph holds a picture or an object',
  );

  /* Places something points to (card 525, N4). Measured over the corpus, the
     marks in paragraphs that may go were all `_GoBack` and `_Hlk…`, pointed
     to by nothing — those still go. */
  const judge = (body, index, join = false) => {
    const xml = part(body);
    const paragraphs = findOdtParagraphs(xml);
    const styles = readOdtStyles(xml, null);
    return join ? odtJoinRefusal(xml, paragraphs, styles, index) : odtRemovalRefusal(xml, paragraphs, styles, index);
  };
  check(
    'not removed: a line a cross-reference points to',
    judge('<text:p>A</text:p><text:p><text:bookmark text:name="cilj"/></text:p><text:p>Vidi <text:bookmark-ref text:ref-name="cilj">1</text:bookmark-ref></text:p>', 1) ===
      'the paragraph holds a place something else points to',
  );
  check(
    'nor one a link within the document points to',
    judge('<text:p>A</text:p><text:p><text:bookmark-start text:name="cilj"/>x<text:bookmark-end text:name="cilj"/></text:p><text:p><text:a xlink:href="#cilj|outline">tu</text:a></text:p>', 1) ===
      'the paragraph holds a place something else points to',
  );
  check(
    'nor one holding half of a bookmark that runs on',
    judge('<text:p><text:bookmark-start text:name="r"/>A</text:p><text:p>B<text:bookmark-end text:name="r"/></text:p><text:p>C</text:p>', 0) ===
      'a bookmark continues outside the paragraph',
  );
  check(
    'but a line holding a mark nothing points to still goes',
    judge('<text:p>A</text:p><text:p><text:bookmark text:name="_GoBack"/></text:p><text:p>C</text:p>', 1) === null,
  );

  const controls = plan(doc, { inserts: [{ after: AT.bold, text: 'a\u000Bb\u000Cc\u0001d\uD800e' }] });
  check(
    'what XML cannot hold is left out of what was typed',
    controls.includes('>abcde<') && !/[\u0001\u000B\u000C]/.test(controls),
  );
  written.push(controls);

  const oddStyles =
    `<office:document-styles ${NS} xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"><office:styles>` +
    `<style:style style:name="Text_20_body" style:family="paragraph" style:next-style-name="a&amp;b&lt;c&e;"/></office:styles></office:document-styles>`;
  const odd = { ...doc, styles: readOdtStyles(doc.xml, oddStyles) };
  const oddOut = plan(odd, { inserts: [{ after: AT.bold, text: 'x' }] });
  check(
    'a style name out of styles.xml goes in escaped once, not twice and not raw',
    oddOut.includes('text:style-name="a&amp;b&lt;c&amp;e;"'),
    /text:style-name="a[^"]*c"/.exec(oddOut)?.[0] ?? 'not found',
  );
  written.push(oddOut);

  /* Cost: tables nested a thousand deep, and twenty thousand named comments. */
  let nest = '<table:table-row><table:table-cell><text:p>x</text:p></table:table-cell></table:table-row>';
  for (let i = 0; i < 1000; i++) nest = `<table:table><table:table-row><table:table-cell>${nest}</table:table-cell></table:table-row></table:table>`;
  const deep = part(`<table:table>${nest}</table:table>${'<table:table><table:table-row><table:table-cell/></table:table-row></table:table>'.repeat(20000)}`);
  let started = Date.now();
  findOdtRows(deep);
  const deepTook = Date.now() - started;
  check('tables nested a thousand deep are read in one pass', deepTook < 1500, `${deepTook} ms`);

  const comments = part(
    `<text:p>${'<office:annotation office:name="c"><text:p>k</text:p></office:annotation>'.repeat(20000)}</text:p><text:p>B</text:p>`,
  );
  const commented = findOdtParagraphs(comments);
  started = Date.now();
  odtRemovalRefusal(comments, commented, readOdtStyles(comments, null), 0);
  const commentsTook = Date.now() - started;
  check('twenty thousand named comments are judged without reading the part for each', commentsTook < 1500, `${commentsTook} ms`);
}

/* ── everything at once ──────────────────────────────────────────────── */

{
  const reshaping = {
    inserts: [{ after: AT.last, text: MARKER }],
    removals: [AT.blank],
    cuts: [{ piece: pieceOf('Poglavlje čćžšđ').index, parts: ['Poglavlje', ' čćžšđ'] }],
    joins: [AT.heading],
  };
  const out = plan(doc, reshaping);
  check('every kind of step in one plan: well formed', balanced(out));
  check('and the count is the sum of the steps', count(out) === P.length + 1 - 1 + 1 - 1, `${P.length} → ${count(out)}`);
  check('and twice is the same bytes', plan(doc, reshaping) === out);
}

/* ── the corpus: what LibreOffice writes ─────────────────────────────── */

const SOFFICE = [
  process.env.ULEDITOR_SOFFICE,
  'C:/Program Files/LibreOffice/program/soffice.com',
  'C:/Program Files (x86)/LibreOffice/program/soffice.com',
  '/usr/bin/soffice',
  '/usr/local/bin/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
]
  .filter(Boolean)
  .find((path) => existsSync(path));

const work = mkdtempSync(join(tmpdir(), 'ul-odt-paragraphs-'));
const profile = pathToFileURL(join(work, 'profile')).href;

/** One LibreOffice, a private profile, a batch of files; the outputs are the answer, not the exit code. */
function convert(sources, filter, outdir) {
  mkdirSync(outdir, { recursive: true });
  try {
    execFileSync(
      SOFFICE,
      [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--invisible', '--nolockcheck',
        '--nodefault', '--nofirststartwizard', '--convert-to', filter, '--outdir', outdir, ...sources],
      { stdio: 'ignore', timeout: 900000 },
    );
  } catch {
    /* The files are the answer. */
  }
}

function walk(dir, pattern, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/^(node_modules|\.git|AppData|ComfyUI.*)$/.test(entry.name)) walk(full, pattern, out, depth + 1);
    } else if (pattern.test(entry.name) && !entry.name.startsWith('~$')) out.push(full);
  }
  return out;
}

check('LibreOffice is installed', !!SOFFICE, SOFFICE ?? 'not found — set ULEDITOR_SOFFICE; this check refuses to pass without it');

const corpus = process.env.UL_CORPUS ?? join(process.env.USERPROFILE ?? '', 'Documents');
const words = walk(corpus, /\.docx$/i);
const odts = walk(corpus, /\.odt$/i);
check('a corpus of real documents was walked', words.length + odts.length > 0, `${words.length} .docx and ${odts.length} .odt under ${corpus}`);

const files = [...odts];
if (SOFFICE && words.length) {
  const src = join(work, 'src');
  mkdirSync(src);
  /* Copied under plain names: two documents of one name in different folders
     would otherwise be one output. */
  const copies = words.map((file, i) => {
    const copy = join(src, `d${String(i).padStart(3, '0')}.docx`);
    copyFileSync(file, copy);
    return copy;
  });
  convert(copies, 'odt', join(work, 'odt'));
  const made = readdirSync(join(work, 'odt')).map((name) => join(work, 'odt', name));
  check('LibreOffice wrote the Word documents as OpenDocument', made.length > 0, `${made.length} of ${words.length}`);
  files.push(...made);
}

const stats = { files: 0, body: 0, list: 0, elsewhere: 0, inserts: 0, removals: 0, cuts: 0, joins: 0, rows: 0, rowsOffered: 0 };
const damaged = [];
const readable = [];
const notPlain = [];
/** The corpus's parts as they were read, for the parser to read again below. */
const originals = [];

for (const file of files) {
  let one;
  try {
    one = open(readFileSync(file));
  } catch {
    continue;
  }
  stats.files++;
  if (odtIsPlain(one.xml) !== null) notPlain.push(`${basename(file)}: ${odtIsPlain(one.xml)}`);
  originals.push({ name: basename(file), xml: one.xml });
  const body = one.paragraphs.filter((span) => span.refusal === null);
  stats.body += body.length;
  stats.list += one.paragraphs.filter((span) => span.refusal === 'the paragraph is in a list').length;
  stats.elsewhere += one.paragraphs.length - body.length;

  /* One of each step, spread through the document rather than taken from its front. */
  const middle = (list) => list[Math.floor(list.length / 2)];
  const after = middle(body);
  const removable = body.filter((span) => span !== after && odtRemovalRefusal(one.xml, one.paragraphs, one.styles, span.index) === null);
  const divisible = one.pieces.filter(
    (piece) => piece.text.length >= 2 && odtDivisionRefusal(one.xml, one.paragraphs, one.styles, piece) === null,
  );
  const joinable = body.filter(
    (span) =>
      odtJoinRefusal(one.xml, one.paragraphs, one.styles, span.index) === null &&
      !odtShowsNothing(one.xml, one.pieces, span),
  );

  const steps = [];
  if (after) steps.push(['insert', { inserts: [{ after: after.index, text: MARKER }] }, +1]);
  const removal = middle(removable);
  if (removal) steps.push(['removal', { removals: [removal.index] }, -1]);
  const cut = middle(divisible);
  if (cut) {
    const half = Math.ceil(cut.text.length / 2);
    steps.push(['cut', { cuts: [{ piece: cut.index, parts: [cut.text.slice(0, half), cut.text.slice(half)] }] }, +1]);
  }
  const join = middle(joinable);
  if (join) steps.push(['join', { joins: [join.index] }, -1]);
  const rows = findOdtRows(one.xml);
  const rowable = rows.filter((row) => odtRowRefusal(rows, row.index) === null);
  const rowAfter = middle(rowable);
  if (rowAfter) {
    const shape = odtRowShape(anchorOdtRow(rows, rowAfter));
    steps.push(['row', { rows, rowInserts: [{ after: rowAfter.index, cells: shape.map((_, k) => `ulRed${k}`) }] }, shape.length]);
    stats.rowsOffered += rowable.length;
  }

  for (const [kind, reshaping, delta] of steps) {
    stats[`${kind === 'removal' ? 'removals' : kind === 'insert' ? 'inserts' : `${kind}s`}`]++;
    const out = plan(one, reshaping);
    written.push(out);
    const rowsRight = kind !== 'row' || findOdtRows(out).length === findOdtRows(one.xml).length + 1;
    const ok = balanced(out) && rowsRight && count(out) === one.paragraphs.length + delta && plan(one, reshaping) === out;
    if (!ok) damaged.push(`${basename(file)}: ${kind} (${one.paragraphs.length} → ${count(out)}, balanced ${balanced(out)})`);
  }

  if (readable.length < 12) {
    /* For the reader that is not ours: every step at once, each on a
       paragraph of its own, with markers it can be asked about. The cut's
       halves and the join's first line carry words of their own, so a line
       LibreOffice shows says which happened. */
    const joining = joinable.find((span) => {
      const next = body.find((other) => other.index > span.index);
      return span !== after && next && !odtShowsNothing(one.xml, one.pieces, next) && lastPieceOf(one.xml, one.pieces, one.paragraphs, span);
    });
    const cutting = joining
      ? divisible.find((piece) => {
          const at = paragraphOf(one.paragraphs, piece);
          return at !== after && at !== joining && piece.index !== lastPieceOf(one.xml, one.pieces, one.paragraphs, joining)?.index;
        })
      : undefined;
    const partner = joining ? body.find((span) => span.index > joining.index) : undefined;
    if (partner && odtShowsNothing(one.xml, one.pieces, partner)) continue;
    const taking = cutting
      ? removable.find(
          (span) => span !== joining && span !== partner && span !== paragraphOf(one.paragraphs, cutting) && span.index > joining.index + 1,
        )
      : undefined;
    if (after && joining && cutting && taking) {
      const last = lastPieceOf(one.xml, one.pieces, one.paragraphs, joining);
      const half = Math.ceil(cutting.text.length / 2);
      const out = plan(
        one,
        {
          inserts: [{ after: after.index, text: MARKER }],
          removals: [taking.index],
          cuts: [{ piece: cutting.index, parts: [`${cutting.text.slice(0, half)} ulRezA`, `ulRezB ${cutting.text.slice(half)}`] }],
          joins: [joining.index],
          ...(rowAfter
            ? { rows, rowInserts: [{ after: rowAfter.index, cells: odtRowShape(anchorOdtRow(rows, rowAfter)).map(() => 'ulRedak') }] }
            : {}),
        },
        [{ index: last.index, text: `${last.text} ulSpojA` }],
      );
      readable.push({ file, bytes: writeOdf(one.archive, out), original: readFileSync(file), row: !!rowAfter });
    }
  }
}

check('the corpus was read', stats.files > 0, `${stats.files} files: ${stats.body} body paragraphs, ${stats.list} in lists, ${stats.elsewhere - stats.list} elsewhere`);
check(
  'every step of every kind kept the part whole, counted right and wrote the same bytes twice',
  damaged.length === 0 && stats.inserts + stats.removals + stats.cuts + stats.joins > 0,
  damaged.length
    ? damaged.slice(0, 4).join(' | ')
    : `${stats.inserts} insertions, ${stats.removals} removals, ${stats.cuts} divisions, ${stats.joins} joins, ${stats.rows} rows (${stats.rowsOffered} rows could take one)`,
);

check(
  'every document in the corpus is plain enough to edit — the gate costs LibreOffice’s own files nothing',
  stats.files > 0 && notPlain.length === 0,
  notPlain.slice(0, 3).join(' | ') || `${stats.files} files`,
);

/* ── read by a real parser ───────────────────────────────────────────── */

/* The writer's own `balanced` shares the writer's scanner; a parser that
   shares nothing with it reads every part it wrote here — the same parser
   the editor reads them back with, which refuses to save what it cannot. */
{
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let broken = [];
  for (let at = 0; at < written.length; at += 20) {
    const batch = written.slice(at, at + 20);
    const errors = await page.evaluate(
      (parts) =>
        parts.map((xml) => {
          const parsed = new DOMParser().parseFromString(xml, 'application/xml');
          return parsed.getElementsByTagName('parsererror')[0]?.textContent?.slice(0, 120) ?? null;
        }),
      batch,
    );
    broken = broken.concat(errors.map((error, k) => (error ? `#${at + k}: ${error}` : null)).filter(Boolean));
  }
  check('a real XML parser reads every part the writer wrote', written.length > 0 && broken.length === 0, broken[0] ?? `${written.length} parts`);

  /* And every corpus part reads alike to the scan and to the parser, as the
     reader asks before it names anything (`sameAsParsed` in odf.ts): the
     root's declarations, and every element by name, in order. */
  const unlike = [];
  for (const one of originals) {
    const parsed = await page.evaluate((xml) => {
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      const root = doc.documentElement;
      return {
        ns: [...root.attributes]
          .filter((a) => a.namespaceURI === 'http://www.w3.org/2000/xmlns/')
          .map((a) => [a.prefix ? a.localName : '', a.value]),
        names: [...doc.querySelectorAll('*')].map((e) => e.tagName),
      };
    }, one.xml);
    const scanned = rootNamespaces(one.xml);
    const sameNs = parsed.ns.length === scanned.size && parsed.ns.every(([prefix, uri]) => scanned.get(prefix) === uri);
    const names = scannedElements(one.xml);
    const sameNames = names.length === parsed.names.length && names.every((name, i) => name === parsed.names[i]);
    if (!sameNs || !sameNames) unlike.push(one.name);
  }
  await browser.close();
  check(
    'every corpus part reads alike to the scan and to a parser, so the reader names its paragraphs',
    originals.length > 0 && unlike.length === 0,
    unlike.slice(0, 3).join(', ') || `${originals.length} parts`,
  );
}

/* ── read back by LibreOffice ────────────────────────────────────────── */

if (SOFFICE) {
  /* The fixture too, with the join and a division in the paragraph it joins:
     the line LibreOffice shows first runs from the heading into the body
     paragraph's first half. */
  const fixtureOut = plan(
    doc,
    {
      inserts: [{ after: AT.last, text: MARKER }],
      removals: [AT.blank],
      cuts: [{ piece: pieceOf('Prvi odlomak s ').index, parts: ['Prvi odlomak ulRezA', 'ulRezB s '] }],
      joins: [AT.heading],
    },
    [{ index: pieceOf('Poglavlje čćžšđ').index, text: 'Poglavlje čćžšđ ulSpojA' }],
  );
  readable.unshift({ file: 'fixture.odt', bytes: writeOdf(doc.archive, fixtureOut), original: makeOdtParagraphs() });
  /* The table fixture, its new row typed into: only the row is asked about. */
  for (const bytes of readableTables) {
    readable.push({ file: 'table.odt', bytes, original: makeOdtParagraphs(), rowOnly: true });
  }

  const back = join(work, 'back');
  mkdirSync(back);
  const sources = [];
  readable.forEach((one, i) => {
    const edited = join(back, `e${i}.odt`);
    const original = join(back, `o${i}.odt`);
    writeFileSync(edited, one.bytes);
    writeFileSync(original, one.original);
    sources.push(edited, original);
  });
  convert(sources, 'txt', join(back, 'txt'));
  const lines = (name) => {
    const path = join(back, 'txt', `${name}.txt`);
    return existsSync(path) ? readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/) : null;
  };

  let opened = 0;
  const wrong = [];
  const unread = [];
  readable.forEach((one, i) => {
    const original = lines(`o${i}`);
    if (!original || original.join('').trim() === '') {
      unread.push(basename(one.file)); // LibreOffice never read the original: nothing to ask.
      return;
    }
    const edited = lines(`e${i}`);
    if (!edited || edited.join('').trim() === '') {
      wrong.push(`${basename(one.file)}: LibreOffice could not open what was written`);
      return;
    }
    opened++;
    const line = (word) => edited.find((text) => text.includes(word));
    if (one.rowOnly) {
      if (!line('nova lijevo') || !line('nova desno')) wrong.push(`${basename(one.file)}: the new row is not shown`);
      return;
    }
    if (one.row && !line('ulRedak')) wrong.push(`${basename(one.file)}: the new row is not shown`);
    if (!edited.some((text) => text.trim() === MARKER)) wrong.push(`${basename(one.file)}: no line of its own for the new paragraph`);
    if (!line('ulRezA') || !line('ulRezB') || line('ulRezA') === line('ulRezB')) {
      wrong.push(`${basename(one.file)}: the divided paragraph is not two lines`);
    }
    const joined = line('ulSpojA');
    if (!joined || joined.trim().endsWith('ulSpojA')) wrong.push(`${basename(one.file)}: the joined paragraphs are not one line`);
  });
  check(
    'LibreOffice opens every file it could open before, with the plan written in',
    opened > 0 && !wrong.some((one) => one.includes('could not open')),
    `${opened} of ${readable.length}${unread.length ? `; the originals of ${unread.join(', ')} gave LibreOffice no text either` : ''}`,
  );
  check('the fixture is among them', !unread.includes('fixture.odt'));
  check(
    'and shows the lines the plan made: a new one, a divided one as two, two joined as one, a new row',
    opened > 0 && wrong.length === 0,
    wrong.slice(0, 3).join(' | ') || `${opened} documents`,
  );
}

try {
  rmSync(work, { recursive: true, force: true });
} catch {
  /* A LibreOffice still letting go of its profile; the folder is the system's to clear. */
}

const failed = checks.filter((one) => !one.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
