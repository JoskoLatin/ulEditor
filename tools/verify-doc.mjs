/**
 * The old binary Word reader, checked against a file built byte by byte.
 *
 * The fixture is assembled by hand (`makeDoc` in fixtures.mjs) out of the same
 * numbers the reader reads back, so every assertion here recovers something
 * that was deliberately put in — and a wrong offset shows up as a wrong
 * document rather than as a crash.
 *
 * Only the half that needs no browser runs here, which is the half worth
 * running: the piece table, the CP1252 and UTF-16 pieces, the property pages,
 * the style sheet, the table punctuation and the fields. Turning all of that
 * into elements needs a DOM and is checked in verify-ui.mjs, where one exists.
 *
 *   node tools/verify-doc.mjs
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeDoc, makeXls } from './fixtures.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { parseDoc, headingLevel } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-office/src/doc.ts')).href
);
const { Cfb } = await import(pathToFileURL(resolve(ROOT, 'packages/editor-office/src/cfb.ts')).href);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const bytes = makeDoc();

/* ── the container ───────────────────────────────────────────────────── */

/*
 * The table stream is 153 bytes, so it lives in the mini stream — a second
 * allocation of 64-byte sectors inside a stream of the root entry. Every small
 * `.doc` is built this way and no fixture had ever exercised it, which meant
 * the branch that reads it had never once run.
 */
const cfb = new Cfb(bytes);
const wordStream = cfb.stream('WordDocument');
const tableStream = cfb.stream('1Table');
check('the document stream comes out of the container', wordStream?.length === 4096, `${wordStream?.length}`);
check(
  'and the table stream out of the mini stream inside it',
  tableStream !== null && tableStream.length > 100 && tableStream.length < 4096,
  `${tableStream?.length} bytes`,
);
check('a stream that is not there is null, not an exception', cfb.stream('0Table') === null);

/* ── the two encodings ───────────────────────────────────────────────── */

/* The FIB begins the document stream: `wIdent` then `nFib`. Finding it in the
   file gives every byte offset below, and proves the layout at the same time. */
const fibAt = (() => {
  for (let i = 0; i + 4 <= bytes.length; i += 512) {
    if (bytes[i] === 0xec && bytes[i + 1] === 0xa5 && bytes[i + 2] === 0xc1) return i;
  }
  return -1;
})();
check('the document stream begins with a FIB', fibAt > 0, `at ${fibAt}`);

/*
 * `ž` is byte 0x9E in the file — CP1252, one byte — and `č` two bytes of
 * UTF-16 further on. Reading either under the other's rules is the way a
 * Croatian `.doc` comes out as mojibake, and the fixture holds both on purpose.
 */
check(
  'the narrow piece really is CP1252 on disk',
  bytes[fibAt + 0x418] === 0x9e,
  `0x${(bytes[fibAt + 0x418] ?? 0).toString(16)}`,
);

const { paragraphs, styles, notes } = parseDoc(bytes);
const textOf = (para) => para.runs.map((run) => run.text).join('');

check('every paragraph is found', paragraphs.length === 13, `${paragraphs.length}`);
check('the narrow piece is decoded as CP1252', textOf(paragraphs[1]).includes('održan'), textOf(paragraphs[1]));
check(
  'the wide piece keeps the letters CP1252 has no room for',
  textOf(paragraphs[2]) === 'Zaključci' && textOf(paragraphs[4]) === 'Drugi zaključak',
  `${textOf(paragraphs[2])} / ${textOf(paragraphs[4])}`,
);

/* ── the property pages ──────────────────────────────────────────────── */

const bold = paragraphs[1].runs.filter((run) => run.chp.bold);
check('the character properties cut the paragraph into runs', paragraphs[1].runs.length === 5, `${paragraphs[1].runs.length}`);

/*
 * Both spellings of bold, because Word uses both. It does not store "this is
 * bold" but how the letters differ from their style, so clicking the Bold
 * button on ordinary text writes 0x81 — "unlike the style" — and not 1. A
 * reader that took only the 1 passed every check written against a hand-built
 * file and found no bold whatsoever in thirty-one real documents.
 */
check(
  'bold written plainly and bold written as a toggle both arrive',
  bold.length === 2 && bold[0].text === 'održan' && bold[1].text === 'Vodicama',
  JSON.stringify(bold.map((run) => run.text)),
);
check(
  'and nothing else in the paragraph is bold',
  paragraphs[1].runs.filter((run) => !run.chp.bold).map((run) => run.text).join('') === 'Sastanak je  u .',
  JSON.stringify(paragraphs[1].runs.filter((run) => !run.chp.bold).map((run) => run.text)),
);

check('alignment is read off the paragraph', paragraphs[12].pap.jc === 1, `${paragraphs[12].pap.jc}`);
check(
  'a list paragraph says which list it is in',
  paragraphs[3].pap.ilfo === 1 && paragraphs[4].pap.ilfo === 1 && paragraphs[1].pap.ilfo === 0,
);

/* ── the style sheet ─────────────────────────────────────────────────── */

/*
 * Two ways of naming the same thing, and files use both. A built-in heading
 * carries the number Word gives its own styles and may carry no name at all;
 * one made by hand carries only a name, and in a document written here that
 * name is Croatian. A reader that handles one turns half the headings in the
 * country into paragraphs.
 */
check('a style is recognised by the number Word gave it', headingLevel(styles, 1) === 1, `${headingLevel(styles, 1)}`);
check('and one that has only a Croatian name, by the name', headingLevel(styles, 2) === 2, `${styles.names[2]}`);
check('an ordinary paragraph style is no heading', headingLevel(styles, 0) === 0);
check('the first paragraph carries the heading style', paragraphs[0].pap.istd === 1, `${paragraphs[0].pap.istd}`);

/* ── the table, which is only punctuation ────────────────────────────── */

const cells = paragraphs.filter((para) => para.pap.inTable);
check('the table paragraphs are marked as such', cells.length === 6, `${cells.length}`);
check(
  'a cell ends at the cell mark',
  paragraphs[5].cell && textOf(paragraphs[5]) === 'Stavka' && textOf(paragraphs[8]) === 'Prijevoz',
  `${textOf(paragraphs[5])} / ${textOf(paragraphs[8])}`,
);
check(
  'and a row at the paragraph that says so',
  paragraphs[7].pap.rowEnd && paragraphs[10].pap.rowEnd && !paragraphs[5].pap.rowEnd,
);
check('nothing outside the table claims to be in one', !paragraphs[11].pap.inTable && !paragraphs[0].pap.inTable);

/* ── fields ──────────────────────────────────────────────────────────── */

/*
 * A field is stored twice: the instruction that computes it and the text Word
 * last drew. Showing the first is how a document ends up reading
 * "Stranica PAGE 2" — the machinery on the page beside its own result.
 */
check(
  'the field instruction is dropped and its result kept',
  textOf(paragraphs[11]) === 'Stranica 2.',
  JSON.stringify(textOf(paragraphs[11])),
);

/* ── what the view does not show ─────────────────────────────────────── */

check(
  'a header the view cannot draw is named rather than left out silently',
  [...notes].some((note) => /headers and footers/.test(note)),
  JSON.stringify([...notes]),
);
check(
  'and so is everything about the look that is not carried across',
  [...notes].some((note) => /Fonts, sizes/.test(note)),
);

/* ── the refusals ────────────────────────────────────────────────────── */

const refusal = (bad) => {
  try {
    parseDoc(bad);
    return '';
  } catch (error) {
    return String(error.message ?? error);
  }
};

check(
  'a compound file with no Word document in it says so',
  /no Word document inside/.test(refusal(makeXls())),
  refusal(makeXls()),
);
check('a truncated file is called damaged', /damaged/.test(refusal(bytes.slice(0, 400))), refusal(bytes.slice(0, 400)));

const notWord = Uint8Array.from(bytes);
notWord[fibAt] = 0x00;
check('a stream that is not a FIB is called damaged too', /damaged/.test(refusal(notWord)), refusal(notWord));

/*
 * Word 6 and 95 kept a different block at the front of the same stream, with
 * every pointer read below at some other offset. Reading it anyway would draw
 * whatever those bytes happened to mean.
 */
const older = Uint8Array.from(bytes);
older[fibAt + 2] = 0x68;
older[fibAt + 3] = 0x00;
check('an older Word than 97 is named, not misread', /Word 6 or 95/.test(refusal(older)), refusal(older));

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
