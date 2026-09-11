/**
 * What the program does when it breaks — and what it does not do.
 *
 * Two halves, because the feature makes two different kinds of promise.
 *
 * **The promise that nothing leaves the machine** is checked the way
 * [`verify-updates.mjs`](./verify-updates.mjs) checks the updater: by reading
 * the code and refusing to find a way out of it. No `fetch`, no endpoint, no
 * upload, no key. A crash reporter is the single most tempting place in a
 * program to add "just a little telemetry", so the check exists to make adding
 * it a deliberate act that turns a run red.
 *
 * **The promise that a broken editor does not take the window with it** cannot
 * be read out of the source at all, so it is done in a browser, by breaking the
 * two things that were measured to produce a blank page:
 *
 * - a tab whose format is not in the registry, which `TabBar` used to
 *   dereference without a guard;
 * - an editor whose `focus()` throws, which runs inside a `Pane` effect.
 *
 * Both took `#root` from twelve thousand characters to **zero**. The bar here is
 * that the shell is still standing afterwards and the palette still opens —
 * which is the difference between a program that lost a document and a program
 * that has to be restarted.
 *
 *   pnpm dev                       # in another terminal
 *   node tools/verify-crash.mjs
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');

const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5273';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── nothing leaves the machine ──────────────────────────────────────── */

const rust = read('apps/desktop/src-tauri/src/crash.rs');
const web = read('packages/shell-ui/src/shell/crash.ts');

const OUTBOUND = [
  ['fetch(', 'a fetch'],
  ['XMLHttpRequest', 'an XHR'],
  ['WebSocket', 'a socket'],
  ['https://', 'a URL'],
  ['http://', 'a URL'],
  ['reqwest', 'an HTTP client'],
  ['ureq', 'an HTTP client'],
  ['TcpStream', 'a socket'],
  ['sentry', 'a crash service'],
  ['navigator.sendBeacon', 'a beacon'],
];

const outbound = OUTBOUND.filter(([needle]) => rust.includes(needle) || web.includes(needle));
check(
  'no crash report has anywhere to go but the disk',
  outbound.length === 0,
  outbound.map(([, what]) => what).join(', ') || 'no fetch, no endpoint, no key, no service',
);

/* ── the folder the hook writes to is the one Tauri would use ────────── */

const conf = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json'));
const declared = /const IDENTIFIER: &str = "([^"]+)"/.exec(rust)?.[1] ?? '';
check(
  'the hook and the application agree on the identifier',
  declared === conf.identifier,
  `${declared || '(none)'} vs ${conf.identifier}`,
);

/* ── the hook must survive a broken process ──────────────────────────── */

/* The closure itself, and not a character more. Sliced to the end of the file
   it would swallow `unseen` and `trim`, which list the folder on purpose and
   at a moment when listing it is safe — and the check would then fail on the
   two functions written to keep the hook clean. */
const hookStart = rust.indexOf('set_hook(Box::new(');
const hookEnd = rust.indexOf('previous(info);', hookStart);
const hook = rust.slice(hookStart, hookEnd);
const forbidden = [
  ['Mutex', 'a lock'],
  ['.lock()', 'a lock'],
  ['read_dir', 'a directory listing'],
  ['app.path()', 'a call into Tauri'],
  ['AppHandle', 'a call into Tauri'],
];
const inHook = forbidden.filter(([needle]) => hook.includes(needle));
check(
  'and the hook itself takes no lock, lists no folder and asks Tauri nothing',
  inHook.length === 0,
  inHook.map(([, what]) => what).join(', ') ||
    'a lock would hang the window instead of ending it',
);

check(
  'the hook is installed before anything that can fail',
  /pub fn run\(\) \{[\s\S]{0,600}?crash::install\(\);[\s\S]{0,80}?let builder/.test(
    read('apps/desktop/src-tauri/src/lib.rs'),
  ),
  'before the plugins, the context and the builder’s own expect',
);

const lib = read('apps/desktop/src-tauri/src/lib.rs');
check(
  'the two commands the window needs are registered',
  lib.includes('record_crash,') && lib.includes('take_crash_reports,'),
);

check(
  'a report from the window cannot be unbounded',
  /const LONGEST_REPORT: usize/.test(lib) && /const MOST = \d+;/.test(web),
  'one cap on the size, one on how many a session may write',
);

check(
  'a failed write cannot come back round as another crash',
  /invoke\('record_crash'[\s\S]{0,120}?\.catch\(/.test(web),
  'the rejection is swallowed, or it re-enters its own listener',
);

check(
  'a cancelled operation is not a crash',
  web.includes("error.name === 'AbortError'"),
);

/* ── what a report may say about a person ────────────────────────────── */

const { scrub } = await import(
  pathToFileURL(resolve(ROOT, 'packages/shell-ui/src/shell/crash.ts')).href
);

const PRIVATE = [
  ['C:\\Users\\joško\\Moji dokumenti\\ugovor.docx', 'a Croatian path with a space in it'],
  ['C:/Users/noob/Documents/Ponuda za Kliniku.docx', 'the same with forward slashes'],
  ['file:///C:/dev/ulEditor/packages/shell-ui/src/main.tsx', 'a module URL in a stack frame'],
  [
    'at Pane (file:///C:/Users/noob/dev/ulEditor/src/EditorSurface.tsx:58:12)',
    'a whole stack frame, brackets and line numbers and all',
  ],
  ['C:\\Program Files\\LibreOffice\\program\\soffice.com is missing', 'a path with a space in it'],
  ['\\\\server\\share\\tajno\\placa.xlsx', 'a share on the network'],
  ['/home/josko/dokumenti/ugovor.odt', 'a POSIX home'],
  ['could not read C:\\Users\\noob\\ugovor.docx: damaged', 'a path in the middle of a sentence'],
];

/* Named parts rather than a shape. Asking "does a drive letter survive?" reads
   the `e:` in `file:` as one and fails on output that is perfectly clean —
   which is how this check first accused the code it was written to defend. */
const SECRETS = ['joško', 'josko', 'noob', 'Users', 'server', 'share', 'tajno', 'home', 'dev'];
const leaked = PRIVATE.filter(([text]) => {
  const cleaned = scrub(text);
  return SECRETS.some((secret) => cleaned.includes(secret));
});
check(
  'a path, a share and a module URL are cut back to their last part',
  leaked.length === 0,
  leaked.map(([, what]) => what).join('; ') || `${PRIVATE.length} shapes`,
);

/* The other half of the same question, and the reason the rule is narrow: a
   scrub greedy enough to catch everything eats the message it was protecting. */
const sentence = 'could not read C:\\Users\\noob\\ugovor.docx: the archive is damaged';
check(
  'and the message around it survives, which is the whole point of writing it down',
  scrub(sentence).includes('the archive is damaged') && scrub(sentence).startsWith('could not read'),
  JSON.stringify(scrub(sentence)),
);

/* Two paths in one sentence must stay two, and the words between them must stay
   words. This is the case a scrub that simply allowed spaces would swallow. */
const two = 'copy C:\\a\\b.txt to D:\\c\\d.txt failed';
check(
  'two paths in one sentence stay two, and the words between them survive',
  scrub(two) === 'copy …/b.txt to …/d.txt failed',
  JSON.stringify(scrub(two)),
);

check(
  'a sentence with nothing private in it is left exactly as it was',
  scrub('the archive is damaged or incompletely downloaded') ===
    'the archive is damaged or incompletely downloaded',
);

/* ── and now the window ──────────────────────────────────────────────── */

let browser;
let page;
try {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  /* Every line the crash listener writes, so it can be asked what it counted. */
  const recorded = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().startsWith('[uleditor]')) recorded.push(message.text());
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.shell', { timeout: 20000 });

  /*
   * (0) What is not a crash, and what is.
   *
   * The first version of the window listener fell back to the event's message
   * when nothing had been thrown — and a ResizeObserver whose layout settles
   * over two frames reports exactly that, with `error: null`, once per round.
   * The reading view pages that way as a matter of course, so every session of
   * reading wrote crash reports to disk and announced them at the next start.
   * `verify:reading` is what caught it, as a console error nobody had written.
   * So both halves are asked: the loop records nothing, and a real throw from a
   * timer — the same channel — still records one, or the first half would pass
   * against a listener that had simply stopped listening.
   */
  const before = recorded.length;
  await page.evaluate(async () => {
    const box = document.createElement('div');
    document.body.appendChild(box);
    let round = 0;
    const observer = new ResizeObserver(() => {
      if (round++ < 5) box.style.width = `${100 + round * 10}px`;
    });
    observer.observe(box);
    await new Promise((settle) => setTimeout(settle, 300));
    observer.disconnect();
    box.remove();
  });
  check(
    'a layout that settles over two frames is not recorded as a crash',
    recorded.length === before,
    recorded.length === before ? 'nothing recorded' : recorded.slice(before).join(' · ').slice(0, 140),
  );
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error('a real fault, thrown with nothing to catch it');
    });
  });
  await page.waitForTimeout(200);
  check(
    'and a real throw on the same channel still is',
    recorded.slice(before).some((line) => line.includes('a real fault')),
    `${recorded.length - before} recorded`,
  );

  const alive = async () => ({
    shell: (await page.locator('.shell').count()) > 0,
    rootLength: await page.evaluate(() => document.getElementById('root')?.innerHTML.length ?? 0),
    boundary: (await page.locator('.surface-error').count()) > 0,
  });

  /* A document, so there is something to break. Dropped rather than opened
     through a command, which is how every other browser check here gets one. */
  await page.evaluate(() => {
    const file = new File(['probe'], 'crash-probe.txt');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    window.dispatchEvent(
      new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
    );
  });
  await page.waitForSelector('.tabbar .tab', { timeout: 15000 });

  const opened = await page.locator('.tabbar .tab').count();
  /* Everything below asks what happens to an open document. Without one they
     would all pass by asking nothing, which is the shape of check this
     repository distrusts most. */
  check('a document is open to break', opened > 0, `${opened} tabs`);
  if (opened === 0) throw new Error('nothing was open, so nothing below was measured');

  /* (a) The format that is not in the registry — the measured blank page. */
  await page.evaluate(async () => {
    const { useWorkspace } = await import('/src/state/workspace.ts');
    const state = useWorkspace.getState();
    const tab = state.tabs[0];
    if (tab) state.patchTab(tab.id, { format: 'nonesuch' });
  });
  await page.waitForTimeout(400);

  const afterFormat = await alive();
  check(
    'a tab whose format nothing knows no longer empties the window',
    afterFormat.shell && afterFormat.rootLength > 1000,
    `#root ${afterFormat.rootLength} characters`,
  );
  /*
   * And it never threw in the first place. Without this line the check passes
   * either way — the boundary catches the throw and the window survives, which
   * is the promise but not the whole of it. Removing the guard in `TabBar` and
   * running this is how that was found: the run stayed green and only the word
   * "boundary" in the detail said anything had changed.
   */
  check(
    'and it is drawn rather than caught, because the guard came first',
    !afterFormat.boundary,
    afterFormat.boundary ? 'the boundary is holding a throw that should not happen' : 'no throw',
  );
  check(
    'and the palette still opens afterwards',
    await page.evaluate(async () => {
      const { useWorkspace } = await import('/src/state/workspace.ts');
      useWorkspace.getState().setPaletteOpen(true);
      return true;
    }).then(async () => {
      await page.waitForTimeout(200);
      const open = (await page.locator('.palette-input input').count()) > 0;
      await page.keyboard.press('Escape');
      return open;
    }),
  );

  /*
   * (b) An editor whose `focus()` throws, from inside the effect that runs it.
   *
   * A second document first, because that effect only runs again when `focused`
   * changes — with one tab it is already focused and nothing re-runs, and the
   * check would report a pass for a throw that never happened.
   */
  await page.evaluate(() => {
    const file = new File(['second'], 'crash-probe-2.txt');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    window.dispatchEvent(
      new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
    );
  });
  await page.waitForFunction(() => document.querySelectorAll('.tabbar .tab').length >= 2, {
    timeout: 15000,
  });

  const armed = await page.evaluate(async () => {
    const { tabInstances, useWorkspace } = await import('/src/state/workspace.ts');
    const first = useWorkspace.getState().tabs[0];
    const instance = first ? tabInstances.get(first.id) : null;
    if (!instance || !first) return false;
    instance.focus = () => {
      throw new Error('the editor refused the caret');
    };
    useWorkspace.getState().activateTab(first.id);
    return true;
  });
  check('an editor was armed to throw when it is focused', armed);
  await page.waitForTimeout(800);

  const afterFocus = await alive();
  check(
    'an editor that throws is caught, and the rest of the program stands',
    afterFocus.shell && afterFocus.rootLength > 1000 && afterFocus.boundary,
    afterFocus.boundary
      ? `#root ${afterFocus.rootLength} characters, and the panel says so`
      : `#root ${afterFocus.rootLength} characters, but nothing caught anything`,
  );

  const bar = await page.locator('.titlebar, .statusbar').count();
  check('the title bar and the status bar are still there', bar > 0, `${bar}`);
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  if (page) {
    await page
      .screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-crash.png') })
      .catch(() => {});
  }
} finally {
  await browser?.close().catch(() => {});
}

const failed = checks.filter((one) => !one.passed).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
