/**
 * Checking the text export.
 *
 * Whether the save "went through" is not what is looked at — the saved file is
 * opened again and the text taken back out of it. That is how the difference
 * between "I wrote some bytes" and "Word and Acrobat can open this" shows.
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
  'The first line, with diacritics: čćšžđ.',
  '',
  'A second paragraph & the characters XML has to escape < > ".',
  'A very long line that has to be wrapped because it far exceeds the width of an ' +
    'A4 page less its margins, so in the PDF it must not spill off the sheet but ' +
    'move to the next line as any text editor would do.',
].join('\n');

/* ── the format list ─────────────────────────────────────────────────── */

check('four formats are offered', TEXT_FORMATS.length === 4, TEXT_FORMATS.map((f) => f.id).join(', '));
check('an unknown format falls back to text', formatOf('does-not-exist').id === 'txt');

/* ── plain text ──────────────────────────────────────────────────────── */

{
  const { bytes, lost } = await exportText(SOURCE, 'txt', 'test');
  check('the text was written as UTF-8', strFromU8(bytes) === SOURCE);
  check('the text loses nothing', lost.length === 0);
}

/* ── Markdown ────────────────────────────────────────────────────────── */

{
  const { bytes } = await exportText(SOURCE, 'md', 'test');
  check('the markdown is the same content', strFromU8(bytes) === SOURCE);
}

/* ── DOCX ────────────────────────────────────────────────────────────── */

{
  const { bytes } = await exportText(SOURCE, 'docx', 'test');
  const files = unzipSync(bytes);

  check(
    'the docx has its mandatory parts',
    !!files['[Content_Types].xml'] && !!files['_rels/.rels'] && !!files['word/document.xml'],
    Object.keys(files).join(', '),
  );

  const document = strFromU8(files['word/document.xml']);
  check('the docx keeps the diacritics', document.includes('čćšžđ'));
  check('the docx escapes the XML characters', document.includes('&amp;') && document.includes('&lt;'));
  check(
    'an empty line is an empty paragraph',
    document.includes('<w:p/>'),
    'a w:p with no content',
  );

  const paragraphs = (document.match(/<w:p[\s/>]/g) ?? []).length;
  check('every line is a paragraph', paragraphs === SOURCE.split('\n').length, `${paragraphs} paragraphs`);

  // The program's own format detection has to recognise this as Word.
  const { detect } = await import(
    pathToFileURL(resolve(ROOT, 'packages/shell-ui/src/host/detect.ts')).href
  );
  check('the program recognises the exported docx', detect('a.bin', bytes).format === 'docx');
}

/* ── PDF ─────────────────────────────────────────────────────────────── */

{
  const { bytes, lost } = await exportText(SOURCE, 'pdf', 'The document title');
  const doc = await PDFDocument.load(bytes);

  check('the pdf is valid and has a page', doc.getPageCount() >= 1, `${doc.getPageCount()} pages`);
  check('the pdf carries its title', doc.getTitle() === 'The document title', String(doc.getTitle()));
  check(
    'the loss of the diacritics is reported',
    lost.length === 1 && lost[0].includes('diacritics'),
    lost.join(' | '),
  );

  // Text without diacritics must report nothing.
  const plain = await exportText('Plain ASCII only.', 'pdf', 'x');
  check('pure ASCII reports no loss', plain.lost.length === 0);

  // A lot of text has to move onto the next page rather than spill off the sheet.
  const many = await exportText(
    Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'),
    'pdf',
    'x',
  );
  const paged = await PDFDocument.load(many.bytes);
  check('the document breaks into pages', paged.getPageCount() > 1, `${paged.getPageCount()} pages`);
}

/* ── line wrapping ───────────────────────────────────────────────────── */

{
  // The measure: one character = one unit, so the expected wrap is obvious.
  const measure = (text) => text.length;

  check('a short line is left alone', String(wrapLines('short', 20, measure)) === 'short');

  const wrapped = wrapLines('one two three four five six', 12, measure);
  check(
    'a line wraps on word boundaries',
    wrapped.every((line) => line.length <= 12) && wrapped.join(' ') === 'one two three four five six',
    wrapped.join(' | '),
  );

  // A word longer than the line (a URL, a path) has to wrap on characters.
  const long = wrapLines('abcdefghijklmnopqrstuvwxyz', 10, measure);
  check(
    'an over-long word wraps on characters',
    long.length === 3 && long.every((line) => line.length <= 10),
    long.join(' | '),
  );

  check('an empty line stays a line', String(wrapLines('', 10, measure)) === '');
}

/* ── empty input ─────────────────────────────────────────────────────── */

{
  const { bytes } = await exportText('', 'docx', 'empty');
  check('empty text gives a valid docx', unzipSync(bytes)['word/document.xml'] !== undefined);

  const pdf = await exportText('', 'pdf', 'empty');
  check('empty text gives a valid pdf', (await PDFDocument.load(pdf.bytes)).getPageCount() === 1);
}

/* ── outcome ─────────────────────────────────────────────────────────── */

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
