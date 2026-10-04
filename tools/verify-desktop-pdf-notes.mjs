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
 * And three that the fix for those left, found by the checks added after it:
 *
 * - **Inserting a PDF brought a deleted note back**, and doubled an edited one:
 *   the insert reads every page again, from bytes that still hold the originals.
 * - **Undo, after scrolling, deleted a note nobody had touched.** A page's notes
 *   are read when it is first drawn, and the step undone to knew nothing of them.
 * - **Inserting after the last page was not a change.** The page order then
 *   reads as an untouched document's, so closing did not ask.
 *
 * `verify-pdf-annotations.mjs` holds the save functions to the same promises on
 * bytes in memory; this drives the editor itself — the note tool, the note's
 * popup, Ctrl+S — and reads what reached the disk.
 *
 *   node tools/verify-desktop-pdf-notes.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PDFDocument, PDFName, PDFArray, StandardFonts } from 'pdf-lib';

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

/**
 * Types `path` into the open-file dialog of the debug build and presses Open.
 *
 * The common dialog keeps its file name box at control 1148 (a combo box with
 * an edit inside) and Open at 1 (`IDOK`), as it has since Windows Vista. It is
 * waited for, up to fifteen seconds, since it opens on a thread of its own.
 */
function answerFileDialog(path) {
  const script = `
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class UlDialog {
  delegate bool Each(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Each f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr p, IntPtr after, string cls, string title);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static string Answer(uint pid, string path) {
    IntPtr dialog = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner != pid || !IsWindowVisible(h)) return true;
      var name = new StringBuilder(64); GetClassName(h, name, 64);
      if (name.ToString() != "#32770") return true;
      dialog = h; return false;
    }, IntPtr.Zero);
    if (dialog == IntPtr.Zero) return "no dialog";
    IntPtr box = GetDlgItem(dialog, 1148);
    if (box == IntPtr.Zero) return "no file name box";
    IntPtr inner = FindWindowEx(box, IntPtr.Zero, "ComboBox", null);
    IntPtr edit = FindWindowEx(inner == IntPtr.Zero ? box : inner, IntPtr.Zero, "Edit", null);
    if (edit == IntPtr.Zero) return "no edit in the file name box";
    SendMessage(edit, 0x000C, IntPtr.Zero, path);
    PostMessage(GetDlgItem(dialog, 1), 0x00F5, IntPtr.Zero, IntPtr.Zero);
    return "answered";
  }
}
'@
$app = (Get-CimInstance Win32_Process -Filter "Name='uleditor-desktop.exe'" | Where-Object { $_.ExecutablePath -like '*\\target\\debug\\*' } | Select-Object -First 1).ProcessId
$said = 'no application'
for ($i = 0; $app -and $i -lt 60; $i++) {
  $said = [UlDialog]::Answer([uint32]$app, '${path.replace(/'/g, "''")}')
  if ($said -eq 'answered') { break }
  Start-Sleep -Milliseconds 250
}
$said`;
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  return (out.stdout ?? '').trim().split(/\r?\n/).pop() || (out.stderr ?? '').trim();
}

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

/* Eight pages with a note on the last: the editor reads a page's notes when the
   page is first drawn, so this one is not known until somebody scrolls to it. */
const long = await PDFDocument.create();
const helvetica = await long.embedFont(StandardFonts.Helvetica);
for (let n = 1; n <= 8; n++) {
  long.addPage([300, 200]).drawText(`Page ${n}`, { x: 30, y: 110, size: 22, font: helvetica });
}
const lastNote = { ...fileNote, id: 'on-the-last-page', page: 8, text: 'on the last page' };
const longNoted = (await writeAnnotations(await long.save(), [lastNote])).bytes;

const workspace = await mkdtemp(join(tmpdir(), 'ul-pdf-notes-'));
const blank = join(workspace, 'twice.pdf');
const toEdit = join(workspace, 'edit-note.pdf');
const toDelete = join(workspace, 'delete-note.pdf');
const deleteThenInsert = join(workspace, 'delete-then-insert.pdf');
const editThenInsert = join(workspace, 'edit-then-insert.pdf');
const insertAtEnd = join(workspace, 'insert-at-end.pdf');
const longOne = join(workspace, 'long-with-note.pdf');
const inserted = join(workspace, 'inserted.pdf');
await writeFile(blank, makePdf('Two saves'));
await writeFile(toEdit, noted);
await writeFile(toDelete, noted);
await writeFile(deleteThenInsert, noted);
await writeFile(editThenInsert, noted);
await writeFile(insertAtEnd, makePdf('One page'));
await writeFile(longOne, longNoted);
await writeFile(inserted, makePdf('Inserted'));

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
    // The toolbar is still being put together when the first page shows.
    await sleep(1000);
  };

  /**
   * Ctrl+S, then waits for different bytes on disk.
   *
   * A save with notes is followed by the question about what it could not
   * reproduce (notes are written without an appearance stream). It stays until
   * answered, and four of them cover the toolbar, so it is answered here.
   */
  const save = async (path) => {
    const before = await readFile(path);
    await page.keyboard.press('Control+S');
    let written = false;
    for (let i = 0; i < 60 && !written; i++) {
      await sleep(250);
      const now = await readFile(path).catch(() => before);
      written = !now.equals(before);
    }
    const asked = page.locator('.toast .toast-btn', { hasText: 'Save anyway' });
    const shown = await asked.first().waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false);
    if (shown) await asked.first().click();
    return written;
  };

  const activeDirty = async () =>
    (await page.locator('.tab[data-active="true"]').first().getAttribute('data-dirty')) === 'true';

  const addNote = async (text, position) => {
    await page.locator('.ul-pdf-tool[title^="Note"]:visible').first().click();
    await page.locator('.ul-pdf-page:visible').first().click({ position });
    await page.waitForSelector('.ul-pdf-note-popup textarea', { timeout: 10000 });
    await page.locator('.ul-pdf-note-popup textarea').fill(text);
    await page.locator('.ul-pdf-note-popup button', { hasText: 'Save' }).click();
  };

  const notesOnScreen = () => page.locator('.ul-pdf-ann-note:visible').count();

  /** Opens a note the file had and answers its popup. */
  const openFirstNote = async () => {
    await page.waitForSelector('.ul-pdf-ann-note:visible', { timeout: 15000 });
    await page.locator('.ul-pdf-ann-note:visible').first().click();
    await page.waitForSelector('.ul-pdf-note-popup', { timeout: 10000 });
  };

  /**
   * "Insert PDF" from the page rail, answered in the system's own file dialog.
   *
   * Tauri's `invoke` cannot be replaced from the page — it is defined neither
   * writable nor configurable — so the dialog really opens, and this types the
   * path into it and presses Open the way somebody would.
   */
  const insertPdf = async (path) => {
    const before = await page.locator('.ul-pdf-page:visible').count();
    await page.locator('.ul-pdf-toolbar:visible .ul-pdf-btn').first().click();
    await page.locator('.ul-pdf-rail-actions:visible button', { hasText: 'Insert PDF' }).click();
    const answered = answerFileDialog(path);
    if (answered !== 'answered') throw new Error(`the file dialog was not answered: ${answered}`);
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      if ((await page.locator('.ul-pdf-page:visible').count()) > before) break;
    }
    await page.locator('.ul-pdf-toolbar:visible .ul-pdf-btn').first().click();
    await page.waitForSelector('.ul-pdf-page:visible[data-rendered="true"]', { timeout: 30000 });
    await sleep(1000);
    return page.locator('.ul-pdf-page:visible').count();
  };

  const pagesOnDisk = async (path) => (await PDFDocument.load(await readFile(path))).getPageCount();

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

  /* ── undo, after a note further on was read ────────────────────────── */
  /* A step back restores the notes as they were at that step. A note on a page
     nobody had scrolled to yet was not among them — and must not be taken for
     one somebody deleted. */

  await open('long-with-note.pdf');
  await addNote('a step to undo', { x: 90, y: 90 });
  await page.locator('.ul-pdf-page:visible').last().scrollIntoViewIfNeeded();
  await page.waitForSelector('.ul-pdf-page:visible[data-page="8"][data-rendered="true"]', { timeout: 30000 });
  await sleep(500);
  check('the note on the last page is read once it is reached', (await notesOnScreen()) === 2, `${await notesOnScreen()} on screen`);
  // A note is two steps, placing it and writing it, and both are taken back.
  await page.locator('button[title="Undo (Ctrl+Z)"]').click();
  await page.locator('button[title="Undo (Ctrl+Z)"]').click();
  await sleep(500);
  check('undo takes back only the step it undoes', (await notesOnScreen()) === 1, `${await notesOnScreen()} on screen`);
  check('and leaves the document as it is on disk', !(await activeDirty()));
  await page.locator('.ul-pdf-page:visible').first().scrollIntoViewIfNeeded();
  await addNote('after the undo', { x: 90, y: 90 });
  check('a save after the undo reached the disk', await save(longOne));
  const afterUndo = await notesOnDisk(longOne);
  check(
    'and the note nobody touched is still in the file',
    afterUndo.length === 2 && afterUndo.includes('on the last page') && afterUndo.includes('after the undo'),
    JSON.stringify(afterUndo),
  );

  /* ── a note the file had, deleted, then another PDF inserted ───────── */
  /* Inserting rebuilds the document from new bytes and reads its notes again,
     and the original of a deleted note is still in those bytes. */

  await open('delete-then-insert.pdf');
  await openFirstNote();
  await page.locator('.ul-pdf-note-popup button', { hasText: 'Delete' }).click();
  check('after an insert the document has both PDFs', (await insertPdf(inserted)) === 2);
  check('a deleted note does not come back with the insert', (await notesOnScreen()) === 0, `${await notesOnScreen()} on screen`);
  check('the insert was saved', await save(deleteThenInsert));
  check(
    'and the file has the pages and not the note',
    (await pagesOnDisk(deleteThenInsert)) === 2 && (await notesOnDisk(deleteThenInsert)).length === 0,
    JSON.stringify(await notesOnDisk(deleteThenInsert)),
  );

  /* ── a note the file had, edited, then another PDF inserted ────────── */

  await open('edit-then-insert.pdf');
  await openFirstNote();
  await page.locator('.ul-pdf-note-popup textarea').fill('edited before the insert');
  await page.locator('.ul-pdf-note-popup button', { hasText: 'Save' }).click();
  await insertPdf(inserted);
  check('an edited note is not doubled by an insert', (await notesOnScreen()) === 1, `${await notesOnScreen()} on screen`);
  check('the edit and the insert were saved', await save(editThenInsert));
  const editedThenInserted = await notesOnDisk(editThenInsert);
  check(
    'and the file has the edited note once',
    JSON.stringify(editedThenInserted) === '["edited before the insert"]',
    JSON.stringify(editedThenInserted),
  );

  /* ── inserting after the last page ─────────────────────────────────── */
  /* The page order is then the order of the bytes, which is how an untouched
     document looks — but the bytes are not the ones on disk. */

  await open('insert-at-end.pdf');
  check('a one-page document starts clean', !(await activeDirty()));
  await insertPdf(inserted);
  check('inserting after the last page leaves the document changed', await activeDirty());
  check('and the save writes both pages', (await save(insertAtEnd)) && (await pagesOnDisk(insertAtEnd)) === 2);

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
