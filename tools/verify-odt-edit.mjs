/**
 * Checking that retyping text in an OpenDocument document touches **only what
 * the person touched** — and that the ordinals the view was built with still
 * mean what they meant.
 *
 * The first half is the same promise `verify-docx-edit.mjs` measures, made in a
 * format that keeps its formatting in a different place, so it is measured
 * again rather than assumed: every other part of the archive byte for byte, and
 * inside `content.xml` every character outside the rewritten ranges.
 *
 * The second half is this format's own hazard. ODF collapses whitespace exactly
 * as HTML does, so a run of spaces is an element — `<text:s text:c="3"/>` — and
 * a piece of text is a stretch of character data with those elements inside it.
 * Two things follow, and both are checked here:
 *
 * - **spacing survives a rewrite.** Type two spaces after a full stop and a
 *   literal `"  "` comes back out of LibreOffice as one. What is written back
 *   has to decode to exactly what was typed.
 * - **an emptied piece keeps its place.** Delete the text of a piece and there
 *   is no character data left where it was, so reading the file again would not
 *   find a piece there at all and every ordinal after it would shift by one —
 *   while the view on screen still carries the old ones. The next save would
 *   then land in the wrong sentence, silently, which is the only kind of wrong
 *   this project treats as unacceptable.
 *
 * The reader's side of it — pairing a piece with the text drawn for it on the
 * page — needs a DOM, so it is checked in `verify-ui.mjs`, in a browser.
 *
 *   node tools/verify-odt-edit.mjs
 */

import { unzipSync, strFromU8 } from 'fflate';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeOdt } from './fixtures.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { findOdtPieces, applyOdtEdits, movedPieces, odtTextXml, textPrefix, spacesOf } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-office/src/odt-edit.ts')).href
);
const { writeOdf } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-office/src/odf-package.ts')).href
);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const archive = unzipSync(makeOdt());
const xml = strFromU8(archive['content.xml']);
const pieces = findOdtPieces(xml);
const editable = pieces.filter((piece) => !piece.refusal && piece.text.trim() !== '');

/* ── reading the pieces ──────────────────────────────────────────────── */

check('the pieces were found', editable.length > 0, `${editable.length} of ${pieces.length}`);

check(
  'a piece reads as the text it stands for',
  editable.some((piece) => piece.text === 'Izvjestaj o vjernosti') &&
    editable.some((piece) => piece.text === 'Uvodni odlomak s dijakriticima: čćšžđ.'),
);

check(
  'the ranges are in order and do not overlap',
  pieces.every((piece, i) => (i === 0 || piece.start >= pieces[i - 1].end) && piece.end >= piece.start),
);

/*
 * The fixture writes `Ime<text:s text:c="5"/>Prezime`, which is how every
 * writing program spells a run of spaces. Read as `textContent` it is
 * "ImePrezime" — the quiet damage this decoding exists to prevent.
 */
const spaced = pieces.find((piece) => piece.text.startsWith('Ime'));
check('spacing elements are decoded into the text', spaced?.text === `Ime${' '.repeat(5)}Prezime`, JSON.stringify(spaced?.text));

check(
  'a run of spaces is one piece, not three',
  spaced !== undefined && xml.slice(spaced.start, spaced.end) === 'Ime<text:s text:c="5"/>Prezime',
);

check('a count nobody could mean is capped', spacesOf(1e9).length === 4096, `${spacesOf(1e9).length}`);
check('a missing count is one space', spacesOf(null) === ' ');

/*
 * Formatting in this format is an *ancestor*, so the text inside a span is a
 * piece of its own — that is the granularity a rewrite has to work at, and it
 * is what lets the bold half of a line be retyped without touching the rest.
 */
check(
  'text inside a span is a piece of its own',
  pieces.some((piece) => piece.text === 'Podebljano ') && pieces.some((piece) => piece.text === 'i ukoseno'),
);

/* ── what is refused ─────────────────────────────────────────────────── */

const fielded = findOdtPieces(
  `<office:document-content xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">` +
    `<text:p>Datum: <text:date text:date-value="2026-08-27">27.08.2026.</text:date></text:p>` +
    `<text:p><text:span>Ovo se smije</text:span></text:p>` +
    `</office:document-content>`,
);
check(
  "a field's drawn text is not offered for rewriting",
  fielded.find((piece) => piece.text === '27.08.2026.')?.refusal !== null,
  fielded.find((piece) => piece.text === '27.08.2026.')?.refusal ?? 'it was offered',
);
check(
  'the text beside it still is',
  fielded.find((piece) => piece.text === 'Datum: ')?.refusal === null &&
    fielded.find((piece) => piece.text === 'Ovo se smije')?.refusal === null,
);

/* A line break, an image or a footnote ends a piece rather than being swallowed by one. */
const broken = findOdtPieces(
  `<office:document-content xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">` +
    `<text:p>Prvi<text:line-break/>Drugi<draw:frame><draw:image xlink:href="a.png"/></draw:frame>Treci</text:p>` +
    `</office:document-content>`,
);
check(
  'a break and an image end a piece',
  JSON.stringify(broken.map((piece) => piece.text)) === JSON.stringify(['Prvi', 'Drugi', 'Treci']),
  JSON.stringify(broken.map((piece) => piece.text)),
);

/*
 * A comment between two words is skipped whole by the tag scan, so the range of
 * the piece around it covers it too. Replacing that range would delete the
 * comment along with the text — so the piece is read and not offered.
 */
const commented = findOdtPieces(
  `<office:document-content xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">` +
    `<text:p>Prije<!-- biljeska -->poslije</text:p>` +
    `</office:document-content>`,
);
check(
  'a range that covers a comment is not offered for rewriting',
  commented.length === 1 && commented[0].refusal !== null,
  commented[0]?.refusal ?? `${commented.length} pieces, none refused`,
);

/* ── writing ─────────────────────────────────────────────────────────── */

const prefix = textPrefix(xml);
check('the text prefix is read from the file, not assumed', prefix === 'text', prefix);
check(
  'a file that binds the prefix differently is written its way',
  textPrefix(
    `<office:document-content xmlns:t="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><t:p/></office:document-content>`,
  ) === 't',
);

/*
 * How a piece is written back. The middle space of "a b" is a space; the ones
 * ODF would collapse are elements, because a literal `"  "` in this format is
 * one space the moment anybody opens the file.
 */
const spellings = [
  ['jedan dva', 'jedan dva'],
  ['dva  razmaka', `dva <${prefix}:s/>razmaka`],
  ['  na pocetku', `<${prefix}:s ${prefix}:c="2"/>na pocetku`],
  ['na kraju ', `na kraju<${prefix}:s/>`],
  ['tab\tovdje', `tab<${prefix}:tab/>ovdje`],
  ['& < >', '&amp; &lt; &gt;'],
  ['dva\nreda', 'dva reda'],
];
for (const [typed, expected] of spellings) {
  check(
    `"${typed.replace(/\n/g, '\\n')}" is written the way ODF writes it`,
    odtTextXml(typed, prefix) === expected,
    odtTextXml(typed, prefix),
  );
}

/** What a piece of written XML says, read back the way the reader reads it. */
function decode(written) {
  return written
    .replace(new RegExp(`<${prefix}:s ${prefix}:c="(\\d+)"/>`, 'g'), (_, n) => ' '.repeat(Number(n)))
    .replace(new RegExp(`<${prefix}:s/>`, 'g'), ' ')
    .replace(new RegExp(`<${prefix}:tab/>`, 'g'), '\t')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
check(
  'everything written decodes back to what was typed',
  spellings.every(([typed]) => decode(odtTextXml(typed, prefix)) === typed.replace(/[\r\n]+/g, ' ')),
);

/* ── only the ranges asked for ───────────────────────────────────────── */

const TYPED = 'Ivan  Horvat\tzavrsni ';
const edits = [
  { index: spaced.index, text: TYPED },
  { index: pieces.find((piece) => piece.text === 'Podebljano ').index, text: 'PODEBLJANO ' },
];
const edited = applyOdtEdits(xml, pieces, edits);

let cursor = 0;
let rebuilt = '';
for (const edit of [...edits].sort((a, b) => a.index - b.index)) {
  const piece = pieces[edit.index];
  rebuilt += xml.slice(cursor, piece.start) + odtTextXml(edit.text, prefix);
  cursor = piece.end;
}
rebuilt += xml.slice(cursor);
check('nothing outside the rewritten ranges moved', rebuilt === edited);

const untouched = (list) =>
  JSON.stringify(
    list.filter((piece) => !edits.some((edit) => edit.index === piece.index)).map((piece) => piece.text),
  );
check('the other pieces read the same afterwards', untouched(pieces) === untouched(findOdtPieces(edited)));

check(
  'what was typed is what the file now says',
  findOdtPieces(edited)[spaced.index].text === TYPED,
  JSON.stringify(findOdtPieces(edited)[spaced.index].text),
);

/* ── the ordinals after a save ───────────────────────────────────────── */

const moved = movedPieces(xml, pieces, edits);
const rescanned = findOdtPieces(edited);
check(
  'the moved ranges are the ranges a fresh reading finds',
  moved.length === rescanned.length &&
    moved.every(
      (piece, i) =>
        piece.start === rescanned[i].start && piece.end === rescanned[i].end && piece.text === rescanned[i].text,
    ),
  `${moved.length} pieces`,
);

/*
 * And the case a fresh reading gets wrong. Emptying a piece leaves no character
 * data behind, so the scan finds one piece fewer and every ordinal after it
 * shifts — while the view still holds the old ones.
 */
const emptied = [{ index: editable[1].index, text: '' }];
const afterEmpty = applyOdtEdits(xml, pieces, emptied);
const movedEmpty = movedPieces(xml, pieces, emptied);

check(
  'emptying a piece is a piece a fresh reading loses',
  findOdtPieces(afterEmpty).length === pieces.length - 1,
  `${findOdtPieces(afterEmpty).length} of ${pieces.length}`,
);
check(
  'the arithmetic keeps it, empty, where it was',
  movedEmpty.length === pieces.length &&
    movedEmpty[editable[1].index].text === '' &&
    movedEmpty[editable[1].index].start === movedEmpty[editable[1].index].end,
);
check(
  'every later piece still points at its own text',
  movedEmpty
    .slice(editable[1].index + 1)
    .every((piece, i) => afterEmpty.slice(piece.start, piece.end) === xmlOf(pieces[editable[1].index + 1 + i])),
);
function xmlOf(piece) {
  return xml.slice(piece.start, piece.end);
}

const typedBackIn = applyOdtEdits(afterEmpty, movedEmpty, [{ index: editable[1].index, text: 'Vraceno' }]);
check(
  'and typing into the emptied piece lands where the text was',
  findOdtPieces(typedBackIn).map((piece) => piece.text).join('|') ===
    pieces.map((piece) => (piece.index === editable[1].index ? 'Vraceno' : piece.text)).join('|'),
);

/* ── the whole file ──────────────────────────────────────────────────── */

const written = writeOdf(archive, edited);
const after = unzipSync(written);

check(
  'the archive has the same parts',
  JSON.stringify(Object.keys(after).sort()) === JSON.stringify(Object.keys(archive).sort()),
  `${Object.keys(after).length} parts`,
);

const others = Object.keys(archive).filter((path) => path !== 'content.xml');
const identical = others.filter((path) => {
  const a = archive[path];
  const b = after[path];
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
});
check(
  'every other part is identical byte for byte',
  identical.length === others.length,
  `${identical.length} of ${others.length}: ${others.filter((p) => !identical.includes(p)).join(', ') || 'none drifted'}`,
);

check('the part written is the part read back', strFromU8(after['content.xml']) === edited);

/*
 * `mimetype` first and uncompressed — the same rule the `.ods` save keeps, and
 * for the same reason: it is what lets any program say what the file is from
 * its opening bytes, this program's own detection included.
 */
const head = new TextDecoder('latin1').decode(written.subarray(0, 64));
check(
  'mimetype is the first, uncompressed entry',
  head.startsWith('PK') && head.includes('mimetype') && written[8] === 0 && written[9] === 0,
);

/* ── outcome ─────────────────────────────────────────────────────────── */

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
