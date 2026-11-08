/**
 * The shared mobile layer in a browser (ADR 0009, K3).
 *
 * `packages/mobile-core` holds the rules and is checked in Node
 * (`verify-mobile-core.mjs`). This checks the other half: the adapters in
 * `shell-ui/src/mobile/common` that tie those rules to the window, driven
 * through the development view the mobile shell starts for an interface not
 * built yet (`?ui=palac` until K7). Arak itself is checked by
 * `tools/verify-mobile.mjs --ui=arak`.
 *
 * - **Back through `history`**: a layer opened pushes one entry and Back closes
 *   it; a question answered by Back runs the action marked as its cancel, even
 *   when that is not the first; a question with no cancel stays, and gets its
 *   entry back; a layer closed by a tap takes its entry away. After every step
 *   the entries of ours equal the open layers, and with none open Back leaves.
 * - **`--kb-inset`** follows a simulated `visualViewport`, with the Pixel's
 *   figures from K2 (997 CSS px, 632 with the keyboard up), and a question
 *   stands above it.
 * - **`DocumentStage`** mounts each editor once: the same elements survive
 *   bringing the documents to the front in turn.
 * - **The tool row** keeps the focus where it was, for a click and a tap.
 * - **The swipe helper** leaves the screen's edges to Android's Back.
 * - **The debug signal**: a release build has none of the mobile shell's code
 *   in any of its files, `?ui=` starts nothing there, and in the app on
 *   Android (stood in for) it starts the desktop shell, where a debug build
 *   starts the mobile one, unless the device checks' key in `sessionStorage`
 *   keeps it on the desktop shell for that run.
 *
 *   node tools/verify-mobile-common.mjs [--headed]
 *   node tools/verify-mobile-common.mjs --url <development build>
 *     --release-url <release build> --release-dist <its folder>
 *     [--debug-url <debug build> --debug-dist <its folder>]
 *     [--dev-dist <the development build's folder>] [--headed]
 *
 * With no `--url` it builds the three itself, from the tree as it is, into a
 * folder of its own under the system's temp, serves each with `vite preview`
 * on a free port of 127.0.0.1, and takes all of it down afterwards; about a
 * minute. No dev server: what is checked is a build, which another hand on the
 * same tree cannot change halfway through.
 *
 * `?ui=` works in Vite's development mode only, so the development build is
 * `NODE_ENV=development vite build --mode development` (or the dev server, given
 * as `--url`). The release build is a plain `vite build`; the debug build the
 * same with `TAURI_ENV_DEBUG=true`, as Tauri runs it for a debug APK. The debug
 * build is the control: the same markers have to be found in it and the same
 * entry has to start the mobile shell there, or their absence from the release
 * proves nothing.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DESKTOP_SHELL_KEY } from './device-session.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL_UI = resolve(ROOT, 'packages/shell-ui');
const VITE = resolve(SHELL_UI, 'node_modules/vite/bin/vite.js');

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const headed = args.includes('--headed');

/* ── the builds, when none is given ──────────────────────────────────── */

const servers = [];
let scratch = null;

/** Vite in `packages/shell-ui`, as `node vite.js …`: no shell between, so nothing to quote and nothing left behind. */
function vite(argv, env) {
  const child = spawn(process.execPath, [VITE, ...argv], { cwd: SHELL_UI, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  return { child, output: () => output };
}

/** The environment without the two variables a build is told apart by, so the caller's shell does not decide. */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!('TAURI_ENV_DEBUG' in extra)) delete env.TAURI_ENV_DEBUG;
  if (!('NODE_ENV' in extra)) delete env.NODE_ENV;
  return env;
}

async function build(outDir, env, extraArgs = []) {
  const { child, output } = vite(['build', '--outDir', outDir, '--emptyOutDir', ...extraArgs], env);
  const code = await new Promise((done) => child.on('close', done));
  if (code !== 0) throw new Error(`vite build into ${outDir} failed (${code}):\n${output().slice(-2000)}`);
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

async function serve(outDir) {
  const port = await freePort();
  const { child, output } = vite(['preview', '--outDir', outDir, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], cleanEnv());
  servers.push(child);
  const url = `http://127.0.0.1:${port}/`;
  const up = await until(async () => {
    try {
      return (await fetch(url)).ok;
    } catch {
      return false;
    }
  }, 30000);
  if (!up) throw new Error(`vite preview of ${outDir} did not come up on ${port}:\n${output().slice(-2000)}`);
  return url;
}

async function stopServers() {
  await Promise.all(
    servers.map(
      (child) =>
        new Promise((done) => {
          if (child.exitCode !== null) return done();
          child.once('close', done);
          child.kill();
        }),
    ),
  );
}

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Waits for a condition instead of guessing how long it takes; says whether it came true. */
async function until(condition, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The lazy chunks of the mobile shell: the shell, the development view and each interface. */
const CHUNKS = /MobileApp|DevView|Arak/;

/** Through a real `drop`, the way `verify-ui.mjs` hands the shell a document. */
async function dropFile(page, name, text) {
  await page.evaluate(
    ([fileName, body]) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([body], fileName));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    },
    [name, text],
  );
}

const withUi = (base, ui) => {
  const url = new URL(base);
  if (ui !== null) url.searchParams.set('ui', ui);
  return url.href;
};

/** What the page says about Back: the open layers it draws, and the entries of ours it holds. */
async function backState(page) {
  return page.evaluate(() => ({
    layers: Number(document.querySelector('[data-ul-role="mobile-shell"]')?.getAttribute('data-layers') ?? -1),
    entries: window.history.state?.ulLayers ?? 0,
    url: window.location.href,
  }));
}

/** Entries of ours equal to the open layers, `n` of each, once the page has settled. */
async function settlesAt(page, n) {
  const ok = await until(async () => {
    const state = await backState(page);
    return state.layers === n && state.entries === n;
  });
  return { ok, state: await backState(page) };
}

const count = (page, selector) => page.locator(selector).count();
const role = (name) => `[data-ul-role="${name}"]`;

/** The browser's Back, which is what the system's Back is to the WebView (ADR 0009, K2 b). */
const pressBack = (page) => page.goBack({ waitUntil: 'commit' }).catch(() => null);

let devUrl = option('--url');
let releaseUrl = option('--release-url');
let releaseDist = option('--release-dist');
let debugUrl = option('--debug-url');
let debugDist = option('--debug-dist');
let developmentDist = option('--dev-dist');
let browser;

try {
  if (!devUrl) {
    scratch = await mkdtemp(join(tmpdir(), 'uleditor-mobile-common-'));
    const development = join(scratch, 'development');
    developmentDist = development;
    releaseDist = join(scratch, 'release');
    debugDist = join(scratch, 'debug');
    console.log(`Building the release, debug and development builds into ${scratch} …`);
    /* One after another: three at once on one machine take as long, with three times the memory. */
    await build(releaseDist, cleanEnv());
    await build(debugDist, cleanEnv({ TAURI_ENV_DEBUG: 'true' }));
    await build(development, cleanEnv({ NODE_ENV: 'development' }), ['--mode', 'development']);
    [devUrl, releaseUrl, debugUrl] = await Promise.all([serve(development), serve(releaseDist), serve(debugDist)]);
  }

  browser = await chromium.launch({ headless: !headed });

  /* ── the development build, as the Pixel's viewport ─────────────────── */

  const context = await browser.newContext({ viewport: { width: 448, height: 997 }, hasTouch: true, locale: 'en-US' });
  const page = await context.newPage();
  const origin = new URL(devUrl).origin;
  const errors = [];
  const outside = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:') && url !== 'about:blank') {
      outside.push(url);
    }
  });

  await page.goto('about:blank');
  await page.goto(withUi(devUrl, 'palac'));
  await page.waitForSelector(role('mobile-shell'), { timeout: 20000 });

  const entered = await page.evaluate(() => ({
    ui: document.documentElement.dataset.ui ?? null,
    shellUi: document.querySelector('[data-ul-role="mobile-shell"]')?.getAttribute('data-ui') ?? null,
    desktop: document.querySelector('.shell') !== null,
  }));
  check(
    '?ui=palac starts the mobile shell over the web host, not the desktop one',
    entered.shellUi === 'palac' && entered.ui === 'palac' && !entered.desktop,
    JSON.stringify(entered),
  );
  check('it says it is the development view', (await count(page, role('dev-banner'))) === 1);
  const start = await settlesAt(page, 0);
  check('it starts with no layer and no entry of ours', start.ok, JSON.stringify(start.state));

  /* ── Back through history: layers ───────────────────────────────────── */

  const baseLength = await page.evaluate(() => window.history.length);
  await page.tap(role('find'));
  let at = await settlesAt(page, 1);
  check('opening the search opens a layer and pushes one entry', at.ok && (await count(page, role('find-row'))) === 1, JSON.stringify(at.state));
  await page.tap(role('dev-layer'));
  at = await settlesAt(page, 2);
  const lengthAtTwo = await page.evaluate(() => window.history.length);
  check(
    'a second layer pushes a second entry, and no more',
    at.ok && lengthAtTwo === baseLength + 2,
    `${JSON.stringify(at.state)}, history.length ${baseLength} → ${lengthAtTwo}`,
  );

  await pressBack(page);
  at = await settlesAt(page, 1);
  check(
    'Back closes the layer on top and leaves the one under it',
    at.ok && (await count(page, role('layer'))) === 0 && (await count(page, role('find-row'))) === 1,
    JSON.stringify(at.state),
  );
  await pressBack(page);
  at = await settlesAt(page, 0);
  check(
    'Back closes the last layer, and the app stays',
    at.ok && (await count(page, role('find-row'))) === 0 && at.state.url.startsWith(origin),
    JSON.stringify(at.state),
  );

  await page.tap(role('dev-layer'));
  await settlesAt(page, 1);
  await page.tap(role('layer-close'));
  at = await settlesAt(page, 0);
  check('a layer closed by a tap takes its entry away', at.ok && (await count(page, role('layer'))) === 0, JSON.stringify(at.state));

  /* ── Back on a question ─────────────────────────────────────────────── */

  await page.tap(role('dev-ask'));
  await page.waitForSelector(role('question'));
  at = await settlesAt(page, 1);
  const marked = await page.$$eval(`${role('question-action')}`, (buttons) =>
    buttons.map((button) => button.getAttribute('data-cancel') === 'true'),
  );
  check('a question is a layer with an entry of its own', at.ok, JSON.stringify(at.state));
  check('its Cancel is marked, and it is not the first action', JSON.stringify(marked) === '[false,true]', JSON.stringify(marked));
  await pressBack(page);
  at = await settlesAt(page, 0);
  const answered = await page.getAttribute(role('dev-readout'), 'data-answer');
  check(
    'Back answers the question with the action marked as its cancel, not the first',
    at.ok && answered === 'cancel' && (await count(page, role('question'))) === 0,
    `answer ${answered}, ${JSON.stringify(at.state)}`,
  );

  await page.tap(role('dev-ask-no-cancel'));
  await page.waitForSelector(role('question'));
  await settlesAt(page, 1);
  await pressBack(page);
  /* Nothing is supposed to happen; give it the time something would take. */
  await pause(400);
  at = await settlesAt(page, 1);
  check(
    'Back leaves a question with no cancel standing, and puts its entry back',
    at.ok && (await count(page, role('question'))) === 1 && (await page.getAttribute(role('dev-readout'), 'data-answer')) === 'cancel',
    JSON.stringify(at.state),
  );
  /* Only if it is still there: a Back that wrongly answered it must leave a red
     line above, not a timeout here that hides the rest. */
  if ((await count(page, role('question'))) > 0) await page.tap(role('question-action'));
  at = await settlesAt(page, 0);
  check(
    'answered by a tap, it is gone and so is its entry',
    at.ok && (await page.getAttribute(role('dev-readout'), 'data-answer')) === 'only' && (await count(page, role('question'))) === 0,
    JSON.stringify(at.state),
  );

  /* ── the keyboard's inset ───────────────────────────────────────────── */

  const inset = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--kb-inset').trim());
  /* `visualViewport`'s numbers are the browser's; a check can only stand in
     for them. Shadowed on the instance, then announced the way the WebView
     announces them. */
  const keyboard = (height, offsetTop = 0) =>
    page.evaluate(
      ([h, top]) => {
        const viewport = window.visualViewport;
        Object.defineProperty(viewport, 'height', { configurable: true, get: () => h ?? window.innerHeight });
        Object.defineProperty(viewport, 'offsetTop', { configurable: true, get: () => top });
        viewport.dispatchEvent(new Event('resize'));
      },
      [height, offsetTop],
    );

  check('--kb-inset is 0 with the keyboard down', (await inset()) === '0px', await inset());
  await keyboard(632);
  check('--kb-inset is 365px with the Pixel\'s keyboard up (997 → 632)', (await inset()) === '365px', await inset());
  await page.tap(role('dev-ask'));
  await page.waitForSelector(role('question'));
  const questionBottom = await page.$eval(role('question'), (element) => element.getBoundingClientRect().bottom);
  check('a question stands above the keyboard', questionBottom <= 997 - 365 + 0.5, `its bottom at ${questionBottom}, the keyboard's top at ${997 - 365}`);
  await pressBack(page);
  await settlesAt(page, 0);
  await keyboard(632, 100);
  check('the visible part moved down the layout counts as such (offsetTop 100 → 265px)', (await inset()) === '265px', await inset());
  await keyboard(null);
  check('--kb-inset is 0 again with the keyboard down', (await inset()) === '0px', await inset());

  /* ── the tool row keeps the focus ───────────────────────────────────── */

  await page.tap(role('find'));
  await page.waitForSelector(role('find-field'));
  await page.focus(role('find-field'));
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('data-ul-role') ?? document.activeElement?.tagName);
  await page.click('[aria-label="Next match"]');
  const afterClick = await focused();
  await page.tap('[aria-label="Previous match"]');
  const afterTap = await focused();
  check('a click in the tool row leaves the focus in the field', afterClick === 'find-field', String(afterClick));
  check('a tap in the tool row leaves the focus in the field', afterTap === 'find-field', String(afterTap));
  await page.tap(role('find-close'));
  await settlesAt(page, 0);

  /* ── the swipe helper ───────────────────────────────────────────────── */

  const stageBox = await page.locator(role('stage')).boundingBox();
  const y = stageBox.y + stageBox.height / 2;
  /* A mouse drag selects the text it crosses, and a press on a selection starts
     dragging it, which cancels the pointer: a finger does neither. So each
     drag starts with nothing selected. */
  const drag = async (from, to) => {
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.mouse.move(from, y);
    await page.mouse.down();
    await page.mouse.move((from + to) / 2, y, { steps: 4 });
    await page.mouse.move(to, y, { steps: 4 });
    await page.mouse.up();
  };
  /* The readout is React's, drawn a moment after the pointer is let go: given
     that moment before it is read, so a late change is not missed and an early
     read is not taken for no change. */
  const swiped = async (expected) => {
    await pause(300);
    await until(async () => (await page.getAttribute(role('stage'), 'data-swipe')) === expected, 1500);
    return page.getAttribute(role('stage'), 'data-swipe');
  };
  /* Each swipe from an edge goes the other way from the last one counted, so
     taking it would show. */
  await drag(300, 120);
  let shown = await swiped('left');
  check('a swipe across the middle is ours', shown === 'left', String(shown));
  await drag(6, 260);
  shown = await swiped('left');
  check('a swipe in from the left edge is left to Android', shown === 'left', String(shown));
  await drag(120, 330);
  shown = await swiped('right');
  check('the other way across the middle is ours again', shown === 'right', String(shown));
  await drag(442, 200);
  shown = await swiped('right');
  check('a swipe in from the right edge is left to Android', shown === 'right', String(shown));

  /* ── DocumentStage mounts each editor once ──────────────────────────── */

  await dropFile(page, 'first.md', '# First\n\nA note.\n');
  await page.waitForSelector(`${role('document-stage')} .cm-editor`, { timeout: 20000 });
  await dropFile(page, 'second.txt', 'plain text\n');
  await until(async () => (await count(page, `${role('document-stage')} .cm-editor`)) === 2, 20000);
  /* Marked by expando, not attribute: React would not notice, and a remount
     makes new elements that do not carry it. */
  await page.evaluate(() => {
    const [mount] = document.querySelectorAll('[data-ul-role="document-stage"] > .mount');
    mount.ulProbe = 'mount';
    mount.querySelector('.cm-editor').ulProbe = 'editor';
  });
  const tabsShown = await page.$$(role('document-tab'));
  for (const index of [0, 1, 0, 1]) {
    await tabsShown[index].tap();
    await until(async () => (await tabsShown[index].getAttribute('data-front')) === 'true');
  }
  const stage = await page.evaluate(() => {
    const mounts = [...document.querySelectorAll('[data-ul-role="document-stage"] > .mount')];
    return {
      mounts: mounts.length,
      sameMount: mounts[0]?.ulProbe === 'mount',
      sameEditor: mounts[0]?.querySelector('.cm-editor')?.ulProbe === 'editor',
      shown: mounts.map((mount) => mount.style.display),
    };
  });
  check(
    'DocumentStage mounts each editor once: the same elements after four changes of front',
    stage.mounts === 2 && stage.sameMount && stage.sameEditor,
    JSON.stringify(stage),
  );
  check('only the document in front is shown', JSON.stringify(stage.shown) === '["none","flex"]', JSON.stringify(stage.shown));

  /* ── a real question: closing with unsaved work ─────────────────────── */

  await tabsShown[0].tap();
  await page.locator(`${role('document-stage')} > .mount:visible .cm-content`).click();
  await page.keyboard.type('x');
  const dirty = await until(async () => (await tabsShown[0].getAttribute('data-dirty')) === 'true');
  check('typing into a note makes it unsaved', dirty);
  await page.tap(role('close'));
  await page.waitForSelector(role('question'));
  at = await settlesAt(page, 1);
  const discard = await page.$$eval(role('question-action'), (buttons) =>
    buttons.map((button) => `${button.textContent}${button.getAttribute('data-cancel') === 'true' ? '*' : ''}`),
  );
  check('closing it asks, with Cancel marked (confirmDiscard)', at.ok && discard.join(',') === 'Cancel*,Discard,Save', discard.join(','));
  await pressBack(page);
  at = await settlesAt(page, 0);
  check(
    'Back on that question cancels: the note stays open and unsaved',
    at.ok && (await count(page, role('question'))) === 0 && (await count(page, role('document-tab'))) === 2 && (await tabsShown[0].getAttribute('data-dirty')) === 'true',
    JSON.stringify(at.state),
  );
  await page.tap(role('close'));
  await page.waitForSelector(role('question'));
  await page.locator(role('question-action'), { hasText: 'Discard' }).last().tap();
  at = await settlesAt(page, 0);
  check('a tap on Discard does discard it', at.ok && (await count(page, role('document-tab'))) === 1, JSON.stringify(at.state));

  /* ── with nothing open, Back leaves ─────────────────────────────────── */

  await pressBack(page);
  const left = await until(() => page.url() === 'about:blank');
  check('with no layer open, Back leaves the app: the entries were exactly the layers', left, page.url());

  check('no error in the console', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('no request left the origin', outside.length === 0, outside.slice(0, 3).join(' '));
  await context.close();

  /* ── who gets the mobile shell ──────────────────────────────────────── */

  const plain = await browser.newContext({ viewport: { width: 448, height: 997 }, locale: 'en-US' });
  const other = await plain.newPage();
  const shellAt = async (url) => {
    await other.goto(url);
    await other.waitForSelector(`.shell, ${role('mobile-shell')}`, { timeout: 20000 });
    return other.evaluate(() => ({
      mobile: document.querySelector('[data-ul-role="mobile-shell"]')?.getAttribute('data-ui') ?? null,
      desktop: document.querySelector('.shell') !== null,
    }));
  };
  let found = await shellAt(withUi(devUrl, null));
  check('a narrow browser without ?ui= stays on the desktop shell', found.desktop && found.mobile === null, JSON.stringify(found));
  found = await shellAt(withUi(devUrl, 'boje'));
  check('?ui=boje names the interface', found.mobile === 'boje' && !found.desktop, JSON.stringify(found));
  found = await shellAt(withUi(devUrl, 'arak'));
  const arakItself = await other.evaluate(() => document.querySelector('[data-ul-role="dev-banner"]') === null);
  check('?ui=arak starts Arak itself, not the development view', found.mobile === 'arak' && !found.desktop && arakItself, JSON.stringify(found));
  found = await shellAt(withUi(devUrl, 'kartice'));
  check('?ui= with a name that is not an interface stays on the desktop shell', found.desktop && found.mobile === null, JSON.stringify(found));
  await plain.close();

  /* ── the app on Android: debug and release ──────────────────────────── */

  /*
   * The entry the phone takes, `__TAURI_DEBUG__ && isTauri() && isHandheld()`,
   * with the app stood in for: Tauri's page-side object, whose every call is
   * refused (there is no core behind it), and an Android user agent. The
   * shells come up regardless, which is all that is asked here; the refusals
   * are expected, so this page's console is not counted.
   */
  const asApp = async (url, android, keepDesktop = false, { locale, storedLocale } = {}) => {
    const app = await browser.newContext({
      viewport: { width: 448, height: 997 },
      ...(android
        ? { userAgent: 'Mozilla/5.0 (Linux; Android 17; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36' }
        : {}),
      /* English unless the language is what is checked: without it Playwright takes the computer's. */
      locale: locale ?? 'en-US',
    });
    if (storedLocale) {
      await app.addInitScript((value) => localStorage.setItem('uleditor.settings', JSON.stringify({ locale: value })), storedLocale);
    }
    await app.addInitScript(() => {
      const refuse = () => Promise.reject(new Error('no core behind this page'));
      window.__TAURI_INTERNALS__ = {
        invoke: refuse,
        transformCallback: () => 0,
        unregisterCallback: () => {},
        convertFileSrc: (path) => path,
        metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
        plugins: {},
      };
    });
    const appPage = await app.newPage();
    await appPage.goto(url);
    await appPage.waitForSelector(`.shell, ${role('mobile-shell')}`, { timeout: 20000 });
    if (keepDesktop) {
      /* What `startDevice` does on the phone: the key, then a reload. */
      await appPage.evaluate((key) => sessionStorage.setItem(key, '1'), DESKTOP_SHELL_KEY);
      await appPage.reload();
      await appPage.waitForSelector(`.shell, ${role('mobile-shell')}`, { timeout: 20000 });
    }
    if (locale) await appPage.waitForSelector(role('wall'), { timeout: 20000 }).catch(() => {});
    const result = await appPage.evaluate(() => ({
      mobile: document.querySelector('[data-ul-role="mobile-shell"]')?.getAttribute('data-ui') ?? null,
      desktop: document.querySelector('.shell') !== null,
      wall: document.querySelector('[data-ul-role="wall"]')?.getAttribute('aria-label') ?? null,
    }));
    await app.close();
    return result;
  };
  if (debugUrl) {
    found = await asApp(debugUrl, true);
    check('a debug build in the app on Android starts the mobile shell, Arak by default', found.mobile === 'arak' && !found.desktop, JSON.stringify(found));
    /* The phone's language when none was chosen (measured: a Pixel in Croatian reports hr-HR). */
    found = await asApp(debugUrl, true, false, { locale: 'hr-HR' });
    check('with no language chosen, the mobile shell speaks the phone\'s', found.wall === 'Svi dokumenti', JSON.stringify(found));
    found = await asApp(debugUrl, true, false, { locale: 'hr-HR', storedLocale: 'en' });
    check('a language chosen in the settings wins over the phone\'s', found.wall === 'All documents', JSON.stringify(found));
    found = await asApp(debugUrl, true, true);
    check('a device check can keep a debug build on the desktop shell for that run', found.desktop && found.mobile === null, JSON.stringify(found));
    found = await asApp(debugUrl, false);
    check('a debug build in the app on a computer stays on the desktop shell', found.desktop && found.mobile === null, JSON.stringify(found));
  }
  if (releaseUrl) {
    found = await asApp(releaseUrl, true);
    check('a release build in the app on Android stays on the desktop shell', found.desktop && found.mobile === null, JSON.stringify(found));
  }

  /* ── the release has none of it ─────────────────────────────────────── */

  if (releaseUrl) {
    const release = await browser.newContext({ viewport: { width: 448, height: 997 }, locale: 'en-US' });
    const releasePage = await release.newPage();
    const chunks = [];
    releasePage.on('request', (request) => {
      if (CHUNKS.test(request.url())) chunks.push(request.url());
    });
    await releasePage.goto(withUi(releaseUrl, 'arak'));
    await releasePage.waitForSelector(`.shell, ${role('mobile-shell')}`, { timeout: 20000 });
    const there = await releasePage.evaluate(() => ({
      mobile: document.querySelector('[data-ul-role="mobile-shell"]') !== null,
      desktop: document.querySelector('.shell') !== null,
      ui: document.documentElement.dataset.ui ?? null,
    }));
    check('a release build ignores ?ui=arak and starts the desktop shell', there.desktop && !there.mobile && there.ui === null, JSON.stringify(there));
    check('and asks for no chunk of the mobile shell', chunks.length === 0, chunks.join(' '));
    await release.close();
  } else {
    check('a release build was given (--release-url)', false, 'without it the release is not checked');
  }

  /*
   * In the files, not only in what a browser happens to load: the condition in
   * `main.tsx` is two constants, so a release build drops the mobile shell
   * whole. These markers are strings only the mobile shell's code holds.
   */
  const MARKERS = ['ulLayers', '--kb-inset', 'mobile-shell', 'm-dev-stage', 'arak-corner', 'arak-crta'];
  /* The library a browser check stands in for (`libraryForChecks` in
     `MobileApp.tsx`): in a development build only, never in an APK's. */
  const CHECK_ONLY = ['ul-check-library'];
  const scan = async (dir, markers = MARKERS) => {
    const assets = join(dir, 'assets');
    const names = (await readdir(assets)).filter((name) => /\.(js|css)$/.test(name));
    const hits = [];
    for (const name of names) {
      if (CHUNKS.test(name)) hits.push(name);
      const text = await readFile(join(assets, name), 'utf8');
      for (const marker of markers) if (text.includes(marker)) hits.push(`${name}: ${marker}`);
    }
    return { files: names.length, hits };
  };
  if (releaseDist) {
    const { files, hits } = await scan(releaseDist);
    check(`no file of the release build holds the mobile shell (${files} files)`, files > 0 && hits.length === 0, hits.slice(0, 4).join(', '));
  } else {
    check('a release build\'s folder was given (--release-dist)', false, 'without it the files are not checked');
  }
  if (debugDist) {
    const { files, hits } = await scan(debugDist);
    const markers = new Set(hits.map((hit) => hit.split(': ')[1]).filter(Boolean));
    check(
      `a debug build (TAURI_ENV_DEBUG=true) does hold it, so the markers mean something (${files} files)`,
      MARKERS.every((marker) => markers.has(marker)),
      [...markers].join(', '),
    );
    const chunkNames = hits.filter((hit) => !hit.includes(': '));
    check('and Arak comes as a chunk of its own', chunkNames.some((name) => /Arak/.test(name)), chunkNames.join(', '));
  }
  for (const [label, dir] of [['release', releaseDist], ['debug', debugDist]]) {
    if (!dir) continue;
    const { hits } = await scan(dir, CHECK_ONLY);
    const found = hits.filter((hit) => hit.includes(': '));
    check(`the library stood in for by checks is not in the ${label} build`, found.length === 0, found.join(', '));
  }
  if (developmentDist) {
    const { hits } = await scan(developmentDist, CHECK_ONLY);
    const found = hits.filter((hit) => hit.includes(': '));
    check('and it is in the development build, so its absence means something', found.length > 0, found.join(', '));
  }
} finally {
  await browser?.close();
  await stopServers();
  if (scratch) await rm(scratch, { recursive: true, force: true });
}

const failed = checks.filter((one) => !one.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
