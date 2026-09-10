/**
 * Driving **the real desktop application** from the checks.
 *
 * Some behaviour exists only in the Tauri environment and cannot be checked in a
 * browser: the commands in Rust, and the CSP that applies to the application
 * rather than to the Vite dev server. A check in a browser would be testing the
 * glue instead of the work.
 *
 * WebView2 opens a CDP endpoint on request, so Playwright attaches to the same
 * binary the user runs.
 */

import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Brings the application up and returns the attached page.
 *
 * @param {{ port?: number, timeoutMs?: number }} [opts]
 */
/**
 * Whether an ulEditor is already running, and would swallow the one we start.
 *
 * The application uses `tauri-plugin-single-instance`: a second copy hands its
 * arguments to the first and **exits**. So with the person's own ulEditor open,
 * every desktop check starts a window that is never theirs, waits four minutes
 * for a debugging port that will never open, and reports
 * `connect ECONNREFUSED` — a true sentence about a socket and a useless one
 * about the cause. Asking first costs nothing and turns that into an
 * instruction.
 *
 * Windows only, which is where these checks run; anywhere else it says nothing
 * rather than guessing.
 */
export function alreadyRunning() {
  if (process.platform !== 'win32') return false;
  /* No filter and no shell, deliberately. `tasklist /FI` through a shell is
     mangled when these checks are run from Git Bash — MSYS rewrites `/FI` into
     a path and tasklist answers with an error nobody reads — so the list is
     asked for whole and searched here. */
  const listed = spawnSync('tasklist', [], { encoding: 'utf8' });
  return /uleditor-desktop\.exe/i.test(listed.stdout ?? '');
}

export const ALREADY_RUNNING =
  'ulEditor is already open, and a second copy hands over to the first and exits — ' +
  'close it and run this again';

export async function startDesktop(opts = {}) {
  const port = opts.port ?? 9333;
  const timeoutMs = opts.timeoutMs ?? 240000;

  if (alreadyRunning()) throw new Error(ALREADY_RUNNING);

  const app = spawn('pnpm', ['--filter', '@uleditor/desktop', 'dev'], {
    cwd: ROOT,
    shell: true,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      /* A scratch profile. Settings live in the WebView2 localStorage, and
         without this the checks run in the person's own — every fixture they
         open lands in the real recent list and the real session. */
      WEBVIEW2_USER_DATA_FOLDER: await mkdtemp(join(tmpdir(), 'ul-profile-')),
    },
    /* Silent, unless somebody is trying to find out why a check fails.
       `UL_DESKTOP_LOG=1` lets the application's own output through, which is
       the only way to read `UL_LSP_TRACE` — a check that swallows the program's
       stderr is a check that can only be debugged by guessing. */
    stdio: process.env.UL_DESKTOP_LOG ? 'inherit' : 'ignore',
  });

  const until = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < until) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const context = browser.contexts()[0];
      const page = context?.pages()[0] ?? (await context.waitForEvent('page'));
      await page.waitForSelector('.shell', { timeout: 30000 });
      return { app, browser, page };
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  app.kill();
  throw lastError ?? new Error('WebView2 never opened a CDP endpoint');
}

/** Closes the application and frees the ports for the next run. */
export async function stopDesktop(session) {
  await session?.browser?.close().catch(() => {});
  session?.app?.kill();
  /*
   * By process tree, not by name.
   *
   * `taskkill /IM uleditor-desktop.exe` closes **every** ulEditor on the
   * machine — including the one the person running this check has open, with
   * whatever is unsaved in it. The dev build and the installed build share a
   * name and nothing else, so the only safe handle is the process this harness
   * started itself; `/T` takes the children Tauri leaves behind with it.
   */
  const pid = session?.app?.pid;
  if (pid) spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { shell: true, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
}

/**
 * Whether a URL the window asked for stayed inside the application.
 *
 * The checks that count outgoing requests need this, and getting it wrong is
 * quiet in both directions: too narrow and the application's own IPC reads as an
 * escape, too wide and a CDN fetch reads as local. Tauri's bridge is
 * `http://ipc.localhost` — declared in the CSP's `connect-src` — and every
 * command invoked from the page goes through it, so opening a document at all
 * produces a handful.
 */
export function isLocal(url) {
  return /^(https?:\/\/(localhost|127\.0\.0\.1|192\.168\.|ipc\.localhost|tauri\.localhost)|data:|blob:|ipc:)/.test(
    url,
  );
}
