/**
 * The updater **inside the desktop application**, where the plugin actually
 * exists.
 *
 * `verify-updates.mjs` compares the pieces on disk. What it cannot see is
 * whether the plugin is registered in the running program and whether the
 * window is allowed to call it — a missing line in `capabilities/default.json`
 * turns every check into "updater.check not allowed", and that string would
 * reach a person as a failed update check with no explanation.
 *
 * Three outcomes are acceptable and all three are a pass, because which one
 * happens depends on the release page rather than on this code:
 *
 * - **an error**, which is what happens until the first signed release exists,
 *   since there is no `latest.json` to read yet;
 * - **"this is the newest version"**, once one exists and matches;
 * - **an offer**, once one exists and is newer.
 *
 * What is *not* acceptable is silence, an exception in the page, or a request
 * leaving the window: the check happens in Rust, so `connect-src` is never
 * asked and nothing may be seen going out from here.
 *
 *   node tools/verify-desktop-updates.mjs
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isLocal, startDesktop, stopDesktop } from './desktop-session.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

let session;

try {
  session = await startDesktop({ port: 9339 });
  const { page } = session;
  check('attached to the desktop application', true);

  const external = [];
  page.on('request', (request) => {
    if (!isLocal(request.url())) external.push(request.url());
  });

  const failures = [];
  page.on('pageerror', (err) => failures.push(err.message));

  /* The command, through the palette — the same route the menu row takes. */
  await page.keyboard.press('Control+Shift+P');
  await page.waitForSelector('.palette', { timeout: 10000 });
  await page.locator('.palette-input input').pressSequentially('check for updates');

  const offered = await page.locator('.palette-item').allInnerTexts();
  check(
    'the command is there to be found',
    offered.some((row) => /check for updates/i.test(row)),
    offered.slice(0, 3).join(' | '),
  );

  /* The row is clicked rather than entered. Two commands match this filter —
     the check and the switch that turns the automatic one on — and pressing
     Enter on whichever the list put first would silently toggle a setting and
     look exactly like a check that answered nothing. */
  await page
    .locator('.palette-item')
    .filter({ hasText: /Check for updates…/ })
    .first()
    .click();

  /* The first toast is "Looking for a new version…", which is replaced by
     whatever came back. Waiting for the second is the whole point: the first
     one proves nothing but that a function was called. */
  const answered = await (async () => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const texts = await page.locator('.toast p').allInnerTexts();
      const answer = texts.find((text) => !/Looking for a new version/i.test(text));
      if (answer) return answer;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  })();

  const said = await page.locator('.toast p').allInnerTexts();
  check(
    'the program answered',
    answered !== null,
    answered ?? `nothing within a minute; the toasts said: ${said.join(' | ') || '(none)'}`,
  );

  if (answered) {
    /* Any of the three, and none of the two ways this fails in a way a person
       cannot act on: a permission error, or a plugin that is not there. */
    const legible =
      /newest version/i.test(answered) ||
      /is available/i.test(answered) ||
      /check for updates failed/i.test(answered);
    check('and the answer is one a person can act on', legible, answered);

    check(
      'the permission is granted, so this is not a "not allowed"',
      !/not allowed|forbidden|permission/i.test(answered),
      answered,
    );
    check(
      'and the plugin is registered, so this is not a missing command',
      !/not found|unknown command|invoke/i.test(answered),
      answered,
    );
  }

  check('nothing threw in the page', failures.length === 0, failures.slice(0, 2).join(' | '));
  check(
    'and no request left the window — Rust asked, not the page',
    external.length === 0,
    external.slice(0, 3).join(' | ') || 'no external requests',
  );

  await page.screenshot({ path: resolve(ROOT, 'tools/screenshots/desktop-updates.png') });
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await session?.page
    ?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-desktop-updates.png') })
    .catch(() => {});
} finally {
  await stopDesktop(session);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
