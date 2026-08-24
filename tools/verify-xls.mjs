/**
 * The old binary Excel reader, checked against a file built byte by byte.
 *
 * The fixture is assembled by hand (see `makeXls` in fixtures.mjs), so every
 * assertion here reads back something that was deliberately put in: the shared
 * strings — one of them cut in half by a CONTINUE record, which is the split
 * that garbles real workbooks — the number under its format, the date packed
 * as an RK integer, the merge, and the two honest refusals: a BIFF5 file and
 * a compound file with no workbook in it.
 *
 *   node tools/verify-xls.mjs
 */

import { unzipSync, strFromU8 } from 'fflate';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeXls } from './fixtures.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { readXls } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-office/src/xls.ts')).href
);
const { buildXlsx, convertedName } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-office/src/xlsx-write.ts')).href
);
/* `findCells` reads a worksheet by scanning its text, with no DOM — which is
   why the structure of the written file can be checked here at all. Reading it
   back through `readXlsx` needs a browser, so that half is checked in
   verify-ui.mjs, where one genuinely runs. */
const { findCells } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-office/src/xlsx-edit.ts')).href
);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── the whole file, read back ───────────────────────────────────────── */

const workbook = readXls(makeXls());
const sheet = workbook.sheets[0];

check('the sheet is found under its name', sheet?.name === 'List1', sheet?.name);
check('the workbook carries no archive to write back into', workbook.archive === undefined);
check(
  'so it says a save means a conversion, and what that costs',
  workbook.convert?.losses.length === 2 &&
    workbook.convert.losses.some((loss) => /Styling/.test(loss)),
  JSON.stringify(workbook.convert?.losses),
);

const text = (row, col) => sheet.cells.get(`${row},${col}`)?.text;
const kind = (row, col) => sheet.cells.get(`${row},${col}`)?.kind;

check('a compressed shared string arrives', text(0, 0) === 'Mjesec', text(0, 0));
check('a wide one keeps its diacritics', text(1, 0) === 'Siječanj', text(1, 0));
check(
  'the amount is drawn under its number format',
  text(1, 1) === '1.234,50' && kind(1, 1) === 'number',
  `${text(1, 1)} (${kind(1, 1)})`,
);
check(
  'an RK integer under a date format is a date',
  text(1, 2) === '15.06.2026.' && kind(1, 2) === 'date',
  `${text(1, 2)} (${kind(1, 2)})`,
);
check('the merge is carried over', JSON.stringify(sheet.merges[0]) === '{"row":2,"col":0,"rows":1,"cols":2}', JSON.stringify(sheet.merges[0]));

/* ── the split string ────────────────────────────────────────────────── */

/* A shared string cut mid-word by a CONTINUE record, resuming under its own
   flags byte. Reading the table as one flat buffer garbles exactly this. */
const split = readXls(makeXls({ splitSst: true }));
const splitSheet = split.sheets[0];
check(
  'a string cut in half by a CONTINUE comes back whole',
  splitSheet.cells.get('1,0')?.text === 'Siječanj',
  splitSheet.cells.get('1,0')?.text,
);
check(
  'and the string after the cut is not shifted',
  splitSheet.cells.get('3,0')?.text === 'uniquexls',
  splitSheet.cells.get('3,0')?.text,
);

/* ── the refusals ────────────────────────────────────────────────────── */

{
  let message = '';
  try {
    readXls(makeXls({ biff5: true }));
  } catch (err) {
    message = err.message;
  }
  check('a BIFF5 file is refused with directions', /Excel 5\.0\/95/.test(message), message);
}

{
  let message = '';
  try {
    readXls(new Uint8Array(600));
  } catch (err) {
    message = err.message;
  }
  check('a file with no workbook stream says so', message.length > 0, message);
}

/* ── the conversion ──────────────────────────────────────────────────── */

/*
 * What makes the old format editable: the grid is written out as a fresh
 * .xlsx. The check is not that a file appeared but that the whole grid is in
 * it — a conversion that silently drops a column would pass any weaker
 * assertion — and that the parts a spreadsheet program insists on are there,
 * since a workbook missing one of them does not open at all.
 */
{
  const bytes = buildXlsx(workbook.sheets);
  const archive = unzipSync(bytes);

  check(
    'the converted file has the parts a workbook must have',
    ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml'].every(
      (path) => archive[path],
    ),
    Object.keys(archive).join(', '),
  );

  const sheetXml = strFromU8(archive['xl/worksheets/sheet1.xml']);
  const spans = findCells(sheetXml);
  const written = spans.rows.reduce((n, row) => n + row.cells.length, 0);
  check('with every cell that was in the grid', written === sheet.cells.size, `${written} of ${sheet.cells.size}`);

  check(
    'the diacritics survive the conversion',
    sheetXml.includes('<t xml:space="preserve">Siječanj</t>'),
  );
  check('the amount keeps its value', sheetXml.includes('<v>1234.5</v>'));
  check('and the date stays the serial its format draws', sheetXml.includes('<v>46188</v>'));

  /* A number without its format is a serial number where a date should be, so
     the styles the cells point at have to be in the file. */
  const styles = strFromU8(archive['xl/styles.xml']);
  const dateCell = spans.rows.find((r) => r.r === 2)?.cells.find((c) => c.ref === 'C2');
  check(
    'the date cell points at a style, and that style is a date format',
    !!dateCell?.style && new RegExp(`<xf numFmtId="14"`).test(styles),
    `s="${dateCell?.style}"`,
  );
  check(
    'a custom format travels as its own numFmt',
    /<numFmt numFmtId="16[4-9]" formatCode="#,##0.00"\/>/.test(styles),
    styles.slice(styles.indexOf('<numFmts'), styles.indexOf('</numFmts>') + 10),
  );

  /* The formula's last result goes in as a plain number, and nothing pretends
     to be a formula — which is what the warning promised would happen. */
  check(
    'a formula arrives as the value it last worked out, not as a formula',
    sheetXml.includes('<v>2469</v>') && !sheetXml.includes('<f>'),
    sheetXml.slice(sheetXml.indexOf('<row r="3"'), sheetXml.indexOf('<row r="3"') + 90),
  );

  check(
    'the merge is carried into the new file',
    sheetXml.includes('<mergeCell ref="A3:B3"/>'),
    sheetXml.slice(sheetXml.indexOf('<mergeCells')),
  );
  check('and the sheet keeps its name', strFromU8(archive['xl/workbook.xml']).includes('name="List1"'));
}

{
  /* An edit made in the grid is what actually reaches the new file — the
     point of the whole exercise. */
  const edited = readXls(makeXls());
  edited.sheets[0].cells.set('1,1', { text: '2000', kind: 'number', raw: 2000, fmt: '#,##0.00' });
  const sheetXml = strFromU8(unzipSync(buildXlsx(edited.sheets))['xl/worksheets/sheet1.xml']);
  check(
    'a retyped value is what the converted file holds',
    sheetXml.includes('<v>2000</v>') && !sheetXml.includes('<v>1234.5</v>'),
    sheetXml.slice(sheetXml.indexOf('<row r="2"'), sheetXml.indexOf('<row r="2"') + 160),
  );
}

{
  /*
   * A number format with quotes in it — `#,##0.00 "EUR"`, which is what every
   * Croatian price list is written in. The quotes go into an XML attribute,
   * and unescaped they close it early: the workbook then does not open at
   * all. Found by converting a real till report and handing it to Excel,
   * which refused it; the hand-built fixture had no such format to catch it.
   */
  const quoted = readXls(makeXls());
  quoted.sheets[0].cells.set('1,1', {
    text: '1.245,30 EUR',
    kind: 'number',
    raw: 1245.3,
    fmt: '[$-01041a]#,##0.00 "EUR"',
  });
  quoted.sheets[0].name = 'Promet "lipanj"';
  const archive = unzipSync(buildXlsx(quoted.sheets));
  const styles = strFromU8(archive['xl/styles.xml']);
  const workbookXml = strFromU8(archive['xl/workbook.xml']);

  check(
    'a number format containing quotes does not break its attribute',
    styles.includes('&quot;EUR&quot;') && !/formatCode="[^"]*"EUR"/.test(styles),
    styles.slice(styles.indexOf('<numFmts'), styles.indexOf('</numFmts>')),
  );
  check(
    'and neither does a sheet name containing them',
    workbookXml.includes('&quot;lipanj&quot;'),
    /name="[^"]*"/.exec(workbookXml)?.[0],
  );
}

check('the suggested name swaps the extension', convertedName('Promet 2025.xls') === 'Promet 2025.xlsx');
check('whatever its case', convertedName('CJENIK.XLS') === 'CJENIK.xlsx', convertedName('CJENIK.XLS'));

{
  /* Sheet names Excel refuses make a file unopenable rather than imperfect. */
  const awkward = readXls(makeXls());
  awkward.sheets[0].name = 'Promet/2025: [ožujak]';
  const workbookXml = strFromU8(unzipSync(buildXlsx(awkward.sheets))['xl/workbook.xml']);
  const written = /name="([^"]*)"/.exec(workbookXml)?.[1] ?? '';
  check(
    'a sheet name Excel forbids is made legal rather than passed through',
    written.length > 0 && !/[\\/?*[\]:]/.test(written),
    written,
  );
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
