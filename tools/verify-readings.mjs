/**
 * A tab's scope keeps its readings, and lends them to nobody (ADR 0006).
 *
 * The core compares a save with the reading it continues, found by a token
 * the page never shows an editor: `host/document-scope.ts` adds it to what a
 * tab reads and writes. What can be wrong here is which writes carry which
 * token — and none of that needs a window. So the scope is driven with a
 * file system that writes down what it was asked:
 *
 * - the tab's document is read once, as a reading, and its save carries it;
 * - a path it never read is written with none and begins one, and the next
 *   write of that path carries the one it got;
 * - another tab writing the first one's document sends no reading — nor
 *   does the same path in other letters;
 * - the image editor's look at its document after a save carries the
 *   reading that save made;
 * - closing forgets the tab's readings and nobody else's;
 * - where the file system keeps no readings (the web), the scope is the
 *   host itself.
 *
 * And the token in front of a document's bytes is read as Rust writes it —
 * the same vector as `a_reading_crosses_in_front_of_its_bytes` in lib.rs.
 *
 *   node tools/verify-readings.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = (path) => import(pathToFileURL(resolve(ROOT, path)).href);

const { documentScope } = await load('packages/shell-ui/src/host/document-scope.ts');
const { unframe } = await load('packages/shell-ui/src/host/tauri-fs.ts');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/** A core that hands out tokens and writes down every call. */
function fakeCore() {
  let next = 100;
  const calls = [];
  const fs = {
    calls,
    async readDocument(uri, reading) {
      calls.push({ op: 'read', uri, reading });
      return { reading: reading ?? ++next, bytes: new TextEncoder().encode(`content of ${uri}`) };
    },
    async writeDocument(uri, _data, _opts, reading, begin) {
      calls.push({ op: 'write', uri, reading, begin });
      if (reading !== undefined) return reading;
      return begin ? ++next : null;
    },
    async forgetReadings(readings) {
      calls.push({ op: 'forget', readings: [...readings].sort() });
    },
    async readBytes(uri) {
      calls.push({ op: 'plain-read', uri });
      return new Uint8Array();
    },
    async writeBytes() {
      throw new Error('a write went past the scope');
    },
  };
  const images = {
    async info(source) {
      calls.push({ op: 'look', uri: source });
      return { width: 1, height: 1 };
    },
    async infoDocument(source, reading) {
      const made = reading ?? ++next;
      calls.push({ op: 'info', uri: source, reading, made });
      return { info: { width: 1, height: 1 }, reading: made };
    },
    async writeDocument(_source, target, _ops, _options, reading, begin) {
      calls.push({ op: 'image-write', uri: target, reading, begin });
      return { written: { width: 1, height: 1 }, reading: reading ?? (begin ? ++next : null) };
    },
    available: () => true,
  };
  return { fs, images, calls };
}

const doc = (uri) => ({
  uri,
  name: uri.split('/').pop(),
  stat: { uri, readonly: false },
  detection: {},
  bytes: async () => {
    throw new Error("the tab read the shell's handle, not its own");
  },
});

const core = fakeCore();
const host = { fs: core.fs, images: core.images, commands: {} };
const last = (op) => [...core.calls].reverse().find((c) => c.op === op);

/* ── a tab, its document ────────────────────────────────────────────── */

const tab = documentScope(host, doc('C:/d/notes.md'));
await tab.doc.bytes();
await tab.doc.text();
const reads = core.calls.filter((c) => c.op === 'read');
check('the tab reads its document once, as a reading', reads.length === 1 && reads[0].reading === undefined);
const mine = 101;
await tab.host.fs.writeText('C:/d/notes.md', 'edited');
check(
  'and its save carries that reading',
  last('write')?.reading === mine && last('write')?.begin === false,
  JSON.stringify(last('write')),
);

/* ── a path it never read ──────────────────────────────────────────── */

await tab.host.fs.writeBytes('C:/d/notes.pdf', new Uint8Array([1]));
const begun = last('write');
check('a path it never read is written with none, and begins one', begun.reading === undefined && begun.begin === true);
await tab.host.fs.writeBytes('C:/d/notes.pdf', new Uint8Array([2]));
check('and its next write carries the one it got', last('write').reading === 102, JSON.stringify(last('write')));

/* ── nobody else's ─────────────────────────────────────────────────── */

const other = documentScope(host, doc('C:/d/other.md'));
await other.host.fs.writeText('C:/d/notes.md', 'an export over the first tab');
check(
  "another tab writing the first one's document sends no reading",
  last('write').reading === undefined,
  JSON.stringify(last('write')),
);
await tab.host.fs.writeText('C:/d/NOTES.md', 'other letters');
check(
  'nor does the same path in other letters, from the tab itself',
  last('write').reading === undefined && last('write').begin === true,
);

/* ── the image editor's look after a save ──────────────────────────── */

const picture = documentScope(host, doc('C:/d/slika.png'));
await picture.host.images.info('C:/d/slika.png');
const first = last('info');
await picture.host.images.write('C:/d/slika.png', 'C:/d/slika.png', {});
check(
  "the image editor's look at its document is a reading",
  first.reading === undefined && first.made !== undefined,
);
check(
  'and its save carries it',
  last('image-write').reading === first.made && last('image-write').begin === false,
  JSON.stringify(last('image-write')),
);
await picture.host.images.info('C:/d/slika.png');
check('and the look after it, the same reading', last('info').reading === last('image-write').reading, JSON.stringify(last('info')));
await picture.host.images.info('C:/d/elsewhere.png');
check('a picture it never read or wrote is only looked at', last('look')?.uri === 'C:/d/elsewhere.png');

/* ── closing ───────────────────────────────────────────────────────── */

const before = core.calls.length;
await tab.release();
const forgot = core.calls.slice(before).filter((c) => c.op === 'forget');
check(
  "closing forgets the tab's readings, and nobody else's",
  forgot.length === 1 && JSON.stringify(forgot[0].readings) === JSON.stringify([101, 102, 104]),
  JSON.stringify(forgot),
);

/* ── the web ───────────────────────────────────────────────────────── */

const web = { fs: { readBytes: async () => new Uint8Array() }, images: {} };
const plain = doc('notes.md');
const scope = documentScope(web, plain);
check('where the file system keeps no readings, the scope is the host itself', scope.host === web && scope.doc === plain);

/* ── the token in front of the bytes ───────────────────────────────── */

const framed = unframe(new Uint8Array([0x06, 0x05, 0x04, 0x03, 0x02, 0x01, 0x00, 0x00, 0x64, 0x6f, 0x63]));
check(
  'the token in front of a document is read as Rust writes it',
  framed.reading === 0x010203040506 && new TextDecoder().decode(framed.bytes) === 'doc',
  `${framed.reading}`,
);
let short = false;
try {
  unframe(new Uint8Array([1, 2, 3]));
} catch {
  short = true;
}
check('and a document with no token in front is refused', short);

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
