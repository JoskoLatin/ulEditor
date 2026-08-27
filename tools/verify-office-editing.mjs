/**
 * Rewriting an Office document in **the real desktop application**, out to disk
 * and back — once for Word, once for OpenDocument text.
 *
 * `verify-docx-edit.mjs` and `verify-odt-edit.mjs` prove that each write touches
 * only what it should. Here it is proved that the write reaches the file at all:
 * double-click, typing, `Ctrl+S`, reopening. In between stands everything that
 * cannot be checked from Node — `contenteditable`, the trip through the Rust VFS
 * and reading it back.
 *
 * Both formats go through the same sequence because they go through the same
 * editor: one class drives them, and what a save costs is settled behind
 * `Preview.source`. A run of this is therefore also the check that the seam
 * holds — that the editor really does not know which format it is looking at.
 *
 *   node tools/verify-office-editing.mjs
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

import { makeDocx, makeOdt } from './fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9336;
const REPLACEMENT = 'Rewritten in ulEditor — čćžšđ';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/** The two ways this program writes text into a document it did not create. */
const DOCUMENTS = [
  { label: 'docx', file: 'report.docx', bytes: makeDocx(), part: 'word/document.xml' },
  { label: 'odt', file: 'izvjestaj.odt', bytes: makeOdt(), part: 'content.xml' },
];

const workspace = await mkdtemp(join(tmpdir(), 'ul-office-'));
for (const document of DOCUMENTS) {
  document.path = join(workspace, document.file);
  await writeFile(document.path, document.bytes);
  document.before = unzipSync(await readFile(document.path));
  document.otherParts = Object.keys(document.before).filter((path) => path !== document.part);
}

const app = spawn('pnpm', ['--filter', '@uleditor/desktop', 'dev'], {
  cwd: ROOT,
  shell: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    /* A scratch profile — see desktop-session.mjs: without it the fixtures
       land in the person's real recent list and session. */
    WEBVIEW2_USER_DATA_FOLDER: await mkdtemp(join(tmpdir(), 'ul-profile-')),
  },
  stdio: 'ignore',
});

async function connect(timeoutMs) {
  const until = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < until) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastError ?? new Error('the CDP endpoint never opened');
}

let browser;
let page;

try {
  browser = await connect(240000);
  const contexts = browser.contexts();
  page = contexts[0]?.pages()[0] ?? (await contexts[0].waitForEvent('page'));
  await page.waitForSelector('.shell', { timeout: 30000 });
  check('attached to the desktop application', true);

  for (let guard = 0; guard < 20 && (await page.locator('.tab').count()) > 0; guard++) {
    await page.locator('.tab .close').first().click();
    await page.waitForTimeout(200);
  }

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
    await page.waitForSelector('.ul-office-doc', { timeout: 30000 });
  };

  for (const document of DOCUMENTS) {
    const say = (name) => `${document.label}: ${name}`;

    await open(document.file);
    check(say('the document is open'), true);

    const pieces = await page.locator('.ul-office-run').count();
    check(say('the rewritable pieces of text are marked'), pieces > 0, `${pieces}`);

    const first = page.locator('.ul-office-run').first();
    const originalText = await first.innerText();
    await first.dblclick();

    const editing = await page.evaluate(
      () => document.querySelector('.ul-office-run')?.isContentEditable ?? false,
    );
    check(say('a double-click opens the text for typing'), editing);

    await page.keyboard.press('Control+A');
    await page.keyboard.type(REPLACEMENT);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    check(say('the text was replaced in the view'), (await first.innerText()) === REPLACEMENT, await first.innerText());
    check(say('the document is marked as modified'), (await page.locator('.tab[data-dirty="true"]').count()) === 1);

    await page.keyboard.press('Control+S');
    let saved = true;
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('.tab[data-dirty="true"]').length === 0,
        { timeout: 30000 },
      );
    } catch {
      saved = false;
    }
    check(
      say('the save went through without obstruction'),
      saved,
      (await page.locator('.toast p').last().innerText().catch(() => '')).slice(0, 160),
    );

    /* ── what is on disk ─────────────────────────────────────────────── */

    const after = unzipSync(await readFile(document.path));

    check(say('the change is in the document'), strFromU8(after[document.part]).includes('Rewritten in ulEditor'));
    check(say('the original text is gone'), !strFromU8(after[document.part]).includes(originalText));

    /*
     * The central check of the whole Office direction: editing must not rewrite
     * styles, numbering or metadata along the way. Quietly losing somebody
     * else's formatting is the one mistake trust does not recover from.
     */
    const drifted = document.otherParts.filter((path) => {
      const a = document.before[path];
      const b = after[path];
      return !b || a.length !== b.length || a.some((byte, i) => byte !== b[i]);
    });
    check(
      say('no other part of the file was touched'),
      drifted.length === 0,
      drifted.join(', ') || `${document.otherParts.length} parts unchanged`,
    );

    /* ── reopening ───────────────────────────────────────────────────── */

    await page.locator('.tab .close').first().click();
    await page.waitForTimeout(400);
    await open(document.file);

    const reopened = await page.locator('.ul-office-doc').innerText();
    check(say('the rewritten text reads back'), reopened.includes(REPLACEMENT));
    check(say('the original text is not in the view either'), !reopened.includes(originalText));

    await page.screenshot({ path: resolve(ROOT, `tools/screenshots/desktop-${document.label}-edit.png`) });
    await page.locator('.tab .close').first().click();
    await page.waitForTimeout(400);
  }
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await page
    ?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-office-edit.png') })
    .catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  app.kill();
  spawn('taskkill', ['/F', '/IM', 'uleditor-desktop.exe'], { shell: true, stdio: 'ignore' });
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
