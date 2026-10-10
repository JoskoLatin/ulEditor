/**
 * A save is compared with the reading it continues (ADR 0006), **in the
 * desktop application**.
 *
 * The core keeps a reading of each document a tab opened, named by a token
 * the tab's scope carries; the editors know nothing of it. So this drives
 * the real editors and the real core:
 *
 * - a Markdown, a TypeScript and a PNG document, and a Word, an Excel, an
 *   OpenDocument sheet and a PDF one, each opened, edited, and replaced on
 *   disk by another file renamed over it: Ctrl+S asks, and Cancel leaves the
 *   replacement as it is — the scope carried the reading, whichever editor
 *   held the document;
 * - a document open and unchanged, its path written without a reading, as
 *   the scratch panel or an export writes it: the tab's next save asks —
 *   the write moved nobody's reading;
 * - a save naming a reading nobody made is refused, and is not the
 *   question: nothing would be offered to write over;
 * - a reading taken, the page reloaded: the reading is gone with the page.
 *
 * Windows only, against the program as it ships, under an identifier of its
 * own (an ulEditor the person has open is left alone).
 *
 *   node tools/verify-desktop-save.mjs            (builds first, ~1-2 min)
 *   node tools/verify-desktop-save.mjs --no-build (the binary is current)
 */

import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

import { makeDocx, makeOds, makePdf, makeXlsx } from './fixtures.mjs';
import { buildDesktop, openFromOutside, startDesktop, stopDesktop } from './desktop-session.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IDENTIFIER = 'org.uleditor.app.check';
const CHANGED_OUTSIDE = 'ul:changed-outside:';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

async function until(condition, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** A small PNG of one colour, made here so that nothing binary is committed. */
function png(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (!process.argv.includes('--no-build')) {
  console.log('building the program as it ships …');
  await buildDesktop(IDENTIFIER);
}

const workspace = await mkdtemp(join(tmpdir(), 'ul-save-'));
const files = {
  'notes.md': '# Bilješke\n\nPrvi redak.\n',
  'code.ts': 'export const answer = 42;\n',
  'slika.png': png(8, 4, [255, 0, 0]),
  'izvjestaj.docx': makeDocx(),
  'tablica.xlsx': makeXlsx(),
  'proracun.ods': makeOds(),
  'crtez.pdf': makePdf('Original'),
  'untouched.md': 'Nobody edits this.\n',
};

/** The same file with one byte more: a different file under the same name. The
 *  program compares what it read with what is there; it does not parse it. */
const another = (bytes) => Buffer.concat([Buffer.from(bytes), Buffer.from([0])]);
for (const [name, content] of Object.entries(files)) await writeFile(join(workspace, name), content);

let session;
try {
  session = await startDesktop({ port: 9357, identifier: IDENTIFIER, built: true });
  const { page } = session;
  const invoke = (cmd, args) =>
    page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  const refusal = (cmd, args) =>
    page.evaluate(
      ([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a).then(() => null, (err) => String(err)),
      [cmd, args],
    );
  await openFromOutside(page, [workspace]);
  check('attached to the program as it ships', true);

  const open = async (name) => {
    await page.keyboard.press('Control+P');
    await page.locator('.palette-input input').fill(name);
    await page.locator('.palette-item', { hasText: name }).first().click();
    await until(async () => (await page.locator('.tab', { hasText: name }).count()) > 0);
  };
  const asked = () => page.locator('.toast', { hasText: 'was changed outside ulEditor' });
  /* Ctrl+S, and until the question about a replaced file stands. A PDF with a
     note asks about notes first; that one is answered, the one this check is
     about is not. */
  const ask = async () => {
    await page.keyboard.press('Control+s');
    const notes = page.locator('.toast .toast-btn', { hasText: 'Save anyway' });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if ((await asked().count()) > 0) return true;
      if ((await notes.count()) > 0) await notes.first().click();
      await page.waitForTimeout(200);
    }
    return false;
  };
  const replace = async (name, content) => {
    const aside = join(workspace, `${name}.replacement`);
    await writeFile(aside, content);
    await rename(aside, join(workspace, name));
  };

  /* ── each editor carries its reading ─────────────────────────────── */

  const editors = [
    {
      name: 'notes.md',
      edit: async () => {
        await page.locator('.cm-content').first().click();
        await page.keyboard.type('Drugi redak. ');
      },
      replacement: 'somebody else wrote this\n',
    },
    {
      name: 'code.ts',
      edit: async () => {
        await page.locator('.cm-content:visible').first().click();
        await page.keyboard.type('// edited\n');
      },
      replacement: 'export const theirs = 1;\n',
    },
    {
      name: 'slika.png',
      edit: async () => {
        await page.locator('.ul-img-rotate-right:visible').first().click();
      },
      replacement: png(8, 4, [0, 0, 255]),
    },
    {
      /* A double-click opens a run of text for typing; clicking away ends it. */
      name: 'izvjestaj.docx',
      edit: async () => {
        await page.locator('.ul-office-run:visible').first().dblclick();
        await page.keyboard.press('Control+A');
        await page.keyboard.type('Izmijenjeno u ulEditoru');
        await page.locator('.ul-office-notes strong:visible').first().click();
      },
      replacement: another(files['izvjestaj.docx']),
    },
    {
      /* A cell opens on a double-click and ends at Enter. */
      name: 'tablica.xlsx',
      edit: async () => {
        await page.locator('.ul-sheet td[data-ref]:visible').filter({ hasText: /\S/ }).first().dblclick();
        await page.keyboard.type('Izmijenjeno');
        await page.keyboard.press('Enter');
      },
      replacement: another(files['tablica.xlsx']),
    },
    {
      name: 'proracun.ods',
      edit: async () => {
        await page.locator('.ul-sheet td[data-ref]:visible').filter({ hasText: /\S/ }).first().dblclick();
        await page.keyboard.type('Izmijenjeno');
        await page.keyboard.press('Enter');
      },
      replacement: another(files['proracun.ods']),
    },
    {
      /* A note is the smallest edit a PDF takes. Its save asks about notes
         first (ADR 0004), and that is answered before the question this
         check is about — see `ask`. */
      name: 'crtez.pdf',
      edit: async () => {
        await page.waitForSelector('.ul-pdf-page:visible[data-rendered="true"]', { timeout: 30000 });
        await page.waitForTimeout(1000);
        await page.locator('.ul-pdf-tool[title^="Note"]:visible').first().click();
        await page.locator('.ul-pdf-page:visible').first().click({ position: { x: 60, y: 60 } });
        await page.waitForSelector('.ul-pdf-note-popup textarea', { timeout: 10000 });
        await page.locator('.ul-pdf-note-popup textarea').fill('Bilješka');
        await page.locator('.ul-pdf-note-popup button', { hasText: 'Save' }).click();
      },
      replacement: makePdf('Replacement'),
    },
  ];
  for (const editor of editors) {
    await open(editor.name);
    await page.waitForTimeout(1500);
    await editor.edit();
    await replace(editor.name, editor.replacement);
    const question = await ask();
    check(`${editor.name}: a save over a file replaced since it was read asks first`, question);
    if (question) await asked().first().locator('button', { hasText: 'Cancel' }).click();
    const disk = await readFile(join(workspace, editor.name));
    check(
      `${editor.name}: and Cancel leaves the replacement as it is`,
      Buffer.compare(disk, Buffer.from(editor.replacement)) === 0,
    );
    await page.waitForTimeout(500);
  }

  /* ── a write nobody read moves no reading ────────────────────────── */

  await open('untouched.md');
  await page.waitForTimeout(1500);
  const exported = await refusal('write_file', {
    path: join(workspace, 'untouched.md'),
    contents: Array.from(Buffer.from('An export, written over it.\n')),
  });
  check('a write naming no reading goes through, as the scratch panel writes', exported === null, exported ?? '');
  await page.locator('.cm-content:visible').first().click();
  await page.keyboard.type('mine ');
  await page.keyboard.press('Control+s');
  check(
    "and the open tab's next save is asked about it",
    await until(async () => (await asked().count()) > 0, 10000),
  );
  if ((await asked().count()) > 0) await asked().first().locator('button', { hasText: 'Cancel' }).click();
  check(
    'and the export is still there',
    (await readFile(join(workspace, 'untouched.md'), 'utf8')) === 'An export, written over it.\n',
  );

  /* ── a reading nobody made ───────────────────────────────────────── */

  const target = join(workspace, 'notes.md');
  const before = await readFile(target);
  const unknown = await refusal('write_file', {
    path: target,
    contents: Array.from(Buffer.from('forged')),
    overwrite: true,
    reading: 987654,
  });
  check('a save naming a reading nobody made is refused', unknown !== null, unknown ?? 'written');
  check('and is not the question a changed file is', unknown !== null && !unknown.startsWith(CHANGED_OUTSIDE));
  check('and nothing is written', Buffer.compare(await readFile(target), before) === 0);

  /* ── a reading does not outlive its page ─────────────────────────── */

  const reading = await page.evaluate(async (path) => {
    const buffer = await window.__TAURI_INTERNALS__.invoke('read_document', { path, reading: null });
    return Number(new DataView(new Uint8Array(buffer).buffer, 0, 8).getBigUint64(0, true));
  }, target);
  check('a reading is made and handed over', Number.isInteger(reading) && reading > 0, String(reading));
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 30000 });
  const gone = await refusal('write_file', {
    path: target,
    contents: Array.from(Buffer.from('after the reload')),
    reading,
  });
  check('after the page reloads it is unknown', gone !== null && /not read here/.test(gone), gone ?? 'written');
  check('and nothing is written', Buffer.compare(await readFile(target), before) === 0);

  await page.screenshot({ path: resolve(ROOT, 'tools/screenshots/desktop-save.png') });
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await session?.page
    ?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-desktop-save.png') })
    .catch(() => {});
} finally {
  await stopDesktop(session);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
