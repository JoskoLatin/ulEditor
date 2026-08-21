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
    lost.length === 1 && lost[0].includes('bookmarks'),
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

/* ── rasponi stranica ────────────────────────────────────────────────── */

{
  check('raspon "1-3" se širi', String(parseRanges('1-3', 5)) === '1,2,3');
  check('nabrajanje i raspon zajedno', String(parseRanges('1, 3-4', 5)) === '1,3,4');
  check('obrnuti raspon se ispravlja', String(parseRanges('4-2', 5)) === '2,3,4');
  check('duplikati se stapaju', String(parseRanges('2,2,2-3', 5)) === '2,3');
  check('izvan dokumenta se odbacuje', String(parseRanges('0, 4, 99', 3)) === '');
  check('smeće ne ruši parsiranje', String(parseRanges('abc, , 2', 3)) === '2');
}

/* ── spajanje ────────────────────────────────────────────────────────── */

{
  const other = new TextEncoder().encode(makeMultiPagePdf(2));
  // Umeće se iza prve stranice: 1, [A, B], 2, 3.
  const merged = await mergeInto(SOURCE, base, other, 1);

  check('spajanje javlja koliko je stranica dodano', merged.added === 2, `${merged.added}`);
  check('plan naraste', merged.plan.length === 5, `${merged.plan.length} stranica`);
  check(
    'spajanje prijavljuje što ne prenosi',
    merged.lost.some((m) => m.includes('bookmarks')),
    merged.lost.join(' | '),
  );

  const { bytes } = await saveDocument(merged.bytes, merged.plan, [], 5);
  const labels = await pageLabels(bytes);
  // Umetnute stranice dolaze iz drugog dokumenta i nose vlastite oznake 1 i 2.
  check('umetnute stranice su na traženom mjestu', String(labels) === '1,1,2,2,3', String(labels));
}

/* ── izdvajanje ──────────────────────────────────────────────────────── */

{
  const extracted = await extractPages(SOURCE, base, [3, 1]);
  const labels = await pageLabels(extracted);
  check('izdvajanje poštuje redoslijed stranica', String(labels) === '1,3', String(labels));

  const doc = await PDFDocument.load(extracted);
  check('izdvojeni dokument ima samo tražene stranice', doc.getPageCount() === 2);

  // Izvornik se ne smije promijeniti — to je razlika između izdvajanja i rezanja.
  const original = await PDFDocument.load(SOURCE);
  check('izvornik ostaje netaknut', original.getPageCount() === PAGE_COUNT);

  const rotated = rotatePage(base, 0, 90);
  const withRotation = await extractPages(SOURCE, rotated, [1]);
  const rotatedDoc = await PDFDocument.load(withRotation);
  check(
    'izdvajanje nosi rotaciju iz plana',
    rotatedDoc.getPage(0).getRotation().angle === 90,
    `${rotatedDoc.getPage(0).getRotation().angle}°`,
  );

  let refused = false;
  try {
    await extractPages(SOURCE, base, [99]);
  } catch {
    refused = true;
  }
  check('prazan odabir se odbija', refused);
}

/* ── ishod ───────────────────────────────────────────────────────────── */

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
