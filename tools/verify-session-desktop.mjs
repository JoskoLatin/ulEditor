/**
 * The session in the real desktop application: kept while it runs, offered
 * after it has been closed.
 *
 * - A reload of the window — what a change of language does — brings back
 *   the folders and tabs at once.
 * - Closed through File › Exit and started again in the same profile, the
 *   program opens empty, with "Restore last session" on the welcome screen;
 *   pressing it brings the folder and the tabs back, and the offer goes.
 * - A file opened from outside while it runs (a second double-click) lands
 *   as a new tab in the window that is already open.
 *
 * What only a restart proves is that `sessionStorage`, which tells a reload
 * from a start, does not outlive the process in WebView2.
 *
 *   node tools/verify-session-desktop.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { alreadyRunning, startDesktop, stopDesktop, openFromOutside } from './desktop-session.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = join(ROOT, 'target', 'debug', 'uleditor-desktop.exe');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}
async function until(condition, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const workspace = await mkdtemp(join(tmpdir(), 'ul-session-'));
const fileA = join(workspace, 'prvi.md');
const fileB = join(workspace, 'drugi.md');
await writeFile(fileA, '# Prvi\n');
await writeFile(fileB, '# Drugi\n');

const tabNames = (page) => page.locator('.tab .name').allInnerTexts();
const treeRows = (page) => page.locator('.tree-row').count();
const restoreButton = (page) => page.locator('.welcome-restore');

/** File › Exit, the way a person leaves; then waits for the process to end. */
async function exit(session) {
  const { page } = session;
  await page.keyboard.press('Control+Shift+P');
  await page.locator('.palette input').fill('Exit');
  await page.locator('.palette-item').first().waitFor({ timeout: 10_000 });
  await page.keyboard.press('Enter');
  const ended = await until(async () => !alreadyRunning(), 30_000);
  await stopDesktop(session);
  return ended;
}

let session;
try {
  /* ── run 1: a folder and a tab, and a reload while it runs ─────────── */
  session = await startDesktop({ port: 9337 });
  const profile = session.profile;
  let { page } = session;
  check('attached to the running desktop application', true);
  check('a first start offers nothing to restore', (await restoreButton(page).count()) === 0);

  await openFromOutside(page, [workspace]);
  await page.evaluate(
    ([dir, file]) => {
      const key = 'uleditor.settings';
      const stored = JSON.parse(localStorage.getItem(key) ?? '{}');
      stored['session.workspace'] = { roots: [dir], tabs: [{ uri: file, group: 'left' }], active: file };
      localStorage.setItem(key, JSON.stringify(stored));
    },
    [workspace, fileA],
  );
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 30_000 });
  const reloaded = await until(async () => (await tabNames(page)).includes('prvi.md') && (await treeRows(page)) >= 1);
  check('a reload while it runs brings the folder and the tab back at once', reloaded, (await tabNames(page)).join(', '));

  // A second double-click while it runs: a new tab in this window.
  if (existsSync(EXE)) {
    spawnSync(EXE, [fileB], { timeout: 30_000, stdio: 'ignore' });
    const handed = await until(async () => (await tabNames(page)).includes('drugi.md'));
    check('a file opened from outside while it runs is a new tab here', handed, (await tabNames(page)).join(', '));
  } else {
    check('a file opened from outside while it runs is a new tab here', false, `no ${EXE}`);
  }

  await page.waitForTimeout(800); // the session is written 400 ms after a change
  check('File › Exit ends the program', await exit(session));
  session = null;

  /* ── run 2: the same profile, started again ─────────────────────────── */
  session = await startDesktop({ port: 9337, profile });
  ({ page } = session);
  await page.waitForTimeout(1500);
  const tabsAtStart = await tabNames(page);
  check(
    'a start opens empty',
    tabsAtStart.length === 0 && (await treeRows(page)) === 0,
    `${tabsAtStart.join(', ') || 'no tabs'}, ${await treeRows(page)} rows`,
  );
  check('with the last session offered', (await restoreButton(page).count()) === 1);

  await restoreButton(page).click();
  const restored = await until(
    async () => {
      const names = await tabNames(page);
      return names.includes('prvi.md') && names.includes('drugi.md') && (await treeRows(page)) >= 1;
    },
    20_000,
  );
  check('pressing it brings the folder and both tabs back', restored, (await tabNames(page)).join(', '));

  await page.keyboard.press('Control+Shift+P');
  await page.locator('.palette input').fill('Restore last session');
  await page.waitForTimeout(500);
  const stillOffered = await page.locator('.palette-item', { hasText: 'Restore last session' }).count();
  await page.keyboard.press('Escape');
  check('and the offer is gone once taken', stillOffered === 0, `${stillOffered} in the palette`);

  await page.waitForTimeout(800);
  check('File › Exit ends it again', await exit(session));
  session = null;

  /* ── run 3: what was restored and worked on is the next last session ── */
  session = await startDesktop({ port: 9337, profile });
  ({ page } = session);
  await page.waitForTimeout(1500);
  check('the next start offers it again', (await restoreButton(page).count()) === 1 && (await tabNames(page)).length === 0);

  // A reload before anything is done keeps the start as it was: still empty,
  // still offered — the set-aside session does not creep back by itself.
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 30_000 });
  await page.waitForTimeout(1500);
  check(
    'a reload right after a start stays empty, and keeps the offer',
    (await tabNames(page)).length === 0 && (await treeRows(page)) === 0 && (await restoreButton(page).count()) === 1,
    (await tabNames(page)).join(', ') || 'no tabs',
  );

  await page.keyboard.press('Control+Shift+P');
  await page.locator('.palette input').fill('Restore last session');
  await page.locator('.palette-item', { hasText: 'Restore last session' }).first().waitFor({ timeout: 10_000 });
  await page.keyboard.press('Enter');
  const fromPalette = await until(async () => (await tabNames(page)).includes('prvi.md'), 20_000);
  check('and the palette restores it as well', fromPalette, (await tabNames(page)).join(', '));
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message.split('\n')[0] : String(err));
} finally {
  await stopDesktop(session);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
