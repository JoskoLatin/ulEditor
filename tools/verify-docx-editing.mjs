/**
 * Prepisivanje Word dokumenta u **pravoj desktop aplikaciji**, do diska i natrag.
 *
 * `verify-docx-edit.mjs` dokazuje da zapis dira samo ono što treba. Ovdje se
 * dokazuje da taj zapis uopće dolazi do datoteke: dvoklik, tipkanje,
 * `Ctrl+S`, ponovno otvaranje. Između toga stoji sve što se u Nodeu ne da
 * provjeriti — `contenteditable`, prijenos kroz Rust VFS i ponovno čitanje.
 *
 *   node tools/verify-docx-editing.mjs
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

import { makeDocx } from './fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9336;
const REPLACEMENT = 'Prepisano u ulEditoru — čćžšđ';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const workspace = await mkdtemp(join(tmpdir(), 'ul-docx-'));
const file = join(workspace, 'izvjestaj.docx');
await writeFile(file, makeDocx());

const before = unzipSync(await readFile(file));
const otherParts = Object.keys(before).filter((path) => path !== 'word/document.xml');

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

try {
  browser = await connect(240000);
  const contexts = browser.contexts();
  page = contexts[0]?.pages()[0] ?? (await contexts[0].waitForEvent('page'));
  await page.waitForSelector('.shell', { timeout: 30000 });
  check('spojen na desktop aplikaciju', true);

  for (let guard = 0; guard < 20 && (await page.locator('.tab').count()) > 0; guard++) {
    await page.locator('.tab .close').first().click();
    await page.waitForTimeout(200);
  }

  await page.evaluate(
    (dir) => window.__TAURI_INTERNALS__.invoke('adopt_paths', { paths: [dir] }),
    workspace,
  );

  const open = async () => {
    await page.keyboard.press('Control+P');
    await page.waitForSelector('.palette-input input', { timeout: 10000 });
    await page.locator('.palette-input input').fill('izvjestaj.docx');
    await page.waitForSelector('.palette-item', { timeout: 15000 });
    await page.locator('.palette-item').first().click();
    await page.waitForSelector('.ul-office-doc', { timeout: 30000 });
  };

  await open();
  check('Word dokument je otvoren', true);

  const runs = await page.locator('.ul-office-run').count();
  check('prepisivi komadi teksta su označeni', runs > 0, `${runs}`);

  const first = page.locator('.ul-office-run').first();
  const originalText = await first.innerText();
  await first.dblclick();

  const editing = await page.evaluate(
    () => document.querySelector('.ul-office-run')?.isContentEditable ?? false,
  );
  check('dvoklik otvara tekst za tipkanje', editing);

  await page.keyboard.press('Control+A');
  await page.keyboard.type(REPLACEMENT);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  check('tekst je zamijenjen u pregledu', (await first.innerText()) === REPLACEMENT, await first.innerText());
  check('dokument je označen kao izmijenjen', (await page.locator('.tab[data-dirty="true"]').count()) === 1);

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
    'spremanje je prošlo bez zapreke',
    saved,
    (await page.locator('.toast p').last().innerText().catch(() => '')).slice(0, 160),
  );

  /* ── što je na disku ───────────────────────────────────────────────── */

  const after = unzipSync(await readFile(file));

  check(
    'izmjena je u dokumentu',
    strFromU8(after['word/document.xml']).includes('Prepisano u ulEditoru'),
  );
  check('izvornog teksta više nema', !strFromU8(after['word/document.xml']).includes(originalText));

  /*
   * Glavna provjera cijelog Office smjera: uređivanje ne smije usput
   * prepisati stilove, numeriranje ni metapodatke. Tiho gubljenje tuđeg
   * formatiranja je jedina greška od koje se povjerenje ne oporavi.
   */
  const drifted = otherParts.filter((path) => {
    const a = before[path];
    const b = after[path];
    return !b || a.length !== b.length || a.some((byte, i) => byte !== b[i]);
  });
  check(
    'nijedan drugi dio datoteke nije dirnut',
    drifted.length === 0,
    drifted.join(', ') || `${otherParts.length} dijelova nepromijenjeno`,
  );

  /* ── ponovno otvaranje ─────────────────────────────────────────────── */

  await page.locator('.tab .close').first().click();
  await page.waitForTimeout(400);
  await open();

  const reopened = await page.locator('.ul-office-doc').innerText();
  check('prepisani tekst se čita natrag', reopened.includes(REPLACEMENT));
  check('izvornog teksta nema ni u pregledu', !reopened.includes(originalText));

  await page.screenshot({ path: resolve(ROOT, 'tools/screenshots/desktop-docx-edit.png') });
} catch (err) {
  check('izvođenje bez iznimke', false, err instanceof Error ? err.message : String(err));
  await page
    ?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-docx-edit.png') })
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
