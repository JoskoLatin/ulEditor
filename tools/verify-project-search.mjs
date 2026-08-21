/**
 * Provjera pretrage po projektu — u **pravoj desktop aplikaciji**.
 *
 * Ostale provjere voze Vite u Chromiumu, ali pretraga živi u Rustu i dostupna
 * je samo kroz Tauri naredbu. Stub bi provjerio ljepilo, ne posao. Zato se
 * ovdje diže sam program s otvorenim WebView2 debug portom i Playwright se
 * spaja na njega preko CDP-a — isti binary koji korisnik pokreće.
 *
 * Radni prostor se registrira naredbom `adopt_paths`, jer sistemski dijalog
 * za odabir mape nije moguće voziti iz skripte.
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

/* ── radni prostor s po jednim primjerkom svakog formata ─────────────── */

const workspace = await mkdtemp(join(tmpdir(), 'ul-search-'));
await mkdir(join(workspace, 'src'), { recursive: true });
await mkdir(join(workspace, 'node_modules', 'paket'), { recursive: true });

await writeFile(
  join(workspace, 'src', 'modul.ts'),
  'export const x = 1;\n// jedinstvenokod se traži iz pretrage\nexport const y = 2;\n',
);
await writeFile(join(workspace, 'biljeske.md'), '# Naslov\n\njedinstvenokod i još teksta.\n');
await writeFile(join(workspace, 'node_modules', 'paket', 'skriveno.ts'), 'jedinstvenokod\n');
await writeFile(join(workspace, 'ugovor.pdf'), makePdf('jedinstvenopdf'));
await writeFile(join(workspace, 'izvjestaj.docx'), makeDocx());
await writeFile(join(workspace, 'promet.xlsx'), makeXlsx());
await writeFile(join(workspace, 'knjiga.epub'), makeEpub({ chapters: 2 }));

/* ── program s otvorenim debug portom ────────────────────────────────── */

const app = spawn('pnpm', ['--filter', '@uleditor/desktop', 'dev'], {
  cwd: ROOT,
  shell: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  },
  stdio: 'ignore',
});

/** Čeka da WebView2 objavi CDP endpoint. */
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

try {
  browser = await connect(180000);
  const contexts = browser.contexts();
  page = contexts[0]?.pages()[0] ?? (await contexts[0].waitForEvent('page'));
  await page.waitForSelector('.shell', { timeout: 30000 });
  check('spojen na pokrenutu desktop aplikaciju', true);

  const platform = await page.evaluate(() => Boolean(window.__TAURI_INTERNALS__));
  check('radi u Tauri okruženju, ne u pregledniku', platform);

  /* — radni prostor — */
  const added = await page.evaluate(
    (dir) => window.__TAURI_INTERNALS__.invoke('adopt_paths', { paths: [dir] }),
    workspace,
  );
  check('mapa je registrirana kao radni prostor', Array.isArray(added) && added.length === 1);

  /* — pretraga po tekstu — */
  await page.keyboard.press('Control+Shift+H');
  await page.waitForSelector('.search-panel', { timeout: 10000 });
  check('ploča pretrage se otvara', true);

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

  await runSearch('jedinstvenokod', false);

  const files = await page.locator('.search-file .name').allInnerTexts();
  check('nađeno je u kodu i u Markdownu', files.includes('modul.ts') && files.includes('biljeske.md'), files.join(', '));
  check('node_modules je preskočen', !files.includes('skriveno.ts'), files.join(', '));

  const where = await page.locator('.search-hit .where').first().innerText();
  check('pogodak nosi broj retka', /line \d+/.test(where), where);

  const preview = await page.locator('.search-hit .what').first().innerText();
  check('pogodak nosi isječak retka', preview.includes('jedinstvenokod'), preview.slice(0, 60));

  /* — skok u datoteku koja nije bila otvorena — */
  await page.locator('.search-hit').first().click();
  await page.waitForSelector('.cm-editor', { timeout: 20000 });
  const tab = await page.locator('.tab[data-active="true"] .name').innerText();
  check('klik na pogodak otvara datoteku', tab === 'modul.ts' || tab === 'biljeske.md', tab);

  /* — drugi prolaz: dokumenti — */
  await page.keyboard.press('Control+Shift+H');

  await runSearch('jedinstvenoword', true);
  const docHits = await page.locator('.search-file .name').allInnerTexts();
  check('Word dokument je pretražen', docHits.includes('izvjestaj.docx'), docHits.join(', '));

  await runSearch('jedinstvenoexcel', true);
  const xlsHits = await page.locator('.search-file .name').allInnerTexts();
  check('Excel tablica je pretražena', xlsHits.includes('promet.xlsx'), xlsHits.join(', '));
  const cell = await page.locator('.search-hit .where').first().innerText();
  check('pogodak u tablici nosi adresu ćelije', /![A-Z]+\d+$/.test(cell), cell);

  await runSearch('jedinstvenopoglavlje1', true);
  const bookHits = await page.locator('.search-file .name').allInnerTexts();
  check('e-knjiga je pretražena', bookHits.includes('knjiga.epub'), bookHits.join(', '));

  await runSearch('jedinstvenopdf', true);
  const pdfHits = await page.locator('.search-file .name').allInnerTexts();
  check('PDF je pretražen', pdfHits.includes('ugovor.pdf'), pdfHits.join(', '));
  const pdfWhere = await page.locator('.search-hit .where').first().innerText();
  check('pogodak u PDF-u nosi stranicu', /page \d+/.test(pdfWhere), pdfWhere);

  /* — bez drugog prolaza dokumenti se ne diraju — */
  await runSearch('jedinstvenoword', false);
  const withoutDocs = await page.locator('.search-file .name').allInnerTexts();
  check(
    'bez kvačice dokumenti se ne čitaju',
    !withoutDocs.includes('izvjestaj.docx'),
    withoutDocs.join(', ') || 'nema pogodaka',
  );

  /* — brzo otvaranje po imenu — */
  await page.keyboard.press('Control+P');
  await page.waitForSelector('.palette-input input', { timeout: 10000 });
  await page.locator('.palette-input input').pressSequentially('promet');
  await page.waitForTimeout(400);
  const quick = await page.locator('.palette-item').allInnerTexts();
  check('brzo otvaranje nalazi datoteku po imenu', quick.some((v) => v.includes('promet.xlsx')), quick.slice(0, 3).join(' | '));

  await page.keyboard.press('Enter');
  await page.waitForSelector('.ul-sheet', { timeout: 30000 });
  check('brzo otvaranje stvarno otvara dokument', true);
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await page?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-project-search.png') }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  app.kill();
  // Tauri ostavlja podprocese; port mora biti slobodan za sljedeće pokretanje.
  spawn('taskkill', ['/F', '/IM', 'uleditor-desktop.exe'], { shell: true, stdio: 'ignore' });
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
