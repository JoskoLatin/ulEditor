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
 * Then the three questions — the tooltip, the list and the jump — which have a
 * path of their own the Rust tests cannot reach: a position CodeMirror
 * measured, a command the shell owns, and, for the jump, **a second file
 * opening**. That last one is the interesting half. A definition is very often
 * outside every folder that was opened — the standard library, a crate under
 * `~/.cargo` — and the desktop sandbox has never been told about those, so the
 * jump is also a test of re-adopting a path.
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

/*
 * What the file becomes once the mistake is corrected — and what the three
 * questions are asked about. A function on the first line, called from the
 * sixth: a hover with a signature in it, a definition on a line that is not
 * its own, and a prefix that can be completed.
 */
const FIXED = [
  'fn broj() -> i32 {',
  '    42',
  '}',
  '',
  'fn main() {',
  '    let x = broj();',
  '    println!("{x}");',
  '}',
  '',
].join('\n');

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
      /* `insertText` rather than `type`: CodeMirror closes brackets and indents
         as it goes, so eight lines typed a key at a time arrive as something
         else entirely — and this check is not about that. */
      await page.keyboard.insertText(FIXED);
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

      /* ── and now the three questions ───────────────────────────────────
       *
       * Asked through the same commands the editor asks through, at the same
       * positions. Going through `invoke` rather than through the pointer is
       * deliberate for two of them: a hover depends on where a mouse stops,
       * which is a measurement this harness would be testing instead of the
       * answer. The jump is driven from the keyboard, because the keyboard is
       * the half that has to work.
       */
      const ask = (command, line, column) =>
        page.evaluate(
          ([name, path, at, col]) =>
            window.__TAURI_INTERNALS__.invoke(name, {
              path,
              language: 'rust',
              line: at,
              column: col,
            }),
          [command, join(workspace, 'src', 'main.rs'), line, column],
        );

      /*
       * Asked until answered, not asked once.
       *
       * The save two steps up set `cargo check` going, and a server running one
       * answers a hover late or not at all — the client waits three seconds for
       * one and then shows nothing, which is right for a tooltip and wrong for
       * a check. Asking once here measured how busy rust-analyzer happened to
       * be, which is not a property of this program: the first run of this had
       * all three of these failing while `F12`, half a minute further down the
       * file, went through the same command and worked.
       *
       * So the same patience the diagnostics above are given. What is being
       * checked is that the answer is *reachable* and correct, and the timeouts
       * that decide when it is too late to be worth drawing belong to the
       * client and are stated there.
       */
      const answered = async (command, line, column, correct) => {
        let last;
        const ok = await until(async () => {
          last = await ask(command, line, column);
          return correct(last);
        }, 120000);
        return [ok, last];
      };

      /* `broj` on the sixth line, `    let x = broj();`, column 14. */
      const [hovered, hover] = await answered(
        'lsp_hover',
        6,
        14,
        (answer) => typeof answer?.markdown === 'string' && answer.markdown.includes('i32'),
      );
      check(
        'a hover says what the thing under the cursor is',
        hovered,
        (hover?.markdown ?? '(nothing)').replace(/\s+/g, ' ').slice(0, 70),
      );

      const [jumpedTo, found] = await answered(
        'lsp_definition',
        6,
        14,
        (answer) => Array.isArray(answer) && answer[0]?.line === 1,
      );
      check(
        'a definition points at the line it was declared on',
        jumpedTo,
        Array.isArray(found) ? JSON.stringify(found[0] ?? null) : '(nothing)',
      );

      const [completed, offered] = await answered(
        'lsp_completion',
        6,
        15,
        (answer) => Array.isArray(answer) && answer.some((item) => item.label?.startsWith('broj')),
      );
      check('a completion list has the names of this file in it', completed, `${offered?.length ?? 0} offered`);
      check(
        'and nothing in it is a snippet, because the client said it takes none',
        Array.isArray(offered) && !offered.some((item) => item.snippet),
        `${offered?.filter((item) => item.snippet).length ?? 0} snippet(s)`,
      );

      /*
       * And the whole path, from a key to a cursor. `F12` on the call has to
       * put the cursor on the first line — the declaration — which is the
       * shell's keyboard handler, the editor's own question, a tab lookup and
       * `revealPosition` all having agreed.
       *
       * It is also the check that F12 reaches the editor at all. The key used
       * to open the developer tools unconditionally, and the shell listens with
       * `capture: true` — so a binding put in CodeMirror instead would never
       * have fired, and would have looked exactly like a server with nothing
       * to say.
       */
      await page.locator('.cm-content').click();
      await page.keyboard.press('Control+Home');
      for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowDown');
      for (let i = 0; i < 13; i += 1) await page.keyboard.press('ArrowRight');

      const before = await page.locator('.status-right, .statusbar, .status').first().innerText();
      await page.keyboard.press('F12');
      const jumped = await until(async () => {
        const status = await page
          .locator('.status-right, .statusbar, .status')
          .first()
          .innerText()
          .catch(() => '');
        return status !== before && /(?:Line|Redak|Ln)\s*1\b/.test(status);
      }, 20000);
      check(
        'F12 puts the cursor on the definition',
        jumped,
        jumped ? '' : `the status bar still reads ${before.replace(/\s+/g, ' ').slice(0, 40)}`,
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
