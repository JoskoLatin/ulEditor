/**
 * The file tree against a real folder, in the real desktop application.
 *
 * `verify-tree.mjs` proves the ordering as arithmetic. What only a real run
 * proves is the part that touches the disk: that "check for new files" finds a
 * file another program wrote a moment ago, that sorting by date reads the
 * timestamps the file system reports rather than ones a fixture invented, and
 * that removing a folder from the tree leaves it on disk — which is the one
 * claim in this feature where being wrong would cost somebody their documents.
 *
 * The tree is seeded through the session restore: a stored session is what
 * puts folders in the tree on a normal morning, and it is the only route into
 * it that does not need a native dialog or an OS drag.
 *
 *   node tools/verify-tree-desktop.mjs
 */

import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startDesktop, stopDesktop } from './desktop-session.mjs';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Waits for a condition instead of guessing how long the disk takes. */
async function until(condition, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/*
 * A folder whose three orders are three different lists. That matters more
 * than it looks: with dates that happen to agree with the extensions, a "sort
 * by type" that quietly did nothing at all would pass.
 *
 *   by name  alpha.txt, beta.md, gamma.json
 *   by date  alpha.txt, gamma.json, beta.md
 *   by type  gamma.json, beta.md, alpha.txt
 */
const workspace = await mkdtemp(join(tmpdir(), 'ul-tree-'));
await writeFile(join(workspace, 'alpha.txt'), 'first by name, and the newest\n');
await writeFile(join(workspace, 'beta.md'), '# oldest\n');
await writeFile(join(workspace, 'gamma.json'), '{}\n');

const day = 86400 * 1000;
const now = Date.now();
await utimes(join(workspace, 'beta.md'), new Date(now - 2 * day), new Date(now - 2 * day));
await utimes(join(workspace, 'gamma.json'), new Date(now - 1 * day), new Date(now - 1 * day));

let session;

try {
  session = await startDesktop({ port: 9336 });
  const { page } = session;
  check('attached to the running desktop application', true);

  /*
   * The folder is registered with the sandbox, then written into the stored
   * session and the window reloaded — which is exactly what happens to
   * somebody who closes the program with a folder open and starts it again.
   */
  await page.evaluate(
    (dir) => window.__TAURI_INTERNALS__.invoke('adopt_paths', { paths: [dir] }),
    workspace,
  );
  await page.evaluate((dir) => {
    const key = 'uleditor.settings';
    const stored = JSON.parse(localStorage.getItem(key) ?? '{}');
    stored['session.workspace'] = { roots: [dir], tabs: [], active: null };
    stored['explorer.sort'] = 'name';
    localStorage.setItem(key, JSON.stringify(stored));
  }, workspace);
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 30000 });

  /* One row: the restored root comes back collapsed, on purpose — see
     `restoreSession`. Its files are a click away, which the next line takes. */
  const rows = page.locator('.tree-row');
  const seeded = await until(async () => (await rows.count()) >= 1, 20000);
  check('the folder came back in the tree', seeded, `${await rows.count()} rows`);

  /* The session restore leaves roots collapsed; the files below want opening. */
  if ((await page.locator('.tree-row[data-open="true"]').count()) === 0) {
    await rows.first().locator('.tree-label').click();
  }
  await until(async () => (await rows.count()) === 4, 15000);

  const fileNames = async () =>
    (await page.locator('.tree-row:not([data-root]) .label').allInnerTexts()).join(', ');

  check('by name, the files read in name order', (await fileNames()) === 'alpha.txt, beta.md, gamma.json', await fileNames());

  /* — the order — */

  await page.locator('.sort-select').selectOption('date');
  check(
    'by date, the newest comes first — and these dates came off the disk',
    (await fileNames()) === 'alpha.txt, gamma.json, beta.md',
    await fileNames(),
  );

  await page.locator('.sort-select').selectOption('type');
  check(
    'by type, they group by extension — a different list from either of the others',
    (await fileNames()) === 'gamma.json, beta.md, alpha.txt',
    await fileNames(),
  );

  await page.locator('.sort-select').selectOption('name');

  /* — new files on disk — */

  await writeFile(join(workspace, 'delta.txt'), 'written by somebody else\n');
  check('a file written just now is not in the tree yet', (await rows.count()) === 4, `${await rows.count()} rows`);

  await page.locator('.tree-row[data-root] .icon-btn').first().click();
  const found = await until(async () => (await rows.count()) === 5, 15000);
  check('the refresh button finds it', found, await fileNames());
  check('and it is placed in the chosen order', (await fileNames()).startsWith('alpha.txt, beta.md, delta.txt'), await fileNames());

  /* The order the picker was left in survives a restart — it is a preference,
     not something to choose again every morning. */
  await page.locator('.sort-select').selectOption('date');
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 30000 });
  await until(async () => (await page.locator('.tree-row').count()) > 0, 20000);
  check(
    'the chosen order is still chosen after a restart',
    (await page.locator('.sort-select').inputValue()) === 'date',
    await page.locator('.sort-select').inputValue(),
  );

  /* — removing — */

  const before = (await readdir(workspace)).length;
  await page.locator('.tree-row[data-root] .icon-btn').nth(1).click();
  const gone = await until(async () => (await page.locator('.tree-row').count()) === 0, 10000);
  check('the trash button takes the folder off the tree', gone, `${await page.locator('.tree-row').count()} rows`);

  const after = (await readdir(workspace)).length;
  check(
    'and every file is still on disk — nothing was deleted',
    after === before && after === 4,
    `${before} before, ${after} after`,
  );
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
} finally {
  await stopDesktop(session);
  await rm(workspace, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
