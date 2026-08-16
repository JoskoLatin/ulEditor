/**
 * Provjera da obrisani tekst **stvarno nestane iz datoteke**.
 *
 * Crni pravokutnik preko teksta izgleda kao brisanje i prolazi svaku provjeru
 * koja gleda sliku. Zato ovdje nijedna provjera ne gleda sliku: raspakirava se
 * tok sadržaja i traži se sam niz bajtova. Ako je ondje, tekst se vadi
 * označavanjem i kopiranjem, bez obzira što se vidi.
 *
 * Drugi dio provjere je odbijanje: kad se ne može jamčiti da je sve maknuto,
 * dokument mora ostati netaknut i razlog mora doći do korisnika.
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

/* ── građa ───────────────────────────────────────────────────────────── */

/** PDF s poznatim tekstom na poznatim mjestima. */
function buildPdf({ font = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>', extra = '' } = {}) {
  const stream = [
    'BT /F1 12 Tf',
    '30 150 Td (Tajna: 12345) Tj',
    '0 -30 Td [(Ostaje ) -200 (netaknuto)] TJ',
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

/** Sirovi tok sadržaja prve stranice, raspakiran. */
async function streamOf(bytes) {
  const doc = await PDFDocument.load(bytes);
  return new TextDecoder('latin1').decode(contentsOf(doc.getPages()[0]));
}

/* ── čitanje položaja ────────────────────────────────────────────────── */

const source = buildPdf();
const doc = await PDFDocument.load(source);
const page = doc.getPages()[0];
const content = readPageContent(page, standard);

check('pronađene su tri tekstualne naredbe', content.operations.length === 2, `${content.operations.length}`);

const glyphs = content.operations
  .flatMap((op) => op.parts)
  .filter((part) => part.kind === 'glyphs')
  .flatMap((part) => part.glyphs);

const text = glyphs.map((g) => String.fromCharCode(g.code)).join('');
check('glifovi su pročitani u ispravnom redoslijedu', text === 'Tajna: 12345Ostaje netaknuto', text);

const first = glyphs[0];
check(
  'prvi glif stoji ondje gdje ga je Td postavio',
  Math.abs(first.box.x - 30) < 0.01 && first.box.y < 150 && first.box.y + first.box.height > 150,
  `x ${first.box.x.toFixed(1)}, y ${first.box.y.toFixed(1)}–${(first.box.y + first.box.height).toFixed(1)}`,
);

/* Širina „T” u Helvetici je 611/1000; Liberation Sans mora dati isto. */
check(
  'standardni font je izmjeren, ne nagađan',
  Math.abs(first.advance - (611 / 1000) * 12) < 0.05,
  `${first.advance.toFixed(3)} pt`,
);

/* ── brisanje ────────────────────────────────────────────────────────── */

/** Pravokutnik koji obuhvaća zadane glifove, s malo zraka na sve strane. */
function around(chosen, pad = 0.4) {
  const left = Math.min(...chosen.map((g) => g.box.x));
  const right = Math.max(...chosen.map((g) => g.box.x + g.box.width));
  const bottom = Math.min(...chosen.map((g) => g.box.y));
  const top = Math.max(...chosen.map((g) => g.box.y + g.box.height));
  return { x: left - pad, y: bottom - pad, width: right - left + pad * 2, height: top - bottom + pad * 2 };
}

// Preko samog broja, bez riječi „Tajna:” ispred njega. Zrak oko pravokutnika
// je namjeran: povlačenje rukom nikad nije po pikselu, a susjedna slova
// svejedno moraju ostati.
const rect = around(glyphs.filter((g) => g.code >= 0x31 && g.code <= 0x35));

const preview = previewRedaction(page, [rect], standard);
check('pretpregled najavi točno pet glifova', preview.glyphs === 5, `${preview.glyphs}`);
check('pretpregled ne prijavljuje prepreku', preview.obstacles.length === 0);

const redacted = await applyRedactions(source, [{ id: 'r1', page: 1, rect }], standard);
check('pet glifova je maknuto', redacted.removed === 5, `${redacted.removed}`);
check('ništa nije odbijeno', redacted.refused.length === 0, JSON.stringify(redacted.refused));

const after = await streamOf(redacted.bytes);

/*
 * Ovo je provjera zbog koje ova datoteka postoji. Traži se sam niz bajtova, u
 * oba oblika u kojima se tekst zapisuje — običnom i heksadekadskom.
 */
check('broja više nema kao teksta', !after.includes('12345'));
check('broja više nema ni heksadekadski', !/3132333435/i.test(after));

/*
 * I u cijeloj datoteci, ne samo u toku koji se crta. Novi tok uz preusmjeren
 * `/Contents` ostavio bi stari kao siroče: nitko ga ne crta, a bajtovi su i
 * dalje ondje i vade se prvim alatom koji raspakira tokove.
 */
check(
  'broja nema nigdje u datoteci, ni u napuštenom objektu',
  !new TextDecoder('latin1').decode(redacted.bytes).includes('12345'),
);

const reloaded = await PDFDocument.load(redacted.bytes);
const afterContent = readPageContent(reloaded.getPages()[0], standard);
const afterGlyphs = afterContent.operations
  .flatMap((op) => op.parts)
  .filter((part) => part.kind === 'glyphs')
  .flatMap((part) => part.glyphs);
const afterText = afterGlyphs.map((g) => String.fromCharCode(g.code)).join('');

check('ostatak retka je netaknut', afterText === 'Tajna: Ostaje netaknuto', afterText);

/*
 * Brisanje sredine retka mora ostaviti ostatak na istom mjestu. Bez pomaka u
 * `TJ` polju sve iza obrisanog skliznulo bi ulijevo.
 */
const beforeSecondLine = glyphs.find((g) => g.code === 0x4f); // 'O' iz „Ostaje”
const afterSecondLine = afterGlyphs.find((g) => g.code === 0x4f);
check(
  'drugi redak nije pomaknut',
  Math.abs(beforeSecondLine.box.x - afterSecondLine.box.x) < 0.01 &&
    Math.abs(beforeSecondLine.box.y - afterSecondLine.box.y) < 0.01,
  `${beforeSecondLine.box.x.toFixed(2)} → ${afterSecondLine.box.x.toFixed(2)}`,
);

/* ── brisanje sredine riječi ─────────────────────────────────────────── */

// Preko „ajn” usred „Tajna” — najteži slučaj, jer se niz mora rasjeći.
const midRect = around(glyphs.slice(1, 4));

const middle = await applyRedactions(source, [{ id: 'r2', page: 1, rect: midRect }], standard);
const middleContent = readPageContent((await PDFDocument.load(middle.bytes)).getPages()[0], standard);
const middleText = middleContent.operations
  .flatMap((op) => op.parts)
  .filter((part) => part.kind === 'glyphs')
  .flatMap((part) => part.glyphs)
  .map((g) => String.fromCharCode(g.code))
  .join('');
check('sredina riječi se da izrezati', middleText === 'Ta: 12345Ostaje netaknuto', middleText);

const tail = middleContent.operations[0].parts
  .filter((p) => p.kind === 'glyphs')
  .flatMap((p) => p.glyphs)
  .find((g) => g.code === 0x3a); // ':'
const tailBefore = glyphs.find((g) => g.code === 0x3a);
check(
  'ostatak riječi ostaje na svom mjestu',
  Math.abs(tail.box.x - tailBefore.box.x) < 0.01,
  `${tailBefore.box.x.toFixed(2)} → ${tail.box.x.toFixed(2)}`,
);

/* ── odbijanje ───────────────────────────────────────────────────────── */

// Times bez tablice širina: mjere se ne znaju, pa se ništa ne smije dirati.
const unknownFont = buildPdf({ font: '<</Type/Font/Subtype/Type1/BaseFont/Times-Roman>>' });
const refusedFont = await applyRedactions(unknownFont, [{ id: 'r3', page: 1, rect }], standard);
check('nepoznat font zaustavi brisanje', refusedFont.refused.length === 1, refusedFont.refused[0]?.reason ?? '');
check('odbijeni dokument ostaje bajt po bajt isti', refusedFont.bytes === unknownFont);

// Form XObject preko područja: tekst unutra se odavde ne vidi.
const withForm = buildPdf({ extra: 'q 1 0 0 1 0 0 cm /X1 Do Q' });
const overForm = { x: 205, y: 25, width: 20, height: 10 };
const refusedForm = await applyRedactions(withForm, [{ id: 'r4', page: 1, rect: overForm }], standard);
check(
  'Form XObject preko područja zaustavi brisanje',
  refusedForm.refused.length === 1,
  refusedForm.refused[0]?.reason ?? '',
);

// Isti taj XObject drugdje na stranici ne smije smetati.
const elsewhere = await applyRedactions(withForm, [{ id: 'r5', page: 1, rect }], standard);
check(
  'XObject izvan područja ne smeta',
  elsewhere.refused.length === 0 && elsewhere.removed === 5,
  `maknuto ${elsewhere.removed}, odbijeno ${elsewhere.refused.length}`,
);

/* ── ništa za obrisati ───────────────────────────────────────────────── */

const empty = await applyRedactions(source, [], standard);
check('bez područja dokument se ne prepisuje', empty.bytes === source && empty.removed === 0);

const miss = await applyRedactions(
  source,
  [{ id: 'r6', page: 1, rect: { x: 250, y: 10, width: 20, height: 10 } }],
  standard,
);
check('područje bez teksta ne mijenja dokument', miss.bytes === source && miss.removed === 0);

/* ── ishod ───────────────────────────────────────────────────────────── */

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} provjera prošlo`);
process.exit(failed.length === 0 ? 0 : 1);
