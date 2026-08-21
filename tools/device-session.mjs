/**
 * Driving the application on **a physical Android device** from the checks.
 *
 * The same reason as with `desktop-session.mjs`: some behaviour exists only on
 * the device and cannot be checked in a browser. Here that means the safe area
 * insets and the layout at a real screen width — both depend on how the system
 * bars behave, and no desktop webview imitates that.
 *
 * The WebView in a debug build opens a devtools socket, so Playwright attaches to
 * the same process the user is looking at on the phone.
 *
 * It needs a device connected over `adb` with debugging authorised.
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
 * Installs the APK onto the device.
 *
 * It requires "Install via USB" to be enabled on the phone. On MIUI that switch
 * is gated behind an inserted SIM card; without one the install fails with
 * `INSTALL_FAILED_USER_RESTRICTED` and the APK has to be installed by hand.
 */
export async function installApk(apk) {
  const out = await adb('install', '-r', apk);
  if (!/Success/.test(out)) throw new Error(`Install failed: ${out}`);
}

/**
 * Brings the application up on the device and returns the attached page.
 *
 * @param {{ port?: number, timeoutMs?: number }} [opts]
 */
export async function startDevice(opts = {}) {
  const port = opts.port ?? 9400;
  const timeoutMs = opts.timeoutMs ?? 90000;

  // A clean start: otherwise we attach to the previous instance and measure the old layout.
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
 * The devtools socket name carries the process PID inside it, so it cannot be
 * guessed in advance. It is read from the list of open unix sockets and matched
 * against the application's PID — a device usually has several webviews open
 * (other applications).
 */
async function devtoolsSocket() {
  const pid = (await adb('shell', 'pidof', PACKAGE).catch(() => '')).split(/\s+/)[0];
  if (!pid) return null;

  const sockets = await adb('shell', 'cat', '/proc/net/unix');
  const name = `webview_devtools_remote_${pid}`;
  return sockets.includes(name) ? name : null;
}

/** Closes the connection and removes the port forward. */
export async function stopDevice(session) {
  await session?.browser?.close().catch(() => {});
  if (session?.port) await adb('forward', '--remove', `tcp:${session.port}`).catch(() => {});
  await adb('shell', 'am', 'force-stop', PACKAGE).catch(() => {});
}

/** A screenshot from the device itself — it captures the system bars too, which CDP cannot see. */
export async function deviceScreenshot(target) {
  await adb('shell', 'screencap', '-p', '/sdcard/ul-shot.png');
  await adb('pull', '/sdcard/ul-shot.png', target);
  await adb('shell', 'rm', '-f', '/sdcard/ul-shot.png');
}
