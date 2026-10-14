/**
 * The program's own ZIP walk against fflate's, over real files (card 529).
 *
 * `unzipWithin` (`@uleditor/archive`) walks a ZIP's directory itself, so it
 * can give up a part that unpacks to more than it says; an honest archive
 * must still come out of it as out of fflate's `unzipSync`, part for part,
 * byte for byte. The fixtures in verify-archive-limits ask that of a few
 * archives built here; this asks it of every Office file, book and `.svgz`
 * under a folder — the documents of the corpus, which stay where they are
 * and are only read. Run it again when fflate is updated.
 *
 *   node tools/verify-archive-corpus.mjs C:\Users\…\Documents
 *
 * Prints how many came out the same, which were refused and by whom, and
 * the time against fflate's (measured 13.10.: 102 the same, none different,
 * 1.45 times fflate's time).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync, gunzipSync } from 'fflate';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { unzipWithin, gunzipWithin } = await import(pathToFileURL(resolve(ROOT, 'packages/archive/src/index.ts')).href);
const BOUNDS = { part: 64 * 1024 * 1024, archive: 128 * 1024 * 1024, parts: 10_000 };
const ZIPPED = new Set(['.docx', '.docm', '.dotx', '.xlsx', '.xlsm', '.pptx', '.odt', '.ods', '.odp', '.odg', '.epub', '.cdr', '.zip']);

const folder = process.argv[2];
if (!folder) {
  console.error('Usage: node tools/verify-archive-corpus.mjs <folder>');
  process.exit(2);
}

const files = [];
(function walk(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    const extension = extname(name).toLowerCase();
    if (stat.isDirectory()) {
      if (!name.startsWith('.') && name !== 'node_modules') walk(path);
    } else if (ZIPPED.has(extension) || extension === '.svgz') files.push(path);
  }
})(folder);

const attempt = (open) => {
  const started = performance.now();
  try {
    return { files: open(), took: performance.now() - started };
  } catch (err) {
    return { refused: `${err.constructor.name}: ${err.message}` };
  }
};

let same = 0;
let fflateTime = 0;
let ownTime = 0;
const different = [];
const refused = [];
for (const path of files) {
  const bytes = new Uint8Array(readFileSync(path));
  const gzipped = extname(path).toLowerCase() === '.svgz';
  const theirs = attempt(() => (gzipped ? { svg: gunzipSync(bytes) } : unzipSync(bytes)));
  const ours = attempt(() => (gzipped ? { svg: gunzipWithin(bytes, 64 * 1024 * 1024) } : unzipWithin(bytes, BOUNDS)));
  if (theirs.refused || ours.refused) {
    refused.push(`${path}\n    fflate: ${theirs.refused ?? 'opened'}\n    ours:   ${ours.refused ?? 'opened'}`);
    continue;
  }
  fflateTime += theirs.took;
  ownTime += ours.took;
  const names = Object.keys(theirs.files);
  const equal =
    JSON.stringify(names) === JSON.stringify(Object.keys(ours.files)) &&
    names.every((name) => Buffer.compare(Buffer.from(theirs.files[name]), Buffer.from(ours.files[name])) === 0);
  if (equal) same += 1;
  else different.push(path);
}

console.log(`${files.length} files: ${same} the same, ${different.length} different, ${refused.length} refused by one or both`);
console.log(`time: fflate ${fflateTime.toFixed(0)} ms, ours ${ownTime.toFixed(0)} ms (${(ownTime / fflateTime).toFixed(2)} times)`);
for (const path of different) console.log(`DIFFERENT  ${path}`);
for (const line of refused) console.log(`refused    ${line}`);
process.exit(different.length === 0 ? 0 : 1);
