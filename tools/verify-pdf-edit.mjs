/**
 * Provjera prepisivanja postojećeg teksta.
 *
 * Izmjena je ovdje sastavljena od brisanja i upisivanja, pa je pitanje samo
 * jedno: **poklopi li se zamjena s onim što je bilo.** Zato se ne gleda je li
 * se nešto promijenilo nego se uspoređuju brojke — osnovna linija, veličina,
 * boja — i provjerava se da program odbije ondje gdje se poklapanje ne može
 * obećati.
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

/* ── građa ───────────────────────────────────────────────────────────── */

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

/* ── čitanje retka ───────────────────────────────────────────────────── */

const plain = await pageOf(
  buildPdf(
    [
      'BT /F1 12 Tf 30 150 Td (Ime i prezime) Tj ET',
      'BT 1 0 0 rg /F1 9 Tf 30 120 Td (Crveni sitni redak) Tj ET',
      'BT 3 Tr /F1 12 Tf 30 90 Td (Nevidljivi sloj) Tj ET',
      // `Tr` je dio stanja teksta i traje preko `BT`/`ET`; bez vraćanja na 0
      // bio bi nevidljiv i sljedeći redak.
      'BT 0 Tr /F1 12 Tf 1 0.4 -0.4 1 30 60 Tm (Nakrivo) Tj ET',
    ].join('\n'),
  ),
);

const found = findEditableLine(plain, { x: 45, y: 154 }, standard);
check('redak pod prstom je pronađen', !!found && 'line' in found);

const line = found?.line;
check('tekst je pročitan kao slova', line?.text === 'Ime i prezime', line?.text ?? '');
check('veličina je preuzeta iz dokumenta', Math.abs((line?.size ?? 0) - 12) < 0.01, `${line?.size}`);
check(
  'osnovna linija je ondje gdje ju je Td postavio',
  Math.abs((line?.origin.x ?? 0) - 30) < 0.01 && Math.abs((line?.origin.y ?? 0) - 150) < 0.01,
  `${line?.origin.x}, ${line?.origin.y}`,
);
check('boja je crna', line?.color.every((c) => c === 0) === true, JSON.stringify(line?.color));
check('Helvetica se mjerama poklapa s našim fontom', line?.metricsMatch === true);
check('nema upozorenja o obliku slova', metricsWarning(line) === null);

const red = findEditableLine(plain, { x: 45, y: 124 }, standard);
check(
  'boja retka je pročitana iz sadržaja',
  red?.line?.color?.[0] === 1 && red.line.color[1] === 0 && red.line.color[2] === 0,
  JSON.stringify(red?.line?.color),
);
check('i njegova veličina', Math.abs((red?.line?.size ?? 0) - 9) < 0.01, `${red?.line?.size}`);

check('prazno mjesto ne nudi ništa', findEditableLine(plain, { x: 260, y: 20 }, standard) === null);

/* ── odbijanja ───────────────────────────────────────────────────────── */

/* Razlozi se uspoređuju, ne samo postojanje: odbijanje iz krivog razloga
   znači da provjera gleda drugi redak nego što misli. */
const invisible = findEditableLine(plain, { x: 45, y: 94 }, standard);
check(
  'nevidljiv sloj se odbija kao sloj iz prepoznavanja',
  /invisible/.test(invisible?.refusal ?? ''),
  invisible?.refusal ?? '',
);

const skewed = findEditableLine(plain, { x: 45, y: 66 }, standard);
check(
  'nakrivljen tekst se odbija zbog nagiba',
  /rotated or skewed/.test(skewed?.refusal ?? ''),
  skewed?.refusal ?? '',
);

/* Font s vlastitim širinama i vlastitim kodiranjem, bez /ToUnicode: kodovi se
   daju izmjeriti, ali ne i pročitati kao slova. */
const opaque = await pageOf(
  buildPdf('BT /F1 12 Tf 30 150 Td (abc) Tj ET', [
    '<</Type/Font/Subtype/Type1/BaseFont/Neznani/FirstChar 97/LastChar 99/Widths[500 500 500]' +
      '/Encoding<</Type/Encoding/Differences[97/alpha/beta/gamma]>>>>',
  ]),
);
const unreadable = findEditableLine(opaque, { x: 35, y: 154 }, standard);
check('tekst bez /ToUnicode se odbija, ne nagađa', !!unreadable?.refusal, unreadable?.refusal ?? '');

/* Drugi font s poznatim širinama: prepisivanje ide, ali oblik slova neće biti isti. */
const other = await pageOf(
  buildPdf('BT /F1 10 Tf 30 150 Td (Ugovor) Tj ET', [
    '<</Type/Font/Subtype/Type1/BaseFont/Garamond/FirstChar 32/LastChar 122/Widths[' +
      Array.from({ length: 91 }, () => '500').join(' ') +
      ']>>',
  ]),
);
const foreign = findEditableLine(other, { x: 40, y: 154 }, standard);
check('drugi font se i dalje da prepisati', !!foreign?.line, foreign?.line?.text ?? '');
check(
  'ali se najavi da oblik slova neće biti isti',
  typeof metricsWarning(foreign?.line) === 'string',
  metricsWarning(foreign?.line) ?? '',
);

/* ── poravnanje zamjene ──────────────────────────────────────────────── */

/*
 * Zamjena se sidri po osnovnoj liniji izvornog retka. Ovdje se taj račun vrti
 * unatrag: iz okvira koji nastane mora se dobiti ista osnovna linija s koje
 * se krenulo, inače bi prepisani redak sjeo više ili niže od ostatka retka.
 */
const metrics = await loadFace('sans', loadFont);
const anchor = {
  x: line.origin.x - TEXT_PADDING,
  top: line.origin.y + metrics.ascent(line.size) + TEXT_PADDING,
};
const box = layoutTextBox(metrics, line.text, line.size, anchor);
const baseline = box.y + box.height - TEXT_PADDING - metrics.ascent(line.size);

check(
  'zamjena sjeda na istu osnovnu liniju',
  Math.abs(baseline - line.origin.y) < 0.001,
  `${line.origin.y} → ${baseline.toFixed(3)}`,
);
check(
  'i počinje na istom mjestu slijeva',
  Math.abs(box.x + TEXT_PADDING - line.origin.x) < 0.001,
  `${line.origin.x} → ${(box.x + TEXT_PADDING).toFixed(3)}`,
);

/*
 * Helvetica i Liberation Sans su metrički jednaki, pa prepisani redak mora
 * zauzeti istu širinu kao izvorni — to je cijeli razlog zbog kojeg se piše
 * baš tim fontom.
 */
check(
  'ista širina kao izvorni redak',
  Math.abs(box.width - TEXT_PADDING * 2 - line.bounds.width) < 0.5,
  `${line.bounds.width.toFixed(2)} → ${(box.width - TEXT_PADDING * 2).toFixed(2)} pt`,
);

/* ── ishod ───────────────────────────────────────────────────────────── */

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} provjera prošlo`);
process.exit(failed.length === 0 ? 0 : 1);
