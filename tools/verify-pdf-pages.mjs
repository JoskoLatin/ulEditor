/**
 * Checking the page operations.
 *
 * The UI shows a thumbnail vanishing or turning. That proves nothing about the
 * file — here the written PDF is parsed again and inspected for how many pages it
 * has, in what order and at what rotation. Alongside that comes the thing most
 * easily overlooked: that an annotation stays with ITS OWN page even after the
 * pages have been reordered.
 *
 *   node tools/verify-pdf-pages.mjs
 */

import { PDFDocument, PDFName, PDFArray, PDFDict } from 'pdf-lib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeMultiPagePdf } from './fixtures.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {
  saveDocument,
  identityPlan,
  movePage,
  removePage,
  rotatePage,
  isIdentity,
  pageMapOf,
  mergeInto,
  extractPages,
  parseRanges,
} = await import(pathToFileURL(resolve(ROOT, 'packages/editor-pdf/src/document.ts')).href);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const SOURCE = new TextEncoder().encode(makeMultiPagePdf(3));
const PAGE_COUNT = 3;

/** Returns the content text of each page — that is how we know which one is really where. */
async function pageLabels(bytes) {
  const doc = await PDFDocument.load(bytes);
  const labels = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    const stream = contents?.getContentsString?.() ?? '';
    const match = /\(PAGE (\d+)\)/.exec(stream);
    labels.push(match ? Number(match[1]) : 0);
  }
  return labels;
}

async function rotations(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.getRotation().angle);
}

/* ── the pure plan functions ─────────────────────────────────────────── */

const base = identityPlan(3);
check('the initial plan is untouched', isIdentity(base, 3), JSON.stringify(base.map((e) => e.source)));

check(
  'rotation adds up modulo 360',
  rotatePage(rotatePage(rotatePage(rotatePage(base, 0, 90), 0, 90), 0, 90), 0, 90)[0].rotate === 0,
);
check('rotating left gives 270, not -90', rotatePage(base, 0, -90)[0].rotate === 270);
check(
  'the last page cannot be deleted',
  removePage(identityPlan(1), 0).length === 1,
  'a document with no pages is not a valid PDF',
);
check('a move out of bounds leaves the plan alone', movePage(base, 0, -1) === base);

/* ── deletion ────────────────────────────────────────────────────────── */

{
  const plan = removePage(base, 1); // removes page 2
  const { bytes, lost } = await saveDocument(SOURCE, plan, [], PAGE_COUNT);
  const labels = await pageLabels(bytes);
  check('the deletion leaves two pages', labels.length === 2, labels.join(', '));
  check('pages 1 and 3 are what remain', labels.join(',') === '1,3', labels.join(','));
  check('deletion reports no loss', lost.length === 0, lost.join(' | ') || 'nothing');
}

/* ── rotation ────────────────────────────────────────────────────────── */

{
  const plan = rotatePage(rotatePage(base, 0, 90), 2, 180);
  const { bytes, lost } = await saveDocument(SOURCE, plan, [], PAGE_COUNT);
  const angles = await rotations(bytes);
  check('the rotations were written into the file', angles.join(',') === '90,0,180', angles.join(','));
  check('rotation reports no loss', lost.length === 0, lost.join(' | ') || 'nothing');
}

/* ── reordering ──────────────────────────────────────────────────────── */

{
  // 1,2,3 → 3,1,2
  const plan = movePage(base, 2, -2);
  const { bytes, lost } = await saveDocument(SOURCE, plan, [], PAGE_COUNT);
  const labels = await pageLabels(bytes);
  check('reordering changes the real order', labels.join(',') === '3,1,2', labels.join(','));
  check(
    'reordering reports its loss honestly',
    lost.length === 1 && lost[0].includes('bookmarks'),
    lost.join(' | '),
  );
}

/* ── an annotation follows its own page ──────────────────────────────── */

{
  // A highlight on SOURCE page 3, which the reorder moves into first place.
  const annotation = {
    id: 'ann-on-the-third',
    kind: 'highlight',
    page: 3,
    color: [0.98, 0.79, 0.29],
    createdAt: Date.UTC(2026, 7, 15),
    quads: [{ x: 30, y: 100, width: 120, height: 20 }],
  };

  const plan = movePage(base, 2, -2); // 3,1,2
  check('the page map takes source 3 to position 0', pageMapOf(plan).get(3) === 0);

  const { bytes } = await saveDocument(SOURCE, plan, [annotation], PAGE_COUNT);
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages();

  const annotated = pages.findIndex((page) => {
    const annots = page.node.lookup(PDFName.of('Annots'));
    return annots instanceof PDFArray && annots.size() > 0;
  });
  const labels = await pageLabels(bytes);
  check(
    'the annotation went with its page',
    annotated === 0 && labels[0] === 3,
    `annotation at position ${annotated}, where page ${labels[annotated] ?? '?'} sits`,
  );

  const annots = pages[0].node.lookup(PDFName.of('Annots'));
  const dict = annots instanceof PDFArray ? annots.lookup(0) : null;
  check(
    'it is still a valid highlight',
    dict instanceof PDFDict && dict.lookup(PDFName.of('Subtype'))?.asString?.() === '/Highlight',
  );
}

/* ── an annotation on a deleted page ─────────────────────────────────── */

{
  const annotation = {
    id: 'ann-on-the-deleted-one',
    kind: 'highlight',
    page: 2,
    color: [0.98, 0.79, 0.29],
    createdAt: Date.UTC(2026, 7, 15),
    quads: [{ x: 30, y: 100, width: 120, height: 20 }],
  };

  const plan = removePage(base, 1); // removes source page 2
  const { bytes } = await saveDocument(SOURCE, plan, [annotation], PAGE_COUNT);
  const doc = await PDFDocument.load(bytes);

  // An annotation from a page that is gone must not land on somebody else's page.
  const withAnnots = doc.getPages().filter((page) => {
    const annots = page.node.lookup(PDFName.of('Annots'));
    return annots instanceof PDFArray && annots.size() > 0;
  });
  check(
    'an annotation from a deleted page does not move elsewhere',
    withAnnots.length === 0,
    `${withAnnots.length} pages carry annotations`,
  );
}

/* ── page ranges ─────────────────────────────────────────────────────── */

{
  check('the range "1-3" expands', String(parseRanges('1-3', 5)) === '1,2,3');
  check('a list and a range together', String(parseRanges('1, 3-4', 5)) === '1,3,4');
  check('a reversed range is corrected', String(parseRanges('4-2', 5)) === '2,3,4');
  check('duplicates are merged', String(parseRanges('2,2,2-3', 5)) === '2,3');
  check('anything outside the document is dropped', String(parseRanges('0, 4, 99', 3)) === '');
  check('junk does not break the parsing', String(parseRanges('abc, , 2', 3)) === '2');
}

/* ── merging ─────────────────────────────────────────────────────────── */

{
  const other = new TextEncoder().encode(makeMultiPagePdf(2));
  // Inserted after the first page: 1, [A, B], 2, 3.
  const merged = await mergeInto(SOURCE, base, other, 1);

  check('the merge reports how many pages were added', merged.added === 2, `${merged.added}`);
  check('the plan grows', merged.plan.length === 5, `${merged.plan.length} pages`);
  check(
    'the merge reports what it does not carry over',
    merged.lost.some((m) => m.includes('bookmarks')),
    merged.lost.join(' | '),
  );

  const { bytes } = await saveDocument(merged.bytes, merged.plan, [], 5);
  const labels = await pageLabels(bytes);
  // The inserted pages come from the other document and carry their own labels 1 and 2.
  check('the inserted pages sit where they were asked to', String(labels) === '1,1,2,2,3', String(labels));
}

/* ── extraction ──────────────────────────────────────────────────────── */

{
  const extracted = await extractPages(SOURCE, base, [3, 1]);
  const labels = await pageLabels(extracted);
  check('extraction respects the page order', String(labels) === '1,3', String(labels));

  const doc = await PDFDocument.load(extracted);
  check('the extracted document holds only the pages asked for', doc.getPageCount() === 2);

  // The original must not change — that is the difference between extracting and cutting.
  const original = await PDFDocument.load(SOURCE);
  check('the original stays untouched', original.getPageCount() === PAGE_COUNT);

  const rotated = rotatePage(base, 0, 90);
  const withRotation = await extractPages(SOURCE, rotated, [1]);
  const rotatedDoc = await PDFDocument.load(withRotation);
  check(
    'extraction carries the rotation from the plan',
    rotatedDoc.getPage(0).getRotation().angle === 90,
    `${rotatedDoc.getPage(0).getRotation().angle}°`,
  );

  let refused = false;
  try {
    await extractPages(SOURCE, base, [99]);
  } catch {
    refused = true;
  }
  check('an empty selection is refused', refused);
}

/* ── outcome ─────────────────────────────────────────────────────────── */

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
