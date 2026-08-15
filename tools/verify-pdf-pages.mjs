/**
 * Provjera operacija nad stranicama.
 *
 * UI pokazuje da minijatura nestane ili se okrene. To ne dokazuje ništa o
 * datoteci — ovdje se zapisani PDF ponovno parsira i gleda koliko stranica
 * ima, kojim redoslijedom i s kojom rotacijom. Uz to se provjerava ono što
 * se najlakše previdi: da anotacija ostane uz SVOJU stranicu i nakon što se
 * stranice presloži.
 *
 *   node tools/verify-pdf-pages.mjs
 */

import { PDFDocument, PDFName, PDFArray, PDFDict } from 'pdf-lib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeMultiPagePdf } from './fixtures.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { saveDocument, identityPlan, movePage, removePage, rotatePage, isIdentity, pageMapOf } =
  await import(pathToFileURL(resolve(ROOT, 'packages/editor-pdf/src/document.ts')).href);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const SOURCE = new TextEncoder().encode(makeMultiPagePdf(3));
const PAGE_COUNT = 3;

/** Vraća tekst sadržaja svake stranice — tako znamo koja je stvarno gdje. */
async function pageLabels(bytes) {
  const doc = await PDFDocument.load(bytes);
  const labels = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    const stream = contents?.getContentsString?.() ?? '';
    const match = /\(STRANICA (\d+)\)/.exec(stream);
    labels.push(match ? Number(match[1]) : 0);
  }
  return labels;
}

async function rotations(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.getRotation().angle);
}

/* ── čiste funkcije plana ────────────────────────────────────────────── */

const base = identityPlan(3);
check('početni plan je netaknut', isIdentity(base, 3), JSON.stringify(base.map((e) => e.source)));

check(
  'rotacija se zbraja po modulu 360',
  rotatePage(rotatePage(rotatePage(rotatePage(base, 0, 90), 0, 90), 0, 90), 0, 90)[0].rotate === 0,
);
check('rotacija ulijevo daje 270, ne -90', rotatePage(base, 0, -90)[0].rotate === 270);
check(
  'zadnja stranica se ne može obrisati',
  removePage(identityPlan(1), 0).length === 1,
  'dokument bez stranica nije valjan PDF',
);
check('pomak izvan granica ne mijenja plan', movePage(base, 0, -1) === base);

/* ── brisanje ────────────────────────────────────────────────────────── */

{
  const plan = removePage(base, 1); // miče stranicu 2
  const { bytes, lost } = await saveDocument(SOURCE, plan, [], PAGE_COUNT);
  const labels = await pageLabels(bytes);
  check('brisanje ostavlja dvije stranice', labels.length === 2, labels.join(', '));
  check('ostale su stranice 1 i 3', labels.join(',') === '1,3', labels.join(','));
  check('brisanje ne prijavljuje gubitak', lost.length === 0, lost.join(' | ') || 'ništa');
}

/* ── rotacija ────────────────────────────────────────────────────────── */

{
  const plan = rotatePage(rotatePage(base, 0, 90), 2, 180);
  const { bytes, lost } = await saveDocument(SOURCE, plan, [], PAGE_COUNT);
  const angles = await rotations(bytes);
  check('rotacije su zapisane u datoteku', angles.join(',') === '90,0,180', angles.join(','));
  check('rotacija ne prijavljuje gubitak', lost.length === 0, lost.join(' | ') || 'ništa');
}

/* ── preslagivanje ───────────────────────────────────────────────────── */

{
  // 1,2,3 → 3,1,2
  const plan = movePage(base, 2, -2);
  const { bytes, lost } = await saveDocument(SOURCE, plan, [], PAGE_COUNT);
  const labels = await pageLabels(bytes);
  check('preslagivanje mijenja stvarni redoslijed', labels.join(',') === '3,1,2', labels.join(','));
  check(
    'preslagivanje pošteno prijavljuje gubitak',
    lost.length === 1 && lost[0].includes('oznake'),
    lost.join(' | '),
  );
}

/* ── anotacija prati svoju stranicu ──────────────────────────────────── */

{
  // Istaknuće na IZVORNOJ stranici 3, koja preslagivanjem ide na prvo mjesto.
  const annotation = {
    id: 'ann-na-trecoj',
    kind: 'highlight',
    page: 3,
    color: [0.98, 0.79, 0.29],
    createdAt: Date.UTC(2026, 7, 15),
    quads: [{ x: 30, y: 100, width: 120, height: 20 }],
  };

  const plan = movePage(base, 2, -2); // 3,1,2
  check('mapa stranica vodi izvornu 3 na mjesto 0', pageMapOf(plan).get(3) === 0);

  const { bytes } = await saveDocument(SOURCE, plan, [annotation], PAGE_COUNT);
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages();

  const annotated = pages.findIndex((page) => {
    const annots = page.node.lookup(PDFName.of('Annots'));
    return annots instanceof PDFArray && annots.size() > 0;
  });
  const labels = await pageLabels(bytes);
  check(
    'anotacija je otišla sa svojom stranicom',
    annotated === 0 && labels[0] === 3,
    `anotacija na mjestu ${annotated}, ondje je stranica ${labels[annotated] ?? '?'}`,
  );

  const annots = pages[0].node.lookup(PDFName.of('Annots'));
  const dict = annots instanceof PDFArray ? annots.lookup(0) : null;
  check(
    'i dalje je ispravno istaknuće',
    dict instanceof PDFDict && dict.lookup(PDFName.of('Subtype'))?.asString?.() === '/Highlight',
  );
}

/* ── anotacija na obrisanoj stranici ─────────────────────────────────── */

{
  const annotation = {
    id: 'ann-na-obrisanoj',
    kind: 'highlight',
    page: 2,
    color: [0.98, 0.79, 0.29],
    createdAt: Date.UTC(2026, 7, 15),
    quads: [{ x: 30, y: 100, width: 120, height: 20 }],
  };

  const plan = removePage(base, 1); // miče izvornu stranicu 2
  const { bytes } = await saveDocument(SOURCE, plan, [annotation], PAGE_COUNT);
  const doc = await PDFDocument.load(bytes);

  // Anotacija sa stranice koje više nema ne smije završiti na tuđoj stranici.
  const withAnnots = doc.getPages().filter((page) => {
    const annots = page.node.lookup(PDFName.of('Annots'));
    return annots instanceof PDFArray && annots.size() > 0;
  });
  check(
    'anotacija s obrisane stranice se ne seli drugdje',
    withAnnots.length === 0,
    `${withAnnots.length} stranica s anotacijama`,
  );
}

/* ── ishod ───────────────────────────────────────────────────────────── */

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} provjera prošlo`);
process.exit(failed.length === 0 ? 0 : 1);
