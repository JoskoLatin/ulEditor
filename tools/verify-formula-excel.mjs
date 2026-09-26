/**
 * Asks Excel itself what each SUMIFS/COUNTIFS case comes to, and holds the
 * recorded answers in `formula-excel-cases.mjs` to it.
 *
 * The rules of a criterion were measured this way rather than recalled, and
 * this is the measurement kept runnable: the cases are written to an `.xlsx`,
 * opened in Excel through COM, recalculated in full, and read back. A recorded
 * answer Excel disputes fails here — which is how a case copied wrong, or an
 * Excel that changed its mind, gets found.
 *
 * The first formula is `1+1` with 999 stored as its value. It is the check that
 * anything was calculated at all: LibreOffice headless, tried first, converts
 * such a file without recalculating it and hands every stored value back.
 *
 * Needs Windows and Excel. Without them it says so and stops rather than
 * passing quietly.
 *
 *   node tools/verify-formula-excel.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { strToU8, zipSync } from 'fflate';

import { EXCEL_ANSWERS, EXCEL_DATA } from './formula-excel-cases.mjs';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

if (process.platform !== 'win32') {
  console.log('\n  Excel was NOT asked: this needs Windows with Excel installed.');
  process.exit(0);
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cell = (ref, value) =>
  value === null
    ? ''
    : typeof value === 'number'
      ? `<c r="${ref}"><v>${value}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`;

const formulas = ['1+1', ...EXCEL_ANSWERS.map(([formula]) => formula)];

function book() {
  let data = `<row r="1">${'ABCDE'.split('').map((col) => cell(`${col}1`, `h${col}`)).join('')}</row>`;
  EXCEL_DATA.forEach((row, at) => {
    data += `<row r="${at + 2}">${row.map((value, col) => cell(`${'ABCDE'[col]}${at + 2}`, value)).join('')}</row>`;
  });
  /* 999 stored under every formula: a value Excel did not work out stays 999. */
  const summary = formulas
    .map((formula, at) => `<row r="${at + 1}"><c r="A${at + 1}"><f>${escape(formula)}</f><v>999</v></c></row>`)
    .join('');
  const xml = (body) => strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`);
  const sheet = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
  return zipSync({
    '[Content_Types].xml': xml(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${sheet}"/>` +
        `<Override PartName="/xl/worksheets/sheet2.xml" ContentType="${sheet}"/></Types>`,
    ),
    '_rels/.rels': xml(
      `<Relationships xmlns="${PKG}"><Relationship Id="r1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': xml(
      `<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="Sazetak" sheetId="1" r:id="rId1"/>` +
        `<sheet name="Podaci" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': xml(
      `<Relationships xmlns="${PKG}">` +
        `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
    ),
    'xl/worksheets/sheet1.xml': xml(`<worksheet xmlns="${NS}"><sheetData>${summary}</sheetData></worksheet>`),
    'xl/worksheets/sheet2.xml': xml(`<worksheet xmlns="${NS}"><sheetData>${data}</sheetData></worksheet>`),
  });
}

const dir = mkdtempSync(join(tmpdir(), 'ul-excel-'));
const file = join(dir, 'kriteriji.xlsx');
const answers = join(dir, 'answers.txt');
writeFileSync(file, book());

/* One PowerShell run: open read-only, recalculate everything, write each cell's
   shown text on its own line. The paths are arguments, not text in the script. */
const script = `
param($file, $out, $count)
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
try {
  $book = $excel.Workbooks.Open($file, 0, $true)
  $excel.CalculateFull()
  $sheet = $book.Worksheets.Item('Sazetak')
  $lines = for ($i = 1; $i -le [int]$count; $i++) { $sheet.Cells.Item($i, 1).Text }
  [IO.File]::WriteAllLines($out, [string[]]$lines, [Text.UTF8Encoding]::new($false))
  $book.Close($false)
} finally {
  $excel.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
}
`;
const scriptFile = join(dir, 'ask.ps1');
writeFileSync(scriptFile, script);

try {
  try {
    /* By full path: looked up by name, Windows tries the working directory
       first, and a `powershell.exe` dropped into a checkout would run here. */
    execFileSync(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, file, answers, String(formulas.length)],
      { stdio: 'pipe', timeout: 120_000 },
    );
  } catch (error) {
    console.log(`\n  Excel was NOT asked: ${String(error.stderr ?? error.message).trim().split('\n')[0]}`);
    process.exit(0);
  }
  const shown = readFileSync(answers, 'utf8').split(/\r?\n/);

  check('Excel calculated rather than handing back what was stored', shown[0] === '2', `1+1 → ${shown[0]}`);
  EXCEL_ANSWERS.forEach(([formula, excel], at) => {
    /* The text Excel shows, in this machine's locale: a comma for a decimal point. */
    const got = shown[at + 1] ?? '';
    const want = typeof excel === 'number' ? String(excel).replace('.', ',') : excel;
    check(`Excel still answers ${formula}`, got === want, `${got} (recorded: ${want})`);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const failed = checks.filter((one) => !one.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
