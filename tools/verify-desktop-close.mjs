/**
 * Closing the window **the native way** asks about unsaved work, in the desktop
 * application.
 *
 * The button in the corner of the title bar and File → Exit always asked. Alt+F4,
 * the taskbar's Close and the window menu did not: they destroyed the window
 * natively, and a document typed into and never saved went with it. The shell
 * now holds the close request in Rust while the page says it will ask
 * (`CloseGuard` in `lib.rs`, `guardWindowClose` in `shell/lifecycle.ts`), and
 * this drives the gesture the way Windows does —
 * `WM_SYSCOMMAND` with `SC_CLOSE` posted to the window, which is what Alt+F4 and
 * the taskbar send — rather than calling the program's own close, which would
 * prove only that the program asks when it asks.
 *
 * Two starts. In the first a document is changed: the close must be stopped and
 * asked about, Cancel must leave the window and the change standing, and
 * "Close anyway" must end the program. In the second nothing is changed and the
 * window is reloaded first, as a change of language does: the close must go
 * through at once, with no question and no listener left over from the page
 * that was reloaded.
 *
 * Windows only, like the other desktop checks.
 *
 *   node tools/verify-desktop-close.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDesktop, stopDesktop, openFromOutside } from './desktop-session.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function powershell(script) {
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  });
  return (out.stdout ?? '').trim();
}

/** The debug build this harness started — `alreadyRunning` made sure it is the only one. */
function appPid() {
  const pid = powershell(
    "(Get-CimInstance Win32_Process -Filter \"Name='uleditor-desktop.exe'\" | " +
      "Where-Object { $_.ExecutablePath -like '*\\target\\debug\\*' } | Select-Object -First 1).ProcessId",
  );
  return /^\d+$/.test(pid) ? Number(pid) : null;
}

function alive(pid) {
  return powershell(`[bool](Get-Process -Id ${pid} -ErrorAction SilentlyContinue)`) === 'True';
}

/** What Alt+F4 and the taskbar's Close send: `WM_SYSCOMMAND`, `SC_CLOSE`. */
function nativeClose(pid) {
  return powershell(
    "Add-Type -Name W -Namespace UlClose -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'; " +
      `$h = (Get-Process -Id ${pid}).MainWindowHandle; ` +
      'if ($h -eq [IntPtr]::Zero) { "no window" } else { [UlClose.W]::PostMessage($h, 0x0112, [IntPtr]0xF060, [IntPtr]0) }',
  );
}

async function until(condition, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}

/** Opens a text file and types into it without saving; answers whether the tab is dirty. */
async function changeADocument(page) {
  const workspace = await mkdtemp(join(tmpdir(), 'ul-close-'));
  await writeFile(join(workspace, 'biljeska.txt'), 'Prvi redak.\n');
  await openFromOutside(page, [workspace]);
  await page.keyboard.press('Control+P');
  await page.waitForSelector('.palette-input input', { timeout: 10000 });
  await page.locator('.palette-input input').fill('biljeska.txt');
  /* Enter on the listed file rather than a click: the list is still being
     ranked as the name is typed, and a click once landed on a row that was
     being replaced ("element was detached from the DOM"). */
  await page.waitForSelector('.palette-item[title$="biljeska.txt"]', { timeout: 15000 });
  await page.keyboard.press('Enter');
  await page.waitForSelector('.cm-content', { timeout: 30000 });
  await page.locator('.cm-content').first().click();
  await page.keyboard.type(' nespremljeno');
  return until(async () => (await page.locator('.tab[data-dirty="true"]').count()) > 0, 5000);
}

let session;

/* ── a changed document ─────────────────────────────────────────────── */
try {
  session = await startDesktop({ port: 9341 });
  const { page } = session;
  const pid = appPid();
  check('attached to the desktop application', pid !== null, `pid ${pid}`);

  check('the document has a change nobody saved', await changeADocument(page));

  const sent = nativeClose(pid);
  check('Windows was told to close the window', sent === 'True', sent);
  const asked = await until(async () => (await page.locator('.toast').count()) > 0, 5000);
  const question = asked ? await page.locator('.toast p').first().innerText() : '';
  check('the close is stopped and asked about', asked && alive(pid), question);

  await page.locator('.toast .toast-btn', { hasText: /^\s*Cancel\s*$/ }).first().click();
  await sleep(1500);
  check('Cancel leaves the window open', alive(pid));
  check(
    'and the change still standing',
    (await page.locator('.tab[data-dirty="true"]').count()) > 0 &&
      (await page.locator('.cm-content').first().innerText()).includes('nespremljeno'),
  );

  nativeClose(pid);
  const askedAgain = await until(async () => (await page.locator('.toast').count()) > 0, 5000);
  check('a second close asks again', askedAgain);
  await page.locator('.toast .toast-btn', { hasText: /Close anyway/ }).first().click().catch(() => {});
  const gone = await until(async () => !alive(pid), 15000);
  check('"Close anyway" ends the program', gone);
} catch (err) {
  check('the changed-document run went without an exception', false, err instanceof Error ? err.message : String(err));
  await session?.page
    ?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-desktop-close.png') })
    .catch(() => {});
} finally {
  await stopDesktop(session);
}

/* ── nothing changed, after a reload ────────────────────────────────── */
session = undefined;
try {
  session = await startDesktop({ port: 9342 });
  let { page } = session;
  const pid = appPid();
  check('started again', pid !== null, `pid ${pid}`);

  /* A change of language reloads the window. The listener of the page before
     it must not survive to hold the close for a page that no longer answers. */
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 30000 });
  await sleep(2000);

  nativeClose(pid);
  const gone = await until(async () => !alive(pid), 15000);
  check('with nothing changed, the window closes at once after a reload', gone);
} catch (err) {
  check('the unchanged run went without an exception', false, err instanceof Error ? err.message : String(err));
} finally {
  await stopDesktop(session);
}

/* ── a changed document, after a reload ─────────────────────────────── */
/* The page that comes back has to take the guard up again: a reload clears it
   on the Rust side, so without this the close would go through unasked. */
session = undefined;
try {
  session = await startDesktop({ port: 9344 });
  const { page } = session;
  const pid = appPid();
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 30000 });
  await sleep(2000);
  check('after a reload, a document is changed again', await changeADocument(page));

  nativeClose(pid);
  const asked = await until(async () => (await page.locator('.toast').count()) > 0, 5000);
  check('and the close is asked about again', asked && alive(pid), asked ? await page.locator('.toast p').first().innerText() : '');
  await page.locator('.toast .toast-btn', { hasText: /Close anyway/ }).first().click().catch(() => {});
  check('"Close anyway" still ends it', await until(async () => !alive(pid), 15000));
} catch (err) {
  check('the reloaded run went without an exception', false, err instanceof Error ? err.message : String(err));
} finally {
  await stopDesktop(session);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
