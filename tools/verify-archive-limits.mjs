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

import { deflateSync, zipSync, gzipSync, strToU8, unzipSync } from 'fflate';
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

/* ── ZIPs built by hand (the review of 6f5e284) ──────────────────────────
   Every field under control, so the directory and a local header can
   disagree, parts can share bytes, and zip64 can claim what it likes. */

const join = (parts) => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const header = (size, fields) => {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  for (const [at, width, value] of fields) {
    if (width === 2) view.setUint16(at, value, true);
    else if (width === 4) view.setUint32(at, value, true);
    else view.setBigUint64(at, BigInt(value), true);
  }
  return bytes;
};
const named = (bytes, at, name) => {
  const text = strToU8(name);
  const out = new Uint8Array(bytes.length + text.length);
  out.set(bytes);
  out.set(text, at);
  new DataView(out.buffer).setUint16(at === 30 ? 26 : 28, text.length, true);
  return out;
};
const localHeader = ({ name, method, csize, usize }) =>
  named(header(30, [[0, 4, 0x04034b50], [4, 2, 20], [8, 2, method], [18, 4, csize], [22, 4, usize]]), 30, name);
const centralEntry = ({ name, method, csize, usize, offset }) =>
  named(header(46, [[0, 4, 0x02014b50], [4, 2, 20], [6, 2, 20], [10, 2, method], [20, 4, csize], [24, 4, usize], [42, 4, offset]]), 46, name);
const directoryEnd = ({ count, size, offset }) =>
  header(22, [[0, 4, 0x06054b50], [8, 2, Math.min(count, 0xffff)], [10, 2, Math.min(count, 0xffff)], [12, 4, size], [16, 4, offset]]);

{
  /* (a) Stored parts are copied whole, at their packed size, whatever they
     declare: a hundred entries pointing at one stored stretch of 1 MiB come
     to 100 MiB from a file of 1 MiB — within the bound on the whole, so
     only this asks it: their packed sizes together exceed the file, which an
     honest ZIP's never do (the review measured 2 GiB from 20 MiB). */
  const data = new Uint8Array(1024 * 1024).fill(0x41);
  const body = join([localHeader({ name: 'x', method: 0, csize: data.length, usize: 0 }), data]);
  const entries = join(Array.from({ length: 100 }, (_, i) => centralEntry({ name: `p${i}.xml`, method: 0, csize: data.length, usize: 0, offset: 0 })));
  const shared = join([body, entries, directoryEnd({ count: 100, size: entries.length, offset: body.length })]);
  const got = opened(openArchive, shared);
  check('refused: stored parts sharing one stretch of the file, at once', got.refused === SAID && got.took < 1000, `${got.refused ?? 'opened'}, ${got.took} ms`);
  const bookGot = opened(openEpub, shared);
  check('and as a book', bookGot.refused === SAID, bookGot.refused ?? 'opened');

  /* (b) A directory end claiming four billion entries, in a file of a few
     hundred bytes: the walk ends at the bound, not at the claim. */
  const one = join([localHeader({ name: 'a.xml', method: 0, csize: 1, usize: 1 }), strToU8('a')]);
  const entry = centralEntry({ name: 'a.xml', method: 0, csize: 1, usize: 1, offset: 0 });
  const at = one.length + entry.length;
  const zip64 = header(56, [[0, 4, 0x06064b50], [4, 8, 44], [12, 2, 45], [14, 2, 45], [24, 8, 2 ** 32 - 2], [32, 8, 2 ** 32 - 2], [40, 8, entry.length], [48, 8, one.length]]);
  const locator = header(20, [[0, 4, 0x07064b50], [8, 8, at], [16, 4, 1]]);
  const endless = join([one, entry, zip64, locator, directoryEnd({ count: 0xffff, size: entry.length, offset: one.length })]);
  const walked = opened(openArchive, endless);
  check(`refused: a directory claiming four billion entries, in ${endless.length} bytes, at once`, walked.refused === SAID && walked.took < 1000, `${walked.refused ?? 'opened'}, ${walked.took} ms`);

  /* (c) A deflated part declaring less than it holds comes out as long as it
     declares, and no longer — the property the bounds stand on, kept here
     against an update of fflate that let the buffer grow. */
  const fifty = deflateSync(new Uint8Array(50 * 1024 * 1024));
  const lying = join([localHeader({ name: 'a.xml', method: 8, csize: fifty.length, usize: 100 }), fifty]);
  const lyingEntry = centralEntry({ name: 'a.xml', method: 8, csize: fifty.length, usize: 100, offset: 0 });
  const less = opened(openArchive, join([lying, lyingEntry, directoryEnd({ count: 1, size: lyingEntry.length, offset: lying.length })]));
  check('a part declaring 100 bytes of fifty megabytes comes out 100 bytes', !less.refused && less.result['a.xml']?.length === 100, less.refused ?? `${less.result['a.xml']?.length} bytes`);

  /* (d) Sizes are the directory's: a local header claiming two gigabytes
     beside a directory entry of 600 000 bytes gives 600 000. */
  const small = deflateSync(new Uint8Array(600000));
  const loud = join([localHeader({ name: 'a.xml', method: 8, csize: small.length, usize: 2 ** 31 }), small]);
  const quiet = centralEntry({ name: 'a.xml', method: 8, csize: small.length, usize: 600000, offset: 0 });
  const directory = opened(openArchive, join([loud, quiet, directoryEnd({ count: 1, size: quiet.length, offset: loud.length })]));
  check('the directory\'s sizes count, not a local header\'s', !directory.refused && directory.result['a.xml']?.length === 600000, directory.refused ?? `${directory.result['a.xml']?.length} bytes`);
}

/* ── a book ──────────────────────────────────────────────────────────── */

const book = opened(openEpub, makeEpub());
/* Past the unpacking it needs a DOM, which Node has not: what is asked here is only that the bound lets it through. */
check('an honest book is unpacked, not refused for its size', book.refused !== SAID, book.refused ?? 'opened');
const bookFiles = unzipSync(makeEpub());
const bigBook = claiming(zipSync(bookFiles), Object.keys(bookFiles).map(() => MOST_PART_BYTES + 1));
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
