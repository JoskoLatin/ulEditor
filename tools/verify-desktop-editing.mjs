/**
 * "Open for editing…", **in the desktop application** (card 501, ADR 0005).
 *
 * A document opened only to be read — here the PDF a conversion makes, which
 * the core offers read-only — can be made one that saves, and only by the
 * person: the core draws the system's own file dialog on it and grants what
 * is picked there. So:
 *
 * - Ctrl+S on it says it is read-only and offers "Open for editing…";
 * - the dialog is the system's, titled with the document's name, and Cancel
 *   in it grants nothing — the file still cannot be written;
 * - Open grants it, the tab saves, and the file is written;
 * - the page naming a file it may not read gets no dialog and nothing;
 * - a document that can be written already is answered without asking.
 *
 * The conversion needs LibreOffice, which is installed here; without it the
 * check says so and stops. Windows only, like the other desktop checks, and
 * under an identifier of its own, so an ulEditor the person has open is left
 * alone. Against the program as it ships: under `tauri dev` the shell's own
 * modules were seen loaded twice, and a tab opened through one copy was not
 * there for a save asked through the other.
 *
 *   node tools/verify-desktop-editing.mjs            (builds first, ~1-2 min)
 *   node tools/verify-desktop-editing.mjs --no-build (the binary is current)
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { answerFileDialog, buildDesktop, openFromOutside, startDesktop, stopDesktop } from './desktop-session.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const EPS = [
  '%!PS-Adobe-3.0 EPSF-3.0',
  '%%BoundingBox: 0 0 240 120',
  '%%Title: Proba',
  '/Helvetica findfont 18 scalefont setfont',
  '20 70 moveto',
  '(Pozdrav iz EPS-a) show',
  'showpage',
  '%%EOF',
  '',
].join('\n');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

async function until(condition, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const IDENTIFIER = 'org.uleditor.app.check';
if (!process.argv.includes('--no-build')) {
  console.log('building the program as it ships …');
  await buildDesktop(IDENTIFIER);
}

let session;
try {
  session = await startDesktop({ port: 9355, identifier: IDENTIFIER, built: true });
  const { page } = session;
  const invoke = (cmd, args) =>
    page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  const refused = (cmd, args) =>
    page.evaluate(
      ([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a).then(() => false, () => true),
      [cmd, args],
    );
  check('attached to the desktop application', true);

  const workspace = await mkdtemp(join(tmpdir(), 'ul-editing-'));
  await writeFile(join(workspace, 'crtez.eps'), EPS, 'utf8');
  await writeFile(join(workspace, 'notes.txt'), 'Prvi redak.\n', 'utf8');
  await openFromOutside(page, [workspace]);

  /* ── a document that can be written is answered without asking ───── */

  const writable = await invoke('open_for_editing', { path: join(workspace, 'notes.txt'), uiLanguage: 'en' });
  check(
    'a document that can be written already is answered at once',
    writable?.readonly === false,
    JSON.stringify(writable?.name),
  );
  check('without a dialog', answerFileDialog(false, 2) === 'no dialog');

  /* ── a file the page may not read gets nothing ───────────────────── */

  const outside = join(process.env.SystemRoot ?? 'C:\\Windows', 'win.ini');
  check(
    'a file the page may not read is refused',
    await refused('open_for_editing', { path: outside, uiLanguage: 'en' }),
  );
  check('and no dialog is drawn for it', answerFileDialog(false, 2) === 'no dialog');

  /* ── a converted PDF, read-only ──────────────────────────────────── */

  await page.keyboard.press('Control+P');
  await page.locator('.palette-input input').fill('crtez.eps');
  await page.locator('.palette-item').first().click();
  const offered = await until(async () => (await page.locator('.ul-vec-convert').count()) > 0, 20000);
  if (!offered) {
    check('LibreOffice is installed, which this check needs', false);
    throw new Error('no LibreOffice');
  }
  await page.locator('.ul-vec-convert').first().click();
  const converted = await until(
    async () => (await page.locator('.tab').allInnerTexts()).some((t) => /crtez\.pdf/i.test(t)),
    180000,
  );
  check('the conversion opens a PDF tab', converted);
  /* Its editor is made after the tab: a save asked for before it is there
     finds no editor and does nothing. */
  check(
    'and its page is drawn',
    await until(async () => (await page.locator('.ul-pdf-page[data-rendered="true"]').count()) > 0, 60000),
  );
  /* A tab's title is the path of its document. */
  const pdfPath = await page.locator('.tab', { hasText: 'crtez.pdf' }).first().getAttribute('title');
  const original = await readFile(pdfPath);
  check('which is open read-only', (await page.locator('.status-item', { hasText: 'read-only' }).count()) > 0);
  check(
    'and its file cannot be written',
    await refused('write_file', { path: pdfPath, contents: Array.from(original) }),
  );

  /* ── Ctrl+S offers it; Cancel grants nothing ─────────────────────── */

  await page.locator('.tab', { hasText: 'crtez.pdf' }).first().click();
  await page.keyboard.press('Control+s');
  const toast = page.locator('.toast', { hasText: 'is open read-only' });
  await toast.first().waitFor({ timeout: 10000 });
  const action = toast.locator('button', { hasText: 'Open for editing' });
  check('saving it says it is read-only, and offers "Open for editing…"', (await action.count()) === 1);
  await action.first().click();
  const enterAlone = answerFileDialog(true, 20);
  check(
    'the system draws its own file dialog, titled with the document',
    enterAlone.startsWith('pressed: Open for editing: crtez.pdf'),
    enterAlone,
  );
  check('with no file chosen in it beforehand', /name box:\s*$/.test(enterAlone), enterAlone);
  const stillOpen = answerFileDialog(false, 5);
  check('so Enter alone grants nothing: the dialog is still there', stillOpen.startsWith('pressed'), stillOpen);
  await page.waitForTimeout(1500);
  check(
    'Cancel grants nothing: still read-only',
    (await page.locator('.status-item', { hasText: 'read-only' }).count()) > 0,
  );
  check(
    'and the file still cannot be written',
    await refused('write_file', { path: pdfPath, contents: Array.from(original) }),
  );

  /* Asked again the moment it was cancelled — what script would do to wear
     the person down — it is refused without a dialog. */
  const again = await page.evaluate(
    (path) =>
      window.__TAURI_INTERNALS__.invoke('open_for_editing', { path, uiLanguage: 'en' }).then(
        () => 'asked',
        (err) => String(err),
      ),
    pdfPath,
  );
  check('asked again at once, it is refused', /does not ask for a while/.test(again), again);
  check('without a dialog', answerFileDialog(false, 2) === 'no dialog');
  console.log('  (waiting out the half minute after a Cancel …)');
  await page.waitForTimeout(31000);

  /* ── Open grants it ──────────────────────────────────────────────── */

  await page.keyboard.press('Control+Shift+P');
  await page.locator('.palette input').fill('Open for editing');
  const listed = await page.locator('.palette-item', { hasText: 'Open for editing' }).count();
  check('the command is in the palette for a read-only document', listed > 0);
  await page.keyboard.press('Enter');
  const opened = answerFileDialog(true, 20, 'crtez.pdf');
  check('the file picked in the dialog, and Open', opened.startsWith('pressed'), opened);
  check(
    'the tab can be saved now',
    await until(async () => (await page.locator('.status-item', { hasText: 'read-only' }).count()) === 0, 10000),
  );
  check('and says so', (await page.locator('.toast', { hasText: 'can be saved now' }).count()) > 0);
  check(
    'and the file is written',
    !(await refused('write_file', { path: pdfPath, contents: Array.from(original) })),
  );

  await page.keyboard.press('Control+Shift+P');
  await page.locator('.palette input').fill('Open for editing');
  await page.waitForTimeout(500);
  check(
    'and the command is no longer offered for it',
    (await page.locator('.palette-item', { hasText: 'Open for editing' }).count()) === 0,
  );
  await page.keyboard.press('Escape');

  await page.screenshot({ path: resolve(ROOT, 'tools/screenshots/desktop-editing.png') });
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await session?.page
    ?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-desktop-editing.png') })
    .catch(() => {});
} finally {
  answerFileDialog(false, 1);
  await stopDesktop(session);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
