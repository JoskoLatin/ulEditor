/**
 * Krug koji dokazuje da upisani tekst preživi: napiši → spremi → otvori nanovo.
 *
 * `verify-pdf-text.mjs` gleda strukturu zapisanog PDF-a, ali radi nad
 * bajtovima u memoriji. Ovdje se ista stvar vozi kroz **pravu desktop
 * aplikaciju**, do diska i natrag, jer se između njih nalazi sve ono što
 * struktura ne pokriva: spremanje kroz Rust VFS, ponovno otvaranje i — što je
 * najvažnije — čita li pdf.js natrag ono što je pdf-lib napisao.
 *
 * To zadnje nije formalnost. `/FreeText` je jedina anotacija koju pišemo a
 * koju čitači crtaju isključivo iz priloženog toka izgleda; da smo ga
 * propustili, datoteka bi i dalje bila valjan PDF i i dalje bi sadržavala
 * tekst — samo ga nitko ne bi vidio.
 *
 *   node tools/verify-pdf-editing.mjs
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makePdf } from './fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9334;
const TYPED = 'Vodice, 15. kolovoza — čćžšđ';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const workspace = await mkdtemp(join(tmpdir(), 'ul-pdf-text-'));
const file = join(workspace, 'obrazac.pdf');
await writeFile(file, makePdf());
const originalSize = (await readFile(file)).length;

const app = spawn('pnpm', ['--filter', '@uleditor/desktop', 'dev'], {
  cwd: ROOT,
  shell: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
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
  throw lastError ?? new Error('CDP se nije otvorio');
}

let browser;
let page;

/** Otvara dokument iz radnog prostora kroz brzo otvaranje. */
async function open(name) {
  await page.keyboard.press('Control+P');
  await page.waitForSelector('.palette-input input', { timeout: 10000 });
  await page.locator('.palette-input input').fill(name);
  await page.waitForSelector('.palette-item', { timeout: 15000 });
  await page.locator('.palette-item').first().click();
  await page.waitForSelector('.ul-pdf-page[data-rendered="true"]', { timeout: 30000 });
}

try {
  browser = await connect(240000);
  const contexts = browser.contexts();
  page = contexts[0]?.pages()[0] ?? (await contexts[0].waitForEvent('page'));
  await page.waitForSelector('.shell', { timeout: 30000 });
  check('spojen na desktop aplikaciju', true);

  /* Zatvara sve što je ostalo od prethodnog pokretanja. */
  for (let guard = 0; guard < 20 && (await page.locator('.tab').count()) > 0; guard++) {
    await page.locator('.tab .close').first().click();
    await page.waitForTimeout(200);
  }

  await page.evaluate(
    (dir) => window.__TAURI_INTERNALS__.invoke('adopt_paths', { paths: [dir] }),
    workspace,
  );

  await open('obrazac.pdf');
  check('PDF otvoren iz radnog prostora', true);

  /* ── upis ──────────────────────────────────────────────────────────── */

  await page.locator('.ul-pdf-tool[title*="Add text"]').click();
  await page.locator('.ul-pdf-page').first().click({ position: { x: 80, y: 140 } });
  await page.waitForSelector('.ul-pdf-text-input', { timeout: 15000 });
  await page.locator('.ul-pdf-text-input').pressSequentially(TYPED);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ul-pdf-ann-text', { timeout: 5000 });
  check('tekst upisan u dokument', true);

  /* ── spremanje ─────────────────────────────────────────────────────── */

  await page.keyboard.press('Control+S');
  await page.waitForFunction(() => document.querySelectorAll('.tab[data-dirty="true"]').length === 0, {
    timeout: 30000,
  });

  const saved = await readFile(file);
  const raw = new TextDecoder('latin1').decode(saved);
  check('datoteka na disku je narasla', saved.length > originalSize, `${originalSize} → ${saved.length} B`);
  check('zapisan je FreeText', raw.includes('/FreeText'));
  check('font je ugrađen u datoteku', raw.includes('/FontFile2'));

  /* ── ponovno otvaranje ─────────────────────────────────────────────── */

  await page.locator('.tab .close').first().click();
  await page.waitForTimeout(400);
  await open('obrazac.pdf');

  /*
   * Ovo je prava provjera: okvir se ovdje ne crta iz našeg stanja nego iz
   * onoga što je pdf.js pročitao iz datoteke. Da tok izgleda ili sadržaj
   * nedostaju, ovdje ne bi bilo ničega.
   */
  await page.waitForSelector('.ul-pdf-ann-text', { timeout: 20000 });
  const reopened = await page.locator('.ul-pdf-ann-text').first().innerText();
  check('tekst je pročitan natrag iz datoteke', reopened === TYPED, JSON.stringify(reopened));

  check(
    'ponovno otvoren dokument nije odmah izmijenjen',
    (await page.locator('.tab[data-dirty="true"]').count()) === 0,
  );

  await page.screenshot({ path: resolve(ROOT, 'tools/screenshots/desktop-pdf-text.png') });
} catch (err) {
  check('izvođenje bez iznimke', false, err instanceof Error ? err.message : String(err));
  await page
    ?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-pdf-text.png') })
    .catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  app.kill();
  spawn('taskkill', ['/F', '/IM', 'uleditor-desktop.exe'], { shell: true, stdio: 'ignore' });
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} provjera prošlo`);
process.exit(failed.length === 0 ? 0 : 1);
