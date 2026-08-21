/**
 * Checking project-wide search — in **the real desktop application**.
 *
 * The other checks drive Vite in Chromium, but the search lives in Rust and is
 * reachable only through a Tauri command. A stub would check the glue, not the
 * work. So the program itself is brought up here with the WebView2 debug port
 * open and Playwright attaches to it over CDP — the same binary the user runs.
 *
 * The workspace is registered with the `adopt_paths` command, because the system
 * folder-picker dialog cannot be driven from a script.
 *
 *   node tools/verify-project-search.mjs [--headed]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeDocx, makeEpub, makePdf, makeXlsx } from './fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9333;

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── a workspace holding one specimen of every format ────────────────── */

const workspace = await mkdtemp(join(tmpdir(), 'ul-search-'));
await mkdir(join(workspace, 'src'), { recursive: true });
await mkdir(join(workspace, 'node_modules', 'package'), { recursive: true });

await writeFile(
  join(workspace, 'src', 'module.ts'),
  'export const x = 1;\n// uniquecode is what the search looks for\nexport const y = 2;\n',
);
await writeFile(join(workspace, 'notes.md'), '# Heading\n\nuniquecode and some more text.\n');
await writeFile(join(workspace, 'node_modules', 'package', 'hidden.ts'), 'uniquecode\n');
await writeFile(join(workspace, 'contract.pdf'), makePdf('uniquepdf'));
await writeFile(join(workspace, 'report.docx'), makeDocx());
await writeFile(join(workspace, 'sales.xlsx'), makeXlsx());
await writeFile(join(workspace, 'book.epub'), makeEpub({ chapters: 2 }));

/* ── the program with its debug port open ────────────────────────────── */

const app = spawn('pnpm', ['--filter', '@uleditor/desktop', 'dev'], {
  cwd: ROOT,
  shell: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  },
  stdio: 'ignore',
});

/** Waits for WebView2 to publish its CDP endpoint. */
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
  browser = await connect(180000);
  const contexts = browser.contexts();
  page = contexts[0]?.pages()[0] ?? (await contexts[0].waitForEvent('page'));
  await page.waitForSelector('.shell', { timeout: 30000 });
  check('attached to the running desktop application', true);

  const platform = await page.evaluate(() => Boolean(window.__TAURI_INTERNALS__));
  check('running in the Tauri environment, not in a browser', platform);

  /* — the workspace — */
  const added = await page.evaluate(
    (dir) => window.__TAURI_INTERNALS__.invoke('adopt_paths', { paths: [dir] }),
    workspace,
  );
  check('the folder was registered as a workspace', Array.isArray(added) && added.length === 1);

  /* — search over text — */
  await page.keyboard.press('Control+Shift+H');
  await page.waitForSelector('.search-panel', { timeout: 10000 });
  check('the search panel opens', true);

  const runSearch = async (query, documents) => {
    await page.locator('.search-input input').fill(query);
    const box = page.locator('.search-docs input');
    if ((await box.isChecked()) !== documents) await box.click();
    await page.locator('.search-run').click();
    await page.waitForFunction(() => {
      const note = document.querySelector('.search-note');
      return note && !/…$/.test(note.textContent ?? '');
    }, { timeout: 120000 });
  };

  await runSearch('uniquecode', false);

  const files = await page.locator('.search-file .name').allInnerTexts();
  check('found in the code and in the Markdown', files.includes('module.ts') && files.includes('notes.md'), files.join(', '));
  check('node_modules was skipped', !files.includes('hidden.ts'), files.join(', '));

  const where = await page.locator('.search-hit .where').first().innerText();
  check('the hit carries a line number', /line \d+/.test(where), where);

  const preview = await page.locator('.search-hit .what').first().innerText();
  check('the hit carries a snippet of the line', preview.includes('uniquecode'), preview.slice(0, 60));

  /* — a jump into a file that was not open — */
  await page.locator('.search-hit').first().click();
  await page.waitForSelector('.cm-editor', { timeout: 20000 });
  const tab = await page.locator('.tab[data-active="true"] .name').innerText();
  check('clicking a hit opens the file', tab === 'module.ts' || tab === 'notes.md', tab);

  /* — the second pass: documents — */
  await page.keyboard.press('Control+Shift+H');

  await runSearch('uniqueword', true);
  const docHits = await page.locator('.search-file .name').allInnerTexts();
  check('the Word document was searched', docHits.includes('report.docx'), docHits.join(', '));

  await runSearch('uniqueexcel', true);
  const xlsHits = await page.locator('.search-file .name').allInnerTexts();
  check('the Excel spreadsheet was searched', xlsHits.includes('sales.xlsx'), xlsHits.join(', '));
  const cell = await page.locator('.search-hit .where').first().innerText();
  check('a hit in a spreadsheet carries its cell address', /![A-Z]+\d+$/.test(cell), cell);

  await runSearch('uniquechapter1', true);
  const bookHits = await page.locator('.search-file .name').allInnerTexts();
  check('the e-book was searched', bookHits.includes('book.epub'), bookHits.join(', '));

  await runSearch('uniquepdf', true);
  const pdfHits = await page.locator('.search-file .name').allInnerTexts();
  check('the PDF was searched', pdfHits.includes('contract.pdf'), pdfHits.join(', '));
  const pdfWhere = await page.locator('.search-hit .where').first().innerText();
  check('a hit in a PDF carries its page', /page \d+/.test(pdfWhere), pdfWhere);

  /* — without the second pass the documents are left alone — */
  await runSearch('uniqueword', false);
  const withoutDocs = await page.locator('.search-file .name').allInnerTexts();
  check(
    'with the box unticked the documents are not read',
    !withoutDocs.includes('report.docx'),
    withoutDocs.join(', ') || 'no hits',
  );

  /* — quick open by name — */
  await page.keyboard.press('Control+P');
  await page.waitForSelector('.palette-input input', { timeout: 10000 });
  await page.locator('.palette-input input').pressSequentially('sales');
  await page.waitForTimeout(400);
  const quick = await page.locator('.palette-item').allInnerTexts();
  check('quick open finds the file by name', quick.some((v) => v.includes('sales.xlsx')), quick.slice(0, 3).join(' | '));

  await page.keyboard.press('Enter');
  await page.waitForSelector('.ul-sheet', { timeout: 30000 });
  check('quick open really opens the document', true);
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await page?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-project-search.png') }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  app.kill();
  // Tauri leaves child processes behind; the port has to be free for the next run.
  spawn('taskkill', ['/F', '/IM', 'uleditor-desktop.exe'], { shell: true, stdio: 'ignore' });
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
