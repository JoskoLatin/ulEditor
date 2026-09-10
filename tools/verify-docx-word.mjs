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
 * Windows and Word only. Rather than skipping quietly where there is no Word —
 * a check whose only failure mode is a pass is a check that lies — it says so
 * and fails, the same way `pnpm readback` refuses to pass without LibreOffice.
 *
 *   node tools/verify-docx-word.mjs "C:/Users/you/Documents"
 */

import { unzipSync, strFromU8 } from 'fflate';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeDocx } from './fixtures.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { findRuns, findParagraphs, paragraphOfRun, readStyleSuccession, writeDocx } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-office/src/docx-edit.ts')).href
);

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
$pairs = Get-Content -Raw -Encoding UTF8 '${join(work, 'pairs.json')}' | ConvertFrom-Json
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
$word.AutomationSecurity = 3
$out = @()
foreach ($pair in $pairs) {
  $row = @{ name = $pair.name }
  foreach ($which in 'before', 'written') {
    try {
      $doc = $word.Documents.Open($pair.$which, $false, $true, $false, '', '', $false, '', '', 0, 0, $false, $true, $false)
      $row[$which + 'Paragraphs'] = $doc.Paragraphs.Count
      $row[$which + 'Text'] = $doc.Content.Text
      $doc.Close(0)
    } catch {
      $row[$which + 'Error'] = $_.Exception.Message
    }
  }
  $out += New-Object PSObject -Property $row
}
$word.Quit()
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
$out | ConvertTo-Json -Depth 4 -Compress | Set-Content -Path '${join(work, 'answers.json')}' -Encoding UTF8
`;

writeFileSync(
  join(work, 'pairs.json'),
  JSON.stringify(pairs.map((p) => ({ name: p.name, before: p.before, written: p.written }))),
  'utf8',
);

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
  check(
    'Word answered',
    false,
    `status ${asked.status} · ${((asked.stderr || '') + ' ' + (asked.stdout || '')).slice(0, 600)}`,
  );
  rmSync(work, { recursive: true, force: true });
  done();
}

check('Word answered about every document', answers.length === pairs.length, `${answers.length}/${pairs.length}`);

const refusedOriginal = [];
const opened = [];
const refused = [];
const short = [];
const missing = [];

for (const answer of answers) {
  /* The control first: a document Word will not open in its ORIGINAL form was
     broken before this program saw it, and saying so is the difference between
     a finding and a complaint about somebody else's file. */
  if (answer.beforeError || answer.beforeParagraphs === undefined) {
    refusedOriginal.push(`${answer.name}: ${(answer.beforeError ?? 'no answer').slice(0, 90)}`);
    continue;
  }
  if (answer.writtenError || answer.writtenParagraphs === undefined) {
    refused.push(`${answer.name}: ${(answer.writtenError ?? 'no answer').slice(0, 120)}`);
    continue;
  }

  opened.push(answer.name);
  if (answer.writtenParagraphs !== answer.beforeParagraphs + 1) {
    short.push(`${answer.name}: ${answer.beforeParagraphs} → ${answer.writtenParagraphs}`);
  }
  if (!(answer.writtenText ?? '').includes(MARKER)) missing.push(answer.name);
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

if (refusedOriginal.length > 0) {
  console.log(`\n${refusedOriginal.length} Word will not open in their original form either:`);
  for (const line of refusedOriginal) console.log(`  · ${line}`);
}
if (nowhere.length > 0) {
  console.log(`\n${nowhere.length} have no paragraph a new one may follow — every one of theirs is in a table:`);
  for (const name of nowhere) console.log(`  · ${name}`);
}

rmSync(work, { recursive: true, force: true });
done();
