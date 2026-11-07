/**
 * The document library on **a physical phone**.
 *
 * Two things that cannot be checked anywhere else:
 *
 * 1. **That it finds anything at all.** Scanning depends on what Android lets
 *    through, and that behaves unlike any desktop file system.
 * 2. **That a lie does not get through.** Without permission Android returns
 *    folders with not one file in them and reports no error. A naive library
 *    would then claim "you have no documents" while the device holds hundreds.
 *    So the permission is deliberately taken away here and the application is
 *    checked for telling the truth.
 *
 * The permission is set through `appops`, because the system does not offer
 * `MANAGE_EXTERNAL_STORAGE` through an ordinary dialog. It is set on the debug
 * build only (`PACKAGE`), never on the release beside it, and afterwards put back
 * to what it was before the check: a debuggable build is not left holding
 * access to every file on a phone with real data.
 *
 *   node tools/verify-mobile-library.mjs [--skip-install]
 *
 * With more than one phone attached, `ANDROID_SERIAL` names the one.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

import {
  PACKAGE,
  deviceSerial,
  startDevice,
  stopDevice,
  installApk,
  deviceScreenshot,
  adb,
  tapOn,
} from './device-session.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = resolve(ROOT, 'tools/screenshots');
const APK = resolve(
  ROOT,
  'apps/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk',
);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const setAllFiles = (mode) =>
  adb('shell', 'appops', 'set', PACKAGE, 'MANAGE_EXTERNAL_STORAGE', mode);

/**
 * The package's own mode as it stands: `allow`, `deny`, … or `default` when it
 * was never set. A `Uid mode:` line, when there is one, belongs to the UID and
 * is not what `appops set <package>` changes.
 */
async function allFilesMode() {
  const out = await adb('shell', 'appops', 'get', PACKAGE, 'MANAGE_EXTERNAL_STORAGE');
  const line = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('MANAGE_EXTERNAL_STORAGE:'));
  return /^MANAGE_EXTERNAL_STORAGE: (\w+)/.exec(line ?? '')?.[1] ?? 'default';
}

/**
 * Puts the mode back and reads it again: a restore that did not take is a
 * failure, not a shrug. Called from `finally` and on Ctrl+C, which skips
 * `finally`; a killed process skips both, which is why the command to do it by
 * hand is printed before the mode is first changed.
 */
let modeBefore;
let restoring;
function restoreMode() {
  restoring ??= (async () => {
    if (!modeBefore) return;
    await setAllFiles(modeBefore);
    const now = await allFilesMode();
    if (now !== modeBefore) throw new Error(`all-files access is ${now}, not ${modeBefore} as before`);
  })();
  return restoring;
}

process.once('SIGINT', () => {
  console.error('\n  interrupted: putting all-files access back');
  restoreMode()
    .then(() => console.error(`  back to ${modeBefore ?? 'unchanged'}`))
    .catch((err) => console.error(`  NOT restored: ${err.message}`))
    .finally(() => process.exit(130));
});

/**
 * Opens the library and waits for the scan to settle.
 *
 * The button is a toggle, and on a narrow screen the library is the default view
 * — so a blind click closes it as often as it opens it. The state is what is
 * looked at, not the number of clicks. On a phone the views sit in the title bar
 * (`.view-btn`), not in a vertical rail along the edge — there is none there.
 */
async function openLibrary(page) {
  const shown = async () => (await page.locator('.library').count()) > 0;

  for (let attempt = 0; attempt < 2 && !(await shown()); attempt++) {
    await tapOn(page.locator('.view-btn'));
    await page.waitForTimeout(400);
  }
  await page.waitForSelector('.library', { timeout: 10000 });

  /* The scan is done once a result, an obstacle, or a message that is no longer
     "searching…" appears. Waiting a fixed time would be either too short or
     slow. */
  await page.waitForFunction(
    () =>
      document.querySelector('.library-item') ||
      document.querySelector('.library-blocked') ||
      [...document.querySelectorAll('.library-note')].some((n) => !n.textContent.includes('…')),
    { timeout: 180000 },
  );
}

let session;

try {
  await mkdir(SHOTS, { recursive: true });

  if (!process.argv.includes('--skip-install')) {
    await installApk(APK);
    check('the APK was installed', true);
  }

  modeBefore = await allFilesMode();
  console.log(
    `  all-files access before the check: ${modeBefore}` +
      `\n  if this is killed, put it back by hand: adb -s ${await deviceSerial()} shell appops set ${PACKAGE} MANAGE_EXTERNAL_STORAGE ${modeBefore}`,
  );

  /* ── with permission ────────────────────────────────────────────────── */

  await setAllFiles('allow');
  session = await startDevice();
  await openLibrary(session.page);

  /* What each row is comes from its `data-format`, the scan's own verdict. The
     filter buttons are no source for it: their labels are translated, and with
     a single format there are none, so a phone holding only photos once
     counted them all as documents here. */
  const found = await session.page.evaluate(() => ({
    formats: [...document.querySelectorAll('.library-item')].map((b) => b.dataset.format ?? ''),
    buttons: document.querySelectorAll('.library-formats button').length,
    blocked: !!document.querySelector('.library-blocked'),
    firstDocument:
      document.querySelector('.library-item:not([data-format="image"]) .library-name')?.textContent ?? '',
  }));

  const perFormat = new Map();
  for (const format of found.formats) perFormat.set(format, (perFormat.get(format) ?? 0) + 1);
  const images = perFormat.get('image') ?? 0;
  const documents = found.formats.length - images;

  console.log(
    `\n  found: ${found.formats.length} · documents ${documents} · images ${images}` +
      `\n  formats: ${[...perFormat].map(([format, count]) => `${format} ${count}`).join(', ')}\n`,
  );

  check('every entry says what format it is', found.formats.every(Boolean));
  check('the library found documents', documents > 0, `${documents} documents`);
  check('no obstacle is reported when the permission is there', !found.blocked);

  /* "All" and one button per format, and nothing when there is nothing to choose between. */
  const expected = perFormat.size > 1 ? perFormat.size + 1 : 0;
  check(
    'a filter by format is offered when there is a choice',
    found.buttons === expected,
    `${perFormat.size} formats, ${found.buttons} buttons`,
  );

  /*
   * Without a quota of its own, photos swallow the list: on this device the
   * first measurement gave 1956 images against 41 PDFs, and the limit blew
   * mid-scan. The quota is 400, so what is asked here is that it was respected
   * and that the documents did not fall out.
   */
  check('photos do not smother the documents', images <= 400, `${images} images`);

  /* A document has to be **openable**, not merely listed: the path lies outside
     the workspace, so the scan has to adopt the roots. A document, not a photo,
     whichever happens to be newest. */
  if (documents > 0) {
    await tapOn(session.page.locator('.library-item:not([data-format="image"])'));
    const opened = await session.page
      .waitForSelector('.tabbar .tab', { timeout: 60000 })
      .then(() => true)
      .catch(() => false);
    check('a document from the library opens', opened, found.firstDocument.slice(0, 40));
  } else {
    check('a document from the library opens', false, 'there is no document on the device to open');
  }

  await deviceScreenshot(resolve(SHOTS, 'mobile-library.png'));
  await stopDevice(session);
  session = null;

  /* ── without permission ─────────────────────────────────────────────── */

  await setAllFiles('deny');
  session = await startDevice();
  await openLibrary(session.page);

  const denied = await session.page.evaluate(() => ({
    items: document.querySelectorAll('.library-item').length,
    blocked: !!document.querySelector('.library-blocked'),
    heading: document.querySelector('.library-blocked strong')?.textContent ?? '',
  }));

  check('with no permission there are no false results', denied.items === 0, `${denied.items} entries`);
  check(
    'denied access is reported, not passed over in silence',
    denied.blocked,
    denied.heading || 'no message',
  );

  await deviceScreenshot(resolve(SHOTS, 'mobile-library-blocked.png'));
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await deviceScreenshot(resolve(SHOTS, 'failure-mobile-library.png')).catch(() => {});
} finally {
  await stopDevice(session);
  // The device is left as it was found, and that is checked.
  await restoreMode().then(
    () => modeBefore && check('all-files access is back as it was', true, modeBefore),
    (err) => check('all-files access is back as it was', false, err.message),
  );
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
