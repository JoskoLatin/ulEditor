/**
 * The layout on **a physical phone**.
 *
 * The mobile shell is not a squeezed desktop but a different division of space:
 * navigation on top, the open document's tools along the left edge, the panel
 * dropping from above and leaving the moment a choice is made. All of that
 * depends on the real screen width and on how the system bars behave, so it
 * cannot be checked in a browser — a narrow viewport would test the media query,
 * not the device.
 *
 * It measures rather than looks: the insets are read out of the webview, text
 * wrapping is counted in lines, and positions are compared in pixels.
 *
 *   node tools/verify-mobile-layout.mjs [--skip-install]
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

import { startDevice, stopDevice, installApk, deviceScreenshot } from './device-session.mjs';

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

let session;

try {
  await mkdir(SHOTS, { recursive: true });

  if (!process.argv.includes('--skip-install')) {
    await installApk(APK);
    check('the APK was installed on the device', true);
  }

  session = await startDevice();
  const { page } = session;
  check('attached to the webview on the phone', true);

  /*
   * The shell restores its session, so the panel and the tabs appear only after
   * the first render. Without a pause the check meets an empty DOM, concludes
   * everything is closed, and then the panel jumps in front of its click.
   */
  await page.waitForTimeout(1200);

  /* The button closes the panel only when its own view is already active;
     otherwise it switches the view and the panel stays. So the state is what is
     looked at, not the number of clicks. */
  const panelOpen = async () => (await page.locator('.sidebar').count()) > 0;
  for (let guard = 0; guard < 5 && (await panelOpen()); guard++) {
    await page.locator('.view-btn').first().click();
    await page.waitForTimeout(400);
  }

  /* The welcome screen is what is measured, so no document may be open. */
  for (let guard = 0; guard < 20 && (await page.locator('.tab').count()) > 0; guard++) {
    await page.locator('.tab .close').first().click();
    await page.waitForTimeout(250);
  }

  /*
   * The insets are read from the webview itself. Android need not report them:
   * with no cutout in the screen `safe-area-inset-top` can be zero, and then the
   * system bar still stands over the title bar. So the value is printed and not
   * merely compared — without the number there is no telling whether the fix
   * was applied at all.
   */
  const insets = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = [
      'position:fixed;top:0;left:0;visibility:hidden',
      'padding-top:env(safe-area-inset-top)',
      'padding-right:env(safe-area-inset-right)',
      'padding-bottom:env(safe-area-inset-bottom)',
      'padding-left:env(safe-area-inset-left)',
    ].join(';');
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const read = (v) => Math.round(parseFloat(v) || 0);
    const out = {
      top: read(cs.paddingTop),
      right: read(cs.paddingRight),
      bottom: read(cs.paddingBottom),
      left: read(cs.paddingLeft),
    };
    probe.remove();
    return out;
  });

  console.log(
    `\n  insets: top ${insets.top}px · right ${insets.right}px · bottom ${insets.bottom}px · left ${insets.left}px`,
  );

  const layout = await page.evaluate(() => {
    const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect();
    const sub = document.querySelector('.welcome-sub');
    const lineHeight = sub ? parseFloat(getComputedStyle(sub).lineHeight) : 0;
    const main = rect('.main');

    return {
      viewport: window.innerWidth,
      /* Zooming out is the first sign something stretched the shell past the screen. */
      documentWidth: document.documentElement.scrollWidth,
      titlebarPadTop: Math.round(
        parseFloat(getComputedStyle(document.querySelector('.titlebar')).paddingTop) || 0,
      ),
      mainWidth: Math.round(main?.width ?? 0),
      mainLeft: Math.round(main?.left ?? -1),
      subLines: sub && lineHeight ? Math.round(sub.scrollHeight / lineHeight) : 0,
      titleVisible: !!document.querySelector('.titlebar-title')?.getClientRects().length,
      /* The navigation is on top; the vertical rail along the edge is gone. */
      railVisible: !!document.querySelector('.activitybar')?.getClientRects().length,
      viewButtons: [...document.querySelectorAll('.view-btn')].map((b) =>
        b.getAttribute('aria-label'),
      ),
      desktopOnlyVisible: [...document.querySelectorAll('.desktop-only')].filter(
        (b) => b.getClientRects().length,
      ).length,
    };
  });

  console.log(`  viewport: ${layout.viewport}px · main area: ${layout.mainWidth}px\n`);

  check(
    'the narrow-screen media query is active',
    layout.viewport <= 720,
    `viewport ${layout.viewport}px`,
  );

  /*
   * Content that will not compress stretches the grid past the screen, and the
   * WebView then zooms **the whole** page out — `innerWidth` grows from 392 to
   * 591 px and taps land beside the buttons. That is exactly what happened with
   * a PDF open.
   */
  check(
    'nothing stretches the page past the screen width',
    layout.documentWidth <= layout.viewport,
    `document ${layout.documentWidth}px, screen ${layout.viewport}px`,
  );

  check('the navigation is on top, with no rail along the edge', !layout.railVisible);

  check(
    'the views live in the title bar',
    layout.viewButtons.length >= 2,
    layout.viewButtons.join(' · '),
  );

  /* Folders are a desktop metaphor; on a phone the library replaces them entirely. */
  check(
    'the desktop actions are not offered on a phone',
    layout.desktopOnlyVisible === 0,
    `${layout.desktopOnlyVisible} visible`,
  );

  check('the main area uses the full width', layout.mainWidth >= layout.viewport - 2);
  check('the main area starts at the left edge', layout.mainLeft === 0);

  check(
    'the description does not wrap to one word per line',
    layout.subLines > 0 && layout.subLines <= 5,
    `${layout.subLines} lines`,
  );

  check('the document name was taken out of the title bar', !layout.titleVisible);

  check(
    'the title bar respects the inset from above',
    layout.titlebarPadTop === insets.top,
    `padding ${layout.titlebarPadTop}px, inset ${insets.top}px`,
  );

  /* ── the panel drops from above ─────────────────────────────────────── */

  await page.locator('.view-btn').first().click();
  await page.waitForSelector('.sidebar', { timeout: 8000 });

  const panel = await page.evaluate(() => {
    const el = document.querySelector('.sidebar').getBoundingClientRect();
    const body = document.querySelector('.shell-body').getBoundingClientRect();
    return {
      top: Math.round(el.top - body.top),
      left: Math.round(el.left),
      width: Math.round(el.width),
      bottom: Math.round(el.bottom),
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
    };
  });

  check(
    'the panel drops from above, at full width',
    panel.top === 0 && panel.left === 0 && panel.width >= panel.viewportW - 2,
    `top ${panel.top}px, width ${panel.width}px`,
  );

  /*
   * Below the panel there has to be a surface a finger can hit — that is what
   * closes it. The earlier side-mounted version left 38 px, less than a thumb
   * reliably hits.
   */
  const strip = panel.viewportH - panel.bottom;
  check('a surface for closing is left below the panel', strip >= 56, `${strip}px`);

  await deviceScreenshot(resolve(SHOTS, 'mobile-panel.png'));

  await page.mouse.click(panel.viewportW / 2, panel.bottom + strip / 2);
  await page.waitForTimeout(400);
  check('a tap below the panel closes it', (await page.locator('.sidebar').count()) === 0);

  await deviceScreenshot(resolve(SHOTS, 'mobile-welcome.png'));
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await deviceScreenshot(resolve(SHOTS, 'failure-mobile.png')).catch(() => {});
} finally {
  await stopDevice(session);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
