/**
 * A new paragraph in a Word document — and what the file looks like around it.
 *
 * [`verify-docx-edit.mjs`](./verify-docx-edit.mjs) proves that rewriting a run
 * touches only that run. A new paragraph is the first change this program makes
 * that is **not** a substitution: something exists afterwards that did not exist
 * before, and every promise the byte-range model rests on has to be restated for
 * it. So the questions here are the same ones asked of a rewrite, plus the ones
 * only an insertion raises:
 *
 * - is **everything else** still byte for byte identical — every other part of
 *   the archive, and every character of `document.xml` outside the one point;
 * - is the document one paragraph longer, and exactly one;
 * - did the new paragraph inherit what it should have inherited, and **not**
 *   inherit what it must not: a section break, or somebody else's tracked change;
 * - is a style **resolved** rather than copied, so a paragraph after a heading is
 *   body text and not a second heading;
 * - and is the write **idempotent** — saving twice from the untouched original
 *   has to produce the same bytes, because that is the whole premise of holding
 *   the change as a plan rather than applying it.
 *
 * `pnpm readback` then hands the result to LibreOffice, which is the only reader
 * here that shares no code with the writer. This check and that one answer
 * different halves of the same question and neither replaces the other.
 *
 *   node tools/verify-docx-insert.mjs
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
  paragraphMarkup,
  applyDocxEdits,
  writeDocx,
  scanTags,
  localName,
} = await import(pathToFileURL(resolve(ROOT, 'packages/editor-office/src/docx-edit.ts')).href);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const MARKER = 'Novi odlomak — čćžšđ ČĆŽŠĐ';

/** Reads a document part, the plan, and the succession, the way the editor does. */
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

function inserting(doc, inserts) {
  return { paragraphs: doc.paragraphs, succession: doc.succession, inserts };
}

/** Whether every open tag is closed in order — a cheap well-formedness bar. */
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

const countParagraphs = (xml) => findParagraphs(xml).length;

/* ── the fixture, in detail ──────────────────────────────────────────── */

const fixture = open(makeDocx());

const body = fixture.paragraphs.filter((span) => !span.refusal);
const nested = fixture.paragraphs.filter((span) => span.refusal);
check(
  'the paragraphs of the body are told apart from those in a table',
  body.length > 0 && nested.length > 0,
  `${body.length} in the body, ${nested.length} refused`,
);

const plain = body.find((span) => !span.props);
const after = plain ?? body[0];
const one = applyDocxEdits(fixture.xml, fixture.runs, [], inserting(fixture, [{ after: after.index, text: MARKER }]));

check('the part is still well formed', balanced(one));
check(
  'the document is exactly one paragraph longer',
  countParagraphs(one) === fixture.paragraphs.length + 1,
  `${fixture.paragraphs.length} → ${countParagraphs(one)}`,
);

/* The heart of it: everything outside the single insertion point is untouched. */
const at = after.end;
check(
  'every character before the new paragraph is unchanged',
  one.slice(0, at) === fixture.xml.slice(0, at),
);
check(
  'every character after it is unchanged',
  one.slice(at + (one.length - fixture.xml.length)) === fixture.xml.slice(at),
);

const added = one.slice(at, at + (one.length - fixture.xml.length));
check('and what was added is a single paragraph', /^<w:p[\s>][\s\S]*<\/w:p>$/.test(added) || /^<w:p>[\s\S]*<\/w:p>$/.test(added), added.slice(0, 70));
check('carrying the text that was typed', added.includes(MARKER.replace(/&/g, '&amp;')));
check(
  'with the space preserved, so a leading space is not eaten',
  added.includes('xml:space="preserve"'),
);

/* ── what must not be inherited ──────────────────────────────────────── */

const forbidden = ['sectPr', 'pPrChange', 'ins', 'del'];
const withProps = body.find((span) => span.props);
const fromProps = paragraphMarkup(
  fixture.xml,
  withProps,
  fixture.runs,
  fixture.succession,
  MARKER,
);
check(
  'a new paragraph carries none of the marks that belong to another paragraph',
  forbidden.every((name) => ![...scanTags(fromProps)].some((tag) => localName(tag.name) === name)),
  forbidden.join(', '),
);

/* A hand-built document is the only way to exercise the rules the real corpus
   does not contain: it has no tracked changes anywhere, and its one mid-document
   section break sits on a paragraph with no text. */
const contrived =
  '<w:document xmlns:w="w"><w:body>' +
  '<w:p><w:pPr><w:pStyle w:val="Naslov1"/><w:ind w:left="720"/>' +
  /* The tracked insertion of a paragraph does not live in the `w:pPr` — it
     lives one level down, on the paragraph mark's own run properties, beside
     formatting that must be kept. */
  '<w:rPr><w:ins w:id="7" w:author="Netko" w:date="2020-01-01T00:00:00Z"/><w:i/></w:rPr>' +
  '<w:sectPr><w:pgSz w:w="1"/></w:sectPr>' +
  '<w:pPrChange w:id="1" w:author="Someone"><w:pPr/></w:pPrChange>' +
  '</w:pPr><w:r><w:rPr><w:b/><w:sz w:val="96"/></w:rPr><w:t>Naslov</w:t></w:r></w:p>' +
  '</w:body></w:document>';
const contrivedDoc = {
  xml: contrived,
  runs: findRuns(contrived),
  paragraphs: findParagraphs(contrived),
  succession: readStyleSuccession(
    '<w:styles xmlns:w="w"><w:style w:type="paragraph" w:styleId="Naslov1">' +
      '<w:next w:val="Normal"/></w:style>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"/></w:styles>',
  ),
};

const heir = paragraphMarkup(
  contrived,
  contrivedDoc.paragraphs[0],
  contrivedDoc.runs,
  contrivedDoc.succession,
  MARKER,
);

check(
  'a section break is not carried into the paragraph after it',
  !heir.includes('sectPr'),
  heir.includes('sectPr') ? heir : '',
);
check(
  "another person's tracked change is not carried either",
  !heir.includes('pPrChange') && !heir.includes('Someone'),
);
check(
  'nor the one on the paragraph mark, which is where a tracked insertion lives',
  !heir.includes('Netko') && !heir.includes('w:ins'),
  heir.includes('Netko') ? heir.slice(0, 140) : '',
);
check(
  'while the formatting standing beside it is kept',
  heir.includes('<w:i/>'),
);
check(
  'the indentation of the source paragraph is kept',
  heir.includes('<w:ind w:left="720"/>'),
);
check(
  'a heading hands on the style it names, so the new paragraph is body text',
  /* `Normal` is the document default here, so the resolved style is no `pStyle`
     at all rather than one naming the default — which is what Word writes. */
  !heir.includes('Naslov1') && !heir.includes('pStyle'),
  heir.includes('pStyle') ? `still styled: ${heir.slice(0, 120)}` : 'no pStyle, as the default needs none',
);

/* A style whose heir is NOT the document default is named outright. */
const namedHeir = paragraphMarkup(
  contrived,
  contrivedDoc.paragraphs[0],
  contrivedDoc.runs,
  readStyleSuccession(
    '<w:styles xmlns:w="w"><w:style w:type="paragraph" w:styleId="Naslov1">' +
      '<w:next w:val="Tijeloteksta"/></w:style>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"/></w:styles>',
  ),
  MARKER,
);
check(
  'and when the heir is a style of its own, the new paragraph names it',
  namedHeir.includes('<w:pStyle w:val="Tijeloteksta"/>'),
  namedHeir.slice(0, 90),
);
check(
  'and the text takes the formatting of the run it follows, not the document default',
  heir.includes('<w:b/>') && heir.includes('<w:sz w:val="96"/>'),
  'bold, 48pt',
);

/* A picture in the paragraph holds runs of its own, and the formatting of a
   caption inside a text box is not the formatting of the line being continued. */
const drawn =
  '<w:document xmlns:w="w"><w:body><w:p>' +
  '<w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t>Uz sliku</w:t></w:r>' +
  '<w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:drawing><wp:inline><w:txbxContent>' +
  '<w:p><w:r><w:rPr><w:sz w:val="8"/></w:rPr><w:t>Potpis</w:t></w:r></w:p>' +
  '</w:txbxContent></wp:inline></w:drawing></w:r>' +
  '</w:p></w:body></w:document>';
const drawnMarkup = paragraphMarkup(
  drawn,
  findParagraphs(drawn)[0],
  findRuns(drawn),
  readStyleSuccession(null),
  MARKER,
);
check(
  "the formatting comes from the paragraph's own last run, not one inside a picture",
  drawnMarkup.includes('<w:color w:val="FF0000"/>') && !drawnMarkup.includes('w:sz w:val="8"'),
  drawnMarkup.slice(0, 110),
);

/* A style that follows itself — a list item — says nothing new and is kept. */
const listXml =
  '<w:document xmlns:w="w"><w:body>' +
  '<w:p><w:pPr><w:pStyle w:val="Odlomakpopisa"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr>' +
  '<w:r><w:t>Prva</w:t></w:r></w:p></w:body></w:document>';
const listMarkup = paragraphMarkup(
  listXml,
  findParagraphs(listXml)[0],
  findRuns(listXml),
  readStyleSuccession(
    '<w:styles xmlns:w="w"><w:style w:type="paragraph" w:styleId="Odlomakpopisa">' +
      '<w:next w:val="Odlomakpopisa"/></w:style></w:styles>',
  ),
  MARKER,
);
check(
  'a list item makes another list item, numbering and all',
  listMarkup.includes('w:numId w:val="3"') && listMarkup.includes('Odlomakpopisa'),
);

/* ── what a step is allowed to do ────────────────────────────────────── */

const empty = applyDocxEdits(fixture.xml, fixture.runs, [], inserting(fixture, [{ after: after.index, text: '' }]));
check(
  'a paragraph nobody typed into is a paragraph nobody added',
  empty === fixture.xml,
);

const refused = applyDocxEdits(
  fixture.xml,
  fixture.runs,
  [],
  inserting(fixture, [{ after: nested[0].index, text: MARKER }]),
);
check(
  'a paragraph inside a table cell is refused rather than half-done',
  refused === fixture.xml,
  nested[0].refusal,
);

const two = applyDocxEdits(
  fixture.xml,
  fixture.runs,
  [],
  inserting(fixture, [
    { after: after.index, text: 'Prvi' },
    { after: after.index, text: 'Drugi' },
  ]),
);
check(
  'two new paragraphs after the same one keep the order they were added in',
  two.indexOf('Prvi') < two.indexOf('Drugi') && countParagraphs(two) === fixture.paragraphs.length + 2,
);

/* ── a rewrite and an insertion in the same save ─────────────────────── */

const editable = fixture.runs.filter((run) => !run.refusal);
const target = editable[editable.length - 1];
const both = applyDocxEdits(
  fixture.xml,
  fixture.runs,
  [{ index: target.index, text: 'Prepisano' }],
  inserting(fixture, [{ after: after.index, text: MARKER }]),
);
check(
  'a rewrite and a new paragraph in one save do not move each other',
  balanced(both) &&
    both.includes('Prepisano') &&
    both.includes(MARKER) &&
    countParagraphs(both) === fixture.paragraphs.length + 1,
);

/* ── the plan is a plan ──────────────────────────────────────────────── */

const first = writeDocx(
  fixture.archive,
  fixture.runs,
  fixture.xml,
  [{ index: target.index, text: 'Prepisano' }],
  inserting(fixture, [{ after: after.index, text: MARKER }]),
);
const second = writeDocx(
  fixture.archive,
  fixture.runs,
  fixture.xml,
  [{ index: target.index, text: 'Prepisano' }],
  inserting(fixture, [{ after: after.index, text: MARKER }]),
);
check(
  'saving twice from the untouched original writes the same file',
  Buffer.compare(Buffer.from(first), Buffer.from(second)) === 0,
  `${first.length} bytes`,
);

const rebuilt = unzipSync(first);
const others = Object.keys(fixture.archive).filter((name) => name !== 'word/document.xml');
check(
  'every other part of the archive comes through byte for byte',
  others.length > 0 &&
    others.every(
      (name) =>
        rebuilt[name] &&
        Buffer.compare(Buffer.from(rebuilt[name]), Buffer.from(fixture.archive[name])) === 0,
    ),
  `${others.length} parts`,
);

/* ── and now somebody's real documents ───────────────────────────────── */

function walk(dir, out = [], depth = 0) {
  if (depth > 5) return out;
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

if (files.length === 0) {
  check(
    'a corpus of real documents was walked',
    false,
    `nothing under ${corpus} — set UL_CORPUS to a folder of real .docx`,
  );
} else {
  let tried = 0;
  let clean = 0;
  const trouble = [];
  const unread = [];
  const nowhere = [];

  for (const file of files) {
    const name = file.split(/[\\/]/).pop();
    let doc;
    try {
      doc = open(readFileSync(file));
    } catch (error) {
      // Not a document this check is about; fidelity.mjs reports those.
      unread.push(`${name}: ${error.message}`);
      continue;
    }

    const candidates = doc.paragraphs.filter((span) => !span.refusal);
    const pick = candidates.find((span) => doc.runs.some((run) => paragraphOfRun(doc.paragraphs, run) === span));
    if (!pick) {
      /* Every paragraph is in a table cell, so there is no legal place to put a
         new one. Saying so is the point — three of these documents exist, and a
         check that counted them as passes would be measuring nothing. */
      nowhere.push(name);
      continue;
    }

    tried++;
    const written = applyDocxEdits(doc.xml, doc.runs, [], inserting(doc, [{ after: pick.index, text: MARKER }]));
    const grew = written.length - doc.xml.length;

    const problems = [];
    if (!balanced(written)) problems.push('the part is no longer balanced');
    if (countParagraphs(written) !== doc.paragraphs.length + 1) {
      problems.push(`${doc.paragraphs.length} → ${countParagraphs(written)} paragraphs`);
    }
    if (written.slice(0, pick.end) !== doc.xml.slice(0, pick.end)) problems.push('the text before it moved');
    if (written.slice(pick.end + grew) !== doc.xml.slice(pick.end)) problems.push('the text after it moved');
    const inserted = written.slice(pick.end, pick.end + grew);
    for (const forbid of forbidden) {
      if ([...scanTags(inserted)].some((tag) => localName(tag.name) === forbid)) {
        problems.push(`it inherited a ${forbid}`);
      }
    }
    if (!inserted.includes(MARKER)) problems.push('the text is not in it');

    if (problems.length === 0) clean++;
    else trouble.push(`${name}: ${problems.join('; ')}`);
  }

  check(
    'a paragraph goes into every real document, and nothing else moves',
    tried > 0 && clean === tried,
    `${clean}/${tried} of ${files.length} found`,
  );
  for (const line of trouble.slice(0, 10)) console.log(`  · ${line}`);
  if (trouble.length > 10) console.log(`  · …and ${trouble.length - 10} more`);
  if (nowhere.length > 0) {
    console.log(
      `\n${nowhere.length} have no paragraph a new one may follow — every one of theirs is in a table:`,
    );
    for (const name of nowhere) console.log(`  · ${name}`);
  }
  if (unread.length > 0) {
    console.log(`\n${unread.length} could not be read as a Word document at all:`);
    for (const line of unread.slice(0, 5)) console.log(`  · ${line}`);
  }
}

const failed = checks.filter((one) => !one.passed).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
