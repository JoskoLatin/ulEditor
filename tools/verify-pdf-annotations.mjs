/**
 * Checking that annotations really land in the PDF as valid objects.
 *
 * The UI test in `verify-ui.mjs` shows that an annotation appears on screen. That
 * proves nothing about the file — here the written PDF is parsed again and
 * inspected for real `/Highlight`, `/Text` and `/Ink` annotations on the right
 * pages, with the right coordinates.
 *
 *   node tools/verify-pdf-annotations.mjs
 */

import { PDFDocument, PDFName, PDFArray, PDFDict, PDFHexString, PDFString } from 'pdf-lib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makePdf } from './fixtures.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Node 26 strips types from .ts files itself, so the source is imported directly
// — with no build step that might test something other than what ships. On
// Windows an absolute path has to go as a file:// URL.
const { writeAnnotations } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-pdf/src/annotations.ts')).href
);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── ulaz ────────────────────────────────────────────────────────────── */

const source = new TextEncoder().encode(makePdf());

const annotations = [
  {
    id: 'test-highlight',
    kind: 'highlight',
    page: 1,
    color: [0.98, 0.79, 0.29],
    createdAt: Date.UTC(2026, 7, 15, 12, 0, 0),
    quads: [
      { x: 30, y: 105, width: 120, height: 18 },
      { x: 30, y: 80, width: 90, height: 18 },
    ],
  },
  {
    id: 'test-note',
    kind: 'note',
    page: 1,
    color: [0.25, 0.7, 0.73],
    createdAt: Date.UTC(2026, 7, 15, 12, 0, 0),
    rect: { x: 200, y: 150, width: 20, height: 20 },
    // Diacritics: PDFString is Latin-1, so notes have to go as hex.
    text: 'Check čćžšđ and quotation marks "like this"',
  },
  {
    id: 'test-ink',
    kind: 'ink',
    page: 1,
    color: [0.88, 0.44, 0.37],
    createdAt: Date.UTC(2026, 7, 15, 12, 0, 0),
    strokes: [[{ x: 40, y: 40 }, { x: 60, y: 55 }, { x: 90, y: 35 }]],
    width: 2,
  },
  {
    // Already in the file — it must not be written a second time.
    id: 'test-imported',
    kind: 'highlight',
    page: 1,
    color: [0.36, 0.69, 0.51],
    createdAt: Date.UTC(2026, 7, 15, 12, 0, 0),
    imported: true,
    quads: [{ x: 10, y: 10, width: 20, height: 10 }],
  },
];

/* ── writing ─────────────────────────────────────────────────────────── */

const { bytes, written } = await writeAnnotations(source, annotations);
check('imported annotations are not written again', written === 3, `${written} of 4 written`);
check('the output is larger than the source', bytes.length > source.length, `${source.length} → ${bytes.length} B`);
check('izlaz je i dalje PDF', new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-', '');

/* ── ponovno parsiranje ──────────────────────────────────────────────── */

const reloaded = await PDFDocument.load(bytes);
const page = reloaded.getPages()[0];
const annots = page.node.lookup(PDFName.of('Annots'));

check('the page has an Annots array', annots instanceof PDFArray, annots ? annots.constructor.name : 'none');

const dicts = [];
if (annots instanceof PDFArray) {
  for (let i = 0; i < annots.size(); i++) {
    const value = annots.lookup(i);
    if (value instanceof PDFDict) dicts.push(value);
  }
}
check('three annotations in the file', dicts.length === 3, `${dicts.length}`);

const bySubtype = new Map();
for (const dict of dicts) {
  const subtype = dict.lookup(PDFName.of('Subtype'));
  bySubtype.set(subtype?.asString?.() ?? String(subtype), dict);
}
check(
  'tipovi su Highlight, Text i Ink',
  ['/Highlight', '/Text', '/Ink'].every((t) => bySubtype.has(t)),
  [...bySubtype.keys()].join(', '),
);

/* — highlight — */
const highlight = bySubtype.get('/Highlight');
if (highlight) {
  const quadPoints = highlight.lookup(PDFName.of('QuadPoints'));
  const size = quadPoints instanceof PDFArray ? quadPoints.size() : 0;
  // Two lines × eight numbers per quad.
  check('QuadPoints holds 16 numbers for two lines', size === 16, `${size}`);

  const rect = highlight.lookup(PDFName.of('Rect'));
  const values = rect instanceof PDFArray ? rect.asArray().map((n) => n.asNumber()) : [];
  // The bounding rectangle has to cover both lines: y from 80 to 123.
  check(
    'Rect spans both lines',
    values.length === 4 && values[1] === 80 && values[3] === 123,
    values.join(', '),
  );

  const ca = highlight.lookup(PDFName.of('CA'));
  check('the highlight is semi-transparent', ca?.asNumber?.() === 0.4, String(ca?.asNumber?.()));
}

/* — the note — */
const note = bySubtype.get('/Text');
if (note) {
  const contents = note.lookup(PDFName.of('Contents'));
  const decoded =
    contents instanceof PDFHexString || contents instanceof PDFString ? contents.decodeText() : '';
  check(
    'the note text survived the diacritics',
    decoded === 'Check čćžšđ and quotation marks "like this"',
    JSON.stringify(decoded.slice(0, 40)),
  );

  const name = note.lookup(PDFName.of('Name'));
  check('the note carries the Comment icon', name?.asString?.() === '/Comment', String(name));
}

/* — ink — */
const ink = bySubtype.get('/Ink');
if (ink) {
  const inkList = ink.lookup(PDFName.of('InkList'));
  const strokes = inkList instanceof PDFArray ? inkList.size() : 0;
  const first = inkList instanceof PDFArray ? inkList.lookup(0) : null;
  const points = first instanceof PDFArray ? first.size() : 0;
  check('InkList holds one stroke of three points', strokes === 1 && points === 6, `${strokes} × ${points / 2}`);
}

/* — shared — */
for (const [subtype, dict] of bySubtype) {
  const parent = dict.get(PDFName.of('P'));
  if (!parent) {
    check(`${subtype} points at its page`, false, '/P is missing');
    break;
  }
}
if (bySubtype.size === 3) {
  check(
    'every annotation points at its page (/P)',
    [...bySubtype.values()].every((d) => !!d.get(PDFName.of('P'))),
  );
  check(
    'every one carries an author name (/T)',
    [...bySubtype.values()].every((d) => d.lookup(PDFName.of('T'))?.decodeText?.() === 'ulEditor'),
  );
}

/* ── saving twice ────────────────────────────────────────────────────── */

// After a save the editor marks annotations as imported; saving again must not
// create duplicates.
const second = await writeAnnotations(bytes, annotations.map((a) => ({ ...a, imported: true })));
const reloadedTwice = await PDFDocument.load(second.bytes);
const annotsTwice = reloadedTwice.getPages()[0].node.lookup(PDFName.of('Annots'));
check(
  'saving again does not duplicate the annotations',
  annotsTwice instanceof PDFArray && annotsTwice.size() === 3,
  `${annotsTwice instanceof PDFArray ? annotsTwice.size() : '?'}`,
);

/* ── ishod ───────────────────────────────────────────────────────────── */

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
