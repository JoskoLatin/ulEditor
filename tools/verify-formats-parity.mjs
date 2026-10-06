/**
 * Two detectors, one answer.
 *
 * What a file is gets decided twice: in Rust by `ul-formats`, which the
 * desktop uses, and in TypeScript by `host/detect.ts`, which the browser build
 * and a dozen Node checks use. ADR 0002 planned to replace the second with the
 * first built to WebAssembly. Measured first: over 7 618 real files in the
 * Documents folder the two disagreed on none. And the TypeScript one is what
 * `fidelity.mjs`, `verify-doc.mjs` and the rest classify their corpus with —
 * swapping it would make each of them need Rust and `wasm-bindgen` just to
 * start. So both stay, and this is what keeps them one: every specimen below,
 * and any folder named on the command line, through both, and a disagreement
 * fails.
 *
 * The Rust side is the WebAssembly build of `ul-formats`, which is the same
 * `detect` the desktop calls.
 *
 *   node tools/wasm-assets.mjs
 *   node tools/verify-formats-parity.mjs [folder …]
 */

import './ts-resolve.mjs';

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as fixtures from './fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WASM = resolve(ROOT, 'packages/shell-ui/public/wasm');
const PROBE = 64 * 1024;

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}
function finish() {
  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

if (!existsSync(join(WASM, 'ul_formats_bg.wasm'))) {
  check('a built ul-formats to compare against', false, 'none — run `node tools/wasm-assets.mjs` first');
  finish();
}

const { detect } = await import(pathToFileURL(resolve(ROOT, 'packages/shell-ui/src/host/detect.ts')).href);
const glue = await import(pathToFileURL(join(WASM, 'ul_formats.js')).href);
glue.initSync({ module: readFileSync(join(WASM, 'ul_formats_bg.wasm')) });

/** Name and first bytes → both answers, and whether they are the same. */
function compare(name, bytes) {
  const head = bytes.subarray(0, PROBE);
  const ts = detect(name, head);
  const rust = glue.detectFormat(name, head);
  const same = ts.format === rust.format && ts.via === rust.via;
  return { same, line: `${name}: TypeScript ${ts.format}/${ts.via}, Rust ${rust.format}/${rust.via}` };
}

/* ── the specimens ───────────────────────────────────────────────────── */

const bytes = (value) => (value instanceof Uint8Array ? value : new TextEncoder().encode(String(value)));
const specimens = [
  ['dokument.pdf', fixtures.makePdf()],
  ['izvjestaj.docx', fixtures.makeDocx()],
  ['lazni.docx', fixtures.makeFakeDocx()],
  ['tablica.xlsx', fixtures.makeXlsx()],
  ['stara.xls', fixtures.makeXls()],
  ['tablica.ods', fixtures.makeOds()],
  ['tekst.odt', fixtures.makeOdt()],
  ['knjiga.epub', fixtures.makeEpub()],
  ['main.ts', fixtures.TS_SOURCE],
  ['run.bat', fixtures.BAT_SOURCE],
  ['README.md', fixtures.MD_SOURCE],
  // A name that says one thing and bytes that say another: the bytes win.
  ['zapravo-rtf.doc', '{\\rtf1\\ansi Rich Text under a Word name}'],
  ['zapravo-pdf.txt', '%PDF-1.7\n'],
  ['slika.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['slika.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0])],
  ['slika.gif', 'GIF89a'],
  ['slika.bmp', 'BM'],
  ['slika.webp', 'RIFF\0\0\0\0WEBP'],
  ['sken.tif', new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00])],
  ['sken.tiff', new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08])],
  ['bez-imena-tiff', new Uint8Array([0x49, 0x49, 0x2a, 0x00])],
  ['prazno.txt', ''],
  ['bez-nastavka', 'just text'],
  ['nepoznato.xyz', new Uint8Array([0, 1, 2, 3, 0xff])],
];

const differ = [];
for (const [name, content] of specimens) {
  const { same, line } = compare(name, bytes(content));
  if (!same) differ.push(line);
}
check(
  `the two detectors agree on ${specimens.length} specimens`,
  differ.length === 0,
  differ.join(' | ') || 'every one the same',
);

/* ── and any real folder named ───────────────────────────────────────── */

for (const folder of process.argv.slice(2)) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(folder, 0);

  const disagreements = [];
  for (const path of files) {
    let head;
    try {
      const fd = openSync(path, 'r');
      const buffer = Buffer.alloc(PROBE);
      const read = readSync(fd, buffer, 0, PROBE, 0);
      closeSync(fd);
      head = new Uint8Array(buffer.subarray(0, read));
    } catch {
      continue;
    }
    const { same, line } = compare(basename(path), head);
    if (!same) disagreements.push(line);
  }
  check(
    `and on every file in ${folder}`,
    disagreements.length === 0,
    `${files.length} files, ${disagreements.length} disagree${disagreements.length ? `: ${disagreements.slice(0, 5).join(' | ')}` : ''}`,
  );
}

finish();
