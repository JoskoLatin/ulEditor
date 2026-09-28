/**
 * The open folder survives a reload in the browser (ADR 0002, step 8).
 *
 * The folder is a real `FileSystemDirectoryHandle` from the origin-private file
 * system, handed out by a stand-in for `showDirectoryPicker`, as in
 * verify-web-views.mjs. What the browser answers about permission is played
 * two ways:
 *
 * - still granted, as Chrome's "allow on every visit" leaves it: the folder is
 *   back after a reload without the picker, shut, and its files open;
 * - asked again, as it usually is: nothing asks by itself — `requestPermission`
 *   here throws without a person's gesture, as Chrome's does — and a notice
 *   offers the folder until its button is pressed. Refused, the folder is
 *   forgotten; the question dismissed, it is offered again next time.
 *
 * A folder taken off the tree does not come back.
 *
 *   pnpm --filter @uleditor/shell-ui preview --port 5273
 *   node tools/verify-web-roots.mjs [--url http://localhost:5273]
 */

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5273';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* The picker, counting how often it is used, and the browser's permission
   answers, set from the test through localStorage: `perm` is what a query
   returns until the page has been granted, `answer` what the prompt returns. */
const SETUP = () => {
  const count = (key) => localStorage.setItem(key, String(Number(localStorage.getItem(key) ?? 0) + 1));
  window.showDirectoryPicker = async () => {
    count('picks');
    const storage = await navigator.storage.getDirectory();
    // `where=second` picks another folder that is also called "projekt".
    if (localStorage.getItem('where') === 'second') {
      const other = await (await storage.getDirectoryHandle('drugi', { create: true })).getDirectoryHandle('projekt', { create: true });
      const out = await (await other.getFileHandle('drugo.md', { create: true })).createWritable();
      await out.write('# Druga mapa\n');
      await out.close();
      return other;
    }
    const existing = await storage.getDirectoryHandle('projekt').catch(() => null);
    if (existing) return existing;
    const root = await storage.getDirectoryHandle('projekt', { create: true });
    const file = await root.getFileHandle('biljeske.md', { create: true });
    const out = await file.createWritable();
    await out.write('# Bilješke iz mape\n');
    await out.close();
    return root;
  };
  let granted = false;
  FileSystemHandle.prototype.queryPermission = async function () {
    return granted ? 'granted' : (localStorage.getItem('perm') ?? 'granted');
  };
  FileSystemHandle.prototype.requestPermission = async function () {
    if (!navigator.userActivation.isActive) {
      count('unasked');
      throw new DOMException('User activation is required to request permissions.', 'SecurityError');
    }
    count('asked');
    const answer = localStorage.getItem('answer') ?? 'granted';
    if (answer === 'granted') granted = true;
    return answer;
  };
};

const browser = await chromium.launch();
const errors = [];

const shown = (page) => page.locator('.tree-row .tree-label', { hasText: 'projekt' }).count();
const notice = (page) => page.locator('.toast', { hasText: 'projekt' });
const stored = (page, key) => page.evaluate((k) => Number(localStorage.getItem(k) ?? 0), key);
const set = (page, values) => page.evaluate((v) => Object.entries(v).forEach(([k, x]) => localStorage.setItem(k, x)), values);
const keptRoots = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('uleditor');
        open.onsuccess = () => {
          const keys = open.result.transaction('roots').objectStore('roots').getAllKeys();
          keys.onsuccess = () => resolve(keys.result);
        };
      }),
  );
const load = async (page) => {
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 30_000 });
  await page.waitForTimeout(800);
};

try {
  /* ── still granted ──────────────────────────────────────────────────── */
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(SETUP);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    await page.waitForSelector('.shell', { timeout: 30_000 });
    await page.keyboard.press('Control+k');
    await page.locator('.tree-row', { hasText: 'biljeske.md' }).waitFor({ timeout: 10_000 });

    await load(page);
    check('a folder the browser still allows is back after a reload', (await shown(page)) === 1);
    check('without the picker', (await stored(page, 'picks')) === 1, `${await stored(page, 'picks')} picks`);
    check('shut, as a restored folder is', (await page.locator('.tree-row', { hasText: 'biljeske.md' }).count()) === 0);
    check('and without a notice', (await page.locator('.toast').count()) === 0);

    await page.keyboard.press('Control+p');
    await page.locator('.palette input').fill('biljeske');
    await page.locator('.palette-item').first().waitFor({ timeout: 10_000 });
    await page.keyboard.press('Enter');
    const text = await page
      .locator('.cm-content, .ul-md, .markdown-body')
      .first()
      .innerText({ timeout: 15_000 })
      .catch(() => '');
    check('and a file in it opens', text.includes('Bilješke iz mape'), text.slice(0, 30) || 'nothing');

    await page.locator('.tree-row', { hasText: 'projekt' }).first().hover();
    await page.locator('.tree-row', { hasText: 'projekt' }).first().locator('[title^="Remove from the list"]').click();
    // The record goes from IndexedDB a moment later; a person's reload does not
    // come within milliseconds of the click.
    await page.waitForTimeout(300);
    await load(page);
    check('a folder taken off the tree does not come back', (await shown(page)) === 0 && (await page.locator('.toast').count()) === 0);

    // Deleted since, though still allowed: forgotten, not kept to fail again.
    await page.keyboard.press('Control+k');
    await page.locator('.tree-row', { hasText: 'biljeske.md' }).waitFor({ timeout: 10_000 });
    await page.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('projekt', { recursive: true }));
    await load(page);
    const kept = await keptRoots(page);

    check(
      'a folder deleted since is forgotten quietly',
      kept.length === 0 && (await shown(page)) === 0 && (await page.locator('.toast').count()) === 0,
      JSON.stringify(kept),
    );

    // One folder, one uri: picked twice it is one root; another folder with
    // the same name is a second one, under a uri of its own. (Not necessarily
    // ul:/projekt: the folder removed above still has tabs' handles under that
    // uri in this visit, and a new folder does not take it over.)
    await page.keyboard.press('Control+k');
    await page.locator('.tree-row', { hasText: 'biljeske.md' }).waitFor({ timeout: 10_000 });
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);
    const once = await shown(page);
    await set(page, { where: 'second' });
    await page.keyboard.press('Control+k');
    await page.locator('.tree-row', { hasText: 'drugo.md' }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);
    const both = await shown(page);
    const keys = (await keptRoots(page)).sort();
    check('the same folder picked twice is one root', once === 1, `${once} rows`);
    check(
      'another folder with the same name is its own, under its own uri',
      both === 2 && keys.length === 2 && keys.every((k) => /^ul:\/projekt(~\d+)?$/.test(k)),
      `${both} rows, ${JSON.stringify(keys)}`,
    );

    // A record nothing here wrote: another name over a folder's handle.
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const open = indexedDB.open('uleditor');
          open.onsuccess = async () => {
            const handle = await (await navigator.storage.getDirectory()).getDirectoryHandle('projekt');
            const tx = open.result.transaction('roots', 'readwrite');
            tx.objectStore('roots').put({ uri: 'ul:/lazno', name: 'lazno', handle });
            tx.oncomplete = resolve;
          };
        }),
    );
    await load(page);
    const afterForged = await keptRoots(page);
    check(
      'a record whose name is not its folder’s is thrown away',
      !afterForged.includes('ul:/lazno') && (await shown(page)) === 2,
      `${await shown(page)} rows, ${JSON.stringify(afterForged)}`,
    );
    await context.close();
  }

  /* ── asked again ────────────────────────────────────────────────────── */
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(SETUP);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    await page.waitForSelector('.shell', { timeout: 30_000 });
    await page.keyboard.press('Control+k');
    await page.locator('.tree-row', { hasText: 'biljeske.md' }).waitFor({ timeout: 10_000 });

    await set(page, { perm: 'prompt' });
    await load(page);
    check('a folder the browser would ask about is not read by itself', (await shown(page)) === 0);
    check('and nothing asks the browser without a click', (await stored(page, 'unasked')) === 0 && (await stored(page, 'asked')) === 0);
    await page.waitForTimeout(5_000);
    const offered = await notice(page).count();
    check('a notice offers it, and stays', offered === 1, `${offered} after 5 s`);

    // Question dismissed: the notice goes, and the folder is offered again next time.
    await set(page, { answer: 'prompt' });
    await notice(page).locator('.toast-btn').first().click();
    await page.waitForTimeout(500);
    check('dismissing the question takes the notice away', (await notice(page).count()) === 0 && (await shown(page)) === 0);
    await load(page);
    check('and it is offered again next time', (await notice(page).count()) === 1);

    // Granted from the click.
    await set(page, { answer: 'granted' });
    await notice(page).locator('.toast-btn').first().click();
    const opened = await page
      .locator('.tree-row', { hasText: 'biljeske.md' })
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    check('the button asks, and the folder opens as if picked', opened && (await stored(page, 'asked')) === 2);
    check('the notice is gone', (await notice(page).count()) === 0);
    check('and the browser was never asked without a gesture', (await stored(page, 'unasked')) === 0);

    // Refused: forgotten.
    await set(page, { answer: 'denied' });
    await load(page);
    await notice(page).locator('.toast-btn').first().click();
    await page.waitForTimeout(500);
    await load(page);
    check('a folder the browser refused is not offered again', (await notice(page).count()) === 0 && (await shown(page)) === 0);

    // Refused by the browser itself before any click: forgotten too.
    await set(page, { perm: 'granted', answer: 'granted' });
    await load(page);
    await page.keyboard.press('Control+k');
    await page.locator('.tree-row', { hasText: 'biljeske.md' }).waitFor({ timeout: 10_000 });
    await set(page, { perm: 'denied' });
    await load(page);
    await load(page);
    const refused = await keptRoots(page);
    check(
      'nor is one the browser says is refused, and its record is gone',
      (await notice(page).count()) === 0 && (await shown(page)) === 0 && refused.length === 0,
      JSON.stringify(refused),
    );

    // Forgotten from the notice itself, without the browser being asked.
    await set(page, { perm: 'granted' });
    await load(page);
    await page.keyboard.press('Control+k');
    await page.locator('.tree-row', { hasText: 'biljeske.md' }).waitFor({ timeout: 10_000 });
    await set(page, { perm: 'prompt' });
    await load(page);
    const askedBefore = await stored(page, 'asked');
    await notice(page).locator('.toast-btn', { hasText: 'Forget' }).click();
    await page.waitForTimeout(300);
    await load(page);
    const forgotten = await keptRoots(page);
    check(
      '“Forget” drops the folder without asking the browser',
      (await notice(page).count()) === 0 && forgotten.length === 0 && (await stored(page, 'asked')) === askedBefore,
      JSON.stringify(forgotten),
    );

    // A record with the right uri and another name: the notice names the
    // folder the browser would open, not what the record says.
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const open = indexedDB.open('uleditor');
          open.onsuccess = async () => {
            const handle = await (await navigator.storage.getDirectory()).getDirectoryHandle('projekt');
            const tx = open.result.transaction('roots', 'readwrite');
            tx.objectStore('roots').put({ uri: 'ul:/projekt', name: 'lazno', handle });
            tx.oncomplete = resolve;
          };
        }),
    );
    await load(page);
    const named = await page.locator('.toast').allInnerTexts();
    check(
      'the notice names the folder itself, not what its record says',
      named.length === 1 && named[0].includes('projekt') && !named.join(' ').includes('lazno'),
      named.join(' | ').slice(0, 80),
    );
    await context.close();
  }

  check('nothing threw in the page', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message.split('\n')[0] : String(err));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
