/**
 * An archive is unpacked only as far as this program opens (card 528).
 *
 * A ZIP of a few kilobytes can claim gigabytes, and every Office file, every
 * book and every `.svgz` was unpacked whole into the page: past what the page
 * can hold, it went down with whatever else was unsaved in it. Each is now
 * unpacked within bounds asked of the size its parts declare, before any is
 * unpacked — a part, all of them, and how many for a ZIP; the size its trailer
 * declares for a gzip. fflate unpacks a part only as far as it declares
 * (measured: one declaring 100 bytes of fifty megabytes came out 100 bytes),
 * so a lie downwards gives less, never more.
 *
 * So the archives here claim more than they hold, which is the attack and
 * costs nothing to build: refused at once, while the honest ones open.
 *
 *   node tools/verify-archive-limits.mjs
 */

import { zipSync, gzipSync, strToU8, unzipSync } from 'fflate';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeDocx, makeEpub } from './fixtures.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { openArchive, MOST_PART_BYTES, MOST_ARCHIVE_BYTES, MOST_PARTS } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-office/src/ooxml.ts')).href
);
const { openEpub } = await import(pathToFileURL(resolve(ROOT, 'packages/editor-book/src/epub.ts')).href);
const { unpack, MOST_SVG_BYTES } = await import(pathToFileURL(resolve(ROOT, 'packages/editor-vector/src/unpack.ts')).href);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/** The archive with every part claiming `sizes[i]` bytes unpacked, in its local header and its central directory. */
function claiming(zip, sizes) {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  let local = 0;
  let central = 0;
  for (let at = 0; at + 4 <= out.length; at++) {
    const signature = view.getUint32(at, true);
    if (signature === 0x04034b50 && local < sizes.length) view.setUint32(at + 22, sizes[local++], true);
    else if (signature === 0x02014b50 && central < sizes.length) view.setUint32(at + 24, sizes[central++], true);
  }
  return out;
}

/** What opening it does: the error's message, or what it unpacked to, and how long it took. */
function opened(open, bytes) {
  const started = Date.now();
  try {
    const result = open(bytes);
    return { result, took: Date.now() - started };
  } catch (err) {
    return { refused: err instanceof Error ? err.message : String(err), took: Date.now() - started };
  }
}

const SAID = 'This file would unpack to more than this program opens at once, so it is not opened.';

/* ── Office ──────────────────────────────────────────────────────────── */

const honest = opened(openArchive, makeDocx());
check('an honest Word document opens', !honest.refused && 'word/document.xml' in honest.result, honest.refused ?? '');

const small = zipSync({ 'a.xml': strToU8('<a/>'), 'b.xml': strToU8('<b/>'), 'c.xml': strToU8('<c/>') });
for (const [label, sizes] of [
  ['a part claiming more than a part may hold', [MOST_PART_BYTES + 1, 4, 4]],
  ['parts claiming more than an archive may hold together', [200 * 1024 * 1024, 200 * 1024 * 1024, 200 * 1024 * 1024]],
]) {
  const got = opened(openArchive, claiming(small, sizes));
  check(`refused: ${label}, said so, at once`, got.refused === SAID && got.took < 1000, `${got.refused ?? 'opened'}, ${got.took} ms`);
}
const exactly = opened(openArchive, claiming(small, [MOST_ARCHIVE_BYTES / 2, MOST_ARCHIVE_BYTES / 2, 0]));
check('parts adding up to the limit exactly are not refused for it', exactly.refused !== SAID, exactly.refused ?? 'opened');

const many = {};
for (let i = 0; i <= MOST_PARTS; i++) many[`p${i}.xml`] = strToU8('x');
const tooMany = opened(openArchive, zipSync(many, { level: 0 }));
check(`refused: more than ${MOST_PARTS} parts`, tooMany.refused === SAID, tooMany.refused ?? 'opened');

/* ── a book ──────────────────────────────────────────────────────────── */

const book = opened(openEpub, makeEpub());
/* Past the unpacking it needs a DOM, which Node has not: what is asked here is only that the bound lets it through. */
check('an honest book is unpacked, not refused for its size', book.refused !== SAID, book.refused ?? 'opened');
const bookFiles = unzipSync(makeEpub());
const bigBook = claiming(zipSync(bookFiles, { level: 0 }), Object.keys(bookFiles).map(() => MOST_PART_BYTES + 1));
const refusedBook = opened(openEpub, bigBook);
check('refused: a book whose parts claim too much, said so, at once', refusedBook.refused === SAID && refusedBook.took < 1000, `${refusedBook.refused ?? 'opened'}, ${refusedBook.took} ms`);

/* ── a compressed drawing ────────────────────────────────────────────── */

const svg = strToU8('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
const svgz = gzipSync(svg);
const drawing = opened((bytes) => unpack(bytes, 'svgz'), svgz);
check('an honest .svgz unpacks', !drawing.refused && drawing.result.length === svg.length, drawing.refused ?? '');
const claimingSvgz = svgz.slice();
new DataView(claimingSvgz.buffer).setUint32(claimingSvgz.length - 4, MOST_SVG_BYTES + 1, true);
const refusedSvg = opened((bytes) => unpack(bytes, 'svgz'), claimingSvgz);
check('refused: an .svgz claiming more than a drawing, said so, at once', refusedSvg.refused === SAID && refusedSvg.took < 1000, `${refusedSvg.refused ?? 'unpacked'}, ${refusedSvg.took} ms`);

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
