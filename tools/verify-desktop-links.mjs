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
 *   anyway goes nowhere.
 * - **The page could open the browser on any address** — with whatever it had
 *   read written into it, and no gesture (N6 of the review of ADR 0005). Rust
 *   now asks in a dialog the system draws before any link but the program's
 *   own opens, and after a no keeps the page from asking for a while. Every
 *   question here is answered "Not now": a yes would open the browser on the
 *   machine running this. And the updater, which would send its request
 *   through any proxy the page named, is reached only through the core.
 * - **A folder taken off the tree stayed in the sandbox** until the program
 *   was closed: searched, listed, open to read and write. It now leaves — and
 *   a document still open from it can still be saved.
 * - **The page could let things in.** Since ADR 0005 it only claims what the
 *   core offered or remembered: a file it names is not let in by asking, and
 *   the command that let one in is gone. What F12 offers — the file, to be
 *   read, and nothing beside it — is checked in verify-desktop-lsp.
 *
 * Windows only, like the other desktop checks.
 *
 *   node tools/verify-desktop-links.mjs
 */

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDesktop, stopDesktop, openFromOutside, pressDialog } from './desktop-session.mjs';

/** The first of the three buttons in the core's questions: the safe answer. */
const NOT_NOW = 1004;

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
  session = await startDesktop({ port: 9349, identifier: 'org.uleditor.app.check' });
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

  /* Every kind of link a document can hold, each clicked once. The second
     review found an SVG link and an image map's area let through, and a
     relative link reloading the whole application. */
  const prevented = (markup) =>
    page.evaluate((html) => {
      const holder = document.createElement('div');
      holder.innerHTML = html;
      document.body.append(holder);
      const target = holder.querySelector('[data-click]');
      let result = null;
      window.addEventListener('click', (event) => (result = event.defaultPrevented), { once: true });
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      holder.remove();
      return result;
    }, markup);
  for (const [name, markup] of [
    ['an SVG link', '<svg width="10" height="10"><a data-click href="http://example.invalid/svg"><rect width="10" height="10"/></a></svg>'],
    ['an image map\'s area', '<map name="m"><area data-click shape="rect" coords="0,0,10,10" href="http://example.invalid/area"></map>'],
    ['a relative link, which the application would answer with itself', '<a data-click href="docs/upute.md">upute</a>'],
    ['an empty link, which would reload the page', '<a data-click href="">x</a>'],
    ['an empty SVG link', '<svg width="10" height="10"><a data-click href=""><rect width="10" height="10"/></a></svg>'],
    [
      'an SVG link with no address inside one with an address',
      '<a href="?x"><svg width="10" height="10"><a><rect data-click width="10" height="10"/></a></svg></a>',
    ],
  ]) {
    check(`${name} is taken over too`, (await prevented(markup)) === true);
  }
  await sleep(1500);
  check('and the window is still the application after all of them', page.url() === home, page.url());
  check(
    'a jump within the page is left to the page',
    (await prevented('<a data-click href="#a-heading">x</a>')) === false,
  );
  await page.evaluate(() => history.replaceState(null, '', window.location.pathname));

  /* Navigations the page starts itself go nowhere but the application's own
     page — not https on its host, not another port, not another path. */
  for (const away of [
    'https://example.com/',
    'https://tauri.localhost/',
    'http://tauri.localhost:8080/',
    new URL('docs/upute.md', home).href,
  ]) {
    await page.evaluate((target) => {
      window.location.href = target;
    }, away);
    await sleep(2500);
    check(
      `a navigation to ${away} goes nowhere`,
      page.url() === home && (await page.locator('.shell').count()) > 0,
      page.url(),
    );
  }

  /* ── a link out is asked about ──────────────────────────────────── */

  /* A person clicking an https link in a document: the shell hands it to
     Rust, which asks before the browser opens. */
  await page.evaluate(() => {
    const link = document.createElement('a');
    link.href = 'https://example.com/clicked';
    link.textContent = 'a link out';
    document.body.append(link);
    link.click();
    link.remove();
  });
  const clicked = pressDialog(NOT_NOW, 20);
  check(
    'a click on an https link asks before the browser opens, naming the site',
    /^pressed: Open a link to example\.com\?$/.test(clicked),
    clicked,
  );
  await sleep(500);

  /* After a no the page may not ask again at once: a page that asks the
     moment a question is answered leaves the person nothing to do but yes. */
  const again = page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('open_external', { url: 'https://example.com/again', uiLanguage: 'en' }).then(
      (opened) => `answered: ${opened}`,
      (err) => `refused: ${err}`,
    ),
  );
  await sleep(1500);
  /* Looked for briefly, and pressed if it is there, so that a question that
     should not have come up fails the check rather than hangs it. */
  const askedAgain = pressDialog(NOT_NOW, 3);
  const answeredAgain = await again;
  check(
    'after a no the page cannot ask again at once',
    askedAgain === 'no dialog' && answeredAgain.startsWith('refused: After a link is refused'),
    `${askedAgain}; ${answeredAgain}`,
  );
  await sleep(30500);

  /* Script in the page asking itself, with something it read in the address,
     and asking again while the first question is open. */
  const asking = page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('open_external', { url: 'https://example.com/?data=secret', uiLanguage: 'en' }),
  );
  await sleep(1500);
  const stacked = await invoke('open_external', { url: 'https://example.org/', uiLanguage: 'en' });
  check('a link asked for while a question is open is not opened', stacked === false, String(stacked));
  const pressed = pressDialog(NOT_NOW, 20);
  const opened = await asking;
  check('a link the page asks for itself is asked about', /^pressed: Open a link to example\.com\?$/.test(pressed), pressed);
  check('and without a yes the browser is not opened', opened === false, String(opened));

  /* The updater would send its request through any proxy the page named, from
     Rust, past the CSP — so the page has no permission for the plugin, and
     asks through the core's own commands, which take no proxy. */
  /* By its permission, not by the request failing: with the permission, the
     check is made — through a proxy on a port where nothing listens — and
     fails just the same. */
  const updater = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('plugin:updater|check', { proxy: 'http://name:secret@127.0.0.1:9/' }).then(
      () => 'answered',
      (err) => String(err),
    ),
  );
  check("the updater plugin's own check, which takes a proxy, is not allowed", /not allowed/i.test(updater), updater);
  check('a link that is not https is refused outright', await refused('open_external', { url: 'file:///C:/Windows/win.ini' }));
  check(
    'and so is one with a name before its host',
    await refused('open_external', { url: 'https://github.com@example.com/' }),
  );

  /* ── a folder off the tree ──────────────────────────────────────── */

  /* Handed to the program from outside, as the system does, so it is in the
     tree with its remove button, not only in the sandbox. */
  await openFromOutside(page, [project]);
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

  /* ── the page claims, it does not grant ─────────────────────────── */

  const definition = join(elsewhere, 'definition.rs');
  const claimed = await invoke('adopt_paths', { paths: [definition, elsewhere] });
  check(
    'a file or folder nobody offered is not let in by asking for it',
    Array.isArray(claimed) && claimed.length === 0,
    JSON.stringify(claimed),
  );
  check('and cannot be read', await refused('read_file', { path: definition }));
  check('the command that let a file in is gone', await refused('grant_file', { path: definition }));
  const after = await invoke('roots', {});
  check('and its folder is not a root', !after.some((r) => r.name === 'elsewhere'));
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
