/**
 * Vožnja **prave desktop aplikacije** iz provjera.
 *
 * Dio ponašanja postoji samo u Tauri okruženju i ne može se provjeriti u
 * pregledniku: naredbe u Rustu, i CSP koji vrijedi za aplikaciju a ne za Vite
 * dev server. Provjera u pregledniku bi ondje testirala ljepilo umjesto posla.
 *
 * WebView2 na zahtjev otvara CDP endpoint, pa se Playwright spaja na isti
 * binary koji korisnik pokreće.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Diže aplikaciju i vraća spojenu stranicu.
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
  throw lastError ?? new Error('WebView2 nije otvorio CDP endpoint');
}

/** Zatvara aplikaciju i oslobađa portove za sljedeće pokretanje. */
export async function stopDesktop(session) {
  await session?.browser?.close().catch(() => {});
  session?.app?.kill();
  // Tauri ostavlja podprocese iza sebe.
  spawn('taskkill', ['/F', '/IM', 'uleditor-desktop.exe'], { shell: true, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
}
