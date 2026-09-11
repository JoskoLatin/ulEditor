/**
 * Two paragraphs joined into one — what Backspace does at the start of a
 * paragraph, and Delete at the end of the one before.
 *
 * [`verify-docx-split.mjs`](./verify-docx-split.mjs) asks what happens when a
 * boundary appears where there was none. This asks the other way round, and
 * the question that decides everything is one a file cannot answer: **whose
 * properties does the joined paragraph keep?** Word was asked, over COM, with
 * both keys, on documents Word made itself:
 *
 * - **the first paragraph's** — heading and body text joined is a heading,
 *   body text and a heading is body text, centred and left is centred, a list
 *   item and body text is a list item, and the other way round each time;
 * - **unless the first shows nothing.** Then Word deletes it and the paragraph
 *   below keeps its own properties — an empty line before a heading, joined,
 *   is the heading. "Nothing" was asked too: a paragraph holding only a
 *   bookmark, a proofing mark, an empty text element, a run with nothing but
 *   formatting or the page break Word remembers from its last layout is empty;
 *   a tab or a single space is not. The bookmark goes with it.
 * - **A range mark between the two** — a body-level `w:bookmarkEnd`, which
 *   five real files keep — is carried into the joined paragraph, at the join.
 *
 * So a join is written as the boundary it removes and nothing else: the first
 * paragraph's closing tag, whatever stood between, and the next one's opening
 * tag and properties. The expected output is built here without the writer —
 * the original's own byte ranges, a paragraph's opening read by a pattern of
 * this file's own — and the writer has to produce exactly that.
 *
 *   node tools/verify-docx-join.mjs
 */

import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeDocx } from './fixtures.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const {
  findRuns,
  findParagraphs,
  paragraphOfRun,
  readStyleSuccession,
  joinRefusal,
  showsNothing,
  propertiesAlike,
  applyDocxEdits,
  writeDocx,
  runText,
  escapeXml,
  unescapeXml,
} = await import(pathToFileURL(resolve(ROOT, 'packages/editor-office/src/docx-edit.ts')).href);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

function open(bytes) {
  const archive = unzipSync(bytes);
  const xml = strFromU8(archive['word/document.xml']);
  const styles = archive['word/styles.xml'] ? strFromU8(archive['word/styles.xml']) : null;
  return { archive, xml, runs: findRuns(xml), paragraphs: findParagraphs(xml), succession: readStyleSuccession(styles) };
}

function read(xml) {
  return { xml, runs: findRuns(xml), paragraphs: findParagraphs(xml), succession: { next: new Map(), fallback: '' } };
}

const contrive = (body) => `<w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`;
const para = (text, inner = '') => `<w:p>${inner}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const plan = (doc, { joins = [], cuts = [], inserts = [], removals = [], succession = doc.succession } = {}) => ({
  paragraphs: doc.paragraphs,
  succession,
  inserts,
  removals,
  cuts,
  joins,
});

const write = (doc, reshaping, edits = []) => applyDocxEdits(doc.xml, doc.runs, edits, plan(doc, reshaping));
const countParagraphs = (xml) => findParagraphs(xml).length;
const body = (doc) => doc.paragraphs.filter((span) => span.refusal === null);
const runWith = (doc, text) => doc.runs.find((run) => run.text && runText(doc.xml, run) === text);
const paragraphWith = (doc, text) => paragraphOfRun(doc.paragraphs, runWith(doc, text));

/* ── the expected output, built without the writer ───────────────────── */

const t = (text) => `<w:t xml:space="preserve">${escapeXml(text)}</w:t>`;
const CLOSE = '</w:p>';

/** A paragraph's opening tag and its own properties, by a pattern of this file's own; `null` for `<w:p/>`. */
function openingOf(xml, paragraph) {
  const head = /^<w:p(?:\s[^>]*?)?(\/?)>(<w:pPr(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:pPr>))?/.exec(
    xml.slice(paragraph.start, paragraph.end),
  );
  return head[1] === '/' ? null : head[0];
}

/** A paragraph's own `w:pPr`, as its bytes stand — or nothing. */
function propsOf(xml, paragraph) {
  const found = /^<w:p(?:\s[^>]*?)?>(<w:pPr(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:pPr>))?/.exec(xml.slice(paragraph.start, paragraph.end));
  return found?.[1] ?? '';
}

function formattingOf(xml, run) {
  return /<w:rPr(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:rPr>)/.exec(xml.slice(run.start, run.text.start))?.[0] ?? '';
}

/**
 * The original with the boundaries after `firsts` taken out. Each boundary is
 * the first paragraph's closing tag up to the end of the next one's opening —
 * its tag and properties — with what stood between kept, at the join. A
 * `<w:p/>` at the end of a chain gets the closing tag it never had.
 */
function joined(xml, pairs) {
  let out = xml;
  const nexts = new Set(pairs.map(([, next]) => next.index));
  const firsts = new Set(pairs.map(([first]) => first.index));
  for (const [first, next, carried = xml.slice(first.end, next.start)] of [...pairs].sort((a, b) => b[0].start - a[0].start)) {
    const from = nexts.has(first.index) && openingOf(xml, first) === null ? first.end : first.end - CLOSE.length;
    const opening = openingOf(xml, next);
    const to = opening === null ? next.end : next.start + opening.length;
    const closing = opening === null && !firsts.has(next.index) ? CLOSE : '';
    out = out.slice(0, from) + carried + closing + out.slice(to);
  }
  return out;
}

/** The text a paragraph shows, as its runs hold it. */
const textOf = (xml, span) =>
  [...xml.slice(span.start, span.end).matchAll(/<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([^<]*)</g)]
    .map((m) => unescapeXml(m[1]))
    .join('');

/* ── what Word answered, kept as the rule's own check ────────────────── */

/*
 * The ten paragraphs Word was shown before a heading, and what it did with
 * each when Backspace joined them: `true` where it deleted the paragraph and
 * kept the heading, `false` where the joined paragraph kept the first one's
 * properties. Asked over COM with `Selection.TypeBackspace` at the start of
 * the heading and `Selection.Delete` at the end of the paragraph before; both
 * keys agreed on all ten.
 */
const WORD_SAID = [
  ['only a bookmark', '<w:p><w:bookmarkStart w:id="0" w:name="oznaka"/><w:bookmarkEnd w:id="0"/></w:p>', true],
  ['an empty text element', '<w:p><w:r><w:t></w:t></w:r></w:p>', true],
  ['a run with nothing but its formatting', '<w:p><w:r><w:rPr><w:b/></w:rPr></w:r></w:p>', true],
  ['the page break of the last layout', '<w:p><w:r><w:lastRenderedPageBreak/></w:r></w:p>', true],
  ['properties and nothing else', '<w:p><w:pPr><w:jc w:val="center"/></w:pPr></w:p>', true],
  ['only proofing marks', '<w:p><w:proofErr w:type="spellStart"/><w:proofErr w:type="spellEnd"/></w:p>', true],
  ['<w:p/>', '<w:p/>', true],
  ['a tab', '<w:p><w:r><w:tab/></w:r></w:p>', false],
  ['a single space', '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t xml:space="preserve"> </w:t></w:r></w:p>', false],
  ['a word', para('Prvi'), false],
];
{
  const wrong = [];
  for (const [what, markup, empty] of WORD_SAID) {
    const doc = read(contrive(markup + para('Naslov', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>')));
    if (showsNothing(doc.xml, body(doc)[0], doc.runs) !== empty) wrong.push(what);
  }
  check('what shows nothing is what Word called empty, in all ten paragraphs it was shown', wrong.length === 0, wrong.join(', ') || '10/10');
}
{
  /* Formatting written long-hand is still formatting: an element inside a
     `w:rPr` that closes with a tag of its own does not end the properties. */
  const doc = read(
    contrive(
      '<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial"></w:rFonts><w:b/></w:rPr></w:r></w:p>' +
        para('Naslov', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
    ),
  );
  check('a run whose formatting is written long-hand, and that holds nothing else, shows nothing', showsNothing(doc.xml, body(doc)[0], doc.runs));
}

/* ── the fixture ─────────────────────────────────────────────────────── */

const fixture = open(makeDocx());
const [title, opening, formatted, listHeading, firstItem, secondItem, tableHeading] = body(fixture);

{
  const out = write(fixture, { joins: [title.index] });
  check(
    'a heading joined with the paragraph after it is exactly the original without the boundary between them',
    out === joined(fixture.xml, [[title, opening]]),
    `${countParagraphs(fixture.xml)} → ${countParagraphs(out)} paragraphs`,
  );
  check('and it is one paragraph shorter', countParagraphs(out) === countParagraphs(fixture.xml) - 1);
  const merged = findParagraphs(out)[0];
  check(
    'and the joined paragraph keeps the first one\'s properties, the heading, with both texts in it',
    propsOf(out, merged) === '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' &&
      textOf(out, merged) === 'Fidelity reportAn opening paragraph with diacritics: čćšžđ.',
    textOf(out, merged),
  );
}

check(
  'a paragraph joined with one of two formatted runs takes both of them in, unread',
  write(fixture, { joins: [opening.index] }) === joined(fixture.xml, [[opening, formatted]]),
);
check(
  'two list items joined are one list item',
  write(fixture, { joins: [firstItem.index] }) === joined(fixture.xml, [[firstItem, secondItem]]),
);
{
  const out = write(fixture, { joins: [listHeading.index] });
  check(
    'a heading joined with the list item after it is a heading — the item\'s numbering goes with its properties',
    out === joined(fixture.xml, [[listHeading, firstItem]]) &&
      (out.match(/<w:numId w:val="1"\/>/g) ?? []).length === 1,
  );
}
{
  const out = write(fixture, { joins: [title.index, opening.index] });
  check(
    'Delete twice: three paragraphs joined into one',
    out === joined(fixture.xml, [[title, opening], [opening, formatted]]) &&
      countParagraphs(out) === countParagraphs(fixture.xml) - 2,
  );
}

/* ── in the same save as everything else ─────────────────────────────── */

{
  const out = write(fixture, { joins: [title.index] }, [
    { index: runWith(fixture, 'Fidelity report').index, text: 'Izvješće' },
    { index: runWith(fixture, 'An opening paragraph with diacritics: čćšžđ.').index, text: 'Uvod' },
  ]);
  const heading = runWith(fixture, 'Fidelity report');
  const plain = runWith(fixture, 'An opening paragraph with diacritics: čćšžđ.');
  const expected =
    fixture.xml.slice(0, heading.text.start) +
    t('Izvješće') +
    fixture.xml.slice(heading.text.end, title.end - CLOSE.length) +
    fixture.xml.slice(title.end, opening.start) +
    fixture.xml.slice(opening.start + openingOf(fixture.xml, opening).length, plain.text.start) +
    t('Uvod') +
    fixture.xml.slice(plain.text.end);
  check('the runs of both paragraphs rewritten in the same save are written where they stand', out === expected);
}

{
  /* Removed and then joined across: Backspace twice after a blank line. */
  const out = write(fixture, { removals: [opening.index], joins: [title.index] });
  check(
    'a paragraph removed between two that are joined goes with the boundary',
    out === joined(fixture.xml, [[title, formatted, fixture.xml.slice(title.end, opening.start) + fixture.xml.slice(opening.end, formatted.start)]]),
  );
}

{
  const out = write(fixture, { joins: [title.index], inserts: [{ after: title.index, text: 'Novi' }] });
  const inserted = write(fixture, { inserts: [{ after: title.index, text: 'Novi' }] });
  check(
    'a join yields to a paragraph added after its first paragraph — that paragraph would land inside the boundary',
    out === inserted && out !== fixture.xml,
  );
}

{
  /* A cut in the first paragraph: its last piece is what the next one joins. */
  const run = runWith(fixture, 'An opening paragraph with diacritics: čćšžđ.');
  const out = write(fixture, { joins: [opening.index], cuts: [{ run: run.index, parts: ['An opening', ' paragraph with diacritics: čćšžđ.'] }] });
  const expected =
    fixture.xml.slice(0, run.text.start) +
    t('An opening') +
    `</w:r></w:p><w:p><w:r>${t(' paragraph with diacritics: čćšžđ.')}` +
    fixture.xml.slice(run.text.end, opening.end - CLOSE.length) +
    fixture.xml.slice(opening.end, formatted.start) +
    fixture.xml.slice(formatted.start + openingOf(fixture.xml, formatted).length);
  check('a divided paragraph joined with the next: its last piece takes the next one in', out === expected);
}

{
  /* A cut in the second paragraph: the lines it makes are lines of the joined
     paragraph, and carry its properties — Word divides the line it shows. */
  const run = runWith(fixture, 'An opening paragraph with diacritics: čćšžđ.');
  const out = write(fixture, { joins: [title.index], cuts: [{ run: run.index, parts: ['An opening', ' paragraph with diacritics: čćšžđ.'] }] });
  const expected =
    fixture.xml.slice(0, title.end - CLOSE.length) +
    fixture.xml.slice(title.end, opening.start) +
    fixture.xml.slice(opening.start + openingOf(fixture.xml, opening).length, run.text.start) +
    t('An opening') +
    `</w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r>${t(' paragraph with diacritics: čćšžđ.')}` +
    fixture.xml.slice(run.text.end);
  check('a paragraph joined onto a heading and then divided: both lines are headings', out === expected);
}

{
  /* A new paragraph after a joined one continues the line the join made: the
     first paragraph's properties, handed on, and the last run's formatting. */
  const doc = read(
    contrive(
      para('Sredina', '<w:pPr><w:jc w:val="center"/></w:pPr>') +
        `<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:i/></w:rPr><w:t>desno</w:t></w:r></w:p>` +
        para('Kraj'),
    ),
  );
  const [first, second] = body(doc);
  const out = write(doc, { joins: [first.index], inserts: [{ after: second.index, text: 'Novi' }] });
  const whole = joined(doc.xml, [[first, second]]);
  const at = second.end - (doc.xml.length - whole.length);
  const expected =
    whole.slice(0, at) +
    `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:i/></w:rPr>${t('Novi')}</w:r></w:p>` +
    whole.slice(at);
  check('a paragraph added after a joined one takes the joined line\'s properties and its last run\'s formatting', out === expected, out.slice(0, 400));
}
{
  /* The line's last run, when the paragraph that ends it has none of its own:
     Delete at the end of a line before an empty one, then Enter. */
  const doc = read(contrive(`<w:p><w:r><w:rPr><w:i/></w:rPr><w:t>nakošeno</w:t></w:r></w:p><w:p/>` + para('Kraj')));
  const [first, empty] = body(doc);
  const out = write(doc, { joins: [first.index], inserts: [{ after: empty.index, text: 'Novi' }] });
  check(
    'and where the paragraph that ends the line has no run, the formatting of the line it was joined onto',
    out.includes(`<w:p><w:r><w:rPr><w:i/></w:rPr>${t('Novi')}</w:r></w:p>`),
    out,
  );
}

/* ── empty lines, and the lines a join leaves ─────────────────────────── */

{
  const doc = read(contrive('<w:p><w:bookmarkStart w:id="0" w:name="x"/><w:bookmarkEnd w:id="0"/></w:p>' + para('Drugi')));
  check(
    'a first paragraph that shows nothing is not joined — what Word does there is a removal, and the plan says so with one',
    write(doc, { joins: [body(doc)[0].index] }) === doc.xml,
  );
}
{
  const doc = read(contrive(para('Prvi') + para('Drugi')));
  const out = write(doc, { joins: [body(doc)[0].index] }, [{ index: runWith(doc, 'Prvi').index, text: '' }]);
  check(
    'nor one whose text was typed away — the rewrite is written, the join is not',
    out === doc.xml.replace('<w:t xml:space="preserve">Prvi</w:t>', t('')),
  );
}
{
  /* The line that ends at the boundary is what is asked, not its last paragraph. */
  const doc = read(contrive(para('Prvi') + para('Drugi') + para('Treći')));
  const [a, b, c] = body(doc);
  const out = write(doc, { joins: [a.index, b.index] }, [{ index: runWith(doc, 'Drugi').index, text: '' }]);
  const expected = joined(doc.xml, [[a, b], [b, c]]).replace('<w:t xml:space="preserve">Drugi</w:t>', t(''));
  check('a paragraph typed empty after being joined onto a line with text still ends a line with text, and joins on', out === expected);
}
{
  const doc = read(contrive(para('Prvi') + '<w:p/>' + para('Treći')));
  const [a, b, c] = body(doc);
  check(
    'an empty `<w:p/>` after a paragraph is joined into it, and the paragraph closed where it ended',
    write(doc, { joins: [a.index] }) === joined(doc.xml, [[a, b]]) &&
      write(doc, { joins: [a.index] }) === contrive(para('Prvi') + para('Treći')),
  );
  check(
    'and a chain through one reaches the paragraph after it',
    write(doc, { joins: [a.index, b.index] }) === joined(doc.xml, [[a, b], [b, c]]) &&
      countParagraphs(write(doc, { joins: [a.index, b.index] })) === 1,
  );
}
{
  /* A chain whose last link is refused ends on the `<w:p/>`, and has to be
     closed there — by what was joined, not by what was asked for. */
  const table = `<w:tbl><w:tr><w:tc>${para('U ćeliji')}</w:tc></w:tr></w:tbl>`;
  const doc = read(contrive(para('Prvi') + '<w:p/>' + table + para('Poslije')));
  const [a, b] = body(doc);
  const out = write(doc, { joins: [a.index, b.index] });
  check(
    'a chain whose last link is refused is closed where the joined part of it ends',
    out === joined(doc.xml, [[a, b]]) && out === contrive(para('Prvi') + table + para('Poslije')),
    out.slice(0, 160),
  );
}
{
  const doc = read(contrive(para('Prvi', '<w:bookmarkStart w:id="1" w:name="preko"/>') + '<w:bookmarkEnd w:id="1"/>' + para('Drugi')));
  const [a, b] = body(doc);
  const out = write(doc, { joins: [a.index] });
  check(
    'a bookmark end standing between the two is carried into the joined paragraph, at the join — where Word puts it',
    out === joined(doc.xml, [[a, b]]) && out.includes('Prvi</w:t></w:r><w:bookmarkEnd w:id="1"/><w:r>'),
  );
}
{
  const doc = read(contrive(para('Prvi') + '<w:p><w:pPr/><w:r><w:t>Drugi</w:t></w:r></w:p>'));
  const out = write(doc, { joins: [body(doc)[0].index] });
  check(
    'an empty `<w:pPr/>` of the second paragraph goes with the boundary rather than into the middle of the first',
    out === contrive('<w:p><w:r><w:t xml:space="preserve">Prvi</w:t></w:r><w:r><w:t>Drugi</w:t></w:r></w:p>'),
    out,
  );
}

/* ── what the writer refuses, whatever it is handed ─────────────────── */

const refusalOf = (doc, text) => joinRefusal(doc.xml, doc.paragraphs, paragraphWith(doc, text).index);
const untouched = (doc, text) => write(doc, { joins: [paragraphWith(doc, text).index] }) === doc.xml;

{
  const doc = read(contrive(para('Prije') + `<w:tbl><w:tr><w:tc>${para('U ćeliji')}</w:tc></w:tr></w:tbl>` + para('Poslije')));
  check(
    'a table between two paragraphs is not a thing a join can pass, and the writer leaves them',
    refusalOf(doc, 'Prije') === 'something stands between the two paragraphs' && untouched(doc, 'Prije'),
    refusalOf(doc, 'Prije') ?? 'allowed',
  );
  check(
    'a paragraph in a table cell is refused',
    refusalOf(doc, 'U ćeliji') === 'the paragraph is not in the body of the document' && untouched(doc, 'U ćeliji'),
  );
}
{
  const doc = read(contrive(para('Prije') + `<w:sdt><w:sdtContent>${para('U kontroli')}</w:sdtContent></w:sdt>` + para('Poslije')));
  check(
    'nor a content control the view does not draw — the check is on the bytes, not on what is shown',
    refusalOf(doc, 'Prije') === 'something stands between the two paragraphs' && untouched(doc, 'Prije'),
    refusalOf(doc, 'Prije') ?? 'allowed',
  );
}
{
  const ends = read(contrive(para('Kraj odsječka', '<w:pPr><w:sectPr><w:pgSz w:w="11906"/></w:sectPr></w:pPr>') + para('Dalje')));
  const next = read(contrive(para('Prije') + para('Kraj odsječka', '<w:pPr><w:sectPr><w:pgSz w:w="11906"/></w:sectPr></w:pPr>') + para('Dalje')));
  check(
    'a section\'s end is refused on either side of the boundary',
    refusalOf(ends, 'Kraj odsječka') === 'the paragraph ends a section' &&
      refusalOf(next, 'Prije') === 'the paragraph ends a section' &&
      untouched(ends, 'Kraj odsječka') &&
      untouched(next, 'Prije'),
  );
}
{
  const first = read(contrive(para('Označeno', '<w:pPr><w:jc w:val="center"/><w:pPrChange w:id="5" w:author="Netko"><w:pPr/></w:pPrChange></w:pPr>') + para('Dalje')));
  const second = read(contrive(para('Prije') + para('Umetnuto', '<w:pPr><w:rPr><w:ins w:id="6" w:author="Netko"/></w:rPr></w:pPr>')));
  check(
    'a tracked change recorded on either paragraph\'s mark is refused',
    refusalOf(first, 'Označeno') === 'a tracked change is recorded where the paragraphs meet' &&
      refusalOf(second, 'Prije') === 'a tracked change is recorded where the paragraphs meet' &&
      untouched(first, 'Označeno') &&
      untouched(second, 'Prije'),
  );
}
{
  const doc = read(contrive(para('Jedini') + '<w:sectPr/>'));
  check('the last paragraph has nothing to join', refusalOf(doc, 'Jedini') === 'nothing follows the paragraph' && untouched(doc, 'Jedini'));
}
{
  const doc = read(contrive(para('Prvi') + para('Drugi') + para('Treći')));
  const [a, b, c] = body(doc);
  check(
    'a paragraph the plan removes is not joined to anything',
    write(doc, { removals: [a.index], joins: [a.index] }) === doc.xml.slice(0, a.start) + doc.xml.slice(a.end),
  );
  check('the same paragraph named twice is joined once', write(doc, { joins: [a.index, a.index] }) === joined(doc.xml, [[a, b]]));
  check(
    'joining is ordered by the file, not by the order it was asked in',
    write(doc, { joins: [b.index, a.index] }) === joined(doc.xml, [[a, b], [b, c]]),
  );
}

{
  const doc = read(contrive(para('A', '<w:pPr><w:jc w:val="both"/></w:pPr>') + para('B', '<w:pPr><w:jc w:val="both"/></w:pPr>') + para('C', '<w:pPr><w:jc w:val="left"/></w:pPr>')));
  const [a, b, c] = body(doc);
  check(
    'two paragraphs with the same properties are alike, and two with different ones are not',
    propertiesAlike(doc.xml, a, b) && !propertiesAlike(doc.xml, b, c),
  );
}

/* ── the archive, and saving twice ───────────────────────────────────── */

{
  const first = writeDocx(fixture.archive, fixture.runs, fixture.xml, [], plan(fixture, { joins: [title.index] }));
  const second = writeDocx(fixture.archive, fixture.runs, fixture.xml, [], plan(fixture, { joins: [title.index] }));
  const out = unzipSync(first);
  const kept = Object.keys(fixture.archive).filter(
    (name) => name !== 'word/document.xml' && Buffer.compare(Buffer.from(fixture.archive[name]), Buffer.from(out[name] ?? [])) === 0,
  );
  check('every other part of the archive comes through byte for byte', kept.length === Object.keys(fixture.archive).length - 1, `${kept.length} parts`);
  check('saving twice from the untouched original writes the same file', Buffer.compare(Buffer.from(first), Buffer.from(second)) === 0);
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

let swept = 0;
let pairs = 0;
let joinable = 0;
let emptyFirst = 0;
let marked = 0;
const nowhere = [];
const damaged = [];
const reasons = new Map();

for (const file of files) {
  let doc;
  try {
    doc = open(new Uint8Array(readFileSync(file)));
  } catch {
    continue;
  }
  const name = file.split(/[\\/]/).pop();
  const spans = body(doc);

  /* Every body paragraph but the last, asked; the refusals counted by reason. */
  const candidates = [];
  spans.slice(0, -1).forEach((first, i) => {
    pairs++;
    const why = joinRefusal(doc.xml, doc.paragraphs, first.index);
    if (why) {
      reasons.set(why, (reasons.get(why) ?? 0) + 1);
      return;
    }
    joinable++;
    const next = spans[i + 1];
    if (/<\w/.test(doc.xml.slice(first.end, next.start))) marked++;
    if (showsNothing(doc.xml, first, doc.runs)) {
      emptyFirst++;
      return;
    }
    /* The pattern above reads an opening exactly only when nothing inside it
       holds a `w:pPr` of its own — a tracked change of the properties would. */
    if (/<w:pPrChange[\s/>]/.test(propsOf(doc.xml, next))) return;
    candidates.push([first, next]);
  });
  if (candidates.length === 0) {
    nowhere.push(name);
    continue;
  }

  /* From the middle of the document rather than its front — an offset fault
     shows itself late in a long file. */
  const [first, next] = candidates[Math.floor(candidates.length / 2)];
  swept++;

  const out = write(doc, { joins: [first.index] });
  if (out !== joined(doc.xml, [[first, next]])) {
    damaged.push(`${name}: not the original without the boundary`);
    continue;
  }
  if (countParagraphs(out) !== doc.paragraphs.length - 1) {
    damaged.push(`${name}: ${doc.paragraphs.length} → ${countParagraphs(out)} paragraphs`);
    continue;
  }
  /* And read back by the reader the editor opens files with: one body
     paragraph where there were two, holding both texts, with the first one's
     properties. */
  const back = read(out);
  const merged = back.paragraphs.find((span) => span.start === first.start);
  if (!merged || merged.refusal !== null || textOf(out, merged) !== textOf(doc.xml, first) + textOf(doc.xml, next)) {
    damaged.push(`${name}: the joined paragraph is not a body paragraph with both texts`);
    continue;
  }
  if (propsOf(out, merged) !== propsOf(doc.xml, first)) {
    damaged.push(`${name}: the joined paragraph lost the first one's properties`);
    continue;
  }
  if (write(doc, { joins: [first.index] }) !== out) damaged.push(`${name}: a second save wrote something else`);
}

check(
  'two paragraphs of every real document are joined, and nothing else moves',
  swept > 0 && damaged.length === 0,
  damaged.length ? damaged.slice(0, 4).join(' · ') : `${swept}/${files.length} swept`,
);

console.log(
  `\n${pairs} body paragraphs with another after them across the corpus; ${joinable} may be joined with it` +
    ` (${emptyFirst} of those show nothing, and Backspace after them is a removal;` +
    ` ${marked} have a range mark standing between). Refused:`,
);
for (const [why, count] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(5)} · ${why}`);
if (nowhere.length > 0) {
  console.log(`\n${nowhere.length} offer no two paragraphs that may be joined — named rather than counted as passes:`);
  for (const one of nowhere) console.log(`  · ${one}`);
}

const failed = checks.filter((one) => !one.passed).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
