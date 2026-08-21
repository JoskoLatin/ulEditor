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
 * `MANAGE_EXTERNAL_STORAGE` through an ordinary dialog.
 *
 *   node tools/verify-mobile-library.mjs [--skip-install]
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

import { startDevice, stopDevice, installApk, deviceScreenshot, adb } from './device-session.mjs';

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
  adb('shell', 'appops', 'set', 'org.uleditor.app', 'MANAGE_EXTERNAL_STORAGE', mode);

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
    await page.locator('.view-btn').first().click();
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

  /* ── with permission ────────────────────────────────────────────────── */

  await setAllFiles('allow');
  session = await startDevice();
  await openLibrary(session.page);

  const found = await session.page.evaluate(() => {
    const chips = [...document.querySelectorAll('.library-formats button')].map((b) => ({
      label: b.firstChild?.textContent?.trim() ?? '',
      count: Number(b.querySelector('span')?.textContent ?? 0),
    }));
    return {
      items: document.querySelectorAll('.library-item').length,
      blocked: !!document.querySelector('.library-blocked'),
      chips,
      first: document.querySelector('.library-name')?.textContent ?? '',
    };
  });

  const countOf = (label) => found.chips.find((c) => c.label === label)?.count ?? 0;
  const images = countOf('Image');
  const documents = found.items - images;

  console.log(
    `\n  found: ${found.items} · documents ${documents} · images ${images}` +
      `\n  formats: ${found.chips.map((c) => `${c.label} ${c.count}`).join(', ')}\n`,
  );

  check('the library found documents', documents > 0, `${documents} documents`);
  check('no obstacle is reported when the permission is there', !found.blocked);
  check('a filter by format is offered', found.chips.length > 1);

  /*
   * Without a quota of its own, photos swallow the list: on this device the
   * first measurement gave 1956 images against 41 PDFs, and the limit blew
   * mid-scan. The quota is 400, so what is asked here is that it was respected
   * and that the documents did not fall out.
   */
  check('photos do not smother the documents', images <= 400, `${images} images`);

  /* A document has to be **openable**, not merely listed: the path lies outside
     the workspace, so the scan has to adopt the roots. */
  await session.page.locator('.library-item').first().click();
  const opened = await session.page
    .waitForSelector('.tabbar .tab', { timeout: 60000 })
    .then(() => true)
    .catch(() => false);
  check('a document from the library opens', opened, found.first.slice(0, 40));

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
  // The device is left usable.
  await setAllFiles('allow').catch(() => {});
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
