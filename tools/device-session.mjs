/**
 * Vožnja aplikacije na **fizičkom Android uređaju** iz provjera.
 *
 * Isti razlog kao kod `desktop-session.mjs`: dio ponašanja postoji samo na
 * uređaju i u pregledniku se ne može provjeriti. Ovdje su to umetci sigurnog
 * područja i raspored na stvarnoj širini ekrana — jedno i drugo ovisi o tome
 * kako se sistemske trake ponašaju, a to nijedan desktop webview ne oponaša.
 *
 * WebView u debug buildu otvara devtools socket, pa se Playwright spaja na isti
 * proces koji korisnik gleda na telefonu.
 *
 * Traži uređaj spojen preko `adb` s odobrenim otklanjanjem pogrešaka.
 */

import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);

const PACKAGE = 'org.uleditor.app';

/** `adb` nije na putanji; SDK zna gdje je. */
export function adbPath() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error('ANDROID_HOME nije postavljen.');
  return join(sdk, 'platform-tools', 'adb.exe');
}

export async function adb(...args) {
  const { stdout } = await run(adbPath(), args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Instalira APK na uređaj.
 *
 * Traži da je na telefonu uključeno „Instaliranje putem USB-a”. Na MIUI-ju taj
 * prekidač uvjetuje umetnuta SIM kartica; bez nje instalacija pada s
 * `INSTALL_FAILED_USER_RESTRICTED` i APK se mora instalirati ručno.
 */
export async function installApk(apk) {
  const out = await adb('install', '-r', apk);
  if (!/Success/.test(out)) throw new Error(`Instalacija nije uspjela: ${out}`);
}

/**
 * Diže aplikaciju na uređaju i vraća spojenu stranicu.
 *
 * @param {{ port?: number, timeoutMs?: number }} [opts]
 */
export async function startDevice(opts = {}) {
  const port = opts.port ?? 9400;
  const timeoutMs = opts.timeoutMs ?? 90000;

  // Čist start: inače se spojimo na prethodnu instancu i mjerimo stari raspored.
  await adb('shell', 'am', 'force-stop', PACKAGE);
  await adb('shell', 'monkey', '-p', PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1');

  const until = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < until) {
    try {
      const socket = await devtoolsSocket();
      if (socket) {
        // Prethodni forward na istom portu bi pokazivao na mrtav proces.
        await adb('forward', '--remove', `tcp:${port}`).catch(() => {});
        await adb('forward', `tcp:${port}`, `localabstract:${socket}`);

        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        const context = browser.contexts()[0];
        const page = context?.pages()[0] ?? (await context.waitForEvent('page'));
        await page.waitForSelector('.shell', { timeout: 30000 });
        return { browser, page, port };
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  throw lastError ?? new Error('WebView nije otvorio devtools socket');
}

/**
 * Ime devtools socketa nosi PID procesa u sebi, pa se ne da pogoditi unaprijed.
 * Čita se iz popisa otvorenih unix socketa i uspoređuje s PID-om aplikacije —
 * na uređaju je u pravilu otvoreno više webviewa (druge aplikacije).
 */
async function devtoolsSocket() {
  const pid = (await adb('shell', 'pidof', PACKAGE).catch(() => '')).split(/\s+/)[0];
  if (!pid) return null;

  const sockets = await adb('shell', 'cat', '/proc/net/unix');
  const name = `webview_devtools_remote_${pid}`;
  return sockets.includes(name) ? name : null;
}

/** Zatvara vezu i miče preusmjerenje porta. */
export async function stopDevice(session) {
  await session?.browser?.close().catch(() => {});
  if (session?.port) await adb('forward', '--remove', `tcp:${session.port}`).catch(() => {});
  await adb('shell', 'am', 'force-stop', PACKAGE).catch(() => {});
}

/** Snimka ekrana samog uređaja — hvata i sistemske trake, koje CDP ne vidi. */
export async function deviceScreenshot(target) {
  await adb('shell', 'screencap', '-p', '/sdcard/ul-shot.png');
  await adb('pull', '/sdcard/ul-shot.png', target);
  await adb('shell', 'rm', '-f', '/sdcard/ul-shot.png');
}
