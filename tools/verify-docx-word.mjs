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

for (const [i, one] of why.entries()) {
  one.originalPath = join(work, `why-${i}-original.docx`);
  one.cutPath = join(work, `why-${i}-cut.docx`);
  writeFileSync(one.originalPath, Buffer.from(zipSync(one.original)));
  writeFileSync(one.cutPath, Buffer.from(zipSync(one.cut)));
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
$out = @()
foreach ($file in $files) {
  $row = @{ path = $file.path }
  try {
    $doc = $word.Documents.Open($file.path, $false, $true, $false, '', '', $false, '', '', 0, 0, $false, $true, $false)
    $row.paragraphs = $doc.Paragraphs.Count
    $row.tables = $doc.Tables.Count
    $row.text = $doc.Content.Text
    if ($file.editors) {
      $counts = @()
      foreach ($para in $doc.Paragraphs) { $counts += $para.Range.Editors.Count }
      $row.editors = ($counts -join ',')
      $row.protection = $doc.ProtectionType
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
    ...why.flatMap((one) => [one.originalPath, one.cutPath]),
  ]),
].map((path) => ({
  path,
  editors: why.some((one) => one.editors && (one.originalPath === path || one.cutPath === path)),
}));

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

/* ── why the three refusals exist ───────────────────────────────────── */

const [tables, ending, permission] = why;
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
if (nowhere.length > 0) {
  console.log(`\n${nowhere.length} have no paragraph a new one may follow — every one of theirs is in a table:`);
  for (const name of nowhere) console.log(`  · ${name}`);
}

rmSync(work, { recursive: true, force: true });
done();
