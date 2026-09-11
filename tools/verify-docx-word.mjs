/**
 * Word itself opens what we wrote — the one reader that refuses.
 *
 * `pnpm readback` asks LibreOffice, and LibreOffice is the wrong instrument for
 * exactly one question. It is **lenient**: handed a document with a child the
 * body may not have, it opens the file and quietly drops the part it did not
 * understand, and the conversion comes back looking like a success. Word is the
 * reader that refuses, or repairs and tells you. Adding a paragraph is the first
 * change this program makes that can produce that kind of mistake — until now
 * everything written was a substitution inside an element that already existed —
 * so the reader that can see it is the reader this check needs.
 *
 * What is asked, per document, is a comparison rather than an absolute:
 *
 * - Word opens **the original**, and we count its paragraphs. That is the
 *   control, and it is what makes a number mean anything — Word counts a
 *   paragraph its own way, in tables and text boxes and all, and guessing at
 *   what it ought to say would be measuring our guess.
 * - Word opens **ours**, and it must open: a file it will not open at all is
 *   the failure this whole check exists to catch.
 * - It must hold **exactly one paragraph more**, which is the way a silent
 *   repair announces itself. Word repairs by throwing away what it could not
 *   read, so a paragraph that is not there afterwards was not accepted.
 * - And the text must be in it, diacritics and all.
 *
 * **And a paragraph taken away**, asked the same way from the other side: Word
 * opens ours, it holds exactly one paragraph fewer, and a line of text Word
 * showed in the original is no longer anywhere in it.
 *
 * Three removals are refused by this program rather than written, and this is
 * where the reason for each is kept honest. They are cut here **by hand**,
 * bypassing the writer's rules, and Word is asked what it makes of the result:
 * that the paragraph between two tables is what keeps them two, that a document
 * cannot end on a table without Word putting a paragraph back, and that taking
 * away the far half of a protected range takes away somebody's permission to
 * edit a paragraph nobody touched. The day Word stops doing any of these, the
 * rule that refuses it is refusing for nothing — and this is what would say so.
 *
 * **And a paragraph split where the cursor stood** — Enter in the middle of a
 * sentence. Word opens it with exactly one paragraph more, and a line it showed
 * once in the original now stands as two lines one after the other, divided
 * exactly where the cut fell. Two of the split's refusals are cut by hand the
 * same way: a run inside a link, divided anyway, leaves the link opened in one
 * paragraph and closed in the next, and Word will not open the file; a
 * section-ending paragraph divided with its properties copied gives Word one
 * section more than the document had.
 *
 * **And two paragraphs joined** — Backspace at the start of the second. Word
 * opens it with exactly one paragraph fewer and one line where two stood, and
 * then it is asked the question the rest of this file only asks of us: Word
 * joins the same two paragraphs itself, in the original, with
 * `Selection.TypeBackspace`, and the paragraph it makes has to have the same
 * style, alignment, list, indents and spacing as the one Word reads from ours.
 * Word is the reference implementation of a join, and this is where it is
 * consulted. Two rules are shown the same way: after an empty line Word keeps
 * the next paragraph's properties — so the plan removes an empty first
 * paragraph rather than joining it — and a section-ending paragraph joined by
 * hand onto the one before costs Word a section.
 *
 * Windows and Word only. Rather than skipping quietly where there is no Word —
 * a check whose only failure mode is a pass is a check that lies — it says so
 * and fails, the same way `pnpm readback` refuses to pass without LibreOffice.
 *
 *   node tools/verify-docx-word.mjs "C:/Users/you/Documents"
 */

import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeDocx } from './fixtures.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const {
  findRuns,
  findParagraphs,
  paragraphOfRun,
  readStyleSuccession,
  removalRefusal,
  splitRefusal,
  joinRefusal,
  showsNothing,
  propertiesAlike,
  runText,
  escapeXml,
  unescapeXml,
  writeDocx,
} = await import(pathToFileURL(resolve(ROOT, 'packages/editor-office/src/docx-edit.ts')).href);

const MARKER = 'ulProvjera-ČĆŽŠĐ-novi-odlomak';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const done = () => {
  const failed = checks.filter((one) => !one.passed).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
};

/* ── is there a Word to ask ──────────────────────────────────────────── */

if (process.platform !== 'win32') {
  check('Word is installed', false, 'this check needs Windows and Microsoft Word');
  done();
}

const found = spawnSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    "try { $w = New-Object -ComObject Word.Application; $v = $w.Version; $w.Quit(); Write-Output $v } catch { Write-Output 'no' }",
  ],
  { encoding: 'utf8' },
);
const version = (found.stdout ?? '').trim();
check('Word is installed', version !== '' && version !== 'no', version || (found.stderr ?? '').trim());
if (version === '' || version === 'no') done();

/* ── the documents, with a paragraph put into each ───────────────────── */

function walk(dir, out = [], depth = 0) {
  if (depth > 5) return out;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, depth + 1);
    else if (/\.docx$/i.test(entry.name) && !entry.name.startsWith('~$')) out.push(full);
  }
  return out;
}

const args = process.argv.slice(2);
const most = Number(args[args.indexOf('--most') + 1]) || 10;
const corpus = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const files = corpus ? walk(corpus) : [];

/* Word is a second or two per document and this opens two of them, so a slice
   rather than the lot — spread across the folder, not taken from its front. */
const step = files.length > most ? Math.ceil(files.length / most) : 1;
const taken = files.filter((_, i) => i % step === 0).slice(0, most);

const work = mkdtempSync(join(tmpdir(), 'ul-word-'));
const pairs = [];
const nowhere = [];
/** Documents with a paragraph taken away, and the line Word should no longer show. */
const removals = [];
const unremovable = [];
/** Documents with a paragraph split, and the two lines Word should show where one stood. */
const splits = [];
const unsplittable = [];
/** Documents with two paragraphs joined, and the one line Word should show where two stood. */
const joins = [];
const unjoinable = [];

/** Markup that is a character in Word's text and nothing in the runs' — a line holding it cannot be looked for. */
const UNREADABLE = /<(?:[A-Za-z_][\w.-]*:)?(?:br|cr|tab|sym|fldChar|fldSimple|noBreakHyphen|softHyphen|drawing|pict|object)[\s/>]/;

/** The text a paragraph shows, as its runs hold it. */
const textOf = (xml, span) =>
  [...xml.slice(span.start, span.end).matchAll(/<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([^<]*)</g)]
    .map((m) => unescapeXml(m[1]))
    .join('');

/** The fixture goes first, so a run with no corpus still asks Word something. */
const sources = [{ name: 'fixture.docx', bytes: makeDocx() }].concat(
  taken.map((path) => ({ name: path.split(/[\\/]/).pop(), bytes: readFileSync(path), path })),
);

for (const source of sources) {
  let archive;
  try {
    archive = unzipSync(source.bytes);
  } catch {
    continue;
  }
  const part = archive['word/document.xml'];
  if (!part) continue;

  const xml = strFromU8(part);
  const runs = findRuns(xml);
  const paragraphs = findParagraphs(xml);
  const succession = readStyleSuccession(
    archive['word/styles.xml'] ? strFromU8(archive['word/styles.xml']) : null,
  );

  /* A paragraph in the body with text in it — the one a person would put the
     cursor in. Where there is none, the file is named rather than counted. */
  const after = paragraphs.find(
    (span) =>
      !span.refusal &&
      runs.some((run) => !run.refusal && paragraphOfRun(paragraphs, run) === span),
  );
  if (!after) {
    nowhere.push(source.name);
    continue;
  }

  const before = join(work, `before-${pairs.length}.docx`);
  const written = join(work, `after-${pairs.length}.docx`);
  writeFileSync(before, Buffer.from(source.bytes));
  writeFileSync(
    written,
    Buffer.from(
      writeDocx(archive, runs, xml, [], {
        paragraphs,
        succession,
        inserts: [{ after: after.index, text: MARKER }],
      }),
    ),
  );
  pairs.push({ name: source.name, before, written });

  /*
   * And a paragraph split, as Enter in the middle of a sentence splits it. The
   * line has to be one Word shows as it is — nothing in it that is a character
   * to Word and nothing to the runs — and one that stands exactly once in the
   * document, so "two lines where it stood" cannot be satisfied elsewhere.
   */
  {
    const lines = paragraphs.map((span) => textOf(xml, span));
    const run = runs.find((one) => {
      if (!one.text || one.refusal || splitRefusal(xml, paragraphs, one) !== null) return false;
      const span = paragraphOfRun(paragraphs, one);
      if (!span || UNREADABLE.test(xml.slice(span.start, span.end))) return false;
      const line = textOf(xml, span);
      return runText(xml, one).length >= 4 && line.trim().length >= 8 && lines.filter((l) => l === line).length === 1;
    });
    if (run) {
      const span = paragraphOfRun(paragraphs, run);
      const text = runText(xml, run);
      const at = Math.floor(text.length / 2);
      const parts = [text.slice(0, at), text.slice(at)];
      const path = join(work, `split-${splits.length}.docx`);
      writeFileSync(
        path,
        Buffer.from(writeDocx(archive, runs, xml, [], { paragraphs, succession, inserts: [], cuts: [{ run: run.index, parts }] })),
      );
      splits.push({
        name: source.name,
        before,
        path,
        whole: textOf(xml, span),
        first: textOf(xml, { start: span.start, end: run.text.start }) + parts[0],
        second: parts[1] + textOf(xml, { start: run.text.end, end: span.end }),
      });
    } else {
      unsplittable.push(source.name);
    }
  }

  /*
   * And two paragraphs joined, as Backspace at the start of the second joins
   * them. Both lines have to be ones Word shows as they are and that stand
   * once in the document, so the two can be found again by their text — in
   * the original, where Word is asked to do the same join itself, and in
   * ours, where the joined line is looked for.
   */
  {
    const lines = paragraphs.map((span) => textOf(xml, span));
    const body = paragraphs.filter((span) => span.refusal === null);
    const readable = (span) => {
      const line = textOf(xml, span);
      return !UNREADABLE.test(xml.slice(span.start, span.end)) && line.trim().length >= 3 && lines.filter((l) => l === line).length === 1;
    };
    const pairs = body
      .slice(0, -1)
      .map((first, i) => [first, body[i + 1]])
      .filter(
        ([first, next]) =>
          joinRefusal(xml, paragraphs, first.index) === null && !showsNothing(xml, first, runs) && readable(first) && readable(next),
      );
    /* Two paragraphs whose properties differ, where the document has any:
       only those can tell "the first one's properties" from "the second's",
       and a comparison with Word that cannot tell them apart proves nothing
       about the rule. */
    const telling = pairs.filter(([first, next]) => !propertiesAlike(xml, first, next));
    const pool = telling.length > 0 ? telling : pairs;
    const pair = pool[Math.floor(pool.length / 2)];
    if (pair) {
      const [first, next] = pair;
      const path = join(work, `joined-${joins.length}.docx`);
      writeFileSync(path, Buffer.from(writeDocx(archive, runs, xml, [], { paragraphs, succession, inserts: [], joins: [first.index] })));
      joins.push({ name: source.name, before, path, first: textOf(xml, first), second: textOf(xml, next), telling: telling.length > 0 });
    } else {
      unjoinable.push(source.name);
    }
  }

  /*
   * And a paragraph taken away. Chosen so the question has an answer: its text
   * is long enough to be looked for and appears exactly once in the document,
   * so "Word no longer shows it" cannot be satisfied by some other line that
   * happens to say the same thing.
   */
  const everything = paragraphs.map((span) => textOf(xml, span)).join('\n');
  const going = paragraphs.find((span) => {
    if (removalRefusal(xml, paragraphs, span.index) !== null) return false;
    /* A line break, a tab or a field is a character in Word's text and nothing
       in the runs' — measured: the first run of this could not find three
       lines Word was showing, and every one of them held a `w:br`. Such a line
       is not one this check can look for, so another is taken. */
    if (/<(?:[A-Za-z_][\w.-]*:)?(?:br|cr|tab|sym|fldChar|fldSimple|noBreakHyphen|softHyphen)[\s/>]/.test(
      xml.slice(span.start, span.end),
    )) {
      return false;
    }
    const line = textOf(xml, span).trim();
    return line.length >= 6 && everything.split(line).length === 2;
  });
  if (!going) {
    unremovable.push(source.name);
    continue;
  }
  const cut = join(work, `removed-${removals.length}.docx`);
  writeFileSync(
    cut,
    Buffer.from(
      writeDocx(archive, runs, xml, [], {
        paragraphs,
        succession,
        inserts: [],
        removals: [going.index],
      }),
    ),
  );
  removals.push({ name: source.name, before, cut, line: textOf(xml, going).trim() });
}

/* ── the three refusals, cut by hand to show why they are refused ────── */

/*
 * Each is the smallest document that shows the thing, built on the fixture's
 * own package so Word opens it for the right reasons. The cut is a plain slice —
 * deliberately NOT through the writer, which refuses all three — because the
 * question is what Word does with the result the rule prevents.
 */
const base = unzipSync(makeDocx());
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (text, inner = '') => `<w:p>${inner}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const table = (text) =>
  `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>` +
  `<w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${p(text)}</w:tc></w:tr></w:tbl>`;

function packaged(body, extra = {}) {
  const parts = { ...base };
  parts['word/document.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?>\n<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
  );
  for (const [name, text] of Object.entries(extra)) parts[name] = strToU8(text);
  return parts;
}

/** The part with one paragraph's bytes taken out, and nothing else changed. */
function cutByHand(parts, pick) {
  const xml = strFromU8(parts['word/document.xml']);
  const paragraphs = findParagraphs(xml);
  const span = paragraphs.find((one) => !one.refusal && textOf(xml, one) === pick);
  const out = { ...parts };
  out['word/document.xml'] = strToU8(xml.slice(0, span.start) + xml.slice(span.end));
  return { out, refused: removalRefusal(xml, paragraphs, span.index) };
}

const why = [];

{
  const parts = packaged(p('Prije') + table('Prva tablica') + p('Između') + table('Druga tablica') + p('Poslije'));
  const { out, refused } = cutByHand(parts, 'Između');
  why.push({ name: 'two tables', refused, original: parts, cut: out });
}
{
  const parts = packaged(p('Prije') + table('Tablica') + p('Zadnji'));
  const { out, refused } = cutByHand(parts, 'Zadnji');
  why.push({ name: 'ends on a table', refused, original: parts, cut: out });
}
{
  /* A protected document whose one editable stretch runs from the first
     paragraph into the second; the second is the one taken away. */
  const settings =
    `<?xml version="1.0" encoding="UTF-8"?>\n<w:settings ${W}>` +
    `<w:documentProtection w:edit="readOnly" w:enforcement="1"/></w:settings>`;
  const types = strFromU8(base['[Content_Types].xml']).replace(
    '</Types>',
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>',
  );
  const rels = strFromU8(base['word/_rels/document.xml.rels']).replace(
    '</Relationships>',
    '<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>',
  );
  const parts = packaged(
    `<w:p><w:permStart w:id="10" w:edGrp="everyone"/><w:r><w:t>Uredivo</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>Nosi kraj</w:t></w:r><w:permEnd w:id="10"/></w:p>` +
      p('Treći'),
    {
      'word/settings.xml': settings,
      '[Content_Types].xml': types,
      'word/_rels/document.xml.rels': rels,
    },
  );
  const { out, refused } = cutByHand(parts, 'Nosi kraj');
  why.push({ name: 'protected range', refused, original: parts, cut: out, editors: true });
}

/**
 * The part with one run divided by hand — a paragraph boundary and a fresh run
 * put inside it the way a split writes them, the writer's rules not asked. The
 * properties are copied as they stand, `w:sectPr` and all, which is exactly
 * what the rule against dividing a section-ending paragraph prevents.
 */
function divideByHand(parts, pick, at) {
  const xml = strFromU8(parts['word/document.xml']);
  const runs = findRuns(xml);
  const paragraphs = findParagraphs(xml);
  const run = runs.find((one) => one.text && runText(xml, one) === pick);
  const span = paragraphOfRun(paragraphs, run);
  const pPr = /^<w:p(?:\s[^>]*)?>(<w:pPr>[\s\S]*?<\/w:pPr>)?/.exec(xml.slice(span.start, span.end))?.[1] ?? '';
  const rPr = /<w:rPr(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:rPr>)/.exec(xml.slice(run.start, run.text.start))?.[0] ?? '';
  const t = (text) => `<w:t xml:space="preserve">${escapeXml(text)}</w:t>`;
  const out = { ...parts };
  out['word/document.xml'] = strToU8(
    xml.slice(0, run.text.start) +
      t(pick.slice(0, at)) +
      `</w:r></w:p><w:p>${pPr}<w:r>${rPr}` +
      t(pick.slice(at)) +
      xml.slice(run.text.end),
  );
  return { out, refused: splitRefusal(xml, paragraphs, run) };
}

{
  /* An internal link, so the package needs no relationship for it. */
  const parts = packaged(
    p('Prije') + `<w:p><w:hyperlink w:anchor="cilj"><w:r><w:t>poveznica ovdje</w:t></w:r></w:hyperlink></w:p>` + p('Poslije'),
  );
  const { out, refused } = divideByHand(parts, 'poveznica ovdje', 5);
  why.push({ name: 'a link divided', refused, original: parts, cut: out });
}
{
  const parts = packaged(
    p('Prvi odsječak') +
      `<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr><w:r><w:t>Kraj prvog odsječka</w:t></w:r></w:p>` +
      p('Drugi odsječak'),
  );
  const { out, refused } = divideByHand(parts, 'Kraj prvog odsječka', 5);
  why.push({ name: 'a section divided', refused, original: parts, cut: out });
}

/**
 * The part with two paragraphs joined by hand — the boundary between them
 * cut out the way a join writes it, the first one's properties kept, the
 * writer's rules not asked.
 */
function joinByHand(parts, pick) {
  const xml = strFromU8(parts['word/document.xml']);
  const paragraphs = findParagraphs(xml);
  const body = paragraphs.filter((one) => one.refusal === null);
  const at = body.findIndex((one) => textOf(xml, one) === pick);
  const [first, next] = [body[at], body[at + 1]];
  const opening = /^<w:p(?:\s[^>]*?)?(\/?)>(<w:pPr(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:pPr>))?/.exec(xml.slice(next.start, next.end))[0];
  const selfClosing = /^<w:p(?:\s[^>]*?)?\/>/.test(xml.slice(first.start, first.end));
  const out = { ...parts };
  out['word/document.xml'] = strToU8(
    selfClosing
      ? xml.slice(0, first.start) + '<w:p>' + xml.slice(next.start + opening.length)
      : xml.slice(0, first.end - '</w:p>'.length) + xml.slice(first.end, next.start) + xml.slice(next.start + opening.length),
  );
  return { out, refused: joinRefusal(xml, paragraphs, first.index), first, xml, paragraphs };
}

{
  /* An empty line before a centred one: Word, joining them itself, keeps the
     centred line centred, because it deletes the empty one. A join keeping
     the first one's properties would not — which is why the plan removes an
     empty first paragraph rather than joining it. */
  const parts = packaged(p('Prije') + '<w:p/>' + p('Središte', '<w:pPr><w:jc w:val="center"/></w:pPr>') + p('Poslije'));
  const { out, first, xml, paragraphs } = joinByHand(parts, '');
  const plan = { paragraphs, succession: { next: new Map(), fallback: '' }, inserts: [], removals: [first.index] };
  why.push({
    name: 'an empty line joined',
    empty: showsNothing(xml, first, findRuns(xml)),
    original: parts,
    cut: out,
    ours: unzipSync(writeDocx(parts, findRuns(xml), xml, [], plan)),
    joinFirst: '',
    joinSecond: 'Središte',
    describe: 'Središte',
  });
}
{
  const parts = packaged(
    p('Prvi odsječak') +
      `<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr><w:r><w:t>Kraj prvog odsječka</w:t></w:r></w:p>` +
      p('Drugi odsječak'),
  );
  const { out, refused } = joinByHand(parts, 'Prvi odsječak');
  why.push({ name: 'a section joined', refused, original: parts, cut: out });
}

for (const [i, one] of why.entries()) {
  one.originalPath = join(work, `why-${i}-original.docx`);
  one.cutPath = join(work, `why-${i}-cut.docx`);
  writeFileSync(one.originalPath, Buffer.from(zipSync(one.original)));
  writeFileSync(one.cutPath, Buffer.from(zipSync(one.cut)));
  if (one.ours) {
    one.oursPath = join(work, `why-${i}-ours.docx`);
    writeFileSync(one.oursPath, Buffer.from(zipSync(one.ours)));
  }
}

check('documents were prepared, each with one paragraph added', pairs.length > 0, `${pairs.length}`);
if (pairs.length === 0) {
  rmSync(work, { recursive: true, force: true });
  done();
}

/* ── ask Word ────────────────────────────────────────────────────────── */

/*
 * One Word for the whole run, and every dialog turned off before a file is
 * touched. `DisplayAlerts = 0` and `AutomationSecurity = 3` stop a macro prompt
 * and a repair prompt from turning this into a window waiting for a person who
 * is not there; opening read-only and out of the recent list keeps somebody
 * else's Word exactly as they left it.
 */
const script = `
$ErrorActionPreference = 'Stop'
$files = Get-Content -Raw -Encoding UTF8 '${join(work, 'files.json')}' | ConvertFrom-Json
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
$word.AutomationSecurity = 3
function Props($p) {
  return @{ text = $p.Range.Text; style = [string]$p.Style.NameLocal; align = $p.Alignment; list = $p.Range.ListFormat.ListType;
    left = $p.LeftIndent; first = $p.FirstLineIndent; before = $p.SpaceBefore; after = $p.SpaceAfter }
}
$out = @()
foreach ($file in $files) {
  $row = @{ path = $file.path }
  try {
    $doc = $word.Documents.Open($file.path, $false, $true, $false, '', '', $false, '', '', 0, 0, $false, $true, $false)
    $row.paragraphs = $doc.Paragraphs.Count
    $row.tables = $doc.Tables.Count
    $row.sections = $doc.Sections.Count
    $row.text = $doc.Content.Text
    if ($file.editors) {
      $counts = @()
      foreach ($para in $doc.Paragraphs) { $counts += $para.Range.Editors.Count }
      $row.editors = ($counts -join ',')
      $row.protection = $doc.ProtectionType
    }
    if ($file.describe -ne $null) {
      foreach ($para in $doc.Paragraphs) {
        if ($para.Range.Text -eq ($file.describe + [char]13)) { $row.described = (Props $para); break }
      }
    }
    if ($file.joinSecond -ne $null) {
      # Word joins the two itself: Backspace at the start of the second, in memory, never saved.
      # A document opened without a window of its own has no application Selection; its window has one.
      try {
        $doc.TrackRevisions = $false
        $selection = $doc.Windows.Item(1).Selection
        $prev = $null
        foreach ($para in $doc.Paragraphs) {
          if ($prev -ne $null -and $prev.Range.Text -eq ($file.joinFirst + [char]13) -and $para.Range.Text -eq ($file.joinSecond + [char]13)) {
            $start = $prev.Range.Start
            $selection.SetRange($para.Range.Start, $para.Range.Start)
            $selection.TypeBackspace()
            $row.wordJoined = (Props $doc.Range($start, $start).Paragraphs.Item(1))
            $row.wordParagraphs = $doc.Paragraphs.Count
            break
          }
          $prev = $para
        }
      } catch {
        $row.joinError = $_.Exception.Message
      }
    }
    $doc.Close(0)
  } catch {
    $row.error = $_.Exception.Message
  }
  $out += New-Object PSObject -Property $row
}
$word.Quit()
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
$out | ConvertTo-Json -Depth 4 -Compress | Set-Content -Path '${join(work, 'answers.json')}' -Encoding UTF8
`;

/* Every file Word is to open, once each — an original shared by an insertion
   and a removal is still opened only once. */
const asking = [
  ...new Set([
    ...pairs.flatMap((one) => [one.before, one.written]),
    ...removals.flatMap((one) => [one.before, one.cut]),
    ...splits.flatMap((one) => [one.before, one.path]),
    ...joins.flatMap((one) => [one.before, one.path]),
    ...why.flatMap((one) => [one.originalPath, one.cutPath, ...(one.oursPath ? [one.oursPath] : [])]),
  ]),
].map((path) => {
  /* Word is asked to join two paragraphs itself in an original, and to
     describe the joined one in ours — the same line looked for by its text. */
  const joining = joins.find((one) => one.before === path) ?? why.find((one) => one.joinSecond !== undefined && one.originalPath === path);
  const joined = joins.find((one) => one.path === path);
  const described = why.find((one) => one.describe !== undefined && (one.cutPath === path || one.oursPath === path));
  return {
    path,
    editors: why.some((one) => one.editors && (one.originalPath === path || one.cutPath === path)),
    ...(joining ? { joinFirst: joining.first ?? joining.joinFirst, joinSecond: joining.second ?? joining.joinSecond } : {}),
    ...(joined ? { describe: joined.first + joined.second } : described ? { describe: described.describe } : {}),
  };
});

writeFileSync(join(work, 'files.json'), JSON.stringify(asking), 'utf8');

const asked = spawnSync('powershell', ['-NoProfile', '-Command', script], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

/*
 * The answer comes back through a file, not through the pipe.
 *
 * PowerShell writes its standard output in the console code page, and a `Č`
 * does not survive that — the first run of this reported that Word could not
 * find text Word was in fact showing, which is the instrument measuring itself
 * again. A file written as UTF-8 and read as UTF-8 has no code page in it.
 */
let answers = [];
try {
  const raw = readFileSync(join(work, 'answers.json'), 'utf8').replace(/^\uFEFF/, '').trim();
  const parsed = JSON.parse(raw || '[]');
  answers = Array.isArray(parsed) ? parsed : [parsed];
} catch {
  answers = null;
}
if (answers === null) {
  check(
    'Word answered',
    false,
    `status ${asked.status} · ${((asked.stderr || '') + ' ' + (asked.stdout || '')).slice(0, 600)}`,
  );
  rmSync(work, { recursive: true, force: true });
  done();
}

check('Word answered about every document', answers.length === asking.length, `${answers.length}/${asking.length}`);

const answerFor = new Map(answers.map((one) => [one.path, one]));
const said = (path) => answerFor.get(path) ?? { error: 'no answer' };

const refusedOriginal = [];
const opened = [];
const refused = [];
const short = [];
const missing = [];

for (const pair of pairs) {
  const before = said(pair.before);
  const written = said(pair.written);
  /* The control first: a document Word will not open in its ORIGINAL form was
     broken before this program saw it, and saying so is the difference between
     a finding and a complaint about somebody else's file. */
  if (before.error || before.paragraphs === undefined) {
    refusedOriginal.push(`${pair.name}: ${(before.error ?? 'no answer').slice(0, 90)}`);
    continue;
  }
  if (written.error || written.paragraphs === undefined) {
    refused.push(`${pair.name}: ${(written.error ?? 'no answer').slice(0, 120)}`);
    continue;
  }

  opened.push(pair.name);
  if (written.paragraphs !== before.paragraphs + 1) {
    short.push(`${pair.name}: ${before.paragraphs} → ${written.paragraphs}`);
  }
  if (!(written.text ?? '').includes(MARKER)) missing.push(pair.name);
}

check(
  'Word opens every file we wrote, and does not refuse one it opened before',
  refused.length === 0,
  `${opened.length} opened`,
);
for (const line of refused) console.log(`  · ${line}`);

check(
  'and holds exactly one paragraph more, so nothing was quietly repaired away',
  opened.length > 0 && short.length === 0,
  `${opened.length - short.length}/${opened.length}`,
);
for (const line of short.slice(0, 8)) console.log(`  · ${line}`);

check(
  'with the text that was typed in it, diacritics and all',
  opened.length > 0 && missing.length === 0,
  `${opened.length - missing.length}/${opened.length}`,
);
for (const name of missing.slice(0, 8)) console.log(`  · ${name}`);

/* ── the removals ─────────────────────────────────────────────────────── */

const cutOpened = [];
const cutRefused = [];
const cutCount = [];
const cutStill = [];
const cutUnseen = [];

for (const removal of removals) {
  const before = said(removal.before);
  const cut = said(removal.cut);
  if (before.error || before.paragraphs === undefined) continue; // counted above
  if (cut.error || cut.paragraphs === undefined) {
    cutRefused.push(`${removal.name}: ${(cut.error ?? 'no answer').slice(0, 120)}`);
    continue;
  }
  /* The control for the text: the line has to be one Word showed in the
     original, or its absence afterwards says nothing about the writer. */
  if (!(before.text ?? '').includes(removal.line)) {
    cutUnseen.push(removal.name);
    continue;
  }
  cutOpened.push(removal.name);
  if (cut.paragraphs !== before.paragraphs - 1) {
    cutCount.push(`${removal.name}: ${before.paragraphs} → ${cut.paragraphs}`);
  }
  if ((cut.text ?? '').includes(removal.line)) cutStill.push(removal.name);
}

check(
  'Word opens every file with a paragraph taken away',
  removals.length > 0 && cutRefused.length === 0,
  `${cutOpened.length} opened`,
);
for (const line of cutRefused) console.log(`  · ${line}`);

check(
  'and holds exactly one paragraph fewer, so nothing was put back behind our back',
  cutOpened.length > 0 && cutCount.length === 0,
  `${cutOpened.length - cutCount.length}/${cutOpened.length}`,
);
for (const line of cutCount.slice(0, 8)) console.log(`  · ${line}`);

check(
  'and the line that was in it is nowhere in the document',
  cutOpened.length > 0 && cutStill.length === 0,
  `${cutOpened.length - cutStill.length}/${cutOpened.length}`,
);
for (const name of cutStill.slice(0, 8)) console.log(`  · ${name}`);

/* ── the splits ──────────────────────────────────────────────────────── */

const splitOpened = [];
const splitRefused = [];
const splitCount = [];
const splitLines = [];
const splitUnseen = [];

for (const split of splits) {
  const before = said(split.before);
  const after = said(split.path);
  if (before.error || before.paragraphs === undefined) continue; // counted above
  if (after.error || after.paragraphs === undefined) {
    splitRefused.push(`${split.name}: ${(after.error ?? 'no answer').slice(0, 120)}`);
    continue;
  }
  /* The control: the line has to be one Word showed, whole and once, in the
     original — or two lines where it stood say nothing about the writer. */
  const was = (before.text ?? '').split('\r');
  if (was.filter((line) => line === split.whole).length !== 1) {
    splitUnseen.push(split.name);
    continue;
  }
  splitOpened.push(split.name);
  if (after.paragraphs !== before.paragraphs + 1) {
    splitCount.push(`${split.name}: ${before.paragraphs} → ${after.paragraphs}`);
  }
  const now = (after.text ?? '').split('\r');
  const at = now.indexOf(split.first);
  if (at === -1 || now[at + 1] !== split.second || now.includes(split.whole)) {
    splitLines.push(`${split.name}: "${split.first}" / "${split.second}"`);
  }
}

check(
  'Word opens every file with a paragraph split',
  splits.length > 0 && splitRefused.length === 0,
  `${splitOpened.length} opened`,
);
for (const line of splitRefused) console.log(`  · ${line}`);

check(
  'and holds exactly one paragraph more',
  splitOpened.length > 0 && splitCount.length === 0,
  `${splitOpened.length - splitCount.length}/${splitOpened.length}`,
);
for (const line of splitCount.slice(0, 8)) console.log(`  · ${line}`);

check(
  'and where the line stood there are two, one after the other, divided where the cut fell',
  splitOpened.length > 0 && splitLines.length === 0,
  `${splitOpened.length - splitLines.length}/${splitOpened.length}`,
);
for (const line of splitLines.slice(0, 8)) console.log(`  · ${line}`);

/* ── the joins ───────────────────────────────────────────────────────── */

const joinOpened = [];
const joinRefused = [];
const joinCount = [];
const joinLines = [];
const joinUnseen = [];
const joinUnlike = [];
/** What Word says about a paragraph, the joined one compared key by key. */
const PROPS = ['text', 'style', 'align', 'list', 'left', 'first', 'before', 'after'];

for (const one of joins) {
  const before = said(one.before);
  const after = said(one.path);
  if (before.error || before.paragraphs === undefined) continue; // counted above
  if (after.error || after.paragraphs === undefined) {
    joinRefused.push(`${one.name}: ${(after.error ?? 'no answer').slice(0, 120)}`);
    continue;
  }
  /* The control: the two lines have to be ones Word showed, one after the
     other, in the original — and Word has to have found them there to join
     them itself, one paragraph fewer by its own count. */
  const was = (before.text ?? '').split('\r');
  const at = was.indexOf(one.first);
  if (at === -1 || was[at + 1] !== one.second || !before.wordJoined || before.wordParagraphs !== before.paragraphs - 1) {
    joinUnseen.push(one.name);
    continue;
  }
  joinOpened.push(one.name);
  if (after.paragraphs !== before.paragraphs - 1) joinCount.push(`${one.name}: ${before.paragraphs} → ${after.paragraphs}`);
  const now = (after.text ?? '').split('\r');
  if (!now.includes(one.first + one.second) || now.includes(one.first) || now.includes(one.second)) {
    joinLines.push(`${one.name}: "${one.first}" + "${one.second}"`);
  }
  const theirs = before.wordJoined;
  const ours = after.described;
  const differs = ours ? PROPS.filter((key) => String(theirs[key]) !== String(ours[key])) : ['the joined line was not found'];
  if (differs.length > 0) {
    joinUnlike.push(`${one.name}: ${differs.map((key) => `${key} Word ${JSON.stringify(theirs[key])} / ours ${JSON.stringify(ours?.[key])}`).join(', ')}`);
  }
}

check(
  'Word opens every file with two paragraphs joined',
  joins.length > 0 && joinRefused.length === 0,
  `${joinOpened.length} opened`,
);
for (const line of joinRefused) console.log(`  · ${line}`);

check(
  'and holds exactly one paragraph fewer',
  joinOpened.length > 0 && joinCount.length === 0,
  `${joinOpened.length - joinCount.length}/${joinOpened.length}`,
);
for (const line of joinCount.slice(0, 8)) console.log(`  · ${line}`);

check(
  'and where two lines stood there is one, holding both',
  joinOpened.length > 0 && joinLines.length === 0,
  `${joinOpened.length - joinLines.length}/${joinOpened.length}`,
);
for (const line of joinLines.slice(0, 8)) console.log(`  · ${line}`);

const told = joins.filter((one) => one.telling && joinOpened.includes(one.name)).length;
check(
  'and Word, joining the same two itself, gives the joined paragraph the same style, alignment, list, indents and spacing',
  joinOpened.length > 0 && joinUnlike.length === 0 && told > 0,
  `${joinOpened.length - joinUnlike.length}/${joinOpened.length} — ${told} of them two paragraphs whose properties differ`,
);
for (const line of joinUnlike.slice(0, 8)) console.log(`  · ${line}`);

/* ── why the refusals exist ─────────────────────────────────────────── */

const [tables, ending, permission, link, sectioned, emptied, joinedSection] = why;
{
  const before = said(tables.originalPath);
  const after = said(tables.cutPath);
  check(
    'Word merges two tables when the paragraph between them goes — so it is refused',
    tables.refused === 'the paragraph keeps two tables apart' && before.tables === 2 && after.tables === 1,
    `Word: ${before.tables ?? before.error} → ${after.tables ?? after.error} tables · ours: ${tables.refused ?? 'allowed'}`,
  );
}
{
  const before = said(ending.originalPath);
  const after = said(ending.cutPath);
  check(
    'Word puts a paragraph back behind a final table — so removing it is refused',
    ending.refused === 'the document would end without a paragraph' &&
      before.paragraphs !== undefined &&
      after.paragraphs === before.paragraphs,
    `Word: ${before.paragraphs ?? before.error} → ${after.paragraphs ?? after.error} paragraphs · ours: ${ending.refused ?? 'allowed'}`,
  );
}
{
  const before = said(permission.originalPath);
  const after = said(permission.cutPath);
  const first = (answer) => Number(String(answer.editors ?? '').split(',')[0]);
  check(
    "Word revokes an untouched paragraph's permission when the far half goes — so it is refused",
    permission.refused === 'a marked stretch continues outside the paragraph' &&
      first(before) > 0 &&
      first(after) === 0,
    `Word: editors per paragraph ${before.editors ?? before.error} → ${after.editors ?? after.error} · ours: ${permission.refused ?? 'allowed'}`,
  );
}
{
  const before = said(link.originalPath);
  const after = said(link.cutPath);
  check(
    'Word will not open a link divided between two paragraphs — so a run inside one is not split',
    link.refused === 'the run is inside an element a cut would tear in two' &&
      before.paragraphs !== undefined &&
      after.error !== undefined,
    `Word: ${before.paragraphs !== undefined ? 'opens the original' : before.error} → ${(after.error ?? `${after.paragraphs} paragraphs`).slice(0, 90)} · ours: ${link.refused ?? 'allowed'}`,
  );
}
{
  const before = said(sectioned.originalPath);
  const after = said(sectioned.cutPath);
  check(
    'Word counts a section more when a section-ending paragraph is split with its properties — so it is not split',
    sectioned.refused === 'the paragraph ends a section' &&
      before.sections !== undefined &&
      after.sections === before.sections + 1,
    `Word: ${before.sections ?? before.error} → ${after.sections ?? after.error} sections · ours: ${sectioned.refused ?? 'allowed'}`,
  );
}
{
  const original = said(emptied.originalPath);
  const byHand = said(emptied.cutPath);
  const ours = said(emptied.oursPath);
  const align = (props) => (props ? ['left', 'centred', 'right', 'justified'][props.align] ?? props.align : 'not found');
  check(
    "Word keeps the second paragraph's properties after an empty one — so an empty first paragraph is removed, not joined",
    emptied.empty === true && original.wordJoined?.align === 1 && ours.described?.align === 1 && byHand.described?.align === 0,
    `Word's own join: ${align(original.wordJoined)} · ours, a removal: ${align(ours.described)} · a join keeping the first: ${align(byHand.described)}`,
  );
}
{
  const before = said(joinedSection.originalPath);
  const after = said(joinedSection.cutPath);
  check(
    'Word counts a section fewer when a section-ending paragraph is joined onto the one before — so it is refused',
    joinedSection.refused === 'the paragraph ends a section' && before.sections !== undefined && after.sections === before.sections - 1,
    `Word: ${before.sections ?? before.error} → ${after.sections ?? after.error} sections · ours: ${joinedSection.refused ?? 'allowed'}`,
  );
}

if (refusedOriginal.length > 0) {
  console.log(`\n${refusedOriginal.length} Word will not open in their original form either:`);
  for (const line of refusedOriginal) console.log(`  · ${line}`);
}
if (cutUnseen.length > 0) {
  console.log(
    `\n${cutUnseen.length} had a line Word did not show even in the original, so its absence could not be asked about:`,
  );
  for (const name of cutUnseen) console.log(`  · ${name}`);
}
if (unremovable.length > 0) {
  console.log(`\n${unremovable.length} offer no paragraph with a line of its own that may go:`);
  for (const name of unremovable) console.log(`  · ${name}`);
}
if (splitUnseen.length > 0) {
  console.log(`\n${splitUnseen.length} had a split line Word did not show whole and once in the original:`);
  for (const name of splitUnseen) console.log(`  · ${name}`);
}
if (unsplittable.length > 0) {
  console.log(`\n${unsplittable.length} offer no line of its own that may be split:`);
  for (const name of unsplittable) console.log(`  · ${name}`);
}
if (joinUnseen.length > 0) {
  console.log(`\n${joinUnseen.length} had two lines Word did not show one after the other, or would not join itself:`);
  for (const name of joinUnseen) console.log(`  · ${name}`);
}
if (unjoinable.length > 0) {
  console.log(`\n${unjoinable.length} offer no two lines of their own that may be joined:`);
  for (const name of unjoinable) console.log(`  · ${name}`);
}
if (nowhere.length > 0) {
  console.log(`\n${nowhere.length} have no paragraph a new one may follow — every one of theirs is in a table:`);
  for (const name of nowhere) console.log(`  · ${name}`);
}

rmSync(work, { recursive: true, force: true });
done();
