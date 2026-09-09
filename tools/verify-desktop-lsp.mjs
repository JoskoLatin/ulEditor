/**
 * A language server **inside the desktop application**, from a mistake typed in
 * a file to the underline under it.
 *
 * `cargo test -p ul-lsp` checks the client and one ignored test drives a real
 * rust-analyzer. What neither can reach is the whole path: a document opening,
 * a server starting for the right project, a publication crossing the Rust
 * boundary as an event, and a mark appearing in the margin of a CodeMirror that
 * knew nothing about any of it.
 *
 * **Both outcomes are checked, and neither is a silent pass.** With
 * rust-analyzer installed, a mistake has to be marked and then unmarked; with
 * no server, the editor has to keep colouring the code and say nothing. The
 * detail line says which branch ran, so a machine that quietly lost its
 * toolchain cannot look like a machine where diagnostics work.
 *
 * The one thing this cannot rush is rust-analyzer: it loads the sysroot and runs
 * `cargo check` before it says anything, which is tens of seconds on a cold
 * cache. Under the application that check is not blocked by anything — unlike
 * in `cargo test`, where the package-cache lock is held by the test itself.
 *
 *   node tools/verify-desktop-lsp.mjs
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDesktop, stopDesktop } from './desktop-session.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BROKEN = ['fn main() {', '    let broken = ;', '}', ''].join('\n');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

async function until(condition, timeout = 180000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

let session;

try {
  session = await startDesktop({ port: 9341 });
  const { page } = session;
  check('attached to the desktop application', true);

  /* A crate of its own, outside this repository: rust-analyzer runs
     `cargo metadata`, and a directory inside another workspace that is not one
     of its members is a project cargo refuses to describe. */
  const workspace = await mkdtemp(join(tmpdir(), 'ul-lsp-app-'));
  await writeFile(
    join(workspace, 'Cargo.toml'),
    '[package]\nname = "proba"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
    'utf8',
  );
  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'src', 'main.rs'), BROKEN, 'utf8');

  const served = await page.evaluate(
    () => window.__TAURI_INTERNALS__.invoke('lsp_languages'),
  );
  check('the application was asked which languages it can serve', Array.isArray(served), (served ?? []).join(', ') || 'none');

  await page.evaluate(
    (dir) => window.__TAURI_INTERNALS__.invoke('adopt_paths', { paths: [dir] }),
    workspace,
  );

  await page.keyboard.press('Control+P');
  await page.waitForSelector('.palette-input input', { timeout: 10000 });
  await page.locator('.palette-input input').fill('main.rs');
  await page.waitForSelector('.palette-item', { timeout: 15000 });
  await page.locator('.palette-item').first().click();

  await page.waitForSelector('.cm-content', { timeout: 30000 });
  check('the file is open in the code editor', true);

  if (!served.includes('rust')) {
    /* No rust-analyzer on this machine. That is a correct outcome with its own
       claim: the editor colours the code and says nothing about it. */
    const marks = await page.locator('.cm-lint-marker-error').count();
    check('without a server, nothing is marked', marks === 0, `${marks} marks`);
    check(
      'and the code is still there to read',
      (await page.locator('.cm-content').innerText()).includes('fn main'),
    );
  } else {
    /* Three minutes: the sysroot and the first `cargo check`. This is the one
       genuinely slow thing in the program, and it is somebody else's process. */
    const marked = await until(
      async () => (await page.locator('.cm-lint-marker-error').count()) > 0,
      180000,
    );
    check('the mistake is marked in the margin', marked);

    if (marked) {
      const underlined = await page.locator('.cm-lintRange-error').count();
      check('and underlined in the text', underlined > 0, `${underlined} range(s)`);

      const status = await page
        .locator('.status-right, .statusbar, .status')
        .first()
        .innerText()
        .catch(() => '');
      /* `✕` and a number, not merely a digit: "Line 1, column 1" has digits in
         it whatever the server does or does not say, and an assertion that
         cannot fail is an assertion that proves nothing. */
      check(
        'the status bar counts what was found',
        /\d+\s*✕/.test(status),
        status.replace(/\s+/g, ' ').slice(0, 80) || '(nothing)',
      );

      /* And now the half that is easy to get wrong: a corrected file has to
         stop being underlined. The mistake is fixed by typing, and then saved,
         because a save is what makes `cargo check` run again. */
      await page.locator('.cm-content').click();
      await page.keyboard.press('Control+A');
      await page.keyboard.type('fn main() {\n    let fixed = 1;\n    println!("{fixed}");\n');
      await page.keyboard.press('Control+S');

      const cleared = await until(
        async () => (await page.locator('.cm-lint-marker-error').count()) === 0,
        180000,
      );
      check(
        'and the marks go when the mistake does',
        cleared,
        cleared ? '' : 'an underline would have stayed for as long as the file was open',
      );
    }
  }

  await page.screenshot({ path: resolve(ROOT, 'tools/screenshots/desktop-lsp.png') });
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await session?.page
    ?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-desktop-lsp.png') })
    .catch(() => {});
} finally {
  await stopDesktop(session);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
