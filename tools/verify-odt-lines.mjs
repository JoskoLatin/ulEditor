/**
 * The lines of an OpenDocument text, in the editor a person types into —
 * Enter, Backspace and Delete where they are pressed.
 *
 * [`verify-odt-paragraphs.mjs`](./verify-odt-paragraphs.mjs) proves what the
 * writer does with a plan, and [`verify-docx-lines.mjs`](./verify-docx-lines.mjs)
 * proves the plans the keys make — for a Word document. The editor is one
 * class for both, and reads only the seam, so what is asked here is whether
 * the OpenDocument seam answers the keys the way the page then shows: every
 * save is compared with the page, the lines a person sees against the body
 * paragraphs of the file that would be written.
 *
 *   node tools/verify-odt-lines.mjs [--url http://localhost:5273] [--headed]
 */

import { chromium } from 'playwright';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeOdtParagraphs } from './fixtures.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { findOdtParagraphs } = await import(pathToFileURL(resolve(ROOT, 'packages/editor-office/src/odt-edit.ts')).href);

const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5273';
const headed = args.includes('--headed');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── the document ────────────────────────────────────────────────────── */

const BODY =
  `<text:h text:style-name="P1" text:outline-level="1">Naslov dokumenta</text:h>` +
  `<text:p text:style-name="Text_20_body">Prvi odlomak teksta.</text:p>` +
  `<text:p text:style-name="Text_20_body">Drugi odlomak teksta.</text:p>` +
  `<text:p text:style-name="Text_20_body"/>` +
  `<text:h text:style-name="Heading_20_2" text:outline-level="2">Podnaslov</text:h>` +
  `<text:p text:style-name="Text_20_body">Treći odlomak <text:span text:style-name="T1">s podebljanim.</text:span></text:p>` +
  `<text:list><text:list-item><text:p text:style-name="Text_20_body">Stavka popisa</text:p></text:list-item></text:list>` +
  `<table:table table:name="Tablica"><table:table-column table:number-columns-repeated="2"/>` +
  `<table:table-row><table:table-cell office:value-type="string"><text:p>Lijevo gore</text:p></table:table-cell>` +
  `<table:table-cell office:value-type="string"><text:p>Desno gore</text:p></table:table-cell></table:table-row></table:table>` +
  `<text:p text:style-name="Text_20_body">Zadnji odlomak.</text:p>`;

const AUTOMATIC =
  `<office:automatic-styles>` +
  `<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Heading_20_1">` +
  `<style:paragraph-properties fo:text-align="center"/></style:style>` +
  `<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>` +
  `</office:automatic-styles>`;

/* The fixture's package — its styles, manifest and namespaces — with this body. */
const base = unzipSync(makeOdtParagraphs());
const content = strFromU8(base['content.xml'])
  .replace(/<office:automatic-styles>[\s\S]*<\/office:automatic-styles>/, AUTOMATIC)
  .replace(/<office:text>[\s\S]*<\/office:text>/, `<office:text>${BODY}</office:text>`);
const styles = strFromU8(base['styles.xml']).replace(
  '</office:styles>',
  `<style:style style:name="Heading_20_2" style:display-name="Heading 2" style:family="paragraph" ` +
    `style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:default-outline-level="2"/></office:styles>`,
);
const odt = zipSync({
  mimetype: [base.mimetype, { level: 0 }],
  'META-INF/manifest.xml': base['META-INF/manifest.xml'],
  'content.xml': strToU8(content),
  'styles.xml': strToU8(styles),
});

/* ── the page ────────────────────────────────────────────────────────── */

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

const lines = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.ul-office-doc [data-paragraph], .ul-office-doc [data-piece-of], .ul-office-doc [data-new]')]
      .filter((el) => !el.closest('.is-removed, .is-joined'))
      .map((el) => `${el.tagName}:${el.textContent}`),
  );
const texts = async () => (await lines()).map((line) => line.slice(line.indexOf(':') + 1));
const status = () =>
  page.evaluate(async () => {
    const { useWorkspace, activeTabId } = await import('/src/state/workspace.ts');
    return useWorkspace.getState().tabs.find((tab) => tab.id === activeTabId())?.status ?? '';
  });

/** The file a save would write: `content.xml`, and its body paragraphs — kind, style and text. */
const saved = async () => {
  const bytes = await page.evaluate(async () => {
    const { activeInstance } = await import('/src/state/workspace.ts');
    const instance = activeInstance();
    let written = null;
    instance.host = { ...instance.host, fs: { ...instance.host.fs, writeBytes: async (_uri, data) => { written = data; } } };
    await instance.save();
    return Array.from(written);
  });
  const xml = strFromU8(unzipSync(new Uint8Array(bytes))['content.xml']);
  const body = findOdtParagraphs(xml)
    .filter((one) => one.refusal === null)
    .map((one) => ({
      kind: one.kind,
      style: one.style,
      text: one.selfClosing
        ? ''
        : xml
            .slice(one.start, one.end)
            .replace(/<[\w-]+:s\s*\/>/g, ' ')
            .replace(/<[^>]+>/g, ''),
    }));
  return { xml, body };
};
const agrees = async (file) => JSON.stringify(await texts()) === JSON.stringify(file.body.map((one) => one.text));

const run = (text) => page.locator('.ul-office-doc .ul-office-run', { hasText: text }).first();
const typeIn = async (text, where) => {
  await run(text).dblclick();
  await page.keyboard.press(where === 'end' ? 'End' : 'Home');
};
const done = () => page.evaluate(() => document.activeElement?.blur?.());
const press = async (key) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(150);
};
const undoAll = async (original) => {
  await done();
  for (let i = 0; i < 6 && JSON.stringify(await lines()) !== JSON.stringify(original); i++) await press('Control+Z');
  return JSON.stringify(await lines()) === JSON.stringify(original);
};

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shell', { timeout: 20000 });
  await page.evaluate((bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'odlomci.odt'));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, Array.from(odt));
  await page.waitForSelector('.ul-office-doc', { timeout: 20000 });

  const original = await lines();
  check(
    'the document is open, a line for every paragraph of its body — the list item not among them',
    original.length === 7 && original[0] === 'H1:Naslov dokumenta' && original[3] === 'P:' && !original.some((one) => one.includes('Stavka')),
    JSON.stringify(original),
  );

  /* ── Backspace at the start of a paragraph of the file ───────────── */

  await typeIn('Drugi odlomak', 'start');
  await press('Backspace');
  check(
    'Backspace at the start of a paragraph joins it onto the one above',
    (await texts())[1] === 'Prvi odlomak teksta.Drugi odlomak teksta.',
    JSON.stringify(await texts()),
  );
  await page.keyboard.type('Č');
  let file = await saved();
  check(
    'what is typed there is written there, in one paragraph where there were two',
    file.body[1]?.text === 'Prvi odlomak teksta.ČDrugi odlomak teksta.' && file.body.length === original.length - 1,
    JSON.stringify(file.body.slice(0, 3)),
  );
  check('and the page shows exactly what the file holds', await agrees(file));
  check('Ctrl+Z takes back the typing and then the join', await undoAll(original), JSON.stringify(await texts()));

  /* ── Enter at the end of a heading ──────────────────────────────────── */

  await typeIn('Naslov dokumenta', 'end');
  await press('Enter');
  await page.keyboard.type('Novi odlomak');
  file = await saved();
  check(
    'Enter at the end of a heading makes a line, and what is typed there is a paragraph of the file',
    file.body[1]?.text === 'Novi odlomak' && file.body.length === original.length + 1,
    JSON.stringify(file.body.slice(0, 3)),
  );
  check(
    'of the style the heading hands on — body text, not a second heading',
    file.body[1]?.kind === 'p' && file.body[1]?.style === 'Text_20_body',
    JSON.stringify(file.body[1]),
  );
  check('and the page shows exactly what the file holds', await agrees(file), JSON.stringify(await texts()));
  check('Ctrl+Z takes it back', await undoAll(original), JSON.stringify(await texts()));

  /* ── Enter in the middle of a sentence ──────────────────────────────── */

  await typeIn('Prvi odlomak', 'start');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await press('Enter');
  file = await saved();
  check(
    'Enter in the middle of a sentence divides the paragraph where the caret is',
    file.body[1]?.text === 'Prvi' && file.body[2]?.text === ' odlomak teksta.' && file.body[2]?.style === 'Text_20_body',
    JSON.stringify(file.body.slice(0, 4)),
  );
  check('and the page shows exactly what the file holds', await agrees(file), JSON.stringify(await texts()));
  check('Ctrl+Z puts it back together', await undoAll(original), JSON.stringify(await texts()));

  /* ── Backspace after an empty line ──────────────────────────────────── */

  await typeIn('Podnaslov', 'start');
  await press('Backspace');
  file = await saved();
  check(
    'Backspace after an empty line takes the empty line away, and the heading stays a heading',
    file.body.length === original.length - 1 &&
      file.body[3]?.text === 'Podnaslov' &&
      file.body[3]?.kind === 'h' &&
      file.body[3]?.style === 'Heading_20_2',
    JSON.stringify(file.body.slice(2, 5)),
  );
  check('and the page shows exactly what the file holds', await agrees(file), JSON.stringify(await texts()));
  check('Ctrl+Z brings the empty line back', await undoAll(original), JSON.stringify(await texts()));

  /* ── Enter at the end of bold text ──────────────────────────────────── */

  await typeIn('s podebljanim', 'end');
  await press('Enter');
  await page.keyboard.type('Nastavak');
  file = await saved();
  check(
    'a line after bold text goes on in bold — the same span, in a paragraph of its own',
    file.xml.includes(
      '<text:p text:style-name="Text_20_body"><text:span text:style-name="T1">Nastavak</text:span></text:p>',
    ),
    file.body.map((one) => one.text).join(' | '),
  );
  check('and the page shows exactly what the file holds', await agrees(file), JSON.stringify(await texts()));
  check('Ctrl+Z takes it back', await undoAll(original), JSON.stringify(await texts()));

  /* ── a row in a table ───────────────────────────────────────────────── */

  await run('Lijevo gore').click();
  await press('Control+Enter');
  const planned = page.locator('.ul-office-doc [data-new-row]');
  check(
    'Ctrl+Enter in a cell adds a row below, with a cell for every cell of the row',
    (await planned.count()) === 1 && (await planned.locator('td').count()) === 2,
    `${await planned.count()} rows, ${await planned.locator('td').count()} cells`,
  );
  await page.keyboard.type('Novi redak');
  await planned.locator('.ul-office-run').nth(1).dblclick();
  await page.keyboard.type('čćž');
  await done();
  file = await saved();
  const rows = [...file.xml.matchAll(/<table:table-row[\s>][\s\S]*?<\/table:table-row>/g)].map((m) => m[0]);
  check(
    'the file has the row, after the one the caret was in, with what was typed into each cell',
    rows.length === 2 && rows[1].includes('<text:p>Novi redak</text:p>') && rows[1].includes('<text:p>čćž</text:p>'),
    rows[1] ?? 'no second row',
  );
  check('and no merge is offered for these cells', !(await page.evaluate(async () => {
    const { activeInstance } = await import('/src/state/workspace.ts');
    return activeInstance().canMergeCells?.() ?? false;
  })));
  for (let i = 0; i < 6 && (await planned.count()) > 0; i++) await press('Control+Z');
  check('Ctrl+Z takes the row back', (await planned.count()) === 0 && (await saved()).xml.match(/<table:table-row[\s>]/g).length === 1);

  /* ── a boundary the seam refuses ────────────────────────────────────── */

  await typeIn('s podebljanim', 'end');
  await press('Delete');
  const said = await status();
  check(
    'Delete before a list and a table says why it does nothing, and does nothing',
    /list|table/i.test(said) && JSON.stringify(await lines()) === JSON.stringify(original),
    said,
  );
  await done();

  check(
    'the bar names the keys this document has, and no merge',
    !(await page.locator('.ul-office').first().innerText()).includes('Ctrl+M'),
  );

  /* ── a part the scanner and the parser could read differently ───────── */

  const ghost = zipSync({
    mimetype: [base.mimetype, { level: 0 }],
    'META-INF/manifest.xml': base['META-INF/manifest.xml'],
    'content.xml': strToU8(
      content.replace(
        '<text:p text:style-name="Text_20_body">Drugi odlomak teksta.</text:p>',
        '<?x a><text:p>duh</text:p>?><text:p text:style-name="Text_20_body">Drugi odlomak teksta.</text:p>',
      ),
    ),
    'styles.xml': strToU8(styles),
  });
  await page.evaluate((bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'duh.odt'));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, Array.from(ghost));
  await page.waitForFunction(() => document.querySelectorAll('.ul-office').length >= 2, null, { timeout: 20000 });
  const shown = page.locator('.ul-office:visible').first();
  check(
    'a document with a processing instruction in its part is shown, and offers nothing to edit',
    (await shown.locator('[data-paragraph], [data-row], .ul-office-run[data-run]').count()) === 0 &&
      /shown, not edited/.test(await shown.innerText()),
    (await shown.innerText()).slice(0, 160),
  );

  check('nothing threw in the page', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await page.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-odt-lines.png') }).catch(() => {});
} finally {
  await browser.close();
}

const failed = checks.filter((one) => !one.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
