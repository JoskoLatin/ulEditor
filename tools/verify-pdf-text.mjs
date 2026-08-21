/**
 * Provjera da dodani tekst stvarno završi u PDF-u — i to čitljiv.
 *
 * Da se tekst vidi na ekranu ne dokazuje ništa: `/FreeText` bez vlastitog toka
 * izgleda je nevidljiv u gotovo svakom čitaču osim Acrobata, a znak koji font
 * nema pdf-lib tiho zamijeni praznim mjestom. Oboje bi prošlo svaku provjeru
 * koja gleda samo naš model. Zato se ovdje zapisani PDF ponovno parsira i
 * gleda mu se sadržaj toka izgleda, bajt po bajt.
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
 * Isti font koji preglednik dohvaća preko `fonts.ts`, samo s diska: provjera
 * ne smije ovisiti o Viteu ni o mreži.
 */
const FILES = {
  sans: 'LiberationSans-Regular.ttf',
  'sans-bold': 'LiberationSans-Bold.ttf',
  'sans-italic': 'LiberationSans-Italic.ttf',
};

const loadFont = async (face) =>
  new Uint8Array(await readFile(require.resolve(`pdfjs-dist/standard_fonts/${FILES[face]}`)));

const metrics = metricsOf('sans', await loadFont('sans'));

const CROATIAN = 'Vodice, 15. kolovoza — čćžšđ ČĆŽŠĐ';
check(
  'font pokriva hrvatsku dijakritiku',
  metrics.missing(CROATIAN).length === 0,
  metrics.missing(CROATIAN).join('') || '(ništa ne nedostaje)',
);

/* Zašto se font uopće ugrađuje: standardni ga ne bi mogao napisati. */
const helvetica = await PDFDocument.create().then((d) => d.embedFont('Helvetica'));
let standardRefused = false;
try {
  helvetica.encodeText('č');
} catch {
  standardRefused = true;
}
check('standardni PDF font odbija č, pa se mora ugraditi', standardRefused);

/* ── zapis ───────────────────────────────────────────────────────────── */

const source = new TextEncoder().encode(makePdf());

const anchor = { x: 60, top: 200 };
const twoLines = `${CROATIAN}\nDrugi redak`;

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
    text: 'Podebljano',
    size: 14,
    face: 'sans-bold',
    rect: layoutTextBox(metrics, 'Podebljano', 14, { x: 60, top: 120 }),
  },
];

const written = await writeAnnotations(source, boxes, undefined, loadFont);
check('oba okvira su zapisana', written.written === 2, `${written.written}`);
check('nema prijave o nedostajućim znakovima', written.missingGlyphs.length === 0);

/* ── ponovno parsiranje ──────────────────────────────────────────────── */

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
check('oba su tipa FreeText', freeText.length === 2, `${freeText.length}`);

const first = freeText[0];
if (first) {
  const contents = first.lookup(PDFName.of('Contents'));
  const decoded =
    contents instanceof PDFHexString || contents instanceof PDFString ? contents.decodeText() : '';
  check(
    'tekst je u datoteci s dijakritikom',
    decoded === twoLines,
    JSON.stringify(decoded.slice(0, 36)),
  );

  /*
   * Ovo je provjera zbog koje ova datoteka postoji. Bez `/AP` anotacija je
   * nevidljiva u pdf.js-u i u preglednicima — dokument bi izgledao prazan
   * svima osim onome tko ga je napisao.
   */
  const ap = first.lookup(PDFName.of('AP'));
  const normal = ap instanceof PDFDict ? ap.lookup(PDFName.of('N')) : null;
  check('okvir nosi vlastiti tok izgleda (/AP /N)', !!normal, normal ? 'ima' : 'NEMA');

  if (normal) {
    const dict = normal.dict ?? normal;

    // Tok je flate-komprimiran; bez raspakiravanja bi provjera gledala smeće i
    // svejedno "prošla" ako se traži nepostojanje nečega.
    const filter = String(dict.lookup(PDFName.of('Filter')) ?? '');
    check('tok izgleda je komprimiran', filter.includes('FlateDecode'), filter || '(bez filtra)');

    const payload = Buffer.from(normal.getContents());
    const stream = new TextDecoder('latin1').decode(
      filter.includes('FlateDecode') ? inflateSync(payload) : payload,
    );

    const lines = linesOf(twoLines);
    check(
      'tok izgleda crta oba retka',
      (stream.match(/Tj/g) ?? []).length === lines.length,
      `${(stream.match(/Tj/g) ?? []).length} od ${lines.length}`,
    );
    check('tok izgleda postavlja font i veličinu', /\/F1 11 Tf/.test(stream), '');
    check('tekst je kodiran heksadekadski, ne kao Latin-1', /<[0-9a-fA-F]+>\s*Tj/.test(stream));

    const bbox = dict.lookup(PDFName.of('BBox'));
    const values = bbox instanceof PDFArray ? bbox.asArray().map((n) => n.asNumber()) : [];
    const rect = first.lookup(PDFName.of('Rect'));
    const rectValues = rect instanceof PDFArray ? rect.asArray().map((n) => n.asNumber()) : [];
    check(
      'BBox odgovara Rectu, pa se izgled ne rasteže',
      values.length === 4 &&
        rectValues.length === 4 &&
        Math.abs(values[2] - (rectValues[2] - rectValues[0])) < 0.01 &&
        Math.abs(values[3] - (rectValues[3] - rectValues[1])) < 0.01,
      `BBox ${values.join(' ')} · Rect ${rectValues.join(' ')}`,
    );

    const resources = dict.lookup(PDFName.of('Resources'));
    const fonts = resources instanceof PDFDict ? resources.lookup(PDFName.of('Font')) : null;
    check(
      'font je u resursima toka izgleda',
      fonts instanceof PDFDict && !!fonts.get(PDFName.of('F1')),
    );
  }

  /* `/C` na FreeTextu znači boju POZADINE — postavljena bi obojila okvir. */
  check('okvir nema postavljenu boju pozadine (/C)', !first.get(PDFName.of('C')));
  check(
    'boja teksta je u /DA',
    /0 0 0 rg/.test(first.lookup(PDFName.of('DA'))?.decodeText?.() ?? ''),
    first.lookup(PDFName.of('DA'))?.decodeText?.() ?? '',
  );
}

/* ── ugrađeni font ───────────────────────────────────────────────────── */

const raw = new TextDecoder('latin1').decode(written.bytes);
check('font je ugrađen kao podskup', /\/FontFile2/.test(raw));
check(
  'ugrađen je podskup, ne cijeli font',
  written.bytes.length < 90_000,
  `${Math.round(written.bytes.length / 1024)} KB naspram 136 KB samog fonta`,
);

/* ── znak koji font nema ─────────────────────────────────────────────── */

const chinese = {
  ...boxes[0],
  id: 'test-missing',
  text: 'Ovo je 汉字 usred rečenice',
};
const withMissing = await writeAnnotations(source, [chinese], undefined, loadFont);
check(
  'znak koji font nema se prijavljuje, ne guta',
  withMissing.missingGlyphs.join('') === '汉字',
  withMissing.missingGlyphs.join('') || '(ništa — a trebalo bi)',
);
check(
  'upozorenje dođe do korisnika kao tekst',
  missingGlyphWarning(withMissing.missingGlyphs).length === 1,
  missingGlyphWarning(withMissing.missingGlyphs)[0] ?? '',
);

/* ── mjere ───────────────────────────────────────────────────────────── */

const wide = layoutTextBox(metrics, 'iii', 11, anchor);
const wider = layoutTextBox(metrics, 'MMMMMMMMMMMM', 11, anchor);
check('širi tekst daje širi okvir', wider.width > wide.width, `${wide.width} → ${wider.width}`);

const oneLine = layoutTextBox(metrics, 'jedan', 11, anchor);
const threeLines = layoutTextBox(metrics, 'a\nb\nc', 11, anchor);
check(
  'okvir raste prema dolje, gornji rub ostaje',
  Math.abs(oneLine.y + oneLine.height - anchor.top) < 0.01 &&
    Math.abs(threeLines.y + threeLines.height - anchor.top) < 0.01 &&
    threeLines.height > oneLine.height,
  `1 redak ${oneLine.height.toFixed(1)} pt · 3 retka ${threeLines.height.toFixed(1)} pt`,
);

/* ── ponovno spremanje ───────────────────────────────────────────────── */

const second = await writeAnnotations(
  written.bytes,
  boxes.map((b) => ({ ...b, imported: true })),
  undefined,
  loadFont,
);
const twice = await PDFDocument.load(second.bytes);
const annotsTwice = twice.getPages()[0].node.lookup(PDFName.of('Annots'));
check(
  'ponovno spremanje ne duplicira okvire',
  annotsTwice instanceof PDFArray && annotsTwice.size() === 2,
  `${annotsTwice instanceof PDFArray ? annotsTwice.size() : '?'}`,
);

/* ── ishod ───────────────────────────────────────────────────────────── */

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
