/**
 * The fidelity harness — run over a folder of **real** documents.
 *
 * The plan asked for a different instrument: open every document, save it,
 * render both to PDF and pixel-diff the pages. That measures a program which
 * re-lays-out what it opened, and this one does not. Nothing here re-serialises
 * an XML tree or reflows a page. A `.docx`, an `.xlsx` and an `.ods` are edited
 * **by byte range**: one part of the archive is rewritten, inside it exactly the
 * elements the person retyped, and every other byte in the file is carried
 * across untouched. Rendering that to PDF and comparing pictures would answer a
 * question nobody asked while leaving the real one — *did anything else move?* —
 * measured only by eye.
 *
 * So this measures the promise the program actually makes:
 *
 * - **every other part of the archive comes back byte for byte**, and the one
 *   part that changed differs only in the ranges that were rewritten;
 * - **the file reopens**, and what was written reads back;
 * - **the shape survives** — the run count for Word, the grid geometry and the
 *   formula cells for a spreadsheet — because the save path re-scans the file it
 *   just wrote and would quietly corrupt the next save if the ordinals moved;
 * - for the read-only formats, **nothing arrives as mojibake**: no replacement
 *   characters, no stray control codes.
 *
 * Why a corpus and not fixtures: fixtures are written by the same person who
 * wrote the reader, so they hold the file that person imagined. Running the
 * `.doc` reader over one folder of real documents found two things twenty-eight
 * hand-built checks could not — bold that Word stores as a difference from the
 * style rather than as a fact, and a file whose name was simply a lie.
 *
 * **It never writes to the corpus.** Every edit is made in memory, against a
 * copy, and thrown away. Point it at anything.
 *
 *   node tools/fidelity.mjs "C:/Users/you/Documents"
 *   pnpm fidelity -- "C:/Users/you/Documents" --verbose
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = (path) => import(pathToFileURL(resolve(ROOT, path)).href);

const { detect } = await load('packages/shell-ui/src/host/detect.ts');
const { openArchive, readText } = await load('packages/editor-office/src/ooxml.ts');
const { findRuns, applyRunEdits, runText, writeDocx, escapeXml } = await load(
  'packages/editor-office/src/docx-edit.ts',
);
const { findCells, applyCellEdits, cellXml, writeXlsx } = await load(
  'packages/editor-office/src/xlsx-edit.ts',
);
const { findOdsCells, applyOdsEdits, writeOds } = await load('packages/editor-office/src/ods-edit.ts');
const { readXls } = await load('packages/editor-office/src/xls.ts');
const { parseDoc } = await load('packages/editor-office/src/doc.ts');

/* ── the run ─────────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const roots = args.filter((a) => !a.startsWith('--'));


/** What the harness knows how to measure. Anything else is not walked at all. */
const WANTED = new Set(['.docx', '.xlsx', '.ods', '.xls', '.doc', '.odt', '.rtf']);

/** Folders that hold other people's files rather than the user's documents. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'venv', '__pycache__']);

function* walk(dir, depth = 0) {
  if (depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      yield* walk(path, depth + 1);
    } else if (WANTED.has(extname(entry.name).toLowerCase()) && !entry.name.startsWith('~$')) {
      /* `~$Ugovor.docx` is the owner file Word keeps beside an open document —
         a hundred and sixty bytes holding whoever has it open, under the same
         extension as the real thing. It is not a document and never was, and
         the program itself now leaves it out of the tree and the library. */
      yield path;
    }
  }
}

/* ── the shared assertions ───────────────────────────────────────────── */

const sameBytes = (a, b) => !!a && !!b && a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Every part of the archive except the named ones comes back byte for byte.
 *
 * This is the assertion the whole editing model rests on. A `.docx` holds
 * styles, numbering, images, headers, metadata and relationship maps that this
 * program does not understand and must not touch; the way to keep a promise
 * about them is to compare the bytes, not to trust that nothing wrote to them.
 */
function partsSurvive(before, after, allowed) {
  const missing = [];
  const changed = [];
  for (const path of Object.keys(before)) {
    if (allowed.includes(path)) continue;
    if (!(path in after)) missing.push(path);
    else if (!sameBytes(before[path], after[path])) changed.push(path);
  }
  const added = Object.keys(after).filter((path) => !(path in before));
  return { ok: missing.length === 0 && changed.length === 0 && added.length === 0, missing, changed, added };
}

/**
 * The rewritten part differs from the original **only** where it was meant to.
 *
 * The replacements are known exactly — the editors rebuild whole elements — so
 * this walks the gaps between them and compares each one character for
 * character, then checks the tail. A single space added outside a replaced
 * element fails it.
 */
function onlyTheRangesMoved(before, after, replacements) {
  let a = 0;
  let b = 0;
  for (const range of [...replacements].sort((x, y) => x.start - y.start)) {
    const gap = range.start - a;
    if (before.slice(a, range.start) !== after.slice(b, b + gap)) {
      return { ok: false, at: a, why: 'the text before a rewritten element changed' };
    }
    b += gap;
    if (after.slice(b, b + range.insert.length) !== range.insert) {
      return { ok: false, at: range.start, why: 'the rewritten element is not what was asked for' };
    }
    b += range.insert.length;
    a = range.end;
  }
  if (before.slice(a) !== after.slice(b)) {
    return { ok: false, at: a, why: 'the text after the last rewritten element changed' };
  }
  return { ok: true };
}

const MARKER = 'ulEditor fidelity';

/* ── Word ────────────────────────────────────────────────────────────── */

function checkDocx(bytes) {
  const archive = openArchive(bytes);
  const xml = readText(archive, 'word/document.xml');
  if (xml === null) return { skip: 'no word/document.xml' };

  const runs = findRuns(xml);
  const editable = runs.filter((run) => run.text && !run.refusal && runText(xml, run).trim().length > 0);
  if (editable.length === 0) return { skip: 'nothing in it can be rewritten' };

  /* Spread across the document rather than the first three: a fault in the
     offset arithmetic shows up at the end of a long file, not at its start. */
  const picked = [editable[0], editable[Math.floor(editable.length / 2)], editable[editable.length - 1]]
    .filter((run, i, all) => all.indexOf(run) === i)
    .slice(0, 3);

  const edits = picked.map((run, i) => ({ index: run.index, text: `${MARKER} ${i}` }));
  const next = applyRunEdits(xml, runs, edits);

  const replacements = picked.map((run, i) => ({
    start: run.text.start,
    end: run.text.end,
    insert: `<w:t xml:space="preserve">${escapeXml(`${MARKER} ${i}`)}</w:t>`,
  }));
  const ranges = onlyTheRangesMoved(xml, next, replacements);
  if (!ranges.ok) return { fail: `${ranges.why} (near ${ranges.at})` };

  const written = writeDocx(archive, runs, xml, edits);
  const reopened = openArchive(written);

  const parts = partsSurvive(archive, reopened, ['word/document.xml']);
  if (!parts.ok) {
    return { fail: `parts changed: ${[...parts.changed, ...parts.missing, ...parts.added].slice(0, 3).join(', ')}` };
  }

  const back = readText(reopened, 'word/document.xml');
  if (back !== next) return { fail: 'the part written is not the part read back' };

  /*
   * The save path re-scans the document it just wrote and keeps editing against
   * the new ordinals. If a rewrite could add or drop a run, the next save would
   * put the next edit in the wrong piece of text — silently.
   */
  const after = findRuns(back);
  if (after.length !== runs.length) {
    return { fail: `the run count moved: ${runs.length} → ${after.length}` };
  }
  for (let i = 0; i < after.length; i++) {
    const edited = edits.find((edit) => edit.index === after[i].index);
    if (edited) continue;
    if (runText(back, after[i]) !== runText(xml, runs[i])) {
      return { fail: `run ${i} changed and was never edited` };
    }
  }

  return {
    ok: `${edits.length} edits · ${Object.keys(archive).length - 1} parts intact · runs ${runs.length}`,
  };
}

/* ── Excel ───────────────────────────────────────────────────────────── */

function checkXlsx(bytes) {
  const archive = openArchive(bytes);
  const sheets = Object.keys(archive).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path)).sort();
  if (sheets.length === 0) return { skip: 'no worksheets' };

  /* The first sheet that holds something, not the first sheet by name. A
     workbook exported from a till system routinely has an empty `sheet1` and
     ten thousand rows on `sheet2`, and taking the first would report the file
     as having nothing to edit while leaving its real content unmeasured. */
  let path = null;
  let xml = null;
  let spans = null;
  let cells = [];
  for (const candidate of sheets) {
    const text = readText(archive, candidate);
    if (text === null) continue;
    const found = findCells(text);
    const editable = found.rows.flatMap((row) => row.cells).filter((cell) => !cell.formula);
    if (editable.length === 0) continue;
    path = candidate;
    xml = text;
    spans = found;
    cells = editable;
    break;
  }
  if (path === null) return { skip: 'no cell can be retyped' };

  const picked = [cells[0], cells[Math.floor(cells.length / 2)], cells[cells.length - 1]]
    .filter((cell, i, all) => all.indexOf(cell) === i)
    .slice(0, 3);

  const edits = picked.map((cell, i) => ({ ref: cell.ref, value: String(1000 + i) }));
  const next = applyCellEdits(xml, spans, edits);

  const replacements = picked.map((cell, i) => ({
    start: cell.start,
    end: cell.end,
    insert: cellXml(cell.ref, cell.style, String(1000 + i)),
  }));
  const ranges = onlyTheRangesMoved(xml, next, replacements);
  if (!ranges.ok) return { fail: `${ranges.why} (near ${ranges.at})` };

  /* A formula cell is refused rather than overwritten: the number it shows is a
     result, and a literal in its place looks right until the next recalculation. */
  const formula = spans.rows.flatMap((row) => row.cells).find((cell) => cell.formula);
  if (formula && applyCellEdits(xml, spans, [{ ref: formula.ref, value: '0' }]) !== xml) {
    return { fail: `a formula cell (${formula.ref}) was overwritten` };
  }

  const written = writeXlsx(archive, new Map([[path, next]]));
  const reopened = openArchive(written);

  const parts = partsSurvive(archive, reopened, [path, 'xl/workbook.xml']);
  if (!parts.ok) {
    return { fail: `parts changed: ${[...parts.changed, ...parts.missing, ...parts.added].slice(0, 3).join(', ')}` };
  }

  /* The workbook part is allowed to change for exactly one reason, and only
     when there is a reason: an edited input leaves every cached formula result
     stale, and Excel trusts the cache unless the file says otherwise. */
  const hasFormula = sheets.some((sheet) => /<f[\s>]/.test(readText(archive, sheet) ?? ''));
  const workbookBefore = readText(archive, 'xl/workbook.xml') ?? '';
  const workbookAfter = readText(reopened, 'xl/workbook.xml') ?? '';
  const marked = /fullCalcOnLoad="1"/.test(workbookAfter);
  if (hasFormula && !marked) return { fail: 'the workbook holds formulas and was not marked for recalculation' };
  if (!hasFormula && workbookAfter !== workbookBefore) {
    return { fail: 'the workbook part changed with no formula to go stale' };
  }

  if (readText(reopened, path) !== next) return { fail: 'the sheet written is not the sheet read back' };

  return {
    ok:
      `${edits.length} edits · ${Object.keys(archive).length - (hasFormula ? 2 : 1)} parts intact` +
      (hasFormula ? ' · recalc marked' : ''),
  };
}

/* ── OpenDocument spreadsheet ────────────────────────────────────────── */

/**
 * The geometry of the grid, as a string.
 *
 * ODF has no cell addresses. A position is wherever the counting has reached,
 * and the counting runs through repeat attributes — so an edit means splitting a
 * repeated group, and the way that goes wrong is that the counts either side no
 * longer add up to what the group stood for. Every cell after it then sits one
 * column to the left for the rest of the file, which no byte comparison would
 * notice and no reader would complain about.
 */
function geometry(tables) {
  return tables
    .map((table) => {
      const rows = table.rows
        .map((row) => `${row.repeat}:${row.cells.reduce((n, cell) => n + cell.repeat, 0)}`)
        .join(',');
      return `${table.name}[${rows}]`;
    })
    .join('|');
}

function formulaCells(tables) {
  return tables
    .flatMap((table) =>
      table.rows.flatMap((row) =>
        row.cells.filter((cell) => cell.formula).map((cell) => `${table.name}!${row.row},${cell.col}`),
      ),
    )
    .join('|');
}

function checkOds(bytes) {
  const archive = openArchive(bytes);
  const xml = readText(archive, 'content.xml');
  if (xml === null) return { skip: 'no content.xml' };

  const tables = findOdsCells(xml);
  const edits = [];
  for (const [sheet, table] of tables.entries()) {
    for (const row of table.rows) {
      for (const cell of row.cells) {
        if (cell.formula || cell.covered || edits.length >= 3) continue;
        edits.push({ sheet, row: row.row, col: cell.col, value: `${1000 + edits.length}` });
      }
    }
  }
  if (edits.length === 0) return { skip: 'no cell can be retyped' };

  const next = applyOdsEdits(xml, edits);
  const after = findOdsCells(next);

  if (geometry(tables) !== geometry(after)) {
    return { fail: 'the grid geometry moved — a repeated group was split wrongly' };
  }
  if (formulaCells(tables) !== formulaCells(after)) return { fail: 'a formula cell moved or vanished' };

  const written = writeOds(archive, next);
  const reopened = openArchive(written);

  const parts = partsSurvive(archive, reopened, ['content.xml']);
  if (!parts.ok) {
    return { fail: `parts changed: ${[...parts.changed, ...parts.missing, ...parts.added].slice(0, 3).join(', ')}` };
  }

  /*
   * `mimetype` has to come back **first and uncompressed**, because that is what
   * lets any program say what the file is by reading its opening bytes. An
   * archive that stores it like any other entry is a file every other office
   * suite opens and ours does not.
   */
  const head = new TextDecoder('latin1').decode(written.subarray(0, 64));
  const stored = written[8] === 0 && written[9] === 0;
  if (!head.startsWith('PK\u0003\u0004') || !head.includes('mimetype') || !stored) {
    return { fail: 'mimetype is not the first, uncompressed entry' };
  }

  if (readText(reopened, 'content.xml') !== next) return { fail: 'the part written is not the part read back' };

  return { ok: `${edits.length} edits · ${Object.keys(archive).length - 1} parts intact · geometry held` };
}

/* ── the read-only formats ───────────────────────────────────────────── */

/**
 * What a reader must never produce.
 *
 * A replacement character or a stray control code in the text means an encoding
 * was read under the wrong rules, and it is the one failure a person cannot
 * work around: the document opens, it looks finished, and the words are wrong.
 */
function junkIn(text) {
  return (text.match(/[\uFFFD\u0001-\u0008\u000B\u000E-\u001F]/g) ?? []).length;
}

const diacriticsIn = (text) => (text.match(/[čćžšđČĆŽŠĐ]/g) ?? []).length;

function checkXls(bytes) {
  const book = readXls(bytes);
  let cells = 0;
  let text = '';
  for (const sheet of book.sheets) {
    for (const cell of sheet.cells.values()) {
      cells++;
      if (text.length < 200000) text += `${cell.text}\n`;
    }
  }
  const junk = junkIn(text);
  if (junk > 0) return { fail: `${junk} characters came back as mojibake` };
  return { ok: `read-only · ${book.sheets.length} sheets · ${cells} cells · ${diacriticsIn(text)} diacritics` };
}

function checkDoc(bytes) {
  const { paragraphs } = parseDoc(bytes);
  const text = paragraphs.map((para) => para.runs.map((run) => run.text).join('')).join('\n');
  const junk = junkIn(text);
  if (junk > 0) return { fail: `${junk} characters came back as mojibake` };
  const bold = paragraphs.reduce((n, para) => n + para.runs.filter((run) => run.chp.bold).length, 0);
  return {
    ok: `read-only · ${paragraphs.length} paragraphs · ${diacriticsIn(text)} diacritics · ${bold} bold`,
  };
}

/* ── walking the corpus ──────────────────────────────────────────────── */

const CHECKS = { docx: checkDocx, xlsx: checkXlsx, ods: checkOds, xls: checkXls, doc: checkDoc };

/* Readers whose output is a page of elements rather than a structure. They are
   checked in verify-ui.mjs, in a browser, because that is where a DOM exists. */
const NEEDS_A_BROWSER = new Set(['odt']);

/**
 * What to measure: a real folder if one was named, and otherwise the fixtures.
 *
 * The fixture run is not a substitute and does not pretend to be. It proves the
 * harness itself still works — that nothing here rotted while the readers moved
 * on — so it can sit in `pnpm check`, where a corpus cannot: real documents are
 * somebody's, and they do not belong in a repository.
 */
async function corpus() {
  if (roots.length > 0) {
    const files = [...new Set(roots.flatMap((root) => [...walk(resolve(root))]))].sort();
    return files.map((file) => ({ file, name: file.split(/[\\\\/]/).pop() }));
  }

  console.log('No folder named, so the fixtures stand in. This proves the harness works,');
  console.log('not that the readers do — for that, point it at a folder of real documents:');
  console.log('  node tools/fidelity.mjs "C:/Users/you/Documents"');
  console.log('');

  const made = await import('./fixtures.mjs');
  return [
    { name: 'ugovor.docx', bytes: made.makeDocx() },
    { name: 'prodaja.xlsx', bytes: made.makeXlsx() },
    { name: 'prodaja.ods', bytes: made.makeOds() },
    { name: 'promet.xls', bytes: made.makeXls() },
    { name: 'zapisnik.doc', bytes: made.makeDoc() },
    { name: 'izvjestaj.odt', bytes: made.makeOdt() },
  ];
}

const results = [];
const sources = await corpus();

for (const source of sources) {
  const { file, name } = source;
  let bytes = source.bytes;
  try {
    if (!bytes) bytes = new Uint8Array(readFileSync(file));
  } catch (error) {
    results.push({ file, name, format: '?', state: 'fail', detail: `unreadable: ${error.message}` });
    continue;
  }

  /* Routed by the program's own detection, so the harness measures where a file
     would really go — not where its name suggests. */
  const { format } = detect(name, bytes.subarray(0, 65536));

  if (NEEDS_A_BROWSER.has(format)) {
    results.push({ file, name, format, state: 'skip', detail: 'its reader needs a browser' });
    continue;
  }

  const check = CHECKS[format];
  if (!check) {
    results.push({ file, name, format, state: 'skip', detail: 'no editor claims this format yet' });
    continue;
  }

  try {
    const outcome = check(bytes);
    if (outcome.fail) results.push({ file, name, format, state: 'fail', detail: outcome.fail });
    else if (outcome.skip) results.push({ file, name, format, state: 'skip', detail: outcome.skip });
    else results.push({ file, name, format, state: 'ok', detail: outcome.ok });
  } catch (error) {
    results.push({ file, name, format, state: 'fail', detail: `threw: ${error.message}` });
  }
}

/* ── the report ──────────────────────────────────────────────────────── */

for (const result of results) {
  if (result.state === 'skip' && !verbose) continue;
  const mark = result.state === 'ok' ? '  ok  ' : result.state === 'fail' ? ' FAIL ' : ' skip ';
  console.log(`[${mark}] ${result.format.padEnd(4)} ${result.detail.padEnd(52)} ${result.name}`);
}

const byFormat = new Map();
for (const result of results) {
  const row = byFormat.get(result.format) ?? { ok: 0, fail: 0, skip: 0 };
  row[result.state]++;
  byFormat.set(result.format, row);
}

console.log('');
for (const [format, row] of [...byFormat].sort()) {
  console.log(`  ${format.padEnd(6)} ${String(row.ok).padStart(4)} ok  ${String(row.fail).padStart(3)} failed  ${String(row.skip).padStart(3)} skipped`);
}

const failed = results.filter((result) => result.state === 'fail');
const checked = results.filter((result) => result.state === 'ok').length;
console.log(`\n${checked}/${checked + failed.length} documents kept their fidelity · ${sources.length} files walked`);

if (failed.length > 0) {
  console.log('\nWhat went wrong:');
  for (const result of failed) console.log(`  ${result.name}\n    ${result.detail}`);
}

process.exit(failed.length === 0 ? 0 : 1);
