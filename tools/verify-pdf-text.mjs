/**
 * Checking that added text really lands in the PDF — and lands legible.
 *
 * That the text shows on screen proves nothing: a `/FreeText` without an
 * appearance stream of its own is invisible in nearly every reader bar Acrobat,
 * and a character the font lacks is quietly replaced by a blank by pdf-lib.
 * Either would pass any check that looks only at our own model. So here the
 * written PDF is parsed again and its appearance stream inspected, byte by byte.
 *
 *   node tools/verify-pdf-text.mjs
 */

import { PDFDocument, PDFName, PDFArray, PDFDict, PDFHexString, PDFString } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

import { makePdf } from './fixtures.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(ROOT, 'packages/editor-pdf/package.json'));

const { writeAnnotations, missingGlyphWarning } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-pdf/src/annotations.ts')).href
);
const { layoutTextBox, metricsOf, linesOf } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-pdf/src/text.ts')).href
);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── font ────────────────────────────────────────────────────────────── */

/*
 * The same font the browser fetches through `fonts.ts`, only off disk: the check
 * must not depend on Vite or on the network.
 */
const FILES = {
  sans: 'LiberationSans-Regular.ttf',
  'sans-bold': 'LiberationSans-Bold.ttf',
  'sans-italic': 'LiberationSans-Italic.ttf',
  'sans-bold-italic': 'LiberationSans-BoldItalic.ttf',
};

const loadFont = async (face) =>
  new Uint8Array(await readFile(require.resolve(`pdfjs-dist/standard_fonts/${FILES[face]}`)));

const metrics = metricsOf('sans', await loadFont('sans'));

const CROATIAN = 'Vodice, 15 August — čćžšđ ČĆŽŠĐ';
check(
  'the font covers the Croatian diacritics',
  metrics.missing(CROATIAN).length === 0,
  metrics.missing(CROATIAN).join('') || '(nothing missing)',
);

/* Why the font is embedded at all: a standard one could not write it. */
const helvetica = await PDFDocument.create().then((d) => d.embedFont('Helvetica'));
let standardRefused = false;
try {
  helvetica.encodeText('č');
} catch {
  standardRefused = true;
}
check('a standard PDF font refuses č, so one has to be embedded', standardRefused);

/* ── writing ─────────────────────────────────────────────────────────── */

const source = new TextEncoder().encode(makePdf());

const anchor = { x: 60, top: 200 };
const twoLines = `${CROATIAN}\nA second line`;

const boxes = [
  {
    id: 'test-text',
    kind: 'text',
    page: 1,
    color: [0, 0, 0],
    createdAt: Date.UTC(2026, 7, 15, 12, 0, 0),
    text: twoLines,
    size: 11,
    face: 'sans',
    rect: layoutTextBox(metrics, twoLines, 11, anchor),
  },
  {
    id: 'test-text-bold',
    kind: 'text',
    page: 1,
    color: [0.88, 0.44, 0.37],
    createdAt: Date.UTC(2026, 7, 15, 12, 0, 0),
    text: 'Bold',
    size: 14,
    face: 'sans-bold',
    rect: layoutTextBox(metrics, 'Bold', 14, { x: 60, top: 120 }),
  },
  {
    id: 'test-text-underlined',
    kind: 'text',
    page: 1,
    color: [0, 0, 0],
    createdAt: Date.UTC(2026, 7, 15, 12, 0, 0),
    text: 'Underlined',
    size: 12,
    face: 'sans-bold-italic',
    underline: true,
    rect: layoutTextBox(metrics, 'Underlined', 12, { x: 60, top: 90 }),
  },
];

const written = await writeAnnotations(source, boxes, undefined, loadFont);
check('all three boxes were written', written.written === 3, `${written.written}`);
check('nothing is reported as a missing character', written.missingGlyphs.length === 0);

/* ── parsing it back ─────────────────────────────────────────────────── */

const reloaded = await PDFDocument.load(written.bytes);
const page = reloaded.getPages()[0];
const annots = page.node.lookup(PDFName.of('Annots'));

const dicts = [];
if (annots instanceof PDFArray) {
  for (let i = 0; i < annots.size(); i++) {
    const value = annots.lookup(i);
    if (value instanceof PDFDict) dicts.push(value);
  }
}

const freeText = dicts.filter(
  (d) => d.lookup(PDFName.of('Subtype'))?.asString?.() === '/FreeText',
);
check('all three are of type FreeText', freeText.length === 3, `${freeText.length}`);

const first = freeText[0];
if (first) {
  const contents = first.lookup(PDFName.of('Contents'));
  const decoded =
    contents instanceof PDFHexString || contents instanceof PDFString ? contents.decodeText() : '';
  check(
    'the text is in the file, diacritics and all',
    decoded === twoLines,
    JSON.stringify(decoded.slice(0, 36)),
  );

  /*
   * This is the check this file exists for. Without an `/AP` the annotation is
   * invisible in pdf.js and in browsers — the document would look empty to
   * everybody except whoever wrote it.
   */
  const ap = first.lookup(PDFName.of('AP'));
  const normal = ap instanceof PDFDict ? ap.lookup(PDFName.of('N')) : null;
  check('the box carries an appearance stream of its own (/AP /N)', !!normal, normal ? 'it does' : 'IT DOES NOT');

  if (normal) {
    const dict = normal.dict ?? normal;

    // The stream is flate-compressed; without inflating it the check would be
    // looking at rubbish and would still "pass" whenever it asserts an absence.
    const filter = String(dict.lookup(PDFName.of('Filter')) ?? '');
    check('the appearance stream is compressed', filter.includes('FlateDecode'), filter || '(no filter)');

    const payload = Buffer.from(normal.getContents());
    const stream = new TextDecoder('latin1').decode(
      filter.includes('FlateDecode') ? inflateSync(payload) : payload,
    );

    const lines = linesOf(twoLines);
    check(
      'the appearance stream draws both lines',
      (stream.match(/Tj/g) ?? []).length === lines.length,
      `${(stream.match(/Tj/g) ?? []).length} of ${lines.length}`,
    );
    check('the appearance stream sets the font and its size', /\/F1 11 Tf/.test(stream), '');
    check('the text is encoded as hex, not as Latin-1', /<[0-9a-fA-F]+>\s*Tj/.test(stream));

    const bbox = dict.lookup(PDFName.of('BBox'));
    const values = bbox instanceof PDFArray ? bbox.asArray().map((n) => n.asNumber()) : [];
    const rect = first.lookup(PDFName.of('Rect'));
    const rectValues = rect instanceof PDFArray ? rect.asArray().map((n) => n.asNumber()) : [];
    check(
      'the BBox matches the Rect, so the appearance is not stretched',
      values.length === 4 &&
        rectValues.length === 4 &&
        Math.abs(values[2] - (rectValues[2] - rectValues[0])) < 0.01 &&
        Math.abs(values[3] - (rectValues[3] - rectValues[1])) < 0.01,
      `BBox ${values.join(' ')} · Rect ${rectValues.join(' ')}`,
    );

    const resources = dict.lookup(PDFName.of('Resources'));
    const fonts = resources instanceof PDFDict ? resources.lookup(PDFName.of('Font')) : null;
    check(
      'the font is in the appearance stream resources',
      fonts instanceof PDFDict && !!fonts.get(PDFName.of('F1')),
    );
  }

  /* `/C` on a FreeText means the BACKGROUND colour — set, it would tint the box. */
  check('the box has no background colour set (/C)', !first.get(PDFName.of('C')));
  check(
    'the text colour is in the /DA',
    /0 0 0 rg/.test(first.lookup(PDFName.of('DA'))?.decodeText?.() ?? ''),
    first.lookup(PDFName.of('DA'))?.decodeText?.() ?? '',
  );
}

/* ── podcrtavanje ────────────────────────────────────────────────────── */

/*
 * PDF has no underline: the rule is a filled rectangle, and it has to be drawn
 * after `ET`, because a path cannot be built inside a text object. A reader that
 * meets `re` between `BT` and `ET` gives up on the whole stream, so the box
 * would go blank — which is why this is checked in the bytes rather than trusted.
 */
const underlined = freeText[2];
if (underlined) {
  const ap = underlined.lookup(PDFName.of('AP'));
  const normal = ap instanceof PDFDict ? ap.lookup(PDFName.of('N')) : null;
  const dict = normal ? (normal.dict ?? normal) : null;
  const stream = dict
    ? new TextDecoder('latin1').decode(
        String(dict.lookup(PDFName.of('Filter')) ?? '').includes('FlateDecode')
          ? inflateSync(Buffer.from(normal.getContents()))
          : Buffer.from(normal.getContents()),
      )
    : '';

  const rule = /([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re\s*\nf/.exec(stream);
  check('an underlined box draws a rule', !!rule, rule ? rule[0].replace(/\n/, ' ') : '(no re/f)');
  check(
    'the rule is outside the text object',
    stream.indexOf('re') > stream.indexOf('ET'),
    `ET at ${stream.indexOf('ET')}, re at ${stream.indexOf('re')}`,
  );

  const boldItalic = metricsOf('sans-bold-italic', await loadFont('sans-bold-italic'));
  const expected = boldItalic.measure('Underlined', 12);
  check(
    'the rule is as wide as the text it sits under',
    !!rule && Math.abs(Number(rule[3]) - expected) < 0.5,
    rule ? `${rule[3]} against ${expected.toFixed(2)}` : '',
  );
  check(
    'the rule sits below the baseline, and is thin',
    !!rule && Number(rule[4]) > 0 && Number(rule[4]) < 1.2,
    rule ? `${rule[4]} pt at 12 pt` : '',
  );

  const plain = freeText[0];
  const plainAp = plain?.lookup(PDFName.of('AP'));
  const plainNormal = plainAp instanceof PDFDict ? plainAp.lookup(PDFName.of('N')) : null;
  const plainStream = plainNormal
    ? new TextDecoder('latin1').decode(inflateSync(Buffer.from(plainNormal.getContents())))
    : '';
  check('a box without the switch draws no rule', !/ re/.test(plainStream));
}

/* ── the embedded font ───────────────────────────────────────────────── */

const raw = new TextDecoder('latin1').decode(written.bytes);
check('the font is embedded as a subset', /\/FontFile2/.test(raw));
check(
  'a subset is embedded, not the whole font',
  written.bytes.length < 120_000,
  `${Math.round(written.bytes.length / 1024)} KB against the 136 KB of the font itself`,
);

/* ── a character the font lacks ──────────────────────────────────────── */

const chinese = {
  ...boxes[0],
  id: 'test-missing',
  text: 'This is 汉字 mid-sentence',
};
const withMissing = await writeAnnotations(source, [chinese], undefined, loadFont);
check(
  'a character the font lacks is reported, not swallowed',
  withMissing.missingGlyphs.join('') === '汉字',
  withMissing.missingGlyphs.join('') || '(nothing — and there should be)',
);
check(
  'the warning reaches the user as text',
  missingGlyphWarning(withMissing.missingGlyphs).length === 1,
  missingGlyphWarning(withMissing.missingGlyphs)[0] ?? '',
);

/* ── metrics ─────────────────────────────────────────────────────────── */

const wide = layoutTextBox(metrics, 'iii', 11, anchor);
const wider = layoutTextBox(metrics, 'MMMMMMMMMMMM', 11, anchor);
check('wider text gives a wider box', wider.width > wide.width, `${wide.width} → ${wider.width}`);

const oneLine = layoutTextBox(metrics, 'one', 11, anchor);
const threeLines = layoutTextBox(metrics, 'a\nb\nc', 11, anchor);
check(
  'the box grows downwards, the top edge stays put',
  Math.abs(oneLine.y + oneLine.height - anchor.top) < 0.01 &&
    Math.abs(threeLines.y + threeLines.height - anchor.top) < 0.01 &&
    threeLines.height > oneLine.height,
  `1 line ${oneLine.height.toFixed(1)} pt · 3 lines ${threeLines.height.toFixed(1)} pt`,
);

/* ── saving again ────────────────────────────────────────────────────── */

const second = await writeAnnotations(
  written.bytes,
  boxes.map((b) => ({ ...b, imported: true })),
  undefined,
  loadFont,
);
const twice = await PDFDocument.load(second.bytes);
const annotsTwice = twice.getPages()[0].node.lookup(PDFName.of('Annots'));
check(
  'saving again does not duplicate the boxes',
  annotsTwice instanceof PDFArray && annotsTwice.size() === boxes.length,
  `${annotsTwice instanceof PDFArray ? annotsTwice.size() : '?'}`,
);

/* ── outcome ─────────────────────────────────────────────────────────── */

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
