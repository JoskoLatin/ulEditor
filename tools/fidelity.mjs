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
import { createRequire } from 'node:module';
import { PDFDocument, PDFArray, PDFName, PDFRawStream } from 'pdf-lib';
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
const { parseRtf } = await load('packages/editor-office/src/rtf.ts');
const { saveDocument } = await load('packages/editor-pdf/src/document.ts');
const { applyRedactions } = await load('packages/editor-pdf/src/redact.ts');
const { pageContentOrNothing, textOf, boundsOfOperation } = await load(
  'packages/editor-pdf/src/content.ts',
);
const { standardWidths } = await load('packages/editor-pdf/src/text.ts');

/*
 * The metrics of the fourteen fonts a PDF may name without embedding. Redaction
 * needs them to know how wide a removed glyph was, and refuses a page it cannot
 * measure — so a harness that left them out would report the whole corpus as
 * refused and prove nothing. They are passed here exactly as the editor's own
 * save path passes them.
 */
const requireFrom = createRequire(resolve(ROOT, 'packages/editor-pdf/package.json'));
const STANDARD_FACES = {
  sans: 'LiberationSans-Regular.ttf',
  'sans-bold': 'LiberationSans-Bold.ttf',
  'sans-italic': 'LiberationSans-Italic.ttf',
};
const standard = await standardWidths(async (face) =>
  new Uint8Array(readFileSync(requireFrom.resolve(`pdfjs-dist/standard_fonts/${STANDARD_FACES[face]}`))),
);

/* ── the run ─────────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const roots = args.filter((a) => !a.startsWith('--'));


/** What the harness knows how to measure. Anything else is not walked at all. */
const WANTED = new Set(['.docx', '.xlsx', '.ods', '.xls', '.doc', '.odt', '.rtf', '.pdf']);

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

  /*
   * And the value is in the cell it was meant for.
   *
   * This is the assertion ODF exists to be given. A cell there has no address:
   * its position is wherever the counting has reached, and the counting runs
   * through repeat attributes, so writing into one means splitting a repeated
   * group. Split it a column short and the value lands one cell to the left —
   * geometry that still adds up, an archive whose other parts are untouched, a
   * file that opens perfectly, and a number in the wrong place.
   */
  for (const edit of edits) {
    const table = after[edit.sheet];
    const row = table?.rows.find((candidate) => candidate.row === edit.row);
    const cell = row?.cells.find(
      (candidate) => edit.col >= candidate.col && edit.col < candidate.col + candidate.repeat,
    );
    if (!cell) return { fail: `the cell edited at ${edit.row},${edit.col} is no longer there` };
    if (!next.slice(cell.start, cell.end).includes(edit.value)) {
      return { fail: `the value written for ${edit.row},${edit.col} is not in that cell` };
    }
  }

  return {
    ok: `${edits.length} edits · ${Object.keys(archive).length - 1} parts intact · geometry held · values placed`,
  };
}

/* ── PDF ─────────────────────────────────────────────────────────────── */

/**
 * What a page is made of, reduced to something comparable.
 *
 * The content stream is where every mark on the page lives — the text, the
 * lines, the images placed on it. Comparing those bytes is a stricter question
 * than comparing extracted text: it asks whether **anything at all** on the page
 * moved, including the things text extraction cannot see. And it can be asked
 * without a browser, which is what makes a corpus of four hundred documents
 * possible at all.
 */
async function pdfShape(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = doc.getPages().map((page) => {
    const contents = page.node.get(PDFName.of('Contents'));
    const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];

    let length = 0;
    let hash = 0;
    for (const ref of refs) {
      const stream = doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      length += stream.contents.length;
      for (const byte of stream.contents) hash = (hash * 31 + byte) >>> 0;
    }

    const size = page.getSize();
    return {
      width: Math.round(size.width),
      height: Math.round(size.height),
      rotation: ((page.getRotation().angle % 360) + 360) % 360,
      content: `${length}:${hash}`,
      annotations: page.node.Annots()?.size?.() ?? 0,
    };
  });

  return { count: doc.getPageCount(), title: doc.getTitle() ?? '', author: doc.getAuthor() ?? '', pages };
}

/** Every page carries exactly what it carried, in the same place and the same way. */
function pagesHeld(before, after, map) {
  for (let i = 0; i < map.length; i++) {
    const was = before.pages[map[i] - 1];
    const now = after.pages[i];
    if (!was || !now) return `page ${i + 1} is missing`;
    if (was.content !== now.content) return `the content of page ${map[i]} changed`;
    if (was.width !== now.width || was.height !== now.height) return `page ${map[i]} changed size`;
  }
  return null;
}

/**
 * How much text is actually **on** this page.
 *
 * Counting the text-showing operands out of the raw stream is not enough, and
 * the corpus said so: a poster in this folder parks the word `art` at x −443
 * with a font size of 239, four hundred points off the left edge, where it is
 * never drawn. Redaction quite rightly leaves it — it was never inside the
 * marked area — and a check that counted it would report a leak that is not one.
 *
 * So the page is read the way the editor reads it, with the transformations
 * applied, and only what lands within the page is counted.
 */
function textOnPage(page) {
  const { width, height } = page.getSize();
  const content = pageContentOrNothing(page, standard);
  if (!content) return null;

  let total = 0;
  for (const operation of content.operations) {
    const text = textOf(operation);
    if (!text) continue;
    const bounds = boundsOfOperation(operation);
    if (!bounds) continue;
    const onPage =
      bounds.x + bounds.width > 0 &&
      bounds.x < width &&
      bounds.y + bounds.height > 0 &&
      bounds.y < height;
    if (onPage) total += text.length;
  }
  return total;
}

/**
 * The one promise in this program with something at stake beyond tidiness.
 *
 * A black rectangle drawn over a name looks like deletion and survives every
 * check that looks at the picture. So nothing here looks at the picture: the
 * whole first page is redacted — which needs no text positions of its own and
 * therefore works on any document — and then the page is read back and asked
 * how much text is still on it. After removing everything, the answer has to be
 * none.
 *
 * A refusal is not a failure. The format has corners where removal cannot be
 * guaranteed, and there the document must be left exactly as it was and the
 * reason must reach the person — which is the honest outcome and is counted
 * separately here rather than being quietly folded in with the successes.
 */
async function redactionRemoves(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const page = doc.getPage(0);

  const before = textOnPage(page);
  if (before === null) return { note: 'the page cannot be read at all' };
  if (before === 0) return { note: 'no text on the first page' };

  /*
   * An area far larger than the page, and that matters.
   *
   * Redaction removes a glyph whose box the marked area **contains**, not one
   * it merely touches — the conservative rule, and the right one: a person
   * dragging over a line has not asked for the letter their box clipped the
   * corner of. Marking exactly the page rectangle therefore asks an unfair
   * question, because a glyph can straddle the page edge and no user could ever
   * drag a box that contains it. A rotated poster in this corpus does exactly
   * that, and reporting it as a leak said more about the harness than the
   * program. Marked generously, everything visible has to go.
   */
  const result = await applyRedactions(
    bytes,
    [{ id: 'fidelity', page: 1, rect: { x: -20000, y: -20000, width: 40000, height: 40000 } }],
    standard,
  );

  const refused = result.refused.find((entry) => entry.page === 1);
  if (refused) return { refused: refused.reason };

  const cleaned = await PDFDocument.load(result.bytes, { ignoreEncryption: true });
  const after = textOnPage(cleaned.getPage(0));
  if (after !== null && after > 0) {
    return { fail: `${after} of ${before} characters are still on the page after redaction` };
  }
  return { note: `${before} characters removed` };
}

async function checkPdf(bytes) {
  let before;
  try {
    before = await pdfShape(bytes);
  } catch (error) {
    /* Not a failure of fidelity but worth counting: the viewer renders with
       pdf.js and writes with pdf-lib, so a file only one of them accepts is one
       that opens and then cannot be saved. */
    return { skip: `it cannot be written at all: ${error.message.slice(0, 60)}` };
  }
  if (before.count === 0) return { skip: 'no pages' };

  const plan = before.pages.map((_, i) => ({ source: i + 1, rotate: 0 }));
  const identity = plan.map((entry) => entry.source);

  /* An annotation, over an otherwise untouched document. This is the common
     save: a highlight on the first page, and nothing else in the file may move. */
  const highlight = {
    id: 'fidelity',
    kind: 'highlight',
    page: 1,
    color: [1, 1, 0],
    createdAt: 0,
    quads: [{ x: 40, y: 40, width: 80, height: 10 }],
  };
  const annotated = await saveDocument(bytes, plan, [highlight], before.count);
  const afterNote = await pdfShape(annotated.bytes);

  if (afterNote.count !== before.count) return { fail: `annotating changed the page count` };
  const noteMoved = pagesHeld(before, afterNote, identity);
  if (noteMoved) return { fail: `annotating moved something: ${noteMoved}` };
  if (afterNote.title !== before.title || afterNote.author !== before.author) {
    return { fail: 'annotating dropped the document metadata' };
  }
  if (afterNote.pages[0].annotations !== before.pages[0].annotations + 1) {
    return { fail: `the highlight did not arrive (${before.pages[0].annotations} → ${afterNote.pages[0].annotations})` };
  }
  if (annotated.lost.length > 0) return { fail: `annotating declared a loss: ${annotated.lost[0]}` };

  /* A rotation, which the editor performs on the original document rather than
     by rebuilding it — so nothing outside the page tree may be touched. */
  const turned = await saveDocument(
    bytes,
    plan.map((entry, i) => (i === 0 ? { ...entry, rotate: 90 } : entry)),
    [],
    before.count,
  );
  const afterTurn = await pdfShape(turned.bytes);
  const turnMoved = pagesHeld(before, afterTurn, identity);
  if (turnMoved) return { fail: `rotating moved something: ${turnMoved}` };
  if (afterTurn.pages[0].rotation !== (before.pages[0].rotation + 90) % 360) {
    return { fail: `the rotation did not take (${before.pages[0].rotation} → ${afterTurn.pages[0].rotation})` };
  }
  if (turned.lost.length > 0) return { fail: `rotating declared a loss: ${turned.lost[0]}` };

  /* Dropping the last page. The pages that stay must be the pages that were
     there — a deletion that shifts content by one is the quietest way to ruin a
     document, and the page count alone would not show it. */
  let cut = '';
  if (before.count > 1) {
    const kept = plan.slice(0, -1);
    const shorter = await saveDocument(bytes, kept, [], before.count);
    const afterCut = await pdfShape(shorter.bytes);
    if (afterCut.count !== before.count - 1) {
      return { fail: `deleting a page left ${afterCut.count} of ${before.count - 1}` };
    }
    const cutMoved = pagesHeld(before, afterCut, kept.map((entry) => entry.source));
    if (cutMoved) return { fail: `deleting a page moved another: ${cutMoved}` };
    cut = ' · cut';
  }

  /*
   * Reordering, which is the one page operation the editor performs by
   * rebuilding the document — and the one it declares a loss for, because
   * bookmarks, forms and attachments live outside the page tree and do not
   * survive the copy. What must survive is the pages themselves: every one of
   * them, byte for byte, in its new place. Asserting that is what keeps the
   * declared loss honest — a save that quietly lost a page as well would look
   * exactly the same to somebody reading the warning.
   */
  let moved = '';
  if (before.count > 1) {
    const swapped = [...plan];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    const rebuilt = await saveDocument(bytes, swapped, [], before.count);
    const afterSwap = await pdfShape(rebuilt.bytes);

    if (afterSwap.count !== before.count) return { fail: 'reordering changed the page count' };
    const swapMoved = pagesHeld(before, afterSwap, swapped.map((entry) => entry.source));
    if (swapMoved) return { fail: `reordering lost a page: ${swapMoved}` };
    if (rebuilt.lost.length === 0) return { fail: 'reordering is lossy and said nothing' };
    moved = ' · reordered';
  }

  /* And the one promise with something at stake — see `redactionRemoves`. */
  const redaction = await redactionRemoves(bytes);
  if (redaction.fail) return { fail: `redaction left text behind: ${redaction.fail}` };
  const redacted = redaction.refused
    ? ` · redaction refused (${redaction.refused.slice(0, 24)})`
    : ` · redacted`;

  return { ok: `${before.count} pages · annotated · rotated${cut}${moved}${redacted} · content held` };
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

/**
 * Rich Text, where the mojibake count is the whole point.
 *
 * This format claims its code page twice and the two disagree — the document
 * says one thing and each font says another — so a reader that believes the
 * wrong one produces text that is not broken enough to look broken. `Kovačić`
 * comes back as `Kovaèiæ`, which reads as a damaged file rather than as a bug,
 * and the only way to see it at this scale is to count the characters that have
 * no business being in a Croatian document.
 */
function checkRtf(bytes) {
  const { paragraphs } = parseRtf(bytes);
  const text = paragraphs.map((para) => para.runs.map((run) => run.text).join('')).join('\n');
  const junk = junkIn(text);
  if (junk > 0) return { fail: `${junk} characters came back as mojibake` };
  const bold = paragraphs.reduce((n, para) => n + para.runs.filter((run) => run.chp.bold).length, 0);
  return {
    ok: `read-only · ${paragraphs.length} paragraphs · ${diacriticsIn(text)} diacritics · ${bold} bold`,
  };
}

/* ── walking the corpus ──────────────────────────────────────────────── */

const CHECKS = {
  docx: checkDocx,
  xlsx: checkXlsx,
  ods: checkOds,
  xls: checkXls,
  doc: checkDoc,
  rtf: checkRtf,
  pdf: checkPdf,
};

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
  /* The PDF fixtures are written as text, because a PDF is mostly text and
     reading one in a diff is worth more than a byte array. One character is one
     byte here, which is why this is not a `TextEncoder`. */
  const asBytes = (made) =>
    typeof made === 'string' ? Uint8Array.from([...made].map((ch) => ch.charCodeAt(0) & 0xff)) : made;

  return [
    { name: 'ugovor.docx', bytes: made.makeDocx() },
    { name: 'prodaja.xlsx', bytes: made.makeXlsx() },
    { name: 'prodaja.ods', bytes: made.makeOds() },
    { name: 'promet.xls', bytes: made.makeXls() },
    { name: 'zapisnik.doc', bytes: made.makeDoc() },
    { name: 'upitnik.rtf', bytes: made.makeRtf() },
    { name: 'izvjestaj.odt', bytes: made.makeOdt() },
    { name: 'dokument.pdf', bytes: asBytes(made.makeMultiPagePdf(3)) },
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
    const outcome = await check(bytes);
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
