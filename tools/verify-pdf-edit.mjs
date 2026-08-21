/**
 * Checking the rewriting of existing text.
 *
 * An edit here is assembled out of a deletion and a write, so there is only one
 * question: **does the replacement line up with what was there.** So this does
 * not look at whether something changed but compares the numbers — baseline,
 * size, colour — and checks that the program refuses wherever that alignment
 * cannot be promised.
 *
 *   node tools/verify-pdf-edit.mjs
 */

import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(ROOT, 'packages/editor-pdf/package.json'));

const { findEditableLine, metricsWarning } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-pdf/src/edit.ts')).href
);
const { standardWidths, layoutTextBox, loadFace, TEXT_PADDING } = await import(
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

function buildPdf(stream, fonts = ['<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>']) {
  const fontRefs = fonts.map((_, i) => `/F${i + 1} ${5 + i} 0 R`).join('');
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<<${fontRefs}>>>>>>`,
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    ...fonts,
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

const pageOf = async (bytes) => (await PDFDocument.load(bytes)).getPages()[0];

/* ── reading a line ──────────────────────────────────────────────────── */

const plain = await pageOf(
  buildPdf(
    [
      'BT /F1 12 Tf 30 150 Td (Name and surname) Tj ET',
      'BT 1 0 0 rg /F1 9 Tf 30 120 Td (A small red line) Tj ET',
      'BT 3 Tr /F1 12 Tf 30 90 Td (An invisible layer) Tj ET',
      // `Tr` is part of the text state and survives `BT`/`ET`; without resetting
      // it to 0 the next line would be invisible too.
      'BT 0 Tr /F1 12 Tf 1 0.4 -0.4 1 30 60 Tm (Askew) Tj ET',
    ].join('\n'),
  ),
);

const found = findEditableLine(plain, { x: 45, y: 154 }, standard);
check('the line under the finger was found', !!found && 'line' in found);

const line = found?.line;
check('the text was read back as letters', line?.text === 'Name and surname', line?.text ?? '');
check('the size came from the document', Math.abs((line?.size ?? 0) - 12) < 0.01, `${line?.size}`);
check(
  'the baseline is where Td put it',
  Math.abs((line?.origin.x ?? 0) - 30) < 0.01 && Math.abs((line?.origin.y ?? 0) - 150) < 0.01,
  `${line?.origin.x}, ${line?.origin.y}`,
);
check('the colour is black', line?.color.every((c) => c === 0) === true, JSON.stringify(line?.color));
check('Helvetica matches our font metrically', line?.metricsMatch === true);
check('there is no warning about the letterforms', metricsWarning(line) === null);

const red = findEditableLine(plain, { x: 45, y: 124 }, standard);
check(
  'the line colour was read out of the content',
  red?.line?.color?.[0] === 1 && red.line.color[1] === 0 && red.line.color[2] === 0,
  JSON.stringify(red?.line?.color),
);
check('and so was its size', Math.abs((red?.line?.size ?? 0) - 9) < 0.01, `${red?.line?.size}`);

check('an empty spot offers nothing', findEditableLine(plain, { x: 260, y: 20 }, standard) === null);

/* ── refusals ────────────────────────────────────────────────────────── */

/* The reasons are compared, not merely their existence: a refusal for the wrong
   reason means the check is looking at a different line than it thinks. */
const invisible = findEditableLine(plain, { x: 45, y: 94 }, standard);
check(
  'an invisible layer is refused as a recognition layer',
  /invisible/.test(invisible?.refusal ?? ''),
  invisible?.refusal ?? '',
);

const skewed = findEditableLine(plain, { x: 45, y: 66 }, standard);
check(
  'skewed text is refused for its skew',
  /rotated or skewed/.test(skewed?.refusal ?? ''),
  skewed?.refusal ?? '',
);

/* A font with its own widths and its own encoding, without a /ToUnicode: the
   codes can be measured but not read back as letters. */
const opaque = await pageOf(
  buildPdf('BT /F1 12 Tf 30 150 Td (abc) Tj ET', [
    '<</Type/Font/Subtype/Type1/BaseFont/Unknown/FirstChar 97/LastChar 99/Widths[500 500 500]' +
      '/Encoding<</Type/Encoding/Differences[97/alpha/beta/gamma]>>>>',
  ]),
);
const unreadable = findEditableLine(opaque, { x: 35, y: 154 }, standard);
check('text without a /ToUnicode is refused, not guessed at', !!unreadable?.refusal, unreadable?.refusal ?? '');

/* Another font with known widths: rewriting goes ahead, but the letterforms will differ. */
const other = await pageOf(
  buildPdf('BT /F1 10 Tf 30 150 Td (Contract) Tj ET', [
    '<</Type/Font/Subtype/Type1/BaseFont/Garamond/FirstChar 32/LastChar 122/Widths[' +
      Array.from({ length: 91 }, () => '500').join(' ') +
      ']>>',
  ]),
);
const foreign = findEditableLine(other, { x: 40, y: 154 }, standard);
check('another font is still rewritable', !!foreign?.line, foreign?.line?.text ?? '');
check(
  'but it is announced that the letterforms will not be the same',
  typeof metricsWarning(foreign?.line) === 'string',
  metricsWarning(foreign?.line) ?? '',
);

/* ── aligning the replacement ────────────────────────────────────────── */

/*
 * The replacement is anchored on the baseline of the source line. Here that sum
 * is run backwards: the box that comes out has to give back the same baseline it
 * started from, or the rewritten line would sit above or below the rest.
 */
const metrics = await loadFace('sans', loadFont);
const anchor = {
  x: line.origin.x - TEXT_PADDING,
  top: line.origin.y + metrics.ascent(line.size) + TEXT_PADDING,
};
const box = layoutTextBox(metrics, line.text, line.size, anchor);
const baseline = box.y + box.height - TEXT_PADDING - metrics.ascent(line.size);

check(
  'the replacement lands on the same baseline',
  Math.abs(baseline - line.origin.y) < 0.001,
  `${line.origin.y} → ${baseline.toFixed(3)}`,
);
check(
  'and starts at the same place from the left',
  Math.abs(box.x + TEXT_PADDING - line.origin.x) < 0.001,
  `${line.origin.x} → ${(box.x + TEXT_PADDING).toFixed(3)}`,
);

/*
 * Helvetica and Liberation Sans are metrically identical, so the rewritten line
 * has to take up the same width as the source one — that is the entire reason
 * this particular font is what gets written.
 */
check(
  'the same width as the source line',
  Math.abs(box.width - TEXT_PADDING * 2 - line.bounds.width) < 0.5,
  `${line.bounds.width.toFixed(2)} → ${(box.width - TEXT_PADDING * 2).toFixed(2)} pt`,
);

/* ── outcome ─────────────────────────────────────────────────────────── */

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
