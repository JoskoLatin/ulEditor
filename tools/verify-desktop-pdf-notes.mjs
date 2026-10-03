/**
 * PDF notes across saves, **in the desktop application**, read back from disk.
 *
 * Two things went wrong between the editor and the file, and neither showed on
 * screen:
 *
 * - **A note made before the first save was gone after the second.** Every save
 *   starts from the bytes as they were opened, and after a save the editor marked
 *   what it had written as imported — so the next save, starting from the opened
 *   bytes again, did not write it.
 * - **A note the file already had could not be edited or deleted.** The edit was
 *   written beside the original, and a deleted one was still in the file and came
 *   back the next time it was opened.
 *
 * `verify-pdf-annotations.mjs` holds the save functions to the same promises on
 * bytes in memory; this drives the editor itself — the note tool, the note's
 * popup, Ctrl+S — and reads what reached the disk.
 *
 *   node tools/verify-desktop-pdf-notes.mjs
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PDFDocument, PDFName, PDFArray } from 'pdf-lib';

import { makePdf } from './fixtures.mjs';
import { startDesktop, stopDesktop } from './desktop-session.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { writeAnnotations } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-pdf/src/annotations.ts')).href
);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The texts of the notes on disk, in page order. */
async function notesOnDisk(path) {
  const doc = await PDFDocument.load(await readFile(path));
  const found = [];
  for (const page of doc.getPages()) {
    const list = page.node.lookup(PDFName.of('Annots'));
    if (!(list instanceof PDFArray)) continue;
    for (const entry of list.asArray()) {
      const dict = doc.context.lookup(entry);
      if (String(dict?.get?.(PDFName.of('Subtype'))) !== '/Text') continue;
      found.push(dict.get(PDFName.of('Contents'))?.decodeText() ?? '');
    }
  }
  return found;
}

/* A file that already holds one note — written the way the editor writes one, so
   it is a real `/Text` with an object of its own. */
const fileNote = {
  id: 'from-file',
  kind: 'note',
  page: 1,
  color: [0.98, 0.79, 0.29],
  createdAt: Date.UTC(2026, 9, 3),
  rect: { x: 60, y: 150, width: 20, height: 20 },
  text: 'from the file',
};
const noted = (await writeAnnotations(new TextEncoder().encode(makePdf('A note in the file')), [fileNote])).bytes;

const workspace = await mkdtemp(join(tmpdir(), 'ul-pdf-notes-'));
const blank = join(workspace, 'twice.pdf');
const toEdit = join(workspace, 'edit-note.pdf');
const toDelete = join(workspace, 'delete-note.pdf');
await writeFile(blank, makePdf('Two saves'));
await writeFile(toEdit, noted);
await writeFile(toDelete, noted);

let session;
try {
  session = await startDesktop({ port: 9343 });
  const { page } = session;
  check('attached to the desktop application', true);

  await page.evaluate(
    (dir) => window.__TAURI_INTERNALS__.invoke('adopt_paths', { paths: [dir] }),
    workspace,
  );

  const open = async (name) => {
    await page.keyboard.press('Control+P');
    await page.waitForSelector('.palette-input input', { timeout: 10000 });
    await page.locator('.palette-input input').fill(name);
    await page.waitForSelector('.palette-item', { timeout: 15000 });
    await page.locator('.palette-item').first().click();
    await page.waitForSelector('.ul-pdf-page:visible[data-rendered="true"]', { timeout: 30000 });
  };

  /** Ctrl+S, then waits for different bytes on disk. */
  const save = async (path) => {
    const before = await readFile(path);
    await page.keyboard.press('Control+S');
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const now = await readFile(path).catch(() => before);
      if (!now.equals(before)) return true;
    }
    return false;
  };

  const activeDirty = async () =>
    (await page.locator('.tab[data-active="true"]').first().getAttribute('data-dirty')) === 'true';

  const addNote = async (text, position) => {
    await page.locator('.ul-pdf-tool:visible[title^="Note"]').first().click();
    await page.locator('.ul-pdf-page:visible').first().click({ position });
    await page.waitForSelector('.ul-pdf-note-popup textarea', { timeout: 10000 });
    await page.locator('.ul-pdf-note-popup textarea').fill(text);
    await page.locator('.ul-pdf-note-popup button', { hasText: 'Save' }).click();
  };

  /* ── two saves in one session ──────────────────────────────────────── */

  await open('twice.pdf');
  await addNote('first, before the first save', { x: 90, y: 90 });
  check('the first save reached the disk', await save(blank));
  check('and the document is clean after it', !(await activeDirty()));
  check('the first note is on disk', JSON.stringify(await notesOnDisk(blank)) === '["first, before the first save"]', JSON.stringify(await notesOnDisk(blank)));

  await addNote('second, before the second save', { x: 180, y: 90 });
  check('a new note makes it dirty again', await activeDirty());
  check('the second save reached the disk', await save(blank));
  const twice = await notesOnDisk(blank);
  check(
    'both notes are on disk after the second save',
    twice.length === 2 && twice.includes('first, before the first save') && twice.includes('second, before the second save'),
    JSON.stringify(twice),
  );

  /* ── a note the file had, edited ───────────────────────────────────── */

  await open('edit-note.pdf');
  await page.waitForSelector('.ul-pdf-ann-note:visible', { timeout: 15000 });
  await page.locator('.ul-pdf-ann-note:visible').first().click();
  await page.waitForSelector('.ul-pdf-note-popup textarea', { timeout: 10000 });
  await page.locator('.ul-pdf-note-popup textarea').fill('edited in ulEditor');
  await page.locator('.ul-pdf-note-popup button', { hasText: 'Save' }).click();
  check('the edited note was saved', await save(toEdit));
  const edited = await notesOnDisk(toEdit);
  check('the edit replaced the note the file had', JSON.stringify(edited) === '["edited in ulEditor"]', JSON.stringify(edited));

  /* ── a note the file had, deleted ──────────────────────────────────── */

  await open('delete-note.pdf');
  await page.waitForSelector('.ul-pdf-ann-note:visible', { timeout: 15000 });
  await page.locator('.ul-pdf-ann-note:visible').first().click();
  await page.waitForSelector('.ul-pdf-note-popup', { timeout: 10000 });
  await page.locator('.ul-pdf-note-popup button', { hasText: 'Delete' }).click();
  check('the deletion was saved', await save(toDelete));
  const deleted = await notesOnDisk(toDelete);
  check('the note is gone from the file', deleted.length === 0, JSON.stringify(deleted));
  /* Unlinked is not enough: an object nobody points at is still in the bytes,
     and a note somebody deleted should not be readable there. */
  const after = await PDFDocument.load(await readFile(toDelete));
  const stillThere = after.context
    .enumerateIndirectObjects()
    .some(([, object]) => object?.get?.(PDFName.of('Contents'))?.decodeText?.() === 'from the file');
  check('and no object in the file still holds its text', !stillThere);
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await session?.page
    ?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-desktop-pdf-notes.png') })
    .catch(() => {});
} finally {
  await stopDesktop(session);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
