/**
 * What the browser build offers, and whether each of it does something there.
 *
 * Two things did nothing in a browser. The library scans the device's own
 * folders, which a tab cannot read, and was offered anyway: a panel saying it
 * needs the app — and on a narrow screen it was the default view, the first
 * thing a person saw. And `Ctrl+P` asked Rust for the file list, got nothing
 * outside the app, and answered "No matching file." to every name even with a
 * folder open.
 *
 * The folder is a real `FileSystemDirectoryHandle`: the origin-private file
 * system hands one out, and `showDirectoryPicker` — a system dialog no script
 * can drive — is replaced by a function that returns it. Everything after the
 * pick is the application's own File System Access code.
 *
 *   pnpm --filter @uleditor/shell-ui preview --port 5273
 *   node tools/verify-web-views.mjs [--url http://localhost:5273]
 */

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5273';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* A picked folder: two files to find, one in a subfolder, and one under
   node_modules that must not be listed. */
const PICKER = () => {
  window.showDirectoryPicker = async () => {
    const storage = await navigator.storage.getDirectory();
    await storage.removeEntry('projekt', { recursive: true }).catch(() => {});
    const root = await storage.getDirectoryHandle('projekt', { create: true });
    const write = async (dir, name, text) => {
      const file = await dir.getFileHandle(name, { create: true });
      const out = await file.createWritable();
      await out.write(text);
      await out.close();
    };
    await write(root, 'biljeske.md', '# Bilješke\n');
    const src = await root.getDirectoryHandle('src', { create: true });
    await write(src, 'racun.ts', 'export const x = 1;\n');
    const modules = await root.getDirectoryHandle('node_modules', { create: true });
    const pkg = await modules.getDirectoryHandle('paket', { create: true });
    await write(pkg, 'skriveno.ts', 'export {};\n');
    return root;
  };
};

const browser = await chromium.launch();
const errors = [];

try {
  /* ── a narrow screen: the phone ─────────────────────────────────────── */
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    await page.waitForSelector('.shell', { timeout: 30_000 });
    const titles = await page.locator('.view-btn').evaluateAll((els) => els.map((e) => e.getAttribute('title')));
    check('a narrow browser offers no library', !titles.some((t) => t?.startsWith('Library')), titles.join(' · '));
    check('and offers the folder tree instead', titles.some((t) => t?.startsWith('Explorer')));
    check(
      'and does not open on the library panel',
      (await page.locator('.library').count()) === 0,
    );
    await page.close();
  }

  /* ── a wide screen: quick open over a picked folder ─────────────────── */
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(PICKER);
    await page.goto(url);
    await page.waitForSelector('.shell', { timeout: 30_000 });
    const titles = await page.locator('.activitybar button[title]').evaluateAll((els) => els.map((e) => e.getAttribute('title')));
    check('a wide browser offers no library either', !titles.some((t) => t?.startsWith('Library')), titles.join(' · '));

    await page.keyboard.press('Control+k');
    await page.getByText('biljeske.md').first().waitFor({ timeout: 10_000 });

    await page.keyboard.press('Control+p');
    await page.locator('.palette input').waitFor();
    await page.keyboard.type('racun');
    await page.locator('.palette-item').first().waitFor({ timeout: 10_000 }).catch(() => {});
    const found = await page.locator('.palette-item').allTextContents();
    check(
      'Ctrl+P finds a file in a folder never expanded',
      found.some((t) => t.includes('racun.ts')),
      found.join(' · ') || (await page.locator('.palette-empty').allTextContents()).join(' · '),
    );

    await page.locator('.palette input').fill('skriveno');
    await page.waitForTimeout(300);
    const hidden = await page.locator('.palette-item').allTextContents();
    check('and does not list what is under node_modules', !hidden.some((t) => t.includes('skriveno')), hidden.join(' · ') || 'nothing listed');

    await page.locator('.palette input').fill('racun');
    const listed = await page
      .locator('.palette-item')
      .first()
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (listed) await page.keyboard.press('Enter');
    const opened =
      listed &&
      (await page
        .locator('.tab', { hasText: 'racun.ts' })
        .first()
        .waitFor({ timeout: 10_000 })
        .then(() => true)
        .catch(() => false));
    check('and the file it finds opens', opened);
    await page.close();
  }

  check('nothing threw in the page', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
