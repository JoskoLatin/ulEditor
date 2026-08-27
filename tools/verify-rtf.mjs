/**
 * Rich Text, checked against a file built instruction by instruction.
 *
 * The fixture (`makeRtf` in fixtures.mjs) is written to contain every way this
 * format has of putting bytes in a file that are not the document — a picture,
 * a generator signature, binary data, hidden text, a field instruction — so
 * that "the text came out right" also means "and nothing else came out with
 * it".
 *
 * Only the half that needs no browser runs here. Turning paragraphs into
 * elements is `buildPreview`, shared with the old binary Word and checked in
 * verify-ui.mjs where a DOM exists.
 *
 *   node tools/verify-rtf.mjs
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeRtf } from './fixtures.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { parseRtf } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-office/src/rtf.ts')).href
);
const { headingLevel } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-office/src/doc.ts')).href
);
const { fromCodePage } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-office/src/codepages.ts')).href
);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const bytes = makeRtf();
const { paragraphs, styles, notes } = parseRtf(bytes);
const textOf = (para) => para.runs.map((run) => run.text).join('');
const all = paragraphs.map(textOf).join('\n');

/* ── the two code pages ──────────────────────────────────────────────── */

/*
 * The trap this format sets, and the reason a Croatian file needs a reader that
 * knows about it. `0xE8` appears twice in the fixture: once in text set in a
 * font that declares charset 238, where it is `č`, and once in text set in a
 * font that does not, where it is `è`. A reader that takes the document's own
 * `\ansicpg1252` as the answer everywhere turns every Croatian word into
 * something that reads like a damaged file rather than like a bug.
 */
check('0xE8 is two different letters in the two pages', fromCodePage(0xe8, 1250) === 'č' && fromCodePage(0xe8, 1252) === 'è');
check(
  'the font that declares CP1250 is decoded as CP1250',
  textOf(paragraphs[1]) === 'Sastanak je održen u Vodicama, zaključak: ćemo nastaviti.',
  textOf(paragraphs[1]),
);
check(
  'and the same byte in a font that does not is left alone',
  textOf(paragraphs[2]) === 'Café: è',
  textOf(paragraphs[2]),
);

/*
 * The other half of the encoding problem. Every Unicode character is written
 * twice — as itself and as something an old reader could print — and `\uc1`
 * says the second copy is one character long. Not swallowing it puts a question
 * mark after every Croatian letter in the document.
 */
check(
  'a character written as \\u brings no question mark with it',
  textOf(paragraphs[3]) === 'Ivan Perković',
  textOf(paragraphs[3]),
);

/* ── runs ────────────────────────────────────────────────────────────── */

{
  const marked = paragraphs[4].runs.filter((run) => run.chp.bold || run.chp.italic || run.chp.strike);
  check(
    'bold, italic and struck through each end where their zero says',
    marked.map((run) => run.text).join('|') === 'podebljano|ukoseno|precrtano',
    marked.map((run) => run.text).join('|'),
  );
  check(
    'and the words between them carry nothing',
    textOf(paragraphs[4]) === 'Ovo je podebljano i ukoseno i precrtano.',
    textOf(paragraphs[4]),
  );
}

/* ── paragraphs ──────────────────────────────────────────────────────── */

check('alignment is read', paragraphs[5].pap.jc === 1, `${paragraphs[5].pap.jc}`);
check(
  'a list paragraph says which list it is in',
  paragraphs[6].pap.ilfo === 1 && paragraphs[7].pap.ilfo === 1 && paragraphs[4].pap.ilfo === 0,
);

/*
 * Two ways of being a heading, and files use both. One carries a style whose
 * name says so — and in a document written here that name is Croatian. The
 * other carries an ordinary body style and declares itself only with
 * `\outlinelevel`, which is what Word writes when somebody set the outline
 * level by hand rather than applying a heading style.
 */
check(
  'a heading named in Croatian is a heading',
  headingLevel(styles, paragraphs[0].pap.istd) === 1,
  styles.names[paragraphs[0].pap.istd],
);
check(
  'and one that says so only with an outline level is too',
  headingLevel(styles, paragraphs[8].pap.istd) === 2,
  styles.names[paragraphs[8].pap.istd],
);
check(
  'an ordinary paragraph is neither',
  headingLevel(styles, paragraphs[4].pap.istd) === 0,
);

/* ── the table ───────────────────────────────────────────────────────── */

{
  const inTable = paragraphs.filter((para) => para.pap.inTable);
  check('the table paragraphs are marked as such', inTable.length === 6, `${inTable.length}`);
  check(
    'a cell ends where the cell mark is',
    paragraphs[9].cell && textOf(paragraphs[9]) === 'Stavka' && textOf(paragraphs[12]) === 'Prijevoz',
    `${textOf(paragraphs[9])} / ${textOf(paragraphs[12])}`,
  );
  check(
    'and a row where the row mark is',
    paragraphs[11].pap.rowEnd && paragraphs[14].pap.rowEnd && !paragraphs[9].pap.rowEnd,
  );
  check(
    'nothing outside the table claims to be in one',
    !paragraphs[15].pap.inTable && !paragraphs[0].pap.inTable,
  );
}

/* ── what must not reach the page ────────────────────────────────────── */

/*
 * A field is stored twice: the instruction that computes it and the text the
 * writer last drew. Showing the first is how a document ends up reading
 * "Stranica PAGE 2" — the machinery beside its own result.
 */
check(
  'the field instruction is dropped and its result kept',
  textOf(paragraphs[15]) === 'Stranica 2 .',
  JSON.stringify(textOf(paragraphs[15])),
);

/*
 * Hidden text, and the bug it caused the first time. `\v` is a property of the
 * characters, not a destination — it is turned off by `\v0` *inside* the very
 * stretch it turned on. A reader that treats it as a group to skip never reads
 * the instruction that ends it, and everything after the first hidden word in
 * the file is silently lost. Here that was the last paragraph.
 */
check(
  'hidden text does not reach the page',
  textOf(paragraphs[16]) === 'Vidljivo.',
  JSON.stringify(textOf(paragraphs[16])),
);
check(
  'and the document carries on after it',
  textOf(paragraphs[17]) === 'Kraj',
  JSON.stringify(textOf(paragraphs[17])),
);

check('a picture is left out', !all.includes('0102030405'));
check('the binary data after \\bin is skipped, not printed', !all.includes('....'));
check('the generator signature is not part of the document', !all.includes('Riched20'));
check('nor is the font table', !all.includes('Times New Roman') && !all.includes('Arial'));
check('nor the style sheet', !all.includes('Body Text'));

/* ── what the view does not show ─────────────────────────────────────── */

check(
  'the picture it could not draw is named rather than left out silently',
  [...notes].some((note) => /Pictures are not shown/.test(note)),
  JSON.stringify([...notes]),
);
check(
  'and so is everything about the look that is not carried across',
  [...notes].some((note) => /Fonts, sizes/.test(note)),
);
check(
  'a numbered list says its numbers are gone',
  [...notes].some((note) => /Numbering is not carried over/.test(note)),
);

/* ── the list marker, which the writer supplies and the view also draws ── */

/*
 * Word 97 onwards and LibreOffice put the bullet or the number in a group of
 * its own in front of the item. Read as text it lands in the paragraph, and
 * then the view — seeing a paragraph in a list — draws its own marker in front
 * of that, so every list in every real file came out as "• · Prva stavka"
 * and a numbered one as "• 1. Prva stavka" beneath a note saying the numbering
 * had not been carried over. The fixture writes its list the way Word does, and
 * this is the assertion that keeps it that way.
 */
check(
  'the marker the writer supplied does not reach the text',
  textOf(paragraphs[6]) === 'Prva stavka' && textOf(paragraphs[7]) === 'Druga stavka',
  `${textOf(paragraphs[6])} / ${textOf(paragraphs[7])}`,
);
check(
  'and the paragraph is still a list item',
  paragraphs[6].pap.ilfo === 1 && paragraphs[7].pap.ilfo === 1,
);

/* ── an alphabet this reader does not have ── */

/*
 * Two code pages are decoded and the rest are read as Western. For Cyrillic or
 * Greek that is not a failure the reader can see — the letters come back as
 * *different* letters, which looks like a document rather than like a fault.
 * So it is said above the document instead.
 */
check(
  'a font in an alphabet it cannot decode is named, not guessed at silently',
  [...notes].some((note) => /alphabet this reader does not decode/.test(note)),
  JSON.stringify([...notes]),
);

/* ── what a damaged file may not do ── */

/*
 * Every one of these came out of a fuzz over malformed input, and every one of
 * them ended the same way: a file that is merely damaged took the whole reader
 * with it, so the document that was mostly readable showed nothing at all —
 * and in one case showed the JavaScript engine's own English sentence in place
 * of the program's.
 */
const B = String.fromCharCode(92);
const rtf = (body) => {
  const text = ('{@rtf1@ansi ' + body + '}').replaceAll('@', B);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
};
const survives = (name, body, expected) => {
  let outcome;
  try {
    outcome = parseRtf(typeof body === 'string' ? rtf(body) : body)
      .paragraphs.map(textOf)
      .join(' | ');
  } catch (error) {
    outcome = `THREW ${error.constructor.name}: ${error.message}`;
  }
  check(name, outcome === expected, JSON.stringify(outcome));
};

survives('a code point outside Unicode loses its character, not the file', 'a@u1114112 ?b@par', 'ab');
survives('a control word three hundred thousand letters long is survivable', '@' + 'x'.repeat(300000) + ' kraj@par', 'kraj');
survives('the swallow counter does not eat text past the brace it was set in', '{@uc3@u263 }XYZ@par', 'ćXYZ');

{
  /* Everything after the brace that closes the document is not the document.
     Reading it added a paragraph of somebody's stray bytes to the end. */
  const text = ('{@rtf1@ansi unutra@par}IZVAN@par').replaceAll('@', B);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  survives('bytes after the closing brace are not part of the document', bytes, 'unutra');
}

{
  /* A file that ends mid-escape had the byte past its end read as the second
     hex digit, which turned the last letter into a control character. */
  const text = ('{@rtf1@ansi abc@' + "'" + 'e').replaceAll('@', B);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  survives('a hex escape cut in half at the end of the file adds nothing', bytes, 'abc');
}

/* ── refusals ────────────────────────────────────────────────────────── */

const refusal = (bad) => {
  try {
    parseRtf(bad);
    return '';
  } catch (error) {
    return String(error.message ?? error);
  }
};

check(
  'a file that is not Rich Text is refused',
  /not a Rich Text/.test(refusal(new TextEncoder().encode('Poštovani, ovo je obična poruka.'))),
  refusal(new TextEncoder().encode('nope')),
);

/*
 * The check that would have caught the first spelling of the signature. It was
 * written as a string literal, and the backslash in it was read as an escape —
 * so the reader looked for a carriage return where the format keeps a
 * backslash, and refused every Rich Text file in existence.
 */
check(
  'and a real one is not',
  refusal(bytes) === '' && bytes[1] === 0x5c,
  `second byte 0x${bytes[1].toString(16)}`,
);

/* Truncation must not become a refusal: half a file still holds text somebody
   wants to see, and RTF is read from the front. */
check(
  'a file cut in half still gives up what it holds',
  parseRtf(bytes.slice(0, 600)).paragraphs.some((para) => textOf(para).includes('Vodicama')),
);

/* ── the name is not the format ──────────────────────────────────────── */

const { detect } = await import(
  pathToFileURL(resolve(ROOT, 'packages/shell-ui/src/host/detect.ts')).href
);

check('a .rtf is Rich Text', detect('upitnik.rtf', bytes).format === 'rtf', detect('upitnik.rtf', bytes).format);
check(
  'and so is a file called .doc that is Rich Text underneath',
  detect('Upitnik za poslodavca.doc', bytes).format === 'rtf',
  detect('Upitnik za poslodavca.doc', bytes).format,
);

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
