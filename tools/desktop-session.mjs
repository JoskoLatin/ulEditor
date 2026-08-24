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
import { spawn } from 'node:child_process';
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
export async function startDesktop(opts = {}) {
  const port = opts.port ?? 9333;
  const timeoutMs = opts.timeoutMs ?? 240000;

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
    stdio: 'ignore',
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
  // Tauri leaves child processes behind.
  spawn('taskkill', ['/F', '/IM', 'uleditor-desktop.exe'], { shell: true, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
}
