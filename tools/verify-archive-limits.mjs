/**
 * An archive is unpacked only as far as this program opens (card 528).
 *
 * A ZIP of a few kilobytes can claim gigabytes, and every Office file, every
 * book and every `.svgz` was unpacked whole into the page: past what the page
 * can hold, it went down with whatever else was unsaved in it. Each is now
 * unpacked within bounds asked of the size its parts declare, before any is
 * unpacked — a part, all of them, and how many for a ZIP; the size its trailer
 * declares for a gzip. And a part that holds more than it declares is
 * given up as soon as it unpacks past that (card 529): fflate kept to the
 * declared size, but decoded the whole stream to get there — six seconds
 * for a megabyte holding a gigabyte.
 *
 * So the archives here claim more than they hold, or hold more than they
 * claim, which is the attack and costs nothing to build: refused at once,
 * while the honest ones open to what fflate's own `unzipSync` makes of them.
 *
 *   node tools/verify-archive-limits.mjs
 */

import { Deflate, deflateSync, gunzipSync, gzipSync, inflateSync, strToU8, unzipSync, zipSync } from 'fflate';
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
const { unzipWithin, gunzipWithin, ArchiveTooSlow } = await import(pathToFileURL(resolve(ROOT, 'packages/archive/src/index.ts')).href);

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
const DAMAGED = 'This is not a valid Office archive — it is probably damaged or incompletely downloaded.';
const BOOK_DAMAGED = 'This is not a valid book — it is probably damaged or incompletely downloaded.';

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

  /* (c) A deflated part declaring less than it holds is given up as soon
     as it unpacks past what it declares — not decoded to its end and cut
     (card 529). */
  const fifty = deflateSync(new Uint8Array(50 * 1024 * 1024));
  const lying = join([localHeader({ name: 'a.xml', method: 8, csize: fifty.length, usize: 100 }), fifty]);
  const lyingEntry = centralEntry({ name: 'a.xml', method: 8, csize: fifty.length, usize: 100, offset: 0 });
  const less = opened(openArchive, join([lying, lyingEntry, directoryEnd({ count: 1, size: lyingEntry.length, offset: lying.length })]));
  check('refused: a part declaring 100 bytes of fifty megabytes, as damaged', less.refused === DAMAGED, less.refused ?? `${less.result['a.xml']?.length} bytes`);

  /* (d) Sizes are the directory's: a local header claiming two gigabytes
     beside a directory entry of 600 000 bytes gives 600 000. */
  const small = deflateSync(new Uint8Array(600000));
  const loud = join([localHeader({ name: 'a.xml', method: 8, csize: small.length, usize: 2 ** 31 }), small]);
  const quiet = centralEntry({ name: 'a.xml', method: 8, csize: small.length, usize: 600000, offset: 0 });
  const directory = opened(openArchive, join([loud, quiet, directoryEnd({ count: 1, size: quiet.length, offset: loud.length })]));
  check('the directory\'s sizes count, not a local header\'s', !directory.refused && directory.result['a.xml']?.length === 600000, directory.refused ?? `${directory.result['a.xml']?.length} bytes`);
}

/* Every bound asked of both openers — the book's is a copy of the Office
   one's, and must be held to the same (the second review of 6f5e284). */
{
  const deflatedPart = (name, declared, data = new Uint8Array(16)) => {
    const packed = deflateSync(data);
    return { name, method: 8, packed, usize: declared };
  };
  const storedPart = (name, data, declared = data.length) => ({ name, method: 0, packed: data, usize: declared });
  const build = (parts) => {
    const locals = [];
    const entries = [];
    let at = 0;
    for (const part of parts) {
      const local = join([localHeader({ name: part.name, method: part.method, csize: part.packed.length, usize: part.usize }), part.packed]);
      entries.push(centralEntry({ name: part.name, method: part.method, csize: part.packed.length, usize: part.usize, offset: part.at ?? at }));
      if (part.at === undefined) {
        locals.push(local);
        at += local.length;
      }
    }
    const directory = join(entries);
    return join([...locals, directory, directoryEnd({ count: parts.length, size: directory.length, offset: at })]);
  };
  const MiB = 1024 * 1024;
  const cases = [
    ['three parts of 50 MiB each, within a part, past the whole', build([0, 1, 2].map((i) => deflatedPart(`p${i}.xml`, 50 * MiB)))],
    ['two stored parts at one place', (() => {
      const data = new Uint8Array(MiB).fill(0x41);
      return build([storedPart('a.xml', data), { ...storedPart('b.xml', data), at: 0 }]);
    })()],
    ['a stored part counted at its size, whatever it declares', build([storedPart('s.xml', new Uint8Array(MiB).fill(0x42), 0), deflatedPart('a.xml', 63.75 * MiB), deflatedPart('b.xml', 63.75 * MiB)])],
    ['a part past the bound after a broken one: the directory is read first', build([{ name: 'bad.xml', method: 8, packed: new Uint8Array([0xff, 0xff, 0xff, 0xff]), usize: 100 }, deflatedPart('big.xml', MOST_PART_BYTES + 1)])],
    ['10 001 parts', build(Array.from({ length: MOST_PARTS + 1 }, (_, i) => storedPart(`p${i}.xml`, strToU8('x'))))],
  ];
  for (const [opener, open] of [['Office', openArchive], ['book', openEpub]]) {
    for (const [label, bytes] of cases) {
      const got = opened(open, bytes);
      check(`refused as ${opener === 'Office' ? 'an Office file' : 'a book'}: ${label}`, got.refused === SAID && got.took < 1000, `${got.refused ?? 'opened'}, ${got.took} ms`);
    }
  }
  /* And the book walks no further than the Office file: four billion entries claimed. */
  const one = join([localHeader({ name: 'a.xml', method: 0, csize: 1, usize: 1 }), strToU8('a')]);
  const entry = centralEntry({ name: 'a.xml', method: 0, csize: 1, usize: 1, offset: 0 });
  const zip64 = header(56, [[0, 4, 0x06064b50], [4, 8, 44], [12, 2, 45], [14, 2, 45], [24, 8, 2 ** 32 - 2], [32, 8, 2 ** 32 - 2], [40, 8, entry.length], [48, 8, one.length]]);
  const locator = header(20, [[0, 4, 0x07064b50], [8, 8, one.length + entry.length], [16, 4, 1]]);
  const endless = join([one, entry, zip64, locator, directoryEnd({ count: 0xffff, size: entry.length, offset: one.length })]);
  const walked = opened(openEpub, endless);
  check('refused as a book: four billion claimed entries, at once', walked.refused === SAID && walked.took < 1000, `${walked.refused ?? 'opened'}, ${walked.took} ms`);
}

/* ── a part that holds more than it declares (card 529) ──────────────
   A gigabyte of zeros is a megabyte of deflate, at the most deflate packs
   (about 1030 to 1). Compressing a gigabyte takes eight seconds, so the
   check compresses 16 MiB, ended by a sync flush on a byte, and repeats
   that 64 times before an empty last block: each repeat refers back only
   to zeros, so the whole is one valid stream. */

/** A deflate stream that unpacks to `16 MiB × times` zeros. */
function zeros(times) {
  const pieces = [];
  const deflate = new Deflate({ level: 9 }, (chunk) => pieces.push(chunk));
  deflate.push(new Uint8Array(16 * 1024 * 1024), false);
  deflate.flush(true);
  const piece = join(pieces);
  return join([...Array.from({ length: times }, () => piece), new Uint8Array([0x03, 0x00])]);
}
{
  const GiB = 1024 * 1024 * 1024;
  check('the stream built so is deflate, and unpacks to its zeros', (() => {
    const back = inflateSync(zeros(2));
    return back.length === 32 * 1024 * 1024 && back.every((byte) => byte === 0);
  })());
  const bomb = zeros(64);
  const zipOf = (declared) => {
    const local = join([localHeader({ name: 'word/document.xml', method: 8, csize: bomb.length, usize: declared }), bomb]);
    const entry = centralEntry({ name: 'word/document.xml', method: 8, csize: bomb.length, usize: declared, offset: 0 });
    return join([local, entry, directoryEnd({ count: 1, size: entry.length, offset: local.length })]);
  };
  for (const [label, declared] of [['100 bytes', 100], ['a megabyte', 1024 * 1024], ['the most a part may', MOST_PART_BYTES]]) {
    const bytes = zipOf(declared);
    for (const [opener, open, said] of [['an Office file', openArchive, DAMAGED], ['a book', openEpub, BOOK_DAMAGED]]) {
      const got = opened(open, bytes);
      check(
        `refused as ${opener}, at once: ${(bytes.length / 1024 / 1024).toFixed(2)} MiB holding a gigabyte, declaring ${label}`,
        got.refused === said && got.took < 1000,
        `${got.refused ?? 'opened'}, ${got.took} ms`,
      );
    }
  }
  /* An .svgz: a trailer declaring nothing, and two members, the first the
     gigabyte, the last declaring ten bytes. */
  const gzip = (stream, declared) => join([new Uint8Array([31, 139, 8, 0, 0, 0, 0, 0, 0, 255]), stream, header(8, [[4, 4, declared]])]);
  for (const [label, bytes] of [
    ['declaring nothing', gzip(bomb, 0)],
    ['in two members, the last declaring ten bytes', join([gzip(bomb, 0), gzip(deflateSync(new Uint8Array(10)), 10)])],
  ]) {
    const got = opened((b) => unpack(b, 'svgz'), bytes);
    check(`refused: an .svgz holding a gigabyte, ${label}, at once`, got.refused !== undefined && got.took < 1000, `${got.refused ?? 'unpacked'}, ${got.took} ms`);
  }
}

/* ── the review of card 529 ────────────────────────────────────────── */
{
  const BOUNDS = { part: MOST_PART_BYTES, archive: MOST_ARCHIVE_BYTES, parts: MOST_PARTS };
  const varied = (n) => {
    const out = new Uint8Array(n);
    let x = 7;
    for (let i = 0; i < n; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      out[i] = x & 0x0f;
    }
    return out;
  };
  const caught = (run) => {
    try {
      run();
      return 'unpacked';
    } catch (err) {
      return err;
    }
  };

  /* Past the time it is given, unpacking stops, said apart from a size:
     an honest part of many slices, given no time at all. */
  const many = zipSync({ 'big.xml': varied(3 * 1024 * 1024) });
  check('a ZIP past its time is given up, as too slow', caught(() => unzipWithin(many, { ...BOUNDS, seconds: 0 })) instanceof ArchiveTooSlow);
  check('and within it, unpacked', caught(() => unzipWithin(many, BOUNDS)) === 'unpacked');
  const slowSvg = gzipSync(varied(2 * 1024 * 1024));
  check(`a gzip past its time is given up, as too slow (${slowSvg.length} bytes packed)`, caught(() => gunzipWithin(slowSvg, MOST_SVG_BYTES, 0)) instanceof ArchiveTooSlow);

  /* And a ZIP of parts of one slice each: they too are asked of the time,
     after each part. */
  const sliceParts = {};
  for (let i = 0; i < 50; i++) sliceParts[`p${i}.xml`] = strToU8(`<p>${'x'.repeat(i * 37)}</p>`);
  check('a ZIP of one-slice parts past its time is given up, as too slow', caught(() => unzipWithin(zipSync(sliceParts), { ...BOUNDS, seconds: 0 })) instanceof ArchiveTooSlow);

  /* What follows the end of a part's stream is not read: 16 MiB after it
     had taken seconds, copied again at every slice. And an .svgz of two
     members is its first, as fflate reads it. */
  {
    const after = new Uint8Array(16 * 1024 * 1024).fill(0x5a);
    const ended = join([new Uint8Array([0x03, 0x00]), after]);
    const local = join([localHeader({ name: 'a.xml', method: 8, csize: ended.length, usize: 0 }), ended]);
    const entry = centralEntry({ name: 'a.xml', method: 8, csize: ended.length, usize: 0, offset: 0 });
    const got = opened(openArchive, join([local, entry, directoryEnd({ count: 1, size: entry.length, offset: local.length })]));
    check("16 MiB after the end of a part's stream is not read, quickly", !got.refused && got.result['a.xml']?.length === 0 && got.took < 1000, `${got.refused ?? 'opened'}, ${got.took} ms`);
    const svg = strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const two = join([gzipSync(svg), gzipSync(after, { level: 0 })]);
    const back = opened((b) => unpack(b, 'svgz'), two);
    check('an .svgz of two members, the second 16 MiB, is its first, quickly', !back.refused && back.result.length === svg.length && back.took < 1000, `${back.refused ?? 'unpacked'}, ${back.took} ms`);
  }

  /* A stream of one slice, decoded at once, still may not give more than it says. */
  const packedSmall = deflateSync(new Uint8Array(1024 * 1024));
  const oneSlice = join([localHeader({ name: 'a.xml', method: 8, csize: packedSmall.length, usize: 100 }), packedSmall]);
  const oneEntry = centralEntry({ name: 'a.xml', method: 8, csize: packedSmall.length, usize: 100, offset: 0 });
  const lyingSmall = opened(openArchive, join([oneSlice, oneEntry, directoryEnd({ count: 1, size: oneEntry.length, offset: oneSlice.length })]));
  check(`refused: a part of one slice (${packedSmall.length} bytes) declaring 100 bytes of a megabyte, as damaged`, lyingSmall.refused === DAMAGED, lyingSmall.refused ?? 'opened');

  /* A part named __proto__ would be the result's prototype, not a part. */
  const proto = join([localHeader({ name: '__proto__', method: 0, csize: 1, usize: 1 }), strToU8('a')]);
  const protoEntry = centralEntry({ name: '__proto__', method: 0, csize: 1, usize: 1, offset: 0 });
  const protoGot = opened(openArchive, join([proto, protoEntry, directoryEnd({ count: 1, size: protoEntry.length, offset: proto.length })]));
  check('refused: a part named __proto__, as damaged', protoGot.refused === DAMAGED, protoGot.refused ?? 'opened');

  /* A book whose stream is broken says so in the reader's words, not fflate's. */
  const broken = join([localHeader({ name: 'mimetype', method: 8, csize: 4, usize: 100 }), new Uint8Array([0xff, 0xff, 0xff, 0xff])]);
  const brokenEntry = centralEntry({ name: 'mimetype', method: 8, csize: 4, usize: 100, offset: 0 });
  const brokenBook = opened(openEpub, join([broken, brokenEntry, directoryEnd({ count: 1, size: brokenEntry.length, offset: broken.length })]));
  check('a book with a broken stream is said to be damaged, in words a reader reads', brokenBook.refused === BOOK_DAMAGED, brokenBook.refused ?? 'opened');

  /* Ten thousand small parts: each decoded at once, not through a streaming
     decoder of its own (575 ms against fflate's 13, the review measured). */
  const small = {};
  for (let i = 0; i < MOST_PARTS; i++) small[`p${i}.xml`] = strToU8(`<p>${i}</p>`);
  const smallZip = zipSync(small);
  const smallGot = opened(openArchive, smallZip);
  const smallTheirs = unzipSync(smallZip);
  check(
    `ten thousand small parts unpack as fflate unpacks them, quickly`,
    !smallGot.refused && smallGot.took < 300 && Object.keys(smallTheirs).every((name) => smallGot.result[name]?.length === smallTheirs[name].length),
    `${smallGot.refused ?? 'opened'}, ${smallGot.took} ms`,
  );
}

/* ── as fflate unpacks it ──────────────────────────────────────────────
   The walk is the program's own now, so an honest archive must come out of
   it as out of fflate's `unzipSync`, part for part, byte for byte: parts
   of many slices, stored and deflated, names in UTF-8 and not. */
{
  const noise = (n, seed) => {
    const out = new Uint8Array(n);
    let x = seed;
    for (let i = 0; i < n; i++) {
      x = (x * 1103515245 + 12345) >>> 0;
      out[i] = (x >>> 24) & 0x0f; // compressible, but not to nothing
    }
    return out;
  };
  const archives = [
    ['a Word document', makeDocx()],
    ['a book', makeEpub()],
    ['parts of many slices, stored and deflated', zipSync({
      'big.xml': noise(3 * 1024 * 1024, 1),
      'stored.bin': [noise(200_000, 2), { level: 0 }],
      'empty.xml': new Uint8Array(0),
      'mapa/čćžšđ.xml': strToU8('<a>ž</a>'),
      'tiny.xml': strToU8('<b/>'),
    })],
  ];
  /* And a name as Windows' own ZIP writer leaves it: no UTF-8 flag, a byte of its own. */
  {
    const named = zipSync({ 'a.xml': strToU8('<a/>') }).slice();
    const view = new DataView(named.buffer);
    for (let at = 0; at + 4 <= named.length; at++) {
      const signature = view.getUint32(at, true);
      if (signature === 0x04034b50) named[at + 30] = 0xe9;
      if (signature === 0x02014b50) {
        view.setUint16(at + 8, view.getUint16(at + 8, true) & ~2048, true);
        named[at + 46] = 0xe9;
      }
    }
    archives.push(['a name not in UTF-8', named]);
  }
  for (const [label, bytes] of archives) {
    const theirs = unzipSync(bytes);
    const got = opened(openArchive, bytes);
    const ours = got.result ?? {};
    const same =
      !got.refused &&
      JSON.stringify(Object.keys(ours)) === JSON.stringify(Object.keys(theirs)) &&
      Object.keys(theirs).every((name) => ours[name].length === theirs[name].length && ours[name].every((byte, i) => byte === theirs[name][i]));
    check(`unpacked as fflate unpacks it: ${label}`, same, got.refused ?? Object.keys(ours).join(', '));
  }
  /* Where a part's bytes begin is its local record's to say: here it
     carries an extra field the directory's record does not. */
  {
    const body = deflateSync(noise(100_000, 4));
    const local = localHeader({ name: 'a.xml', method: 8, csize: body.length, usize: 100_000 });
    const extra = new Uint8Array(local.length + 8);
    extra.set(local);
    extra.set([0xfe, 0xca, 4, 0, 1, 2, 3, 4], local.length);
    new DataView(extra.buffer).setUint16(28, 8, true);
    const first = join([extra, body]);
    const entry = centralEntry({ name: 'a.xml', method: 8, csize: body.length, usize: 100_000, offset: 0 });
    const bytes = join([first, entry, directoryEnd({ count: 1, size: entry.length, offset: first.length })]);
    const theirs = unzipSync(bytes)['a.xml'];
    const got = opened(openArchive, bytes);
    const ours = got.result?.['a.xml'];
    check('a part begins where its local record says', ours !== undefined && ours.length === theirs.length && ours.every((byte, i) => byte === theirs[i]), got.refused ?? '');
  }
  /* A part running past the end of the file is damaged, not cut to what
     is there: its local record after the directory's end, saying it holds
     a hundred bytes of the ten that follow. */
  {
    const pad = new Uint8Array(300);
    const local = join([localHeader({ name: 'a.xml', method: 0, csize: 100, usize: 100 }), strToU8('0123456789')]);
    const entryLength = centralEntry({ name: 'a.xml', method: 0, csize: 100, usize: 100, offset: 0 }).length;
    const entry = centralEntry({ name: 'a.xml', method: 0, csize: 100, usize: 100, offset: pad.length + entryLength + 22 });
    const bytes = join([pad, entry, directoryEnd({ count: 1, size: entry.length, offset: pad.length }), local]);
    const got = opened(openArchive, bytes);
    check('refused: a part running past the end of the file, as damaged', got.refused === DAMAGED, got.refused ?? `${got.result['a.xml']?.length} bytes`);
  }
  /* A deflated part cut short is damaged, as fflate finds it too. */
  {
    const whole = deflateSync(noise(300_000, 5));
    const body = whole.subarray(0, whole.length >> 1);
    const local = join([localHeader({ name: 'a.xml', method: 8, csize: body.length, usize: 300_000 }), body]);
    const entry = centralEntry({ name: 'a.xml', method: 8, csize: body.length, usize: 300_000, offset: 0 });
    const bytes = join([local, entry, directoryEnd({ count: 1, size: entry.length, offset: local.length })]);
    let theirs = 'opened';
    try {
      unzipSync(bytes);
    } catch {
      theirs = 'refused';
    }
    const got = opened(openArchive, bytes);
    check('a deflated part cut short is refused, as fflate refuses it', theirs === 'refused' && got.refused === DAMAGED, `${theirs}; ${got.refused ?? 'opened'}`);
  }
  /* An .svgz holding more than its trailer says, though well within a drawing's bound. */
  {
    const lying = gzipSync(noise(1024 * 1024, 6));
    new DataView(lying.buffer, lying.byteOffset).setUint32(lying.length - 4, 10, true);
    const got = opened((b) => unpack(b, 'svgz'), lying);
    check('refused: an .svgz holding more than its trailer says', got.refused !== undefined, got.refused ?? `${got.result.length} bytes`);
  }
  const honestSvg = gzipSync(noise(2 * 1024 * 1024, 3));
  const back = opened((b) => unpack(b, 'svgz'), honestSvg);
  const theirs = gunzipSync(honestSvg);
  check('an .svgz of many slices unpacks as fflate unpacks it', !back.refused && back.result.length === theirs.length && back.result.every((byte, i) => byte === theirs[i]), back.refused ?? '');
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
