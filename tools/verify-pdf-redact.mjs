/**
 * Checking that deleted text **really leaves the file**.
 *
 * A black rectangle over the text looks like deletion and passes every check that
 * looks at the picture. So no check here looks at the picture: the content stream
 * is decompressed and the byte sequence itself is searched for. If it is there,
 * the text comes out by selecting and copying, whatever is on screen.
 *
 * The second half of the check is refusal: when it cannot be guaranteed that
 * everything was removed, the document has to stay untouched and the reason has
 * to reach the user.
 *
 *   node tools/verify-pdf-redact.mjs
 */

import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(ROOT, 'packages/editor-pdf/package.json'));

const { applyRedactions, previewRedaction } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-pdf/src/redact.ts')).href
);
const { readPageContent, contentsOf } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-pdf/src/content.ts')).href
);
const { standardWidths } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-pdf/src/text.ts')).href
);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const FILES = {
  sans: 'LiberationSans-Regular.ttf',
  'sans-bold': 'LiberationSans-Bold.ttf',
  'sans-italic': 'LiberationSans-Italic.ttf',
};
const loadFont = async (face) =>
  new Uint8Array(await readFile(require.resolve(`pdfjs-dist/standard_fonts/${FILES[face]}`)));

const standard = await standardWidths(loadFont);

/* ── fixtures ────────────────────────────────────────────────────────── */

/** A PDF with known text in known places. */
function buildPdf({ font = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>', extra = '' } = {}) {
  const stream = [
    'BT /F1 12 Tf',
    '30 150 Td (Secret: 12345) Tj',
    '0 -30 Td [(Remains ) -200 (untouched)] TJ',
    'ET',
    extra,
  ].join('\n');

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R' +
      '/Resources<</Font<</F1 5 0 R>>/XObject<</X1 6 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    font,
    '<</Type/XObject/Subtype/Form/BBox[0 0 40 20]/Matrix[1 0 0 1 200 20]/Length 0>>\nstream\n\nendstream',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

const encode = (text) => new TextEncoder().encode(text);

/** The raw content stream of the first page, decompressed. */
async function streamOf(bytes) {
  const doc = await PDFDocument.load(bytes);
  return new TextDecoder('latin1').decode(contentsOf(doc.getPages()[0]));
}

/* ── reading the positions ───────────────────────────────────────────── */

const source = buildPdf();
const doc = await PDFDocument.load(source);
const page = doc.getPages()[0];
const content = readPageContent(page, standard);

check('the text operators were found', content.operations.length === 2, `${content.operations.length}`);

const glyphs = content.operations
  .flatMap((op) => op.parts)
  .filter((part) => part.kind === 'glyphs')
  .flatMap((part) => part.glyphs);

const text = glyphs.map((g) => String.fromCharCode(g.code)).join('');
check('the glyphs were read in the right order', text === 'Secret: 12345Remains untouched', text);

const first = glyphs[0];
check(
  'the first glyph sits where Td put it',
  Math.abs(first.box.x - 30) < 0.01 && first.box.y < 150 && first.box.y + first.box.height > 150,
  `x ${first.box.x.toFixed(1)}, y ${first.box.y.toFixed(1)}–${(first.box.y + first.box.height).toFixed(1)}`,
);

/* The width of "S" in Helvetica is 667/1000; Liberation Sans has to agree. */
check(
  'the standard font was measured, not guessed',
  Math.abs(first.advance - (667 / 1000) * 12) < 0.05,
  `${first.advance.toFixed(3)} pt`,
);

/* ── deletion ────────────────────────────────────────────────────────── */

/** A rectangle spanning the given glyphs, with a little air on every side. */
function around(chosen, pad = 0.4) {
  const left = Math.min(...chosen.map((g) => g.box.x));
  const right = Math.max(...chosen.map((g) => g.box.x + g.box.width));
  const bottom = Math.min(...chosen.map((g) => g.box.y));
  const top = Math.max(...chosen.map((g) => g.box.y + g.box.height));
  return { x: left - pad, y: bottom - pad, width: right - left + pad * 2, height: top - bottom + pad * 2 };
}

// Over the number alone, without the word "Secret:" in front of it. The air
// around the rectangle is deliberate: a drag by hand is never pixel-exact, and
// the neighbouring letters have to survive anyway.
const rect = around(glyphs.filter((g) => g.code >= 0x31 && g.code <= 0x35));

const preview = previewRedaction(page, [rect], standard);
check('the preview announces exactly five glyphs', preview.glyphs === 5, `${preview.glyphs}`);
check('the preview reports no obstacle', preview.obstacles.length === 0);

const redacted = await applyRedactions(source, [{ id: 'r1', page: 1, rect }], standard);
check('five glyphs were removed', redacted.removed === 5, `${redacted.removed}`);
check('nothing was refused', redacted.refused.length === 0, JSON.stringify(redacted.refused));

const after = await streamOf(redacted.bytes);

/*
 * This is the check this file exists for. The byte sequence itself is searched
 * for, in both forms text is written in — plain and hexadecimal.
 */
check('the number is no longer there as text', !after.includes('12345'));
check('the number is not there in hex either', !/3132333435/i.test(after));

/*
 * And in the whole file, not only in the stream that gets drawn. A new stream
 * with a redirected `/Contents` would leave the old one orphaned: nobody draws
 * it, but the bytes are still there and come out with the first tool that
 * decompresses streams.
 */
check(
  'the number is nowhere in the file, not even in an abandoned object',
  !new TextDecoder('latin1').decode(redacted.bytes).includes('12345'),
);

const reloaded = await PDFDocument.load(redacted.bytes);
const afterContent = readPageContent(reloaded.getPages()[0], standard);
const afterGlyphs = afterContent.operations
  .flatMap((op) => op.parts)
  .filter((part) => part.kind === 'glyphs')
  .flatMap((part) => part.glyphs);
const afterText = afterGlyphs.map((g) => String.fromCharCode(g.code)).join('');

check('the rest of the line is untouched', afterText === 'Secret: Remains untouched', afterText);

/*
 * Deleting the middle of a line has to leave the rest in place. Without an
 * adjustment in the `TJ` array everything after the deletion would slide left.
 */
const beforeSecondLine = glyphs.find((g) => g.code === 0x52); // 'R' from "Remains"
const afterSecondLine = afterGlyphs.find((g) => g.code === 0x52);
check(
  'the second line did not move',
  Math.abs(beforeSecondLine.box.x - afterSecondLine.box.x) < 0.01 &&
    Math.abs(beforeSecondLine.box.y - afterSecondLine.box.y) < 0.01,
  `${beforeSecondLine.box.x.toFixed(2)} → ${afterSecondLine.box.x.toFixed(2)}`,
);

/* ── deleting the middle of a word ───────────────────────────────────── */

// Over "ecr" inside "Secret" — the hardest case, because the string has to be cut apart.
const midRect = around(glyphs.slice(1, 4));

const middle = await applyRedactions(source, [{ id: 'r2', page: 1, rect: midRect }], standard);
const middleContent = readPageContent((await PDFDocument.load(middle.bytes)).getPages()[0], standard);
const middleText = middleContent.operations
  .flatMap((op) => op.parts)
  .filter((part) => part.kind === 'glyphs')
  .flatMap((part) => part.glyphs)
  .map((g) => String.fromCharCode(g.code))
  .join('');
check('the middle of a word can be cut out', middleText === 'Set: 12345Remains untouched', middleText);

const tail = middleContent.operations[0].parts
  .filter((p) => p.kind === 'glyphs')
  .flatMap((p) => p.glyphs)
  .find((g) => g.code === 0x3a); // ':'
const tailBefore = glyphs.find((g) => g.code === 0x3a);
check(
  'the rest of the word stays in place',
  Math.abs(tail.box.x - tailBefore.box.x) < 0.01,
  `${tailBefore.box.x.toFixed(2)} → ${tail.box.x.toFixed(2)}`,
);

/* ── refusal ─────────────────────────────────────────────────────────── */

// Times with no widths table: the metrics are unknown, so nothing may be touched.
const unknownFont = buildPdf({ font: '<</Type/Font/Subtype/Type1/BaseFont/Times-Roman>>' });
const refusedFont = await applyRedactions(unknownFont, [{ id: 'r3', page: 1, rect }], standard);
check('an unknown font stops the deletion', refusedFont.refused.length === 1, refusedFont.refused[0]?.reason ?? '');
check('a refused document stays identical byte for byte', refusedFont.bytes === unknownFont);

// A Form XObject over the area: the text inside it cannot be seen from here.
const withForm = buildPdf({ extra: 'q 1 0 0 1 0 0 cm /X1 Do Q' });
const overForm = { x: 205, y: 25, width: 20, height: 10 };
const refusedForm = await applyRedactions(withForm, [{ id: 'r4', page: 1, rect: overForm }], standard);
check(
  'a Form XObject over the area stops the deletion',
  refusedForm.refused.length === 1,
  refusedForm.refused[0]?.reason ?? '',
);

// That same XObject elsewhere on the page must not get in the way.
const elsewhere = await applyRedactions(withForm, [{ id: 'r5', page: 1, rect }], standard);
check(
  'an XObject outside the area does not interfere',
  elsewhere.refused.length === 0 && elsewhere.removed === 5,
  `${elsewhere.removed} removed, ${elsewhere.refused.length} refused`,
);

/* ── nothing to delete ───────────────────────────────────────────────── */

const empty = await applyRedactions(source, [], standard);
check('with no areas the document is not rewritten', empty.bytes === source && empty.removed === 0);

const miss = await applyRedactions(
  source,
  [{ id: 'r6', page: 1, rect: { x: 250, y: 10, width: 20, height: 10 } }],
  standard,
);
check('an area with no text leaves the document alone', miss.bytes === source && miss.removed === 0);

/* ── outcome ─────────────────────────────────────────────────────────── */

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
