/**
 * What formulas are actually in people's spreadsheets.
 *
 * "Recalculate the totals" sounds like a five-hundred-function interpreter and
 * a dependency graph, which is what Univer was in the plan to bring. Before any
 * of that is written, the same rule this project applies everywhere else: a
 * number nobody has measured is an opinion. So this counts what is really
 * there — every `<f>` in every worksheet of a folder of real files, the
 * functions named in them, the shapes of the references, and the two kinds of
 * formula that are written once and stand for many.
 *
 * It **never writes**. Every file is read, unzipped in memory and closed.
 *
 *   node tools/formula-census.mjs "C:/Users/you/Documents"
 *   node tools/formula-census.mjs "C:/Users/you/Documents" --verbose
 *
 * With no folder it runs over the repository's own fixtures and says so: that
 * proves the census still counts, not that anybody's spreadsheets look like it.
 *
 * `.xls` is counted and not scanned. The binary formula stream is a different
 * reader from the one here, and a file skipped in silence is how a census comes
 * to describe only the easy half of its corpus.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unzipSync, strFromU8 } from 'fflate';

import { makeFormulaXlsx, makeXlsx, makeOds } from './fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const folder = argv.find((one) => !one.startsWith('--')) ?? null;

/** Folders nobody keeps their own work in. */
const NOISE = new Set(['node_modules', '.git', 'target', 'dist', '__pycache__', 'site-packages']);

function* walk(dir, depth = 0) {
  if (depth > 6) return;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('~$')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!NOISE.has(entry.name)) yield* walk(path, depth + 1);
    } else {
      yield path;
    }
  }
}

/** Every `<f>` of an OOXML workbook, with the flags that say what kind it is. */
function ooxmlFormulas(bytes) {
  const zip = unzipSync(bytes);
  const found = [];
  for (const [name, part] of Object.entries(zip)) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(name)) continue;
    const xml = strFromU8(part);
    for (const match of xml.matchAll(/<f(\s[^>]*)?(?:\/>|>([\s\S]*?)<\/f>)/g)) {
      const attrs = match[1] ?? '';
      found.push({
        text: (match[2] ?? '').trim(),
        shared: /t="shared"/.test(attrs),
        array: /t="array"/.test(attrs),
        /* A shared formula's dependent carries the `si` and no text of its own:
           one formula standing for a column of them. */
        dependent: /t="shared"/.test(attrs) && (match[2] ?? '').trim() === '',
      });
    }
  }
  return found;
}

/** And of an OpenDocument spreadsheet, where the formula is an attribute. */
function odfFormulas(bytes) {
  const zip = unzipSync(bytes);
  const part = zip['content.xml'];
  if (!part) return [];
  const xml = strFromU8(part);
  return [...xml.matchAll(/table:formula="([^"]*)"/g)].map((match) => ({
    /* `of:=SUM([.A1:.A5])` — the namespace prefix and the brackets are
       OpenDocument's, the function name is the same one Excel writes. */
    text: match[1].replace(/^[a-z]+:=/, '').replace(/\[\.?([^\]]*)\]/g, '$1'),
    shared: false,
    array: false,
    dependent: false,
  }));
}

const XML_ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
const unescape = (text) => text.replace(/&(?:lt|gt|amp|quot|apos);/g, (entity) => XML_ENTITIES[entity]);

/* ── the census ──────────────────────────────────────────────────────── */

const files = [];
/** The fixtures, which are built in memory and never touch the disk. */
const built = folder
  ? []
  : [
      { name: '(fixture) a workbook with formulas', ext: '.xlsx', bytes: makeFormulaXlsx() },
      { name: '(fixture) an ordinary workbook', ext: '.xlsx', bytes: makeXlsx() },
      { name: '(fixture) an OpenDocument sheet', ext: '.ods', bytes: makeOds() },
    ];
if (folder) {
  for (const path of walk(resolve(folder))) {
    const ext = extname(path).toLowerCase();
    if (['.xlsx', '.xlsm', '.ods', '.xls'].includes(ext)) files.push(path);
  }
}

const functions = new Map();
const shapes = new Map();
let formulas = 0;
let shared = 0;
let dependents = 0;
let arrays = 0;
let crossSheet = 0;
let withFormulas = 0;
let scanned = 0;
const unscanned = [];
const broken = [];
const perFile = [];

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

const each = [
  ...files.map((path) => ({ name: path, ext: extname(path).toLowerCase(), bytes: null })),
  ...built,
];

for (const one of each) {
  const { name: path, ext } = one;
  if (ext === '.xls') {
    unscanned.push(path);
    continue;
  }
  let found = [];
  try {
    const bytes = one.bytes ?? new Uint8Array(readFileSync(path));
    found = ext === '.ods' ? odfFormulas(bytes) : ooxmlFormulas(bytes);
    scanned++;
  } catch (error) {
    broken.push(`${path} — ${String(error.message).split('\n')[0]}`);
    continue;
  }

  if (found.length > 0) withFormulas++;
  perFile.push({ path, count: found.length });

  for (const one of found) {
    formulas++;
    if (one.shared) shared++;
    if (one.dependent) dependents++;
    if (one.array) arrays++;
    const text = unescape(one.text);
    if (text === '') continue;

    /* A name followed by an open bracket is a call; a bare `A1+B1` names none,
       which is itself one of the answers being looked for. */
    const names = [...text.matchAll(/\b([A-Z][A-Z0-9._]*)\s*\(/g)].map((match) => match[1]);
    if (names.length === 0) bump(functions, '(no function — arithmetic only)');
    for (const name of new Set(names)) bump(functions, name);

    if (/(?:'[^']+'|[A-Za-z_][A-Za-z0-9_.]*)!/.test(text)) crossSheet++;

    /* The shape of what it reaches, which decides how much of a dependency
       graph is needed rather than which functions are. */
    if (/\$?[A-Z]{1,3}\$?\d+:\$?[A-Z]{1,3}\$?\d+/.test(text)) bump(shapes, 'a range (A1:A9)');
    else if (/\$?[A-Z]{1,3}\$?\d+/.test(text)) bump(shapes, 'single cells only');
    else bump(shapes, 'no reference at all');
  }
}

const sorted = (map) => [...map].sort((a, b) => b[1] - a[1]);

console.log(folder ? `Over ${resolve(folder)}` : 'Over the repository fixtures — which proves the census, not the corpus');
console.log(
  `\n${each.length} spreadsheets found · ${scanned} scanned · ${withFormulas} of those hold a formula · ${formulas} formulas in all`,
);
if (unscanned.length > 0) {
  console.log(`${unscanned.length} .xls counted and NOT scanned — the binary formula stream is a different reader`);
}
if (broken.length > 0) {
  console.log(`${broken.length} could not be read:`);
  for (const one of broken.slice(0, 5)) console.log(`  · ${one}`);
}

if (formulas > 0) {
  console.log('\nFunctions, by how many formulas name them:');
  for (const [name, count] of sorted(functions)) {
    const share = ((count / formulas) * 100).toFixed(1);
    console.log(`  ${String(count).padStart(6)}  ${share.padStart(5)}%  ${name}`);
  }

  console.log('\nWhat they reach:');
  for (const [shape, count] of sorted(shapes)) {
    console.log(`  ${String(count).padStart(6)}  ${((count / formulas) * 100).toFixed(1).padStart(5)}%  ${shape}`);
  }

  console.log('\nWritten once and standing for many:');
  console.log(`  ${String(shared).padStart(6)}  shared (${dependents} of them dependents carrying only an si)`);
  console.log(`  ${String(arrays).padStart(6)}  array`);
  console.log(`  ${String(crossSheet).padStart(6)}  reach another sheet by name`);
}

if (verbose) {
  console.log('\nPer file, most formulas first:');
  for (const one of perFile.sort((a, b) => b.count - a.count).slice(0, 25)) {
    console.log(`  ${String(one.count).padStart(6)}  ${one.path}`);
  }
}
