/**
 * What we wrote, opened by somebody else's word processor.
 *
 * **Every "it reopens" claim in this repository goes back through this
 * repository's own readers.** `fidelity.mjs` proves a great deal — that no
 * other part of the archive moved, that nothing outside the rewritten ranges
 * changed, that the ordinals still mean the same text — but it proves all of it
 * with the same namespace-blind tag scanners that wrote the file. A writer and
 * a reader that share a mistake agree with each other perfectly, and the run
 * reports `ok`.
 *
 * So this asks a program that shares nothing with us. LibreOffice is a real
 * OOXML and ODF implementation, it is not ours, and it is already a dependency
 * of the conversion feature. Two questions, and they are the two no scanner of
 * ours can answer:
 *
 * - **does it open at all?** A converter that produces an output file has
 *   parsed the XML, resolved every namespace prefix, matched the schema well
 *   enough to lay the document out, and accepted the ZIP container. Nothing
 *   here checks well-formedness today — not one harness runs an XML parser over
 *   a written part.
 * - **is the text we typed the text it shows?** Bytes in the right place prove
 *   the write landed; a word in the converted output proves it landed *where a
 *   reader looks*. Those are different claims, and only the second one is the
 *   promise made to a person.
 *
 * The marker carries **Croatian diacritics on purpose**. A `č` is two bytes and
 * one character, and the whole chain — our writer, the ZIP, LibreOffice's
 * parser, its exporter — has to agree about that. Nothing else in the repository
 * checks a round trip through a foreign reader, and mojibake is exactly the
 * failure that looks like success from the inside.
 *
 * **It refuses to pass without LibreOffice**, rather than skipping quietly. A
 * check whose only failure mode is a pass is the thing this repository has
 * already been bitten by once; `crates/ul-lsp/tests/live.rs` says the same
 * about rust-analyzer. Install it, or do not run this.
 *
 * **The original is converted too, and the control is the whole method.** It
 * answers two different objections, and the first run of this needed both.
 *
 * A real folder holds files that were already broken before this program saw
 * them — a truncated download, a `.xlsx` somebody's script wrote badly. Without
 * the control each of those is reported as damage we did. So a file counts
 * against us only when LibreOffice opened what we *read* and refused what we
 * *wrote*.
 *
 * And **a converter is not a reader.** `.txt` and `.csv` are lossy on purpose:
 * a CSV holds one sheet, and a plain-text export leaves out whatever its filter
 * leaves out. Asking "is the marker in the output?" measures the filter at
 * least as much as the writer — the first run of this reported eight failures,
 * every one of them a table-layout schedule or a workbook whose edited sheet
 * was not the first, and not one of them a bug. So the question asked is the
 * one that controls for it: **the text that was in that spot before had to be
 * visible in the original's conversion**, and only then is the marker required
 * in ours. A spot the reader never showed is a spot this instrument cannot ask
 * about, and it says so rather than counting it.
 *
 * **A Word document gets every kind of change at once** — runs rewritten, a
 * paragraph added, one taken away, one split where a caret could stand and two
 * joined — because they share one operation list and real documents are where
 * they collide. The split is asked on the same terms as the rest: a line the
 * original's conversion showed whole and once has to come back as two lines,
 * one after the other, divided where the cut fell; and two lines it showed one
 * after the other have to come back as one.
 *
 * **It never writes to the corpus.** Every edit is made against a copy in
 * memory; only the temporary folder ever sees a file.
 *
 *   node tools/verify-office-readback.mjs "C:/Users/you/Documents"
 *   node tools/verify-office-readback.mjs "C:/Users/you/Documents" --most 40
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = (path) => import(pathToFileURL(resolve(ROOT, path)).href);

const { detect } = await load('packages/shell-ui/src/host/detect.ts');
const { openArchive, readText } = await load('packages/editor-office/src/ooxml.ts');
const {
  findRuns,
  findParagraphs,
  paragraphOfRun,
  removalRefusal,
  splitRefusal,
  joinRefusal,
  showsNothing,
  readStyleSuccession,
  applyRunEdits,
  runText,
  writeDocx,
  findRows,
  rowRefusal,
  rowShape,
  anchorRow,
} = await load('packages/editor-office/src/docx-edit.ts');
const { findCells, applyCellEdits, writeXlsx } = await load(
  'packages/editor-office/src/xlsx-edit.ts',
);
const { findOdsCells, applyOdsEdits } = await load('packages/editor-office/src/ods-edit.ts');
const { findOdtPieces, applyOdtEdits } = await load('packages/editor-office/src/odt-edit.ts');
const { writeOdf } = await load('packages/editor-office/src/odf-package.ts');

/*
 * Diacritics on purpose — see the file comment. The digits keep the three
 * edits in one document apart, so a marker found in the wrong place is a
 * different failure from a marker not found at all.
 */
const MARKER = 'ulProvjera-ČĆŽŠĐ-čćžšđ';

/** Where LibreOffice lives, in the order the conversion feature looks. */
const CANDIDATES = [
  process.env.ULEDITOR_SOFFICE,
  'C:/Program Files/LibreOffice/program/soffice.com',
  'C:/Program Files (x86)/LibreOffice/program/soffice.com',
  '/usr/bin/soffice',
  '/usr/local/bin/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
].filter(Boolean);

const SOFFICE = CANDIDATES.find((path) => existsSync(path));

const WANTED = new Set(['.docx', '.odt', '.xlsx', '.ods']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'venv', '__pycache__']);

const args = process.argv.slice(2);
const most = Number(args[args.indexOf('--most') + 1]) || 30;
const roots = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--most');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

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
      yield path;
    }
  }
}

/* ── the edits, one per format ───────────────────────────────────────── */

/**
 * Types the marker into a document and hands back the bytes.
 *
 * Deliberately the same gesture `fidelity.mjs` makes, and deliberately spread
 * across the document rather than taken from the front: an offset fault shows
 * itself at the end of a long file, not at its start.
 */
function edited(format, bytes) {
  const archive = openArchive(bytes);

  if (format === 'docx') {
    const xml = readText(archive, 'word/document.xml');
    if (xml === null) return { skip: 'no word/document.xml' };
    const runs = findRuns(xml);
    const open = runs.filter((r) => r.text && !r.refusal && runText(xml, r).trim().length > 0);
    if (open.length === 0) return { skip: 'nothing in it can be rewritten' };
    const picked = spread(open);
    const edits = picked.map((run, i) => ({ index: run.index, text: `${MARKER}${i}` }));
    const was = picked.map((run) => runText(xml, run).trim());

    /*
     * And one paragraph that is not in the file at all.
     *
     * A rewrite can be checked by looking at the bytes; a paragraph that did not
     * exist cannot be told apart from a paragraph the writer bungled without a
     * reader saying whether it is there. So it goes in after a run we already
     * know the position of — which means it inherits that run's visibility for
     * free, and the control below can ask about it on exactly the same terms:
     * only where this reader showed that spot to begin with.
     */
    const paragraphs = findParagraphs(xml);
    const anchor = picked
      .map((run, i) => ({ at: i, paragraph: paragraphOfRun(paragraphs, run) }))
      .find((one) => one.paragraph && !one.paragraph.refusal);

    const inserts = anchor ? [{ after: anchor.paragraph.index, text: `${MARKER}p` }] : [];
    const succession = readStyleSuccession(readText(archive, 'word/styles.xml'));

    /*
     * And one paragraph taken away, in the same save — the three kinds of
     * change share one operation list, and real documents are where they
     * collide. It holds none of the rewritten runs and is not the anchor, so
     * nothing else asked about here goes with it; its line is one a person
     * could look for — long enough, with no break, tab or field in it that
     * the export would spell differently.
     */
    const touched = new Set(picked.map((run) => paragraphOfRun(paragraphs, run)?.index));
    const lineOf = (span) =>
      [...xml.slice(span.start, span.end).matchAll(/<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([^<]*)</g)]
        .map((m) => m[1])
        .join('')
        .trim();
    const going = paragraphs.find(
      (span) =>
        !touched.has(span.index) &&
        span.index !== anchor?.paragraph.index &&
        removalRefusal(xml, paragraphs, span.index) === null &&
        !/<(?:[A-Za-z_][\w.-]*:)?(?:br|cr|tab|sym|fldChar|fldSimple)[\s/>]/.test(xml.slice(span.start, span.end)) &&
        /^[^&<>]{8,}$/.test(lineOf(span)),
    );

    /*
     * And one paragraph split, as Enter in the middle of a sentence splits it —
     * in the same save as the rest, clear of the paragraphs they touch, and on
     * a line a person could look for: long enough, with nothing in it the
     * export would spell differently. Where it stood, the reader has to show
     * two lines, divided where the cut fell.
     */
    const busy = new Set([...touched, anchor?.paragraph.index, going?.index]);
    const divided = runs.find((run) => {
      if (!run.text || run.refusal || splitRefusal(xml, paragraphs, run) !== null) return false;
      const span = paragraphOfRun(paragraphs, run);
      if (!span || busy.has(span.index)) return false;
      if (/<(?:[A-Za-z_][\w.-]*:)?(?:br|cr|tab|sym|fldChar|fldSimple|drawing|pict|object)[\s/>]/.test(xml.slice(span.start, span.end))) {
        return false;
      }
      return runText(xml, run).trim().length >= 8 && /^[^&<>]{12,}$/.test(lineOf(span));
    });
    let split = null;
    const cuts = [];
    if (divided) {
      const span = paragraphOfRun(paragraphs, divided);
      const text = runText(xml, divided);
      const at = text.indexOf(' ', Math.floor(text.length / 2)) > 0 ? text.indexOf(' ', Math.floor(text.length / 2)) : Math.floor(text.length / 2);
      const parts = [text.slice(0, at), text.slice(at)];
      cuts.push({ run: divided.index, parts });
      /* Untrimmed, unlike `lineOf`: a space at the end of the text before the
         cut belongs to the first line, and trimming each half would glue two
         words together. Only the finished lines are trimmed, as the export's. */
      const raw = (from, to) =>
        [...xml.slice(from, to).matchAll(/<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([^<]*)</g)].map((m) => m[1]).join('');
      split = {
        whole: lineOf(span),
        first: `${raw(span.start, divided.text.start)}${parts[0]}`.trim(),
        second: `${parts[1]}${raw(divided.text.end, span.end)}`.trim(),
      };
    }

    /*
     * And two paragraphs joined, as Backspace at the start of the second joins
     * them — clear of every paragraph the rest touch, and on two lines a person
     * could look for. Where they stood, the reader has to show one line holding
     * both, and neither of them on its own.
     */
    const rawOf = (span) =>
      [...xml.slice(span.start, span.end).matchAll(/<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([^<]*)</g)].map((m) => m[1]).join('');
    const clear = (span) =>
      !busy.has(span.index) &&
      span.index !== (divided ? paragraphOfRun(paragraphs, divided)?.index : undefined) &&
      !/<(?:[A-Za-z_][\w.-]*:)?(?:br|cr|tab|sym|fldChar|fldSimple|drawing|pict|object)[\s/>]/.test(xml.slice(span.start, span.end)) &&
      /^[^&<>]{6,}$/.test(lineOf(span));
    const body = paragraphs.filter((span) => span.refusal === null);
    const pair = body
      .slice(0, -1)
      .map((first, i) => [first, body[i + 1]])
      .find(
        ([first, next]) =>
          clear(first) && clear(next) && joinRefusal(xml, paragraphs, first.index) === null && !showsNothing(xml, first, runs),
      );
    const joined = pair
      ? { first: lineOf(pair[0]), second: lineOf(pair[1]), whole: `${rawOf(pair[0])}${rawOf(pair[1])}`.trim() }
      : null;

    /*
     * And a row added to a table, in the same save as everything else. It is
     * asked about on the same terms as the new paragraph: the marker goes into
     * the first cell of a new row under a row whose own first cell this reader
     * showed, so a marker that does not come back is a fact about the write
     * rather than about the filter's idea of a table.
     */
    const tableRows = findRows(xml);
    const cellOf = (row) => {
      const closes = xml.indexOf('</w:tc>', row.start);
      return closes === -1 ? '' : rawOf({ start: row.start, end: closes }).trim();
    };
    const under = tableRows.find(
      (row) => rowRefusal(xml, tableRows, row.index) === null && /^[^&<>]{5,}$/.test(cellOf(row)),
    );
    /* As many cells as the row the new one is copied from has, which is not
       always the row named: a merge carries the new row past its last row. */
    const rowInserts = under
      ? [
          {
            after: under.index,
            cells: rowShape(xml, anchorRow(xml, tableRows, under)).map((_, k) => (k === 0 ? `${MARKER}r` : '')),
          },
        ]
      : [];

    return {
      bytes: writeDocx(archive, runs, xml, edits, {
        paragraphs,
        succession,
        inserts,
        removals: going ? [going.index] : [],
        cuts,
        joins: pair ? [pair[0].index] : [],
        rows: tableRows,
        rowInserts,
      }),
      typed: [
        ...edits.map((e) => e.text),
        ...inserts.map((one) => one.text),
        ...rowInserts.map((one) => one.cells[0]),
      ],
      was: [...(anchor ? [...was, was[anchor.at]] : was), ...(under ? [cellOf(under)] : [])],
      gone: going ? lineOf(going) : null,
      split,
      joined,
    };
  }

  if (format === 'odt') {
    const xml = readText(archive, 'content.xml');
    if (xml === null) return { skip: 'no content.xml' };
    const pieces = findOdtPieces(xml);
    const open = pieces.filter((p) => !p.refusal && p.text.trim().length > 0);
    if (open.length === 0) return { skip: 'nothing in it can be rewritten' };
    const picked = spread(open);
    const edits = picked.map((piece, i) => ({ index: piece.index, text: `${MARKER}${i}` }));
    return {
      bytes: writeOdf(archive, applyOdtEdits(xml, pieces, edits)),
      typed: edits.map((e) => e.text),
      was: picked.map((piece) => piece.text.trim()),
    };
  }

  if (format === 'xlsx') {
    const sheets = Object.keys(archive).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p));
    for (const path of sheets) {
      const xml = readText(archive, path);
      if (xml === null) continue;
      const spans = findCells(xml);
      const open = spans.rows.flatMap((row) => row.cells).filter((c) => !c.formula);
      if (open.length === 0) continue;
      const picked = spread(open);
      const edits = picked.map((cell, i) => ({ ref: cell.ref, value: `${MARKER}${i}` }));
      const next = applyCellEdits(xml, spans, edits);
      return {
        bytes: writeXlsx(archive, new Map([[path, next]])),
        typed: edits.map((e) => e.value),
        was: picked.map((cell) => (cellText(xml, cell) ?? '').trim()),
      };
    }
    return { skip: 'no sheet holds a cell that can be rewritten' };
  }

  if (format === 'ods') {
    const xml = readText(archive, 'content.xml');
    if (xml === null) return { skip: 'no content.xml' };
    const tables = findOdsCells(xml);
    const open = [];
    tables.forEach((table, sheet) =>
      table.rows.forEach((row, r) =>
        row.cells.forEach((cell) => {
          if (!cell.formula && !cell.covered) {
            open.push({ sheet, row: r, col: cell.col, text: odsCellText(xml, cell) });
          }
        }),
      ),
    );
    if (open.length === 0) return { skip: 'nothing in it can be rewritten' };
    const picked = spread(open);
    const edits = picked.map((at, i) => ({ ...at, value: `${MARKER}${i}` }));
    return {
      bytes: writeOdf(archive, applyOdsEdits(xml, edits)),
      typed: edits.map((e) => e.value),
      was: picked.map((at) => at.text.trim()),
    };
  }

  return { skip: `nothing here edits a ${format}` };
}

/**
 * What a spreadsheet cell shows, as text, well enough to look for later.
 *
 * Not a reader — the readers are in `xlsx.ts` and `odf.ts` and they need a
 * browser. This wants one thing only: a distinctive string that was in that
 * spot before, so the control below can ask whether the converter ever showed
 * it. An inline string, a `<v>` and an ODF `<text:p>` are the three shapes that
 * carry one.
 */
function cellText(xml, cell) {
  const body = xml.slice(cell.start, cell.end);
  const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(body);
  if (inline) return unescape(inline[1]);
  const value = /<v>([\s\S]*?)<\/v>/.exec(body);
  return value ? unescape(value[1]) : null;
}

function odsCellText(xml, cell) {
  const body = xml.slice(cell.start, cell.end);
  const shown = /<text:p[^>]*>([\s\S]*?)<\/text:p>/.exec(body);
  return shown ? unescape(shown[1]) : '';
}

const unescape = (text) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** First, middle and last, deduplicated — the same spread fidelity uses. */
function spread(all) {
  return [all[0], all[Math.floor(all.length / 2)], all[all.length - 1]]
    .filter((one, i, list) => list.indexOf(one) === i)
    .slice(0, 3);
}

/* ── the independent reader ──────────────────────────────────────────── */

const work = mkdtempSync(join(tmpdir(), 'ul-readback-'));
const profile = pathToFileURL(join(work, 'profile')).href;
let converted = 0;

/**
 * Hands one file to LibreOffice and returns the text it made of it.
 *
 * **The exit code is not the answer.** It is 1 for a file LibreOffice loaded
 * perfectly and 0 for one it refused, so what is waited for is the output file
 * — the same rule `crates/ul-convert` learned and writes down. A run that ends
 * without one is the refusal it is.
 */
function asText(bytes, name, filter) {
  const stem = `doc${converted++}`;
  const source = join(work, `${stem}${extname(name)}`);
  const outdir = join(work, stem);
  writeFileSync(source, bytes);

  try {
    execFileSync(
      SOFFICE,
      [
        `-env:UserInstallation=${profile}`,
        '--headless',
        '--norestore',
        '--invisible',
        '--nolockcheck',
        '--nodefault',
        '--nofirststartwizard',
        '--convert-to',
        filter,
        '--outdir',
        outdir,
        source,
      ],
      { stdio: 'ignore', timeout: 120000 },
    );
  } catch {
    /* Said above: the file is the answer, not the code. */
  }

  let made = [];
  try {
    made = readdirSync(outdir);
  } catch {
    return null;
  }
  const out = made.find((f) => f.endsWith(`.${filter}`));
  return out ? readFileSync(join(outdir, out), 'utf8') : null;
}

/* ── the run ─────────────────────────────────────────────────────────── */

console.log('What we wrote, opened by somebody else\u2019s word processor.\n');

if (!SOFFICE) {
  check(
    'LibreOffice is installed',
    false,
    'not found — this check refuses to pass without it, because a check that passes on a machine that cannot run it is a check that lies',
  );
  console.log('\nSet ULEDITOR_SOFFICE, or install LibreOffice, then run this again.');
  process.exit(1);
}
check('LibreOffice is installed', true, SOFFICE);

if (roots.length === 0) {
  check(
    'a folder of real documents was named',
    false,
    'fixtures would prove the harness works, not that the writers do — name a folder',
  );
  console.log('\n  node tools/verify-office-readback.mjs "C:/Users/you/Documents"');
  process.exit(1);
}

const found = [...new Set(roots.flatMap((root) => [...walk(resolve(root))]))].sort();

/* No silent cap: what was left out is said out loud, with the number. */
const sampled = found.filter((_, i) => i % Math.max(1, Math.ceil(found.length / most)) === 0);
check(
  'a corpus was walked',
  found.length > 0,
  found.length > most
    ? `${found.length} found, ${sampled.length} taken every ${Math.ceil(found.length / most)}th — LibreOffice is a second or two each`
    : `${found.length} found, all taken`,
);

const opened = [];
const showed = [];
const skipped = [];
const invisible = [];
const added = [];
const taken = [];
const halved = [];
const merged = [];
const rowed = [];
const broke = [];

for (const file of sampled) {
  const name = file.split(/[\\/]/).pop();
  let bytes;
  try {
    bytes = new Uint8Array(readFileSync(file));
  } catch (error) {
    broke.push(`${name}: unreadable`);
    continue;
  }

  const { format } = detect(name, bytes.subarray(0, 65536));
  let made;
  try {
    made = edited(format, bytes);
  } catch (error) {
    broke.push(`${name}: our own writer threw — ${error.message}`);
    continue;
  }
  if (made.skip) {
    skipped.push(`${name}: ${made.skip}`);
    continue;
  }

  const filter = format === 'xlsx' || format === 'ods' ? 'csv' : 'txt';
  const text = asText(made.bytes, name, filter);

  if (text === null) {
    /* The control. A file LibreOffice cannot open either way was broken before
       we saw it, and saying so is the difference between a finding and a
       complaint about somebody else's file. */
    if (asText(bytes, name, filter) === null) {
      skipped.push(`${name}: LibreOffice will not open the original either`);
    } else {
      broke.push(`${name} (${format}): opened before we wrote it, and not after`);
    }
    continue;
  }
  opened.push(name);

  /*
   * The control, and it is what makes the number mean anything: for each spot,
   * ask first whether the converter ever showed what was there. A cell on the
   * second sheet of a workbook and a paragraph the text filter leaves out are
   * both invisible before we touch them, and a marker missing from a spot the
   * reader never showed is a fact about the filter.
   *
   * A short string is no evidence either way — "1" appears in every document
   * ever written — so only a distinctive one is asked about.
   */
  const original = asText(bytes, name, filter);
  const asked = [];
  for (const [i, was] of made.was.entries()) {
    if (was.length < 4) continue;
    if (original === null || !original.includes(was)) continue;
    asked.push({ was, typed: made.typed[i] });
  }

  /* A paragraph taken away is asked about on the same terms, and on its own —
     before the rewrites decide whether this document is worth asking about:
     only a line this reader showed exactly once in the original can be missed
     afterwards, or its absence would be a fact about the filter or about some
     other line that happens to say the same thing. */
  if (made.gone && original !== null && original.split(made.gone).length === 2) {
    if (text.includes(made.gone)) {
      broke.push(`${name} (${format}): a paragraph taken away is still there — "${made.gone.slice(0, 30)}"`);
    } else {
      taken.push(name);
    }
  }

  const lines = (body) => body.split(/\r?\n/).map((line) => line.trim());

  /* A join, on the same terms: two lines this reader showed once each, one
     after the other, have to come back as one line holding both. */
  if (made.joined && original !== null) {
    const was = lines(original);
    const at = was.indexOf(made.joined.first);
    const once = (line) => was.filter((one) => one === line).length === 1;
    if (at !== -1 && was[at + 1] === made.joined.second && once(made.joined.first) && once(made.joined.second)) {
      const now = lines(text);
      if (!now.includes(made.joined.whole) || now.includes(made.joined.first) || now.includes(made.joined.second)) {
        broke.push(`${name} (${format}): two joined paragraphs are not one line — "${made.joined.whole.slice(0, 40)}"`);
      } else {
        merged.push(name);
      }
    }
  }

  /* A split, on the same terms: a line this reader showed whole and once in
     the original has to come back as two lines, one after the other. */
  if (made.split && original !== null) {
    const was = lines(original);
    if (was.filter((line) => line === made.split.whole).length === 1) {
      const now = lines(text);
      const at = now.indexOf(made.split.first);
      if (at === -1 || now[at + 1] !== made.split.second || now.includes(made.split.whole)) {
        broke.push(`${name} (${format}): a split paragraph is not two lines — "${made.split.first.slice(0, 24)}" / "${made.split.second.slice(0, 24)}"`);
      } else {
        halved.push(name);
      }
    }
  }

  if (asked.length === 0) {
    invisible.push(`${name}: this reader shows none of the spots we edited`);
    continue;
  }

  /* How often the harder question actually got asked. A paragraph that was not
     in the file is the one thing here no scanner of ours can confirm, so a run
     that quietly never asked about one would be reporting the easy half and
     calling it the whole. */
  if (asked.some((one) => one.typed.endsWith(`${MARKER}p`))) added.push(name);
  /* And the same for a row that was not in the table, which no scanner of
     ours can confirm either. */
  if (asked.some((one) => one.typed.endsWith(`${MARKER}r`))) rowed.push(name);

  const missing = asked.filter((one) => !text.includes(one.typed));
  if (missing.length === 0) showed.push(name);
  else {
    broke.push(
      `${name} (${format}): ${missing.length} of ${asked.length} edits are not in what a reader shows` +
        ` (e.g. "${missing[0].was.slice(0, 30)}" did not become the marker)`,
    );
  }
}

console.log('');
check(
  'every file we wrote opens in a word processor that is not ours',
  broke.filter((b) => b.includes('and not after')).length === 0,
  `${opened.length} opened`,
);
const asked = showed.length + broke.filter((b) => b.includes('not in what a reader shows')).length;
check(
  'and the text we typed is the text it shows, diacritics and all',
  asked > 0 && showed.length === asked,
  `${showed.length}/${asked} documents, of ${opened.length} opened`,
);

check(
  'and a paragraph that was not in the file at all is there when it is reopened',
  added.length > 0,
  `${added.length} documents were given one and asked about it`,
);

check(
  'and a paragraph taken out of the file is gone when it is reopened',
  taken.length > 0 && !broke.some((b) => b.includes('taken away is still there')),
  `${taken.length} documents lost one and were asked about it`,
);

check(
  'and a paragraph split where the cursor stood is two lines when it is reopened',
  halved.length > 0 && !broke.some((b) => b.includes('split paragraph is not two lines')),
  `${halved.length} documents had one split and were asked about it`,
);

check(
  'and two paragraphs joined are one line when it is reopened',
  merged.length > 0 && !broke.some((b) => b.includes('joined paragraphs are not one line')),
  `${merged.length} documents had two joined and were asked about it`,
);

check(
  'and a row that was not in the table is there when it is reopened',
  rowed.length > 0,
  `${rowed.length} documents were given one and asked about it`,
);

if (invisible.length > 0) {
  console.log(
    `\n${invisible.length} could not be asked, because a .txt or .csv export does not show those spots:`,
  );
  for (const one of invisible.slice(0, 8)) console.log(`  · ${one}`);
  if (invisible.length > 8) console.log(`  · …and ${invisible.length - 8} more`);
}

if (skipped.length > 0) {
  console.log(`\n${skipped.length} skipped, which is not a failure:`);
  for (const one of skipped.slice(0, 8)) console.log(`  · ${one}`);
  if (skipped.length > 8) console.log(`  · …and ${skipped.length - 8} more`);
}

if (broke.length > 0) {
  console.log(`\n${broke.length} to look at:`);
  for (const one of broke) console.log(`  ✕ ${one}`);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 && broke.length === 0 ? 0 : 1);
