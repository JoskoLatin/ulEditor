/**
 * The mobile shell's scenarios, run on one interface (ADR 0009, testing level C).
 *
 *   node tools/verify-mobile.mjs --ui=arak [--target=browser] [--url <development build>]
 *        [--only <scenario id>] [--width 448|360] [--scheme light|dark] [--headed]
 *   node tools/verify-mobile.mjs --ui=arak --target=device      (a stub: not measured)
 *
 * **In the browser** it builds a development snapshot of the tree as it is into
 * the system's temp (`tools/mobile-snapshot.mjs`), serves it on a free port of
 * 127.0.0.1 and takes it all down afterwards; `--url` gives one instead. Every
 * scenario of `tools/mobile-scenarios.mjs` runs in a fresh browser context, at
 * 448 px (the Pixel 8 Pro) and 360 px (the narrow end, the Redmi), in light and
 * dark (`colorScheme`), in Croatian, at a fixed moment (`NOW`) so the wall's
 * groups come out the same every day. The library is handed in the way Rust's
 * look at the device would hand it (`ul-check-library`, development builds
 * only), with the repository's own fixtures.
 *
 * **On every screen**, after every step:
 *
 * - no horizontal overflow: the page no wider than the window, and nothing of
 *   the interface outside it (a row meant to scroll sideways, `data-scroll-x`,
 *   only as a whole);
 * - every touch target 44 × 44 px or more; the named exception is everything
 *   inside `[data-ul-role="document-stage"]`, the editors' own: words in a
 *   text, cells, and the editors' own controls until K4 gives them a touch
 *   contract;
 * - a question standing on the keyboard's top edge, never under it;
 *
 * and for every scenario, no error in the console and no request that leaves
 * the origin (`page.route`, with service workers blocked, since a request a
 * worker makes passes `page.route` by). The keyboard is stood in for as
 * `verify-mobile-common.mjs` does: `visualViewport` made shorter by the
 * Pixel's share of the screen (365 of 997 px, measured in K2) and announced
 * with `resize`.
 *
 * Screenshots go into `tools/screenshots/arak-k6a/` (ignored by git), at 448 px
 * in both schemes.
 *
 * **On the device** (`--target=device`) it only attaches through
 * `tools/device-session.mjs` and looks that the interface is up: the scenarios
 * hand the library in through a development build's stand-in, which a phone's
 * debug build does not have, so the table there needs fixtures pushed to the
 * phone. Not measured; it says so and fails.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { arakDriver } from './mobile-drivers/arak.mjs';
import { FIXTURES, NOW, SCENARIOS } from './mobile-scenarios.mjs';
import { snapshot } from './mobile-snapshot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = resolve(ROOT, 'tools/screenshots');
const DRIVERS = { arak: arakDriver };

const args = process.argv.slice(2);
const option = (name) => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  return args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
};
const ui = option('--ui') ?? 'arak';
const target = option('--target') ?? 'browser';
const only = option('--only');
const headed = args.includes('--headed');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

function finish() {
  const failed = checks.filter((one) => !one.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

if (!DRIVERS[ui]) {
  check(`a driver for --ui=${ui}`, false, `there is one for: ${Object.keys(DRIVERS).join(', ')}`);
  finish();
}

/* ── the device: a stub, not measured ────────────────────────────────── */

if (target === 'device') {
  const { startDevice, stopDevice } = await import('./device-session.mjs');
  let session;
  try {
    session = await startDevice({ shell: 'mobile' });
    const driver = DRIVERS[ui](session.page);
    await driver.ready();
    const state = await driver.state();
    check(`the debug build on the phone starts ${ui}`, state.ui === ui, JSON.stringify({ ui: state.ui, place: state.place }));
  } catch (error) {
    check(`the debug build on the phone starts ${ui}`, false, String(error?.message ?? error));
  } finally {
    await stopDevice(session);
  }
  check('the scenario table on the device', false, 'not measured: it needs fixtures on the phone in place of the development build\'s stand-in');
  finish();
}

/* ── the browser ─────────────────────────────────────────────────────── */

/** The two widths and the height each phone has, and the keyboard as the Pixel's share of it. */
const SIZES = [
  { width: 448, height: 997 },
  { width: 360, height: 780 },
].filter((size) => !option('--width') || String(size.width) === option('--width'));
const SCHEMES = ['light', 'dark'].filter((scheme) => !option('--scheme') || scheme === option('--scheme'));
const KEYBOARD_SHARE = 365 / 997;

/** The fixtures as bytes the page can make a `File` of. */
const FILES = Object.fromEntries(
  Object.entries(FIXTURES).map(([id, fixture]) => {
    const raw = fixture.bytes();
    const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
    return [id, { name: fixture.name, folder: fixture.folder, modified: Date.parse(fixture.modified), bytes: Array.from(bytes) }];
  }),
);

/** A part of the state matches: objects by the keys given, arrays by length and each element, the rest by value. */
function matches(actual, expected) {
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => matches(actual[index], item));
  }
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([key, value]) => matches(actual[key], value));
}

/** The keyboard, stood in for: `visualViewport` shortened, then announced the way the WebView announces it. */
async function keyboard(page, inset) {
  await page.evaluate((covered) => {
    const viewport = window.visualViewport;
    Object.defineProperty(viewport, 'height', { configurable: true, get: () => window.innerHeight - covered });
    Object.defineProperty(viewport, 'offsetTop', { configurable: true, get: () => 0 });
    viewport.dispatchEvent(new Event('resize'));
  }, inset);
}

/** The invariants of every screen; what broke them, as sentences. */
function measureScreen(page, inset) {
  return page.evaluate((covered) => {
    const shell = document.querySelector('[data-ul-role="mobile-shell"]');
    if (!shell) return { overflow: [], small: [], under: [], targets: 0 };
    const width = window.innerWidth;
    const keyboardTop = window.innerHeight - covered;
    const name = (element) =>
      element.getAttribute('data-ul-role') ?? `${element.tagName.toLowerCase()}${element.className && typeof element.className === 'string' ? `.${element.className.split(' ')[0]}` : ''}`;
    const editors = (element) => element.closest('[data-ul-role="document-stage"]') !== null;
    const seen = (element) => element.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && !element.closest('[inert]');

    const overflow = [];
    if (document.documentElement.scrollWidth > width + 0.5) overflow.push(`the page is ${document.documentElement.scrollWidth} px wide`);
    for (const element of shell.querySelectorAll('*')) {
      if (editors(element) || !seen(element)) continue;
      const row = element.closest('[data-scroll-x]');
      if (row && row !== element) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (box.left < -1 || box.right > width + 1) overflow.push(`${name(element)} ${Math.round(box.left)}..${Math.round(box.right)}`);
    }

    const small = [];
    let targets = 0;
    const interactive = 'button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';
    for (const element of shell.querySelectorAll(interactive)) {
      if (editors(element) || !seen(element)) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      targets += 1;
      if (box.width < 43.5 || box.height < 43.5) small.push(`${name(element)} ${Math.round(box.width)}×${Math.round(box.height)}`);
    }

    const under = [];
    for (const question of shell.querySelectorAll('[data-ul-role="question"], [data-ul-role="notice"]')) {
      if (!seen(question)) continue;
      const box = question.getBoundingClientRect();
      if (box.bottom > keyboardTop + 0.5) under.push(`${name(question)} bottom ${Math.round(box.bottom)} > ${Math.round(keyboardTop)}`);
    }
    return { overflow, small, under, targets };
  }, inset);
}

/** The measures a scenario asks for by name. */
const MEASURES = {
  fieldAboveKeyboard: (page, inset) =>
    page.evaluate((covered) => {
      const strip = document.querySelector('[data-ul-role="find-strip"]');
      const field = document.querySelector('[data-ul-role="find-field"]');
      if (!strip || !field) return { ok: false, detail: 'no strip' };
      const top = window.innerHeight - covered;
      const bottom = strip.getBoundingClientRect().bottom;
      const fieldBottom = field.getBoundingClientRect().bottom;
      return { ok: bottom <= top + 0.5 && bottom >= top - 1 && fieldBottom <= top, detail: `strip bottom ${bottom}, field bottom ${fieldBottom}, keyboard top ${top}` };
    }, inset),
  questionAboveKeyboard: (page, inset) =>
    page.evaluate((covered) => {
      const question = document.querySelector('[data-ul-role="question"]');
      if (!question) return { ok: false, detail: 'no question' };
      const top = window.innerHeight - covered;
      const box = question.getBoundingClientRect();
      return { ok: box.bottom <= top + 0.5 && box.bottom >= top - 1 && box.top >= 0, detail: `question ${Math.round(box.top)}..${box.bottom}, keyboard top ${top}` };
    }, inset),
  /* The PDF editor's own mark of the current hit (`.ul-pdf-hit`, drawn after
     `reveal()`): read by the harness, not the driver, and only to see where it
     landed. It has to be inside the stage and above the strip. */
  hitInView: async (page) => {
    const deadline = Date.now() + 8000;
    let last = { ok: false, detail: 'no current hit drawn' };
    while (Date.now() < deadline) {
      last = await page.evaluate(() => {
        const hit = document.querySelector('[data-ul-role="document-stage"] .ul-pdf-hit[data-current="true"]');
        const stage = document.querySelector('[data-ul-role="document-stage"]');
        const strip = document.querySelector('[data-ul-role="find-strip"]');
        if (!hit || !stage) return { ok: false, detail: 'no current hit drawn' };
        const box = hit.getBoundingClientRect();
        const area = stage.getBoundingClientRect();
        const floor = Math.min(area.bottom, strip ? strip.getBoundingClientRect().top : Infinity);
        return {
          ok: box.height > 0 && box.top >= area.top - 0.5 && box.bottom <= floor + 0.5,
          detail: `hit ${Math.round(box.top)}..${Math.round(box.bottom)}, visible ${Math.round(area.top)}..${Math.round(floor)}`,
        };
      });
      if (last.ok) return last;
      await page.waitForTimeout(100);
    }
    return last;
  },
};

async function runScenario(browser, url, size, scheme, scenario) {
  const label = `${size.width} ${scheme} · ${scenario.id}`;
  const inset = Math.round(size.height * KEYBOARD_SHARE);
  const context = await browser.newContext({
    viewport: size,
    hasTouch: true,
    colorScheme: scheme,
    locale: 'hr-HR',
    timezoneId: 'Europe/Zagreb',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  /* In Croatian, as on Čovik's phone; `about:blank` has no storage of its own. */
  await context.addInitScript(() => {
    if (window.location.protocol !== 'http:') return;
    if (!localStorage.getItem('uleditor.settings')) localStorage.setItem('uleditor.settings', JSON.stringify({ locale: 'hr' }));
  });
  await context.clock.setSystemTime(new Date(NOW));
  const page = await context.newPage();
  const origin = new URL(url).origin;
  const errors = [];
  const outside = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route('**/*', (route) => {
    const address = route.request().url();
    if (address.startsWith(origin) || address.startsWith('data:') || address.startsWith('blob:')) return route.continue();
    outside.push(address);
    return route.abort();
  });

  const screens = { count: 0, overflow: [], small: [], under: [], targets: 0 };
  let covered = 0;
  const measure = async (where) => {
    const found = await measureScreen(page, covered);
    screens.count += 1;
    screens.targets += found.targets;
    for (const kind of ['overflow', 'small', 'under']) for (const what of found[kind]) screens[kind].push(`${where}: ${what}`);
  };

  const driver = DRIVERS[ui](page);
  let failure = null;
  let done = 0;
  try {
    await page.goto('about:blank');
    await page.goto(new URL(`?ui=${ui}`, url).href);
    await driver.ready();
    for (const [index, step] of scenario.steps.entries()) {
      const where = `step ${index + 1}`;
      if (step.library) {
        const files = step.library.map((id) => FILES[id]);
        await page.evaluate(
          ({ list, blocked }) => {
            const entries = list.map((file) => ({ file: new File([new Uint8Array(file.bytes)], file.name, { lastModified: file.modified }), folder: file.folder }));
            window.dispatchEvent(new CustomEvent('ul-check-library', { detail: { files: entries, blocked } }));
          },
          { list: files, blocked: step.blocked === true },
        );
        /* Every file is either a page on the wall or counted behind the pictures' button. */
        await page.waitForFunction((n) => {
          const rows = document.querySelectorAll('[data-ul-role="library-row"]').length;
          const waiting = document.querySelector('[data-ul-role="wall-pictures"][aria-expanded="false"]');
          return rows + Number(waiting?.getAttribute('data-count') ?? 0) === n;
        }, files.length);
      } else if (step.do) {
        await driver.run(step).catch((error) => {
          throw new Error(`${where} (${step.do}): ${String(error?.message ?? error).split('\n')[0]}`);
        });
      } else if (step.keyboard) {
        covered = step.keyboard === 'up' ? inset : 0;
        await keyboard(page, covered);
      } else if (step.expect) {
        const deadline = Date.now() + 10000;
        let state = await driver.state();
        while (!matches(state, step.expect) && Date.now() < deadline) {
          await page.waitForTimeout(100);
          state = await driver.state();
        }
        if (!matches(state, step.expect)) {
          const seen = Object.fromEntries(Object.keys(step.expect).map((key) => [key, state[key]]));
          throw new Error(`${where}: expected ${JSON.stringify(step.expect)}, found ${JSON.stringify(seen)}`);
        }
      } else if (step.check) {
        const result = await MEASURES[step.check](page, covered);
        if (!result.ok) throw new Error(`${where}: ${step.check} — ${result.detail}`);
      } else if (step.shot) {
        if (size.width === 448) {
          await page.waitForTimeout(400);
          /* Where the keyboard would be, so the picture shows what stands on it. Only in the picture. */
          await page.evaluate((height) => {
            if (height === 0) return;
            const board = document.createElement('div');
            board.id = 'ul-check-keyboard';
            board.textContent = 'tipkovnica (simulirana)';
            board.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${height}px;z-index:2147483647;display:grid;place-items:center;background:#c9c7d1;color:#3a3946;font:15px system-ui`;
            document.body.append(board);
          }, covered);
          await page.screenshot({ path: resolve(SHOTS, `${ui}-k6a`, `${step.shot}-448-${scheme}.png`) });
          await page.evaluate(() => document.getElementById('ul-check-keyboard')?.remove());
        }
      }
      if (!step.expect && !step.shot) await measure(where);
      done += 1;
    }
  } catch (error) {
    failure = String(error?.message ?? error).split('\n')[0];
  } finally {
    await context.close();
  }

  check(`${label}: ${scenario.title}`, failure === null, failure ?? `${done} steps`);
  return { errors, outside, screens };
}

let served = null;
let browser;
try {
  await mkdir(resolve(SHOTS, `${ui}-k6a`), { recursive: true });
  let url = option('--url');
  if (!url) {
    console.log('Building a development snapshot into the system temp …');
    served = await snapshot('development');
    url = served.url;
  }
  browser = await chromium.launch({ headless: !headed });
  const scenarios = SCENARIOS.filter((scenario) => !only || scenario.id === only);
  check('there is something to run', scenarios.length > 0 && SIZES.length > 0 && SCHEMES.length > 0, `${scenarios.length} scenarios, ${SIZES.length} widths, ${SCHEMES.length} schemes`);
  for (const size of SIZES) {
    for (const scheme of SCHEMES) {
      const all = { errors: [], outside: [], count: 0, targets: 0, overflow: [], small: [], under: [] };
      for (const scenario of scenarios) {
        const { errors, outside, screens } = await runScenario(browser, url, size, scheme, scenario);
        all.errors.push(...errors.map((error) => `${scenario.id}: ${error}`));
        all.outside.push(...outside.map((address) => `${scenario.id}: ${address}`));
        all.count += screens.count;
        all.targets += screens.targets;
        for (const kind of ['overflow', 'small', 'under']) all[kind].push(...screens[kind].map((what) => `${scenario.id} ${what}`));
      }
      const at = `${size.width} ${scheme}`;
      check(`${at}: no horizontal overflow on ${all.count} screens`, all.count > 0 && all.overflow.length === 0, all.overflow.slice(0, 4).join(' | '));
      check(
        `${at}: every touch target 44 px or more (${all.targets} measured; the editors' own inside the stage excepted)`,
        all.targets > 0 && all.small.length === 0,
        all.small.slice(0, 4).join(' | '),
      );
      check(`${at}: every question and notice above the keyboard`, all.under.length === 0, all.under.slice(0, 3).join(' | '));
      check(`${at}: no error in the console`, all.errors.length === 0, all.errors.slice(0, 3).join(' | '));
      check(`${at}: no request left the origin`, all.outside.length === 0, all.outside.slice(0, 3).join(' | '));
    }
  }
} finally {
  await browser?.close();
  await served?.stop();
}

finish();
