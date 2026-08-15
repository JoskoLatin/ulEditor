/**
 * Provjera izvoza teksta.
 *
 * Ne gleda se je li spremanje "prošlo" — spremljena datoteka se ponovno
 * otvara i iz nje se vadi tekst. Tako se vidi razlika između "napisao sam
 * bajtove" i "Word i Acrobat to mogu otvoriti".
 *
 *   node tools/verify-export.mjs
 */

import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { exportText, wrapLines, TEXT_FORMATS, formatOf } = await import(
  pathToFileURL(resolve(ROOT, 'packages/text-export/src/index.ts')).href
);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const SOURCE = [
  'Prvi redak s dijakriticima: čćšžđ.',
  '',
  'Drugi odlomak & znak koji XML mora escapeati < > ".',
  'Vrlo dug redak koji mora biti prelomljen jer daleko premašuje širinu A4 stranice ' +
    'umanjenu za margine, pa se u PDF-u ne smije izliti izvan lista nego mora prijeći ' +
    'u sljedeći redak kao što bi to napravio svaki uređivač teksta.',
].join('\n');

/* ── popis formata ───────────────────────────────────────────────────── */

check('nude se četiri formata', TEXT_FORMATS.length === 4, TEXT_FORMATS.map((f) => f.id).join(', '));
check('nepoznat format pada na tekst', formatOf('nepostoji').id === 'txt');

/* ── čist tekst ──────────────────────────────────────────────────────── */

{
  const { bytes, lost } = await exportText(SOURCE, 'txt', 'test');
  check('tekst je zapisan kao UTF-8', strFromU8(bytes) === SOURCE);
  check('tekst ne gubi ništa', lost.length === 0);
}

/* ── Markdown ────────────────────────────────────────────────────────── */

{
  const { bytes } = await exportText(SOURCE, 'md', 'test');
  check('markdown je isti sadržaj', strFromU8(bytes) === SOURCE);
}

/* ── DOCX ────────────────────────────────────────────────────────────── */

{
  const { bytes } = await exportText(SOURCE, 'docx', 'test');
  const files = unzipSync(bytes);

  check(
    'docx ima obavezne dijelove',
    !!files['[Content_Types].xml'] && !!files['_rels/.rels'] && !!files['word/document.xml'],
    Object.keys(files).join(', '),
  );

  const document = strFromU8(files['word/document.xml']);
  check('docx čuva dijakritike', document.includes('čćšžđ'));
  check('docx escapea XML znakove', document.includes('&amp;') && document.includes('&lt;'));
  check(
    'prazan redak je prazan odlomak',
    document.includes('<w:p/>'),
    'w:p bez sadržaja',
  );

  const paragraphs = (document.match(/<w:p[\s/>]/g) ?? []).length;
  check('svaki redak je odlomak', paragraphs === SOURCE.split('\n').length, `${paragraphs} odlomaka`);

  // Detekcija formata u samom programu mora prepoznati ovo kao Word.
  const { detect } = await import(
    pathToFileURL(resolve(ROOT, 'packages/shell-ui/src/host/detect.ts')).href
  );
  check('program prepoznaje izvezeni docx', detect('a.bin', bytes).format === 'docx');
}

/* ── PDF ─────────────────────────────────────────────────────────────── */

{
  const { bytes, lost } = await exportText(SOURCE, 'pdf', 'Naslov dokumenta');
  const doc = await PDFDocument.load(bytes);

  check('pdf je valjan i ima stranicu', doc.getPageCount() >= 1, `${doc.getPageCount()} stranica`);
  check('pdf nosi naslov', doc.getTitle() === 'Naslov dokumenta', String(doc.getTitle()));
  check(
    'gubitak dijakritika je prijavljen',
    lost.length === 1 && lost[0].includes('diacritics'),
    lost.join(' | '),
  );

  // Tekst bez dijakritika ne smije ništa prijaviti.
  const plain = await exportText('Plain ASCII only.', 'pdf', 'x');
  check('čisti ASCII ne prijavljuje gubitak', plain.lost.length === 0);

  // Puno teksta mora prijeći na sljedeću stranicu, ne se izliti izvan lista.
  const many = await exportText(
    Array.from({ length: 200 }, (_, i) => `redak ${i}`).join('\n'),
    'pdf',
    'x',
  );
  const paged = await PDFDocument.load(many.bytes);
  check('dokument se lomi na stranice', paged.getPageCount() > 1, `${paged.getPageCount()} stranica`);
}

/* ── prijelom redaka ─────────────────────────────────────────────────── */

{
  // Mjera: jedan znak = jedna jedinica, pa je očekivani prijelom očit.
  const measure = (text) => text.length;

  check('kratak redak se ne dira', String(wrapLines('kratko', 20, measure)) === 'kratko');

  const wrapped = wrapLines('jedan dva tri cetiri pet sest', 12, measure);
  check(
    'redak se lomi po riječima',
    wrapped.every((line) => line.length <= 12) && wrapped.join(' ') === 'jedan dva tri cetiri pet sest',
    wrapped.join(' | '),
  );

  // Riječ dulja od retka (URL, putanja) mora se lomiti po znakovima.
  const long = wrapLines('abcdefghijklmnopqrstuvwxyz', 10, measure);
  check(
    'preduga riječ se lomi po znakovima',
    long.length === 3 && long.every((line) => line.length <= 10),
    long.join(' | '),
  );

  check('prazan redak ostaje redak', String(wrapLines('', 10, measure)) === '');
}

/* ── prazan ulaz ─────────────────────────────────────────────────────── */

{
  const { bytes } = await exportText('', 'docx', 'prazno');
  check('prazan tekst daje valjan docx', unzipSync(bytes)['word/document.xml'] !== undefined);

  const pdf = await exportText('', 'pdf', 'prazno');
  check('prazan tekst daje valjan pdf', (await PDFDocument.load(pdf.bytes)).getPageCount() === 1);
}

/* ── ishod ───────────────────────────────────────────────────────────── */

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} provjera prošlo`);
process.exit(failed.length === 0 ? 0 : 1);
