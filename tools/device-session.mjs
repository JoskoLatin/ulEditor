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
 * It needs a device connected over `adb` with debugging authorised. With more
 * than one attached, `ANDROID_SERIAL` names the one to drive (`adb devices`
 * lists the serials).
 */

import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const run = promisify(execFile);

/**
 * The debug build, under an ID of its own (`applicationIdSuffix` in
 * `build.gradle.kts`): only a debuggable WebView opens a devtools socket, and
 * under its own ID it installs beside the release instead of over it. The
 * release (`org.uleditor.app`) is never driven or touched from here.
 */
export const PACKAGE = 'org.uleditor.app.debug';

function sdkRoot() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error('ANDROID_HOME is not set.');
  return sdk;
}

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

/** `adb` is not on the path; the SDK knows where it is, under either name. */
export function adbPath() {
  return join(sdkRoot(), 'platform-tools', exe('adb'));
}

/**
 * The application ID an APK installs as, read out of the APK itself with the
 * newest `aapt2` in the SDK's build-tools.
 */
export async function apkPackage(apk) {
  const tools = join(sdkRoot(), 'build-tools');
  const versions = (await readdir(tools))
    .filter((v) => existsSync(join(tools, v, exe('aapt2'))))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (!versions.length) throw new Error(`no aapt2 under ${tools}`);
  const aapt2 = join(tools, versions.at(-1), exe('aapt2'));
  const { stdout } = await run(aapt2, ['dump', 'badging', apk], { maxBuffer: 32 * 1024 * 1024 });
  const name = /package: name='([^']+)'/.exec(stdout)?.[1];
  if (!name) throw new Error(`aapt2 found no package name in ${apk}`);
  return name;
}

let serial;

/**
 * The one device every command goes to. Without `-s`, adb refuses as soon as
 * two are attached ("more than one device/emulator"), and a phone with wireless
 * debugging on is listed a second time under an `adb-…._adb-tls-connect` name.
 * So the choice is made once, here: `ANDROID_SERIAL` if it is set, the only
 * ready device if there is one, and otherwise an error that lists them.
 */
export async function deviceSerial() {
  if (serial) return serial;

  const { stdout } = await run(adbPath(), ['devices']);
  const ready = stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(([name, state]) => name && state === 'device')
    .map(([name]) => name);

  const wanted = process.env.ANDROID_SERIAL;
  if (wanted) {
    if (!ready.includes(wanted)) {
      throw new Error(`ANDROID_SERIAL=${wanted} is not a ready device; ready: ${ready.join(', ') || 'none'}`);
    }
    serial = wanted;
  } else if (ready.length === 1) {
    serial = ready[0];
  } else {
    throw new Error(
      ready.length
        ? `${ready.length} devices are ready (${ready.join(', ')}); set ANDROID_SERIAL to the one to drive.`
        : 'no device is ready on adb.',
    );
  }
  return serial;
}

export async function adb(...args) {
  const { stdout } = await run(adbPath(), ['-s', await deviceSerial(), ...args], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * A tap by finger: `Input.dispatchTouchEvent` through the devtools protocol, a
 * touch start and a touch end at one point, in the page's CSS pixels. Playwright's
 * own `page.tap()` is refused here, because the context it attaches to over CDP
 * was not created with `hasTouch`. `adb shell input` is no way round it either:
 * without a SIM, MIUI blocks it (ADR 0001).
 */
export async function tap(page, x, y) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * Taps the middle of the first element the locator finds, scrolled into view
 * first: a touch is dispatched at screen coordinates, and one below the fold
 * lands on nothing.
 */
export async function tapOn(locator) {
  const target = locator.first();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`nothing to tap: ${target}`);
  await tap(target.page(), box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Installs the APK onto the device.
 *
 * It requires "Install via USB" to be enabled on the phone. On MIUI that switch
 * is gated behind an inserted SIM card; without one the install fails with
 * `INSTALL_FAILED_USER_RESTRICTED` and the APK has to be installed by hand.
 */
export async function installApk(apk) {
  /* The path is fixed, and what lies there is whatever was built last. An APK
     without the suffix would install over the release, or over an old build
     under its ID, so it is refused before adb is asked anything. */
  const name = await apkPackage(apk);
  if (name !== PACKAGE) throw new Error(`${apk} installs as ${name}, not ${PACKAGE}; not installed.`);
  const out = await adb('install', '-r', apk);
  if (!/Success/.test(out)) throw new Error(`Install failed: ${out}`);
}

/**
 * Kept in `sessionStorage`, it tells a debug build to stay on the desktop shell
 * for this run of the app. The same name is in `packages/shell-ui/src/main.tsx`,
 * and `verify-mobile-common` proves the two agree.
 */
export const DESKTOP_SHELL_KEY = 'ulEditor.debug.desktopShell';

/** The root of the phone's own shell (ADR 0009). */
const MOBILE_SHELL = '[data-ul-role="mobile-shell"]';

/**
 * Brings the application up on the device and returns the attached page.
 *
 * `shell`: which shell to measure. A debug build after ADR 0009's K3 starts the
 * phone's own shell; `'desktop'` (the default) has it reload into the desktop
 * shell, the layout a release still ships until K6, which the checks of ADR
 * 0003 measure. An older build has only the desktop shell and needs nothing.
 * `'mobile'` waits for the phone's shell instead.
 *
 * @param {{ port?: number, timeoutMs?: number, shell?: 'desktop' | 'mobile' }} [opts]
 */
export async function startDevice(opts = {}) {
  const port = opts.port ?? 9400;
  const timeoutMs = opts.timeoutMs ?? 90000;
  const shell = opts.shell ?? 'desktop';

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
        await page.waitForSelector(`.shell, ${MOBILE_SHELL}`, { timeout: 30000 });
        if (shell === 'desktop' && (await page.$(MOBILE_SHELL))) {
          await page.evaluate((key) => sessionStorage.setItem(key, '1'), DESKTOP_SHELL_KEY);
          await page.reload();
          await page.waitForSelector('.shell', { timeout: 30000 });
        }
        if (shell === 'mobile') await page.waitForSelector(MOBILE_SHELL, { timeout: 30000 });
        return { browser, page, port };
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  throw lastError ?? new Error('the WebView never opened a devtools socket');
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
