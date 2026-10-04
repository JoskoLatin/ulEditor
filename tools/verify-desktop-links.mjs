/**
 * The window stays the application's, and the sandbox is only what was asked
 * for, **in the desktop application**.
 *
 * Four things the second security review found (card 470), each driven here
 * through the real shell:
 *
 * - **The window followed a link.** A link in a Markdown preview replaced the
 *   whole interface with the page — no address bar to say where it was, the
 *   unsaved work behind it. The shell now sends a link to the browser
 *   (`routeExternalLinks`) and Rust refuses any navigation off the
 *   application's own pages (`stays_in_app`). Both are checked, each on its
 *   own: a click is taken over in the page, and a navigation the page starts
 *   anyway goes nowhere. Only `http` links are clicked, which open nothing —
 *   an `https` one would open the browser on the machine running this.
 * - **A folder taken off the tree stayed in the sandbox** until the program
 *   was closed: searched, listed, open to read and write. It now leaves — and
 *   a document still open from it can still be saved.
 * - **F12 adopted the definition's whole folder.** It now lets in that file
 *   and nothing beside it, and the folder does not join the tree.
 *
 * Windows only, like the other desktop checks.
 *
 *   node tools/verify-desktop-links.mjs
 */

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDesktop, stopDesktop } from './desktop-session.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = await mkdtemp(join(tmpdir(), 'ul-links-'));
const project = join(base, 'project');
const elsewhere = join(base, 'elsewhere');
await mkdir(project);
await mkdir(elsewhere);
await writeFile(join(project, 'notes.txt'), 'Prvi redak.\n');
await writeFile(join(project, 'other.txt'), 'MARKER-PROJECT\n');
await writeFile(join(elsewhere, 'definition.rs'), 'fn here() {}\n');
await writeFile(join(elsewhere, 'beside.rs'), 'fn not_asked_for() {}\n');

let session;
try {
  session = await startDesktop({ port: 9349 });
  const { page } = session;
  const invoke = (cmd, args) =>
    page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  const refused = (cmd, args) =>
    page.evaluate(
      ([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a).then(() => false, () => true),
      [cmd, args],
    );
  check('attached to the desktop application', true);
  const home = page.url();

  /* ── links ───────────────────────────────────────────────────────── */

  const taken = await page.evaluate(() => {
    const link = document.createElement('a');
    link.href = 'http://example.invalid/somewhere';
    link.textContent = 'a link in a document';
    document.body.append(link);
    let prevented = null;
    window.addEventListener('click', (event) => (prevented = event.defaultPrevented), { once: true });
    link.click();
    link.remove();
    return prevented;
  });
  await sleep(1500);
  check('a click on a link to the web is taken over by the shell', taken === true, String(taken));
  check('and the window is still the application', page.url() === home, page.url());

  await page.evaluate(() => {
    window.location.href = 'https://example.com/';
  });
  await sleep(3000);
  check(
    'a navigation the page starts anyway goes nowhere',
    page.url() === home && (await page.locator('.shell').count()) > 0,
    page.url(),
  );

  /* ── a folder off the tree ──────────────────────────────────────── */

  /* Opened the way a folder handed to the program from outside is, so it is
     in the tree with its remove button, not only in the sandbox. */
  await invoke('plugin:event|emit', { event: 'uleditor://open-paths', payload: [project] });
  await page.waitForSelector('button[title^="Remove from the list"]', { timeout: 15000 });
  await page.keyboard.press('Control+P');
  await page.waitForSelector('.palette-input input', { timeout: 10000 });
  await page.locator('.palette-input input').fill('notes.txt');
  await page.waitForSelector('.palette-item[title$="notes.txt"]', { timeout: 15000 });
  await page.keyboard.press('Enter');
  await page.waitForSelector('.cm-content', { timeout: 30000 });
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Nakon uklanjanja.');

  const remove = page.locator('button[title^="Remove from the list"]').first();
  const removable = (await remove.count()) > 0;
  check('the folder can be taken off the tree', removable);
  if (removable) await remove.click({ force: true });
  await sleep(1500);

  const roots = await invoke('roots', {});
  check(
    'the folder has left the sandbox',
    !roots.some((r) => r.name === 'project'),
    roots.map((r) => r.name).join(', ') || 'no roots',
  );
  check(
    'a file in it can no longer be read',
    await refused('read_file', { path: join(project, 'other.txt') }),
  );
  const found = await invoke('search_workspace', { query: { query: 'MARKER-PROJECT' } }).catch(() => ({ hits: [] }));
  check('nor found by a search', found.hits.length === 0, `${found.hits.length} hit(s)`);

  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+S');
  let saved = '';
  for (let i = 0; i < 40 && !saved.includes('Nakon uklanjanja'); i++) {
    await sleep(250);
    saved = await readFile(join(project, 'notes.txt'), 'utf8');
  }
  check('a document still open from it is still saved', saved.includes('Nakon uklanjanja'), JSON.stringify(saved));

  /* ── one file, not its folder ───────────────────────────────────── */

  const granted = await invoke('grant_file', { path: join(elsewhere, 'definition.rs') });
  check('a definition is let in', granted?.name === 'definition.rs');
  check(
    'the file beside it is not',
    await refused('read_file', { path: join(elsewhere, 'beside.rs') }),
  );
  const after = await invoke('roots', {});
  check('and its folder is not a root', !after.some((r) => r.name === 'elsewhere'));
  check(
    'a folder is not a file to grant',
    await refused('grant_file', { path: elsewhere }),
  );
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await session?.page
    ?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-desktop-links.png') })
    .catch(() => {});
} finally {
  await stopDesktop(session);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
