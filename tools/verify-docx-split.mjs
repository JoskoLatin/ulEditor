/**
 * A paragraph divided where the cursor stands — what Enter does in the middle
 * of a sentence.
 *
 * [`verify-docx-insert.mjs`](./verify-docx-insert.mjs) asks what happens when a
 * paragraph appears that was not there, and
 * [`verify-docx-delete.mjs`](./verify-docx-delete.mjs) when one the file had
 * goes. A split is neither and both: nothing is added and nothing taken away,
 * but a paragraph's own content is carried across a boundary that did not exist
 * — the run the cursor was in divided, and every run that followed it moved,
 * unread, into a paragraph of its own.
 *
 * What the claims below rest on is the same thing the removal's rest on, and
 * for the same measured reason: **exact byte identity**. The expected output is
 * built here, independently of the writer — from the original's own byte
 * ranges, a paragraph's properties and a run's formatting read out of the file
 * with a pattern of this file's own, and markup written out literally — and
 * the writer has to produce exactly that. A tag-balance check passed a build
 * that wrote `</w:p>w:p><w:p>` once; an identity admits no interpretation.
 *
 * The refusals are the ones a cut can cause and a removal cannot:
 *
 * - a run inside a **`w:hyperlink`**, an inline content control, a tracked
 *   change's `w:ins` or a `w:fldSimple` — a cut closes the paragraph where it
 *   falls, and the wrapper would open in one paragraph and close in the next;
 * - a complex field's **result run** — its `begin` behind it and its `end`
 *   ahead, the case the paragraph-insertion design first found;
 * - a **section-ending** paragraph, whose `w:sectPr` Word moves to whichever
 *   piece ends up last — refused rather than reproduced.
 *
 *   node tools/verify-docx-split.mjs
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
  splitRefusal,
  paragraphMarkup,
  applyDocxEdits,
  writeDocx,
  runText,
  escapeXml,
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

const plan = (doc, { cuts = [], inserts = [], removals = [] } = {}) => ({
  paragraphs: doc.paragraphs,
  succession: doc.succession,
  inserts,
  removals,
  cuts,
});

const write = (doc, reshaping, edits = []) => applyDocxEdits(doc.xml, doc.runs, edits, plan(doc, reshaping));
const countParagraphs = (xml) => findParagraphs(xml).length;
const paragraphOf = (doc, run) => paragraphOfRun(doc.paragraphs, run);
const runWith = (doc, text) => doc.runs.find((run) => run.text && runText(doc.xml, run) === text);

/* ── the expected output, built without the writer ───────────────────── */

/** A fresh text element, the way every rewrite in this program writes one. */
const t = (text) => `<w:t xml:space="preserve">${escapeXml(text)}</w:t>`;

/** A paragraph's own `w:pPr`, read out of its bytes by pattern — or nothing. */
function propsOf(xml, paragraph) {
  const found = /^<w:p(?:\s[^>]*)?>(<w:pPr(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:pPr>))?/.exec(
    xml.slice(paragraph.start, paragraph.end),
  );
  return found?.[1]?.endsWith('/>') ? '' : (found?.[1] ?? '');
}

/** A run's own `w:rPr`, read out of its bytes by pattern — or nothing. */
function formattingOf(xml, run) {
  const found = /<w:rPr(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:rPr>)/.exec(xml.slice(run.start, run.text.start));
  return found?.[0] ?? '';
}

/**
 * The original with one run divided into parts: its own text element replaced
 * by the first, and a paragraph boundary and a fresh run before each part
 * after it. Everything before the run's text and everything after it comes
 * from the original, byte for byte.
 */
function divided(doc, run, parts, props = propsOf(doc.xml, paragraphOf(doc, run))) {
  const [first, ...rest] = parts;
  const rPr = formattingOf(doc.xml, run);
  return (
    doc.xml.slice(0, run.text.start) +
    t(first) +
    rest.map((part) => `</w:r></w:p><w:p>${props}<w:r>${rPr}${t(part)}`).join('') +
    doc.xml.slice(run.text.end)
  );
}

/* ── the fixture ─────────────────────────────────────────────────────── */

const fixture = open(makeDocx());

const opening = runWith(fixture, 'An opening paragraph with diacritics: čćšžđ.');
const once = write(fixture, { cuts: [{ run: opening.index, parts: ['An opening', ' paragraph with diacritics: čćšžđ.'] }] });
check(
  'a paragraph divided in the middle of its only run is exactly the original with one boundary in it',
  once === divided(fixture, opening, ['An opening', ' paragraph with diacritics: čćšžđ.']),
  `${countParagraphs(fixture.xml)} → ${countParagraphs(once)} paragraphs`,
);
check('and it is one paragraph longer', countParagraphs(once) === countParagraphs(fixture.xml) + 1);

/* The bold run divided: the italic run after it goes with the second part. */
const bold = runWith(fixture, 'Bold ');
const italic = runWith(fixture, 'and italic');
const carried = write(fixture, { cuts: [{ run: bold.index, parts: ['Bo', 'ld '] }] });
check(
  'a run divided with another after it takes that run into the new paragraph, unread',
  carried === divided(fixture, bold, ['Bo', 'ld ']),
);
{
  const out = read(carried);
  const moved = out.runs.find((run) => run.text && runText(carried, run) === 'and italic');
  const tail = out.runs.find((run) => run.text && runText(carried, run) === 'ld ');
  check(
    'and the moved run keeps its own formatting, beside the part that keeps the divided one',
    moved && tail && paragraphOfRun(out.paragraphs, moved) === paragraphOfRun(out.paragraphs, tail) &&
      carried.slice(moved.start, moved.end) === fixture.xml.slice(italic.start, italic.end) &&
      carried.slice(tail.start, tail.end).includes('<w:b/>'),
    moved ? carried.slice(moved.start, moved.end) : 'not found',
  );
}

const heading = runWith(fixture, 'Fidelity report');
const headed = write(fixture, { cuts: [{ run: heading.index, parts: ['Fidelity', ' report'] }] });
check(
  'both pieces of a divided heading are headings — the style is kept, not handed on',
  headed === divided(fixture, heading, ['Fidelity', ' report']) &&
    (headed.match(/<w:pStyle w:val="Heading1"\/>/g) ?? []).length === 2,
);

const bullet = runWith(fixture, 'the first requirement');
const listed = write(fixture, { cuts: [{ run: bullet.index, parts: ['the first', ' requirement'] }] });
check(
  'both pieces of a divided list item are list items',
  listed === divided(fixture, bullet, ['the first', ' requirement']) &&
    (listed.match(/<w:numId w:val="1"\/>/g) ?? []).length === 3,
);

const thrice = write(fixture, { cuts: [{ run: opening.index, parts: ['An ', 'opening', ' paragraph with diacritics: čćšžđ.'] }] });
check(
  'a run divided twice is three paragraphs',
  thrice === divided(fixture, opening, ['An ', 'opening', ' paragraph with diacritics: čćšžđ.']) &&
    countParagraphs(thrice) === countParagraphs(fixture.xml) + 2,
);

{
  const both = write(fixture, {
    cuts: [
      { run: bold.index, parts: ['Bo', 'ld '] },
      { run: italic.index, parts: ['and ', 'italic'] },
    ],
  });
  const expected =
    fixture.xml.slice(0, bold.text.start) +
    t('Bo') +
    `</w:r></w:p><w:p><w:r>${formattingOf(fixture.xml, bold)}${t('ld ')}` +
    fixture.xml.slice(bold.text.end, italic.text.start) +
    t('and ') +
    `</w:r></w:p><w:p><w:r>${formattingOf(fixture.xml, italic)}${t('italic')}` +
    fixture.xml.slice(italic.text.end);
  check('two runs of one paragraph divided in the same save are three paragraphs, exactly', both === expected);
}

/* ── in the same save as everything else ─────────────────────────────── */

{
  const out = write(fixture, { cuts: [{ run: bold.index, parts: ['Bo', 'ld '] }] }, [{ index: italic.index, text: 'svijete' }]);
  const expected =
    fixture.xml.slice(0, bold.text.start) +
    t('Bo') +
    `</w:r></w:p><w:p><w:r>${formattingOf(fixture.xml, bold)}${t('ld ')}` +
    fixture.xml.slice(bold.text.end, italic.text.start) +
    t('svijete') +
    fixture.xml.slice(italic.text.end);
  check('a rewrite of a run carried into the new paragraph is written there, not over the cut', out === expected);
}

{
  const out = write(fixture, { cuts: [{ run: italic.index, parts: ['and ', 'italic'] }] }, [{ index: bold.index, text: 'Masno ' }]);
  const expected =
    fixture.xml.slice(0, bold.text.start) +
    t('Masno ') +
    fixture.xml.slice(bold.text.end, italic.text.start) +
    t('and ') +
    `</w:r></w:p><w:p><w:r>${formattingOf(fixture.xml, italic)}${t('italic')}` +
    fixture.xml.slice(italic.text.end);
  check('a rewrite of a run before the cut stays where it is', out === expected);
}

{
  const out = write(fixture, { cuts: [{ run: bold.index, parts: ['Bo', 'ld '] }] }, [{ index: bold.index, text: 'ignored' }]);
  check(
    'a rewrite of the divided run itself yields to the parts',
    out === divided(fixture, bold, ['Bo', 'ld ']),
    out.includes('ignored') ? 'the rewrite was written as well' : 'the parts won',
  );
}

{
  const paragraph = paragraphOf(fixture, opening);
  const out = write(fixture, {
    cuts: [{ run: opening.index, parts: ['An opening', ' paragraph with diacritics: čćšžđ.'] }],
    inserts: [{ after: paragraph.index, text: 'Novi' }],
  });
  const whole = divided(fixture, opening, ['An opening', ' paragraph with diacritics: čćšžđ.']);
  const markup = paragraphMarkup(fixture.xml, paragraph, fixture.runs, fixture.succession, 'Novi');
  const at = paragraph.end + (whole.length - fixture.xml.length);
  check(
    'a paragraph added after a divided one lands after its last piece',
    out === whole.slice(0, at) + markup + whole.slice(at),
  );
}

{
  const paragraph = paragraphOf(fixture, opening);
  const next = fixture.paragraphs.find((span) => span.index === paragraph.index + 1);
  const out = write(fixture, {
    cuts: [{ run: opening.index, parts: ['An opening', ' paragraph with diacritics: čćšžđ.'] }],
    removals: [next.index],
  });
  const whole = divided(fixture, opening, ['An opening', ' paragraph with diacritics: čćšžđ.']);
  const shift = whole.length - fixture.xml.length;
  check(
    'a divided paragraph and the paragraph after it removed, in one save — the ranges touch and neither moves the other',
    out === whole.slice(0, next.start + shift) + whole.slice(next.end + shift),
  );
}

{
  const paragraph = paragraphOf(fixture, opening);
  const out = write(fixture, {
    cuts: [{ run: opening.index, parts: ['An opening', ' paragraph with diacritics: čćšžđ.'] }],
    removals: [paragraph.index],
  });
  check(
    'a divided paragraph that is also removed is removed — the two cannot share bytes',
    out === fixture.xml.slice(0, paragraph.start) + fixture.xml.slice(paragraph.end),
  );
}

/* ── what the writer refuses, whatever it is handed ─────────────────── */

const para = (text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const refusalOf = (doc, text) => {
  const run = runWith(doc, text);
  return run ? splitRefusal(doc.xml, doc.paragraphs, run) : 'no such run';
};
const untouched = (doc, text, parts) => {
  const run = runWith(doc, text);
  return write(doc, { cuts: [{ run: run.index, parts }] }) === doc.xml;
};

const link = read(contrive(`<w:p><w:hyperlink r:id="rId1"><w:r><w:t>poveznica</w:t></w:r></w:hyperlink><w:r><w:t>obično</w:t></w:r></w:p>` + para('dalje')));
check(
  'a run inside a link is refused, and the writer leaves it whole',
  refusalOf(link, 'poveznica') === 'the run is inside an element a cut would tear in two' && untouched(link, 'poveznica', ['pove', 'znica']),
  refusalOf(link, 'poveznica') ?? 'allowed',
);
check('and the run beside the link is not', refusalOf(link, 'obično') === null);

const tracked = read(contrive(`<w:p><w:ins w:id="1" w:author="Netko"><w:r><w:t>umetnuto</w:t></w:r></w:ins></w:p>` + para('dalje')));
check(
  'a run inside a tracked insertion is refused',
  refusalOf(tracked, 'umetnuto') === 'the run is inside an element a cut would tear in two' && untouched(tracked, 'umetnuto', ['umet', 'nuto']),
  refusalOf(tracked, 'umetnuto') ?? 'allowed',
);

const field = read(
  contrive(
    `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> DATE </w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>11.9.2026</w:t></w:r>` +
      `<w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t>poslije</w:t></w:r></w:p>` +
      para('dalje'),
  ),
);
check(
  'a field result run is refused, and left whole',
  refusalOf(field, '11.9.2026') === 'a field begins or ends here and continues elsewhere' && untouched(field, '11.9.2026', ['11.9.', '2026']),
  refusalOf(field, '11.9.2026') ?? 'allowed',
);
check('and the run after the field is not', refusalOf(field, 'poslije') === null);

const section = read(contrive(`<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906"/></w:sectPr></w:pPr><w:r><w:t>kraj odsječka</w:t></w:r></w:p>` + para('dalje')));
check(
  'a paragraph that ends a section is refused, and left whole',
  refusalOf(section, 'kraj odsječka') === 'the paragraph ends a section' && untouched(section, 'kraj odsječka', ['kraj', ' odsječka']),
  refusalOf(section, 'kraj odsječka') ?? 'allowed',
);

const comment = read(
  contrive(`<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>prije</w:t></w:r><w:r><w:t>poslije</w:t></w:r><w:commentRangeEnd w:id="0"/></w:p>` + para('dalje')),
);
check(
  'a run a comment range runs through is refused',
  refusalOf(comment, 'prije') === 'a marked stretch continues outside the paragraph' && untouched(comment, 'prije', ['pr', 'ije']),
  refusalOf(comment, 'prije') ?? 'allowed',
);

const cell = read(contrive(para('Tijelo') + `<w:tbl><w:tr><w:tc>${para('U ćeliji')}</w:tc></w:tr></w:tbl>` + para('Poslije')));
check(
  'a run in a table cell is refused, and left whole',
  refusalOf(cell, 'U ćeliji') === 'the paragraph is not in the body of the document' && untouched(cell, 'U ćeliji', ['U ', 'ćeliji']),
  refusalOf(cell, 'U ćeliji') ?? 'allowed',
);

const plain = read(contrive(para('Jedan dva') + para('Tri')));
/* With text of its own: a one-part cut carrying the run's own text would come
   out byte-identical whether it were honoured or not, and prove nothing. */
check('a cut with one part is no cut — not even a rewrite', untouched(plain, 'Jedan dva', ['Nešto drugo']));
{
  const run = runWith(plain, 'Jedan dva');
  const out = write(plain, { cuts: [{ run: run.index, parts: ['Jedan', ' dva'] }, { run: run.index, parts: ['J', 'edan dva'] }] });
  check('the same run named twice is divided once — the first time', out === divided(plain, run, ['Jedan', ' dva'], ''));
}

/* Tracked-change marks on the paragraph are not copied into a new piece: they
   would claim a reviewer made a paragraph they never saw. */
{
  const marked = read(
    contrive(
      `<w:p><w:pPr><w:jc w:val="center"/><w:pPrChange w:id="5" w:author="Netko"><w:pPr/></w:pPrChange>` +
        `<w:rPr><w:ins w:id="6" w:author="Netko"/><w:b/></w:rPr></w:pPr><w:r><w:t>Označeno</w:t></w:r></w:p>` +
        para('dalje'),
    ),
  );
  const run = runWith(marked, 'Označeno');
  const out = write(marked, { cuts: [{ run: run.index, parts: ['Ozna', 'čeno'] }] });
  check(
    'a tracked change on the paragraph stays with the first piece and is not copied into the new one',
    out === divided(marked, run, ['Ozna', 'čeno'], '<w:pPr><w:jc w:val="center"/><w:rPr><w:b/></w:rPr></w:pPr>'),
  );
}

/* ── the archive, and saving twice ───────────────────────────────────── */

{
  const cuts = [{ run: opening.index, parts: ['An opening', ' paragraph with diacritics: čćšžđ.'] }];
  const first = writeDocx(fixture.archive, fixture.runs, fixture.xml, [], plan(fixture, { cuts }));
  const second = writeDocx(fixture.archive, fixture.runs, fixture.xml, [], plan(fixture, { cuts }));
  const out = unzipSync(first);
  const kept = Object.keys(fixture.archive).filter(
    (name) => name !== 'word/document.xml' && Buffer.compare(Buffer.from(fixture.archive[name]), Buffer.from(out[name] ?? [])) === 0,
  );
  check(
    'every other part of the archive comes through byte for byte',
    kept.length === Object.keys(fixture.archive).length - 1,
    `${kept.length} parts`,
  );
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

/* A property block this pattern reads exactly: nothing a split does not copy. */
const COPIED_WHOLE = (block) => !/<w:(?:sectPr|pPrChange|rPrChange|ins|del|moveFrom|moveTo)[\s/>]/.test(block);

let swept = 0;
const nowhere = [];
const damaged = [];
const reasons = new Map();
let offered = 0;

for (const file of files) {
  let doc;
  try {
    doc = open(new Uint8Array(readFileSync(file)));
  } catch {
    continue;
  }
  const name = file.split(/[\\/]/).pop();

  /* Every editable run of the body, asked; the refusals counted by reason. */
  const candidates = [];
  for (const run of doc.runs) {
    if (!run.text || run.refusal) continue;
    const paragraph = paragraphOf(doc, run);
    if (!paragraph || paragraph.refusal) continue;
    offered++;
    const why = splitRefusal(doc.xml, doc.paragraphs, run);
    if (why) {
      reasons.set(why, (reasons.get(why) ?? 0) + 1);
      continue;
    }
    const text = runText(doc.xml, run);
    if (text.length < 2) continue;
    if (!COPIED_WHOLE(propsOf(doc.xml, paragraph)) || !COPIED_WHOLE(formattingOf(doc.xml, run))) continue;
    candidates.push(run);
  }
  if (candidates.length === 0) {
    nowhere.push(name);
    continue;
  }

  /* From the middle of the document rather than its front — an offset fault
     shows itself late in a long file — and from the middle of the run. */
  const run = candidates[Math.floor(candidates.length / 2)];
  const text = runText(doc.xml, run);
  const at = Math.floor(text.length / 2);
  const parts = [text.slice(0, at), text.slice(at)];
  swept++;

  const out = write(doc, { cuts: [{ run: run.index, parts }] });
  if (out !== divided(doc, run, parts)) {
    damaged.push(`${name}: not the original with one boundary in it`);
    continue;
  }
  if (countParagraphs(out) !== doc.paragraphs.length + 1) {
    damaged.push(`${name}: ${doc.paragraphs.length} → ${countParagraphs(out)} paragraphs`);
    continue;
  }
  /* And read back by the same reader the editor opens files with: the second
     part is a run of its own, in a paragraph of the body a person can type in. */
  const back = read(out);
  const second = back.runs.find((one) => one.text && one.start > run.start && runText(out, one) === parts[1]);
  const home = second && paragraphOfRun(back.paragraphs, second);
  if (!home || home.refusal !== null) {
    damaged.push(`${name}: the second part is not a run of the body`);
    continue;
  }
  if (write(doc, { cuts: [{ run: run.index, parts }] }) !== out) damaged.push(`${name}: a second save wrote something else`);
}

check(
  'a paragraph of every real document is divided, and nothing else moves',
  swept > 0 && damaged.length === 0,
  damaged.length ? damaged.slice(0, 4).join(' · ') : `${swept}/${files.length} swept`,
);

console.log(`\n${offered} editable runs in body paragraphs across the corpus; refused:`);
for (const [why, count] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(5)} · ${why}`);
if (nowhere.length > 0) {
  console.log(`\n${nowhere.length} offer no run that may be divided — named rather than counted as passes:`);
  for (const one of nowhere) console.log(`  · ${one}`);
}

const failed = checks.filter((one) => !one.passed).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
