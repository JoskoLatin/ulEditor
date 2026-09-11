/**
 * A paragraph the file already had, taken away.
 *
 * [`verify-docx-insert.mjs`](./verify-docx-insert.mjs) asks what happens when
 * something exists that did not exist before. This asks the harder half: what
 * happens when something that **other parts of the file point at** stops
 * existing. A run rewrite moves no ranges and an insertion consumes none; a
 * removal consumes a range other elements may be half inside, and every rule
 * here exists because a real reader was asked what it did with the result.
 *
 * Five of the refusals were bought with Word itself over COM, not reasoned out:
 *
 * - a **`permEnd`** taken away leaves an orphaned `permStart`, and Word answers
 *   by revoking the editable region on a paragraph the person never touched —
 *   `Range.Editors.Count` goes 1 → 0 on a paragraph above the one removed;
 * - the paragraph **between two tables** is what keeps them two: remove it and
 *   `Tables.Count` goes 2 → 1, while this program's preview would go on showing
 *   two;
 * - the **last block after a table**, and the **only paragraph of the final
 *   section**, come back with the paragraph count unchanged — Word silently
 *   reinstates a paragraph mark rather than end a document on a table;
 * - and an orphaned **bookmark** half, by the same method, is *fine* — Word
 *   opens it clean — which is why bookmarks are the one paired thing not
 *   refused here. The corpus is full of Word's own `_GoBack`.
 *
 * The sixth is arithmetic the plan model makes possible to get wrong: every
 * removal is judged against **the survivors**, not against the file as opened,
 * so taking paragraphs one at a time cannot arrive somewhere a single step
 * refuses to go. A document emptied that way opens in Word — which quietly
 * invents a paragraph — and comes back to ulEditor with no editable text at
 * all, so the program would have locked itself out of its own output.
 *
 *   node tools/verify-docx-delete.mjs
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
  readStyleSuccession,
  removalRefusal,
  paragraphMarkup,
  applyDocxEdits,
  writeDocx,
  scanTags,
} = await import(pathToFileURL(resolve(ROOT, 'packages/editor-office/src/docx-edit.ts')).href);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const MARKER = 'Novi odlomak — čćžšđ ČĆŽŠĐ';

/** Reads a document part, the plan and the succession, the way the editor does. */
function open(bytes) {
  const archive = unzipSync(bytes);
  const xml = strFromU8(archive['word/document.xml']);
  const styles = archive['word/styles.xml'] ? strFromU8(archive['word/styles.xml']) : null;
  return {
    archive,
    xml,
    runs: findRuns(xml),
    paragraphs: findParagraphs(xml),
    succession: readStyleSuccession(styles),
  };
}

const plan = (doc, { inserts = [], removals = [] } = {}) => ({
  paragraphs: doc.paragraphs,
  succession: doc.succession,
  inserts,
  removals,
});

/**
 * Whether every open tag is closed in order — a floor, and only a floor.
 *
 * It was the whole bar once, and a deliberately broken build walked straight
 * through it: a cut that leaves `</w:p>w:p><w:p>` behind is nonsense a reader
 * would refuse, and this says it is fine, because `w:p>` has no `<` and is
 * therefore not a tag at all. Widening it to "no stray angle bracket outside a
 * tag" does not work either — measured over all 49 real documents, every one of
 * them carries both, in the XML declaration this scanner steps over.
 *
 * So what the claims below actually rest on is the **exact byte identity**:
 * what came out has to equal what the original was, with named slices taken out
 * and named markup put in. That admits no interpretation at all. This stays as
 * a first, cheap complaint when something is obviously wrong.
 */
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

/** The original with a paragraph's bytes taken out — the whole of a removal. */
const without = (doc, ...spans) => {
  let out = doc.xml;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, span.start) + out.slice(span.end);
  }
  return out;
};

const spanOf = (doc, index) => doc.paragraphs.find((one) => one.index === index);

const countParagraphs = (xml) => findParagraphs(xml).length;

/** A document part around a body, for the rules the real corpus does not hold. */
const contrive = (body) => `<w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`;
const para = (text, inner = '') =>
  `<w:p>${inner}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

/** Reads a contrived part with no archive behind it. */
function read(xml) {
  return {
    xml,
    runs: findRuns(xml),
    paragraphs: findParagraphs(xml),
    succession: { next: new Map(), fallback: '' },
  };
}

const refusalOf = (doc, index, survivors) =>
  removalRefusal(doc.xml, doc.paragraphs, index, survivors);

/* ── the fixture, in detail ──────────────────────────────────────────── */

const fixture = open(makeDocx());
const body = fixture.paragraphs.filter((span) => !span.refusal);

/* The fixture ends with a `<w:sectPr/>` of its own after the last paragraph, so
   its last body paragraph is a perfectly ordinary one to remove. */
const target = body.find((span) => refusalOf(fixture, span.index) === null);
check('the fixture offers a paragraph that may go', target !== undefined, `p${target?.index}`);

const cut = applyDocxEdits(fixture.xml, fixture.runs, [], plan(fixture, { removals: [target.index] }));

check('the part is still well formed', balanced(cut));
check(
  'the document is exactly one paragraph shorter',
  countParagraphs(cut) === fixture.paragraphs.length - 1,
  `${fixture.paragraphs.length} → ${countParagraphs(cut)}`,
);
check(
  'every character before the removed paragraph is unchanged',
  cut.slice(0, target.start) === fixture.xml.slice(0, target.start),
);
check(
  'every character after it is unchanged',
  cut.slice(target.start) === fixture.xml.slice(target.end),
);

const gone = fixture.xml.slice(target.start, target.end);
const text = [...gone.matchAll(/>([^<]+)</g)].map((m) => m[1]).join('');
check('and the text that was in it is gone', text.length > 0 && !cut.includes(text), text.slice(0, 40));

/* ── the archive, and saving twice ───────────────────────────────────── */

const written = unzipSync(
  writeDocx(fixture.archive, fixture.runs, fixture.xml, [], plan(fixture, { removals: [target.index] })),
);
const untouched = Object.keys(fixture.archive).filter(
  (name) =>
    name !== 'word/document.xml' &&
    Buffer.compare(Buffer.from(fixture.archive[name]), Buffer.from(written[name] ?? new Uint8Array())) === 0,
);
check(
  'every other part of the archive comes through byte for byte',
  untouched.length === Object.keys(fixture.archive).length - 1,
  `${untouched.length} parts`,
);

const again = writeDocx(
  fixture.archive,
  fixture.runs,
  fixture.xml,
  [],
  plan(fixture, { removals: [target.index] }),
);
check(
  'saving twice from the untouched original writes the same file',
  Buffer.compare(
    Buffer.from(
      writeDocx(fixture.archive, fixture.runs, fixture.xml, [], plan(fixture, { removals: [target.index] })),
    ),
    Buffer.from(again),
  ) === 0,
  `${again.length} bytes`,
);

/* ── the rules, each on a document built to break it ─────────────────── */

const section = read(
  contrive(
    para('One') +
      `<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906"/></w:sectPr></w:pPr></w:p>` +
      para('Two'),
  ),
);
check(
  'a paragraph that ends a section is refused',
  refusalOf(section, 1) === 'the paragraph ends a section',
  refusalOf(section, 1) ?? 'allowed',
);

const field = read(
  contrive(
    `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r></w:p>` +
      `<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>` +
      para('After'),
  ),
);
check(
  'a paragraph holding half a field is refused',
  refusalOf(field, 0) === 'a field begins or ends here and continues elsewhere',
  refusalOf(field, 0) ?? 'allowed',
);

/* The permission case, which Word answered by revoking somebody else's edit. */
const perm = read(
  contrive(
    `<w:p><w:permStart w:id="10" w:edGrp="everyone"/>${para('Editable').slice(5)}` +
      para('Holds the end', '') +
      para('Third'),
  ).replace('<w:p><w:r><w:t xml:space="preserve">Holds the end</w:t></w:r></w:p>',
    '<w:p><w:permEnd w:id="10"/><w:r><w:t xml:space="preserve">Holds the end</w:t></w:r></w:p>'),
);
check(
  'a paragraph holding the far half of a protected range is refused',
  refusalOf(perm, 1) === 'a marked stretch continues outside the paragraph',
  refusalOf(perm, 1) ?? 'allowed',
);

/* And a bookmark, which Word was measured NOT to mind — 7 real files rely on it. */
const bookmark = read(
  contrive(
    `<w:p><w:bookmarkStart w:id="0" w:name="_GoBack"/><w:r><w:t>One</w:t></w:r></w:p>` +
      `<w:p><w:bookmarkEnd w:id="0"/><w:r><w:t>Two</w:t></w:r></w:p>` +
      para('Three'),
  ),
);
check(
  'a bookmark crossing the boundary is NOT refused, because Word does not mind',
  refusalOf(bookmark, 0) === null && refusalOf(bookmark, 1) === null,
  refusalOf(bookmark, 1) ?? 'allowed, as it should be',
);

const sandwich = read(
  contrive(
    para('Before') +
      `<w:tbl><w:tr><w:tc>${para('In a cell')}</w:tc></w:tr></w:tbl>` +
      para('Between') +
      `<w:tbl><w:tr><w:tc>${para('In another')}</w:tc></w:tr></w:tbl>` +
      para('After'),
  ),
);
const between = sandwich.paragraphs.filter((span) => !span.refusal)[1];
check(
  'the paragraph keeping two tables apart is refused',
  refusalOf(sandwich, between.index) === 'the paragraph keeps two tables apart',
  refusalOf(sandwich, between.index) ?? 'allowed',
);

const endsOnTable = read(
  contrive(
    para('Before') + `<w:tbl><w:tr><w:tc>${para('In a cell')}</w:tc></w:tr></w:tbl>` + para('Last'),
  ),
);
const last = endsOnTable.paragraphs.filter((span) => !span.refusal).at(-1);
check(
  'the last paragraph behind a table is refused, because Word puts one back',
  refusalOf(endsOnTable, last.index) === 'the document would end without a paragraph',
  refusalOf(endsOnTable, last.index) ?? 'allowed',
);

const sole = read(contrive(para('The only one')));
check(
  'the last paragraph of a document is refused',
  refusalOf(sole, 0) === 'the last paragraph of the document',
  refusalOf(sole, 0) ?? 'allowed',
);

const cell = read(contrive(para('Body') + `<w:tbl><w:tr><w:tc>${para('In a cell')}</w:tc></w:tr></w:tbl>` + para('After')));
const inCell = cell.paragraphs.find((span) => span.refusal);
check(
  'a paragraph in a table cell is refused with its own reason',
  refusalOf(cell, inCell.index) === 'the paragraph is not in the body of the document',
  refusalOf(cell, inCell.index) ?? 'allowed',
);

const wrapped = read(
  contrive(
    para('Body') + `<w:customXml w:element="thing">${para('Inside a wrapper')}</w:customXml>` + para('After'),
  ),
);
check(
  'a paragraph inside a body-level customXml wrapper is refused too',
  wrapped.paragraphs[1].refusal !== null,
  wrapped.paragraphs[1].refusal ?? 'allowed',
);

/* ── the arithmetic only a plan can get wrong ────────────────────────── */

const many = read(contrive(para('One') + para('Two') + para('Three')));
const survivors = new Set([0, 1, 2]);
const taken = [];
for (const index of [0, 1, 2]) {
  if (removalRefusal(many.xml, many.paragraphs, index, survivors) !== null) break;
  survivors.delete(index);
  taken.push(index);
}
check(
  'taking paragraphs one at a time stops at the last one standing',
  taken.length === 2,
  `${taken.length} of 3 accepted`,
);

const emptied = applyDocxEdits(many.xml, many.runs, [], plan(many, { removals: [0, 1, 2] }));
check(
  'and the writer refuses the same thing, whatever it is handed',
  emptied === without(many, spanOf(many, 0), spanOf(many, 1)),
  `${countParagraphs(emptied)} left of 3`,
);

const twice = applyDocxEdits(many.xml, many.runs, [], plan(many, { removals: [1, 1] }));
check(
  'the same ordinal twice takes one paragraph, not the one after it as well',
  twice === without(many, spanOf(many, 1)),
  `${countParagraphs(twice)} left`,
);

/* ── a removal and an insertion in the same save ─────────────────────── */

/*
 * These are asserted as an exact identity rather than by looking for the text.
 * The reason is a measurement: a build with the rewrite guard taken out
 * produced `</w:p>w:p><w:p>` — the marker present, the removed text gone, the
 * tags balanced, the paragraph count right, and the document nonsense. Every
 * question but the exact one answered yes.
 */
const markupOf = (doc, index, text) =>
  paragraphMarkup(doc.xml, spanOf(doc, index), doc.runs, doc.succession, text);

const both = applyDocxEdits(
  many.xml,
  many.runs,
  [],
  plan(many, { inserts: [{ after: 0, text: MARKER }], removals: [1] }),
);
check(
  'inserting after one paragraph while removing the next writes exactly both',
  both ===
    many.xml.slice(0, spanOf(many, 0).end) +
      markupOf(many, 0, MARKER) +
      many.xml.slice(spanOf(many, 1).end),
  balanced(both) ? `${countParagraphs(both)} paragraphs` : 'MALFORMED',
);
check(
  'and the new paragraph stands where the removed one stood',
  both.indexOf(MARKER) > both.indexOf('>One<') && both.indexOf(MARKER) < both.indexOf('>Three<'),
);

const insideOut = applyDocxEdits(
  many.xml,
  many.runs,
  [],
  plan(many, { inserts: [{ after: 1, text: MARKER }], removals: [1] }),
);
check(
  'a paragraph added after one that is removed still lands, in its place',
  insideOut ===
    many.xml.slice(0, spanOf(many, 1).start) +
      markupOf(many, 1, MARKER) +
      many.xml.slice(spanOf(many, 1).end),
  insideOut.includes(MARKER) ? 'kept' : 'lost',
);

const withEdit = applyDocxEdits(
  many.xml,
  many.runs,
  [{ index: 1, text: 'retyped' }],
  plan(many, { removals: [1] }),
);
check(
  'a rewrite inside a removed paragraph goes with it rather than corrupting the cut',
  withEdit === without(many, spanOf(many, 1)),
  withEdit.includes('retyped') ? 'the rewrite survived the cut' : `${countParagraphs(withEdit)} paragraphs`,
);

const boxed = read(
  contrive(
    para('One') +
      `<w:p><w:r><w:drawing><wp:x xmlns:wp="wp"><w:txbxContent>${para('In a box')}</w:txbxContent></wp:x></w:drawing></w:r></w:p>` +
      para('Three'),
  ),
);
const outer = boxed.paragraphs.filter((span) => !span.refusal)[1];
const boxed_ = { ...boxed };
const boxCut = applyDocxEdits(boxed.xml, boxed.runs, [], plan(boxed, { removals: [outer.index] }));
check(
  'removing a paragraph that carries a text box takes the paragraphs inside it too',
  boxCut === without(boxed_, outer) && !boxCut.includes('In a box'),
  `${countParagraphs(boxed.xml)} → ${countParagraphs(boxCut)}`,
);

/* And a rewrite of a run in that text box goes with the paragraph carrying it. */
const boxedRun = boxed.runs.find((run) => run.start > outer.start && run.end < outer.end && run.text);
const boxEdit = applyDocxEdits(
  boxed.xml,
  boxed.runs,
  boxedRun ? [{ index: boxedRun.index, text: 'retyped in a box' }] : [],
  plan(boxed, { removals: [outer.index] }),
);
check(
  'and a rewrite nested inside it goes too, rather than moving the cut',
  boxedRun !== undefined && boxEdit === without(boxed_, outer),
  boxEdit.includes('retyped in a box') ? 'the nested rewrite survived' : 'dropped with the paragraph',
);

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
let nowhere = [];
const damaged = [];

for (const file of files) {
  let doc;
  try {
    doc = open(new Uint8Array(readFileSync(file)));
  } catch {
    continue;
  }
  if (!doc.xml) continue;

  const name = file.split(/[\\/]/).pop();
  const pick = doc.paragraphs.find(
    (span) =>
      refusalOf(doc, span.index) === null &&
      doc.runs.some((run) => run.start >= span.start && run.end <= span.end && run.text),
  );
  if (!pick) {
    nowhere.push(name);
    continue;
  }

  swept++;
  const out = applyDocxEdits(doc.xml, doc.runs, [], plan(doc, { removals: [pick.index] }));
  const before = doc.xml.slice(0, pick.start);
  const after = doc.xml.slice(pick.end);

  if (!balanced(out)) damaged.push(`${name}: not well formed`);
  else if (out !== before + after) damaged.push(`${name}: something outside the paragraph moved`);
  else if (countParagraphs(out) !== doc.paragraphs.length - countParagraphs(doc.xml.slice(pick.start, pick.end))) {
    damaged.push(
      `${name}: ${doc.paragraphs.length} → ${countParagraphs(out)}, expected ${
        doc.paragraphs.length - countParagraphs(doc.xml.slice(pick.start, pick.end))
      }`,
    );
  } else {
    const second = applyDocxEdits(doc.xml, doc.runs, [], plan(doc, { removals: [pick.index] }));
    if (second !== out) damaged.push(`${name}: a second save wrote something else`);
  }
}

check(
  'a paragraph comes out of every real document, and nothing else moves',
  swept > 0 && damaged.length === 0,
  damaged.length ? damaged.slice(0, 4).join(' · ') : `${swept}/${files.length} swept`,
);

if (nowhere.length > 0) {
  console.log(`\n${nowhere.length} offer no paragraph that may go — named rather than counted as passes:`);
  for (const name of nowhere) console.log(`  · ${name}`);
}

const failed = checks.filter((one) => !one.passed).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
