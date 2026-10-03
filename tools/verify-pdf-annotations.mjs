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
const { writeAnnotations, dropImported } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-pdf/src/annotations.ts')).href
);
const { saveDocument } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-pdf/src/document.ts')).href
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

/* ── what the file already holds ─────────────────────────────────────── */

// Annotations read out of a file are not written into it a second time.
const second = await writeAnnotations(bytes, annotations.map((a) => ({ ...a, imported: true })));
const reloadedTwice = await PDFDocument.load(second.bytes);
const annotsTwice = reloadedTwice.getPages()[0].node.lookup(PDFName.of('Annots'));
check(
  'an annotation already in the file is not written again',
  annotsTwice instanceof PDFArray && annotsTwice.size() === 3,
  `${annotsTwice instanceof PDFArray ? annotsTwice.size() : '?'}`,
);

/* ── saving twice in one session ─────────────────────────────────────── */

/*
 * The editor saves from the bytes as opened every time, so a save has to write
 * everything made in the session, not only what came since the last save. It
 * used to mark what it had saved as imported, and a note made before the first
 * save was missing from the file after the second. Here both saves get the
 * opened bytes, as `PdfEditor.save` hands them over.
 */
const noteOf = (id, text, y) => ({
  id,
  kind: 'note',
  page: 1,
  color: [0.98, 0.79, 0.29],
  createdAt: Date.UTC(2026, 9, 3),
  rect: { x: 40, y, width: 20, height: 20 },
  text,
});
const notesIn = async (pdf) => {
  const doc = await PDFDocument.load(pdf);
  const found = [];
  for (const p of doc.getPages()) {
    const list = p.node.lookup(PDFName.of('Annots'));
    if (!(list instanceof PDFArray)) continue;
    for (const entry of list.asArray()) {
      const dict = doc.context.lookup(entry);
      const contents = dict?.get?.(PDFName.of('Contents'));
      if (contents) found.push(contents.decodeText());
    }
  }
  return found;
};
const identity = [{ source: 1, rotate: 0 }];
const firstNote = noteOf('first', 'before the first save', 150);
const saveOne = await saveDocument(source, identity, [firstNote], 1);
const saveTwo = await saveDocument(source, identity, [firstNote, noteOf('second', 'before the second save', 120)], 1);
const afterTwo = await notesIn(saveTwo.bytes);
check(
  'a note made before the first save is still in the file after the second',
  afterTwo.includes('before the first save') && afterTwo.includes('before the second save') && afterTwo.length === 2,
  JSON.stringify(afterTwo),
);

/* ── an annotation the file was opened with, edited or deleted ───────── */

/*
 * pdf.js names an annotation after its object, `12R`. The editor reads it under
 * that id, and when it is edited or deleted the save takes the original out —
 * before, the edit was written beside it and a deletion came back on reopening.
 */
const opened = saveOne.bytes; // a file that already holds one note
const openedDoc = await PDFDocument.load(opened);
const noteRef = openedDoc.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray).get(0);
const pdfjsId = `${noteRef.objectNumber}R${noteRef.generationNumber ? noteRef.generationNumber : ''}`;
const asOpened = { ...firstNote, id: pdfjsId, imported: true };

const edited = await saveDocument(opened, identity, [{ ...asOpened, text: 'edited', imported: false }], 1, undefined, [], [pdfjsId]);
check('an edited note replaces the one the file had', JSON.stringify(await notesIn(edited.bytes)) === '["edited"]', JSON.stringify(await notesIn(edited.bytes)));

const deleted = await saveDocument(opened, identity, [], 1, undefined, [], [pdfjsId]);
const deletedDoc = await PDFDocument.load(deleted.bytes);
check('a deleted note is gone from the file', (await notesIn(deleted.bytes)).length === 0, JSON.stringify(await notesIn(deleted.bytes)));
check(
  'and its object is deleted, not only unlinked',
  deletedDoc.context.lookup(noteRef) === undefined,
  String(deletedDoc.context.lookup(noteRef)?.constructor?.name ?? 'gone'),
);

const untouched = await saveDocument(opened, identity, [asOpened], 1);
check('a note nobody touched stays', JSON.stringify(await notesIn(untouched.bytes)) === '["before the first save"]');

// A popup opened from the note goes with it.
const withPopup = await PDFDocument.load(opened);
const popupRef = withPopup.context.register(
  withPopup.context.obj({ Type: 'Annot', Subtype: 'Popup', Parent: noteRef, Rect: [60, 120, 200, 180] }),
);
withPopup.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray).push(popupRef);
const popupBytes = await withPopup.save({ useObjectStreams: false });
const noPopup = await PDFDocument.load(await dropImported(popupBytes, [pdfjsId]));
const leftOver = noPopup.getPages()[0].node.lookup(PDFName.of('Annots'));
check(
  "the note's popup goes with it",
  !(leftOver instanceof PDFArray) || leftOver.size() === 0,
  leftOver instanceof PDFArray ? `${leftOver.size()} left` : 'no Annots',
);

// pdf.js gives an annotation without an object of its own an `annot_…` id; nothing to find it by.
check('an id that names no object leaves the file as it was', (await dropImported(opened, ['annot_7'])) === opened);

// Reordering pages copies them and renumbers every object; the original is taken out first.
const twoPages = await PDFDocument.create();
twoPages.addPage([300, 200]);
twoPages.addPage([300, 200]);
const twoBytes = (await writeAnnotations(await twoPages.save(), [noteOf('n', 'on page one', 150)])).bytes;
const twoDoc = await PDFDocument.load(twoBytes);
const twoRef = twoDoc.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray).get(0);
const reordered = await saveDocument(
  twoBytes,
  [{ source: 2, rotate: 0 }, { source: 1, rotate: 0 }],
  [],
  2,
  undefined,
  [],
  [`${twoRef.objectNumber}R`],
);
check('a deleted note stays deleted when the pages are reordered', (await notesIn(reordered.bytes)).length === 0, JSON.stringify(await notesIn(reordered.bytes)));

/* ── ishod ───────────────────────────────────────────────────────────── */

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
