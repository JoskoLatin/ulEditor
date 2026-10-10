/**
 * An update is installed only after a yes in a dialog the system draws
 * (card 515).
 *
 * The page offers an update and asks for it to be installed when "Install and
 * restart" is clicked — but script in the page could ask with no click at all,
 * and an install closes the program under the person, whatever they had not
 * saved. So `install_update` asks first, in the three buttons of the trust
 * question, paced as a link is. This check serves a manifest offering 9.9.9
 * from 127.0.0.1 to a build pointed at it, and counts what is fetched:
 *
 * - "Not now": nothing past the manifest, and the page is told no;
 * - asked again at once: no dialog drawn, and the reason;
 * - half a minute later, the yes: the installer is fetched, and turned away,
 *   since its signature is not one — and the program is still running.
 *
 * Built as it ships, under an identifier of its own, so that an ulEditor the
 * person has open is left alone. Takes about a minute after the build, half of
 * it the pause after "Not now".
 *
 *   node tools/verify-desktop-install.mjs
 */

import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDesktop, pressDialog, startDesktop, stopDesktop } from './desktop-session.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IDENTIFIER = 'org.uleditor.app.check';
/** Where the manifest is served: fixed, since it is compiled into the build. */
const PORT = 9351;
/* rfd numbers the task dialog's custom buttons 1004, 1008 and 1001 — "Not
   now", the yes, "Cancel" (see verify-desktop-lsp). */
const NOT_NOW = 1004;
const YES = 1008;

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── the release, served here ─────────────────────────────────────────── */

const fetched = [];
const server = createServer((request, response) => {
  fetched.push(request.url);
  if (request.url === '/latest.json') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        version: '9.9.9',
        notes: 'verify-desktop-install',
        pub_date: '2026-10-11T00:00:00Z',
        platforms: {
          'windows-x86_64': {
            signature: 'not a signature',
            url: `http://127.0.0.1:${PORT}/installer.exe`,
          },
        },
      }),
    );
    return;
  }
  if (request.url === '/installer.exe') {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(Buffer.alloc(4096, 0x5a));
    return;
  }
  response.writeHead(404);
  response.end();
});
await new Promise((ready, failed) => {
  server.once('error', failed);
  server.listen(PORT, '127.0.0.1', ready);
});

const installerFetched = () => fetched.includes('/installer.exe');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let session;
try {
  await buildDesktop(IDENTIFIER, {
    plugins: {
      updater: {
        endpoints: [`http://127.0.0.1:${PORT}/latest.json`],
        dangerousInsecureTransportProtocol: true,
      },
    },
  });
  session = await startDesktop({ port: 9352, built: true, identifier: IDENTIFIER });
  const { page } = session;
  check('attached to the desktop application', true);

  const invoke = (command, args) =>
    page.evaluate(
      ([c, a]) =>
        window.__TAURI_INTERNALS__.invoke(c, a).then(
          (ok) => ({ ok }),
          (err) => ({ err: String(err) }),
        ),
      [command, args],
    );
  /* As the shell asks, with a channel for the progress — not awaited here:
     the question holds it until a button is pressed. */
  const install = () =>
    page.evaluate(() => {
      const id = window.__TAURI_INTERNALS__.transformCallback(() => {});
      return window.__TAURI_INTERNALS__
        .invoke('install_update', { onEvent: `__CHANNEL__:${id}`, uiLanguage: 'en' })
        .then(
          (ok) => ({ ok }),
          (err) => ({ err: String(err) }),
        );
    });

  const found = await invoke('check_update', {});
  check('the build finds what the manifest offers', found.ok?.version === '9.9.9', JSON.stringify(found));

  /* ── "Not now" ───────────────────────────────────────────────────────── */
  const declined = install();
  await sleep(500); // pressDialog blocks: let the call go out first
  const asked = pressDialog(NOT_NOW, 60);
  check('the core asks first, in a dialog of its own', /^pressed: Install ulEditor 9\.9\.9\?$/.test(asked), asked);
  const no = await declined;
  check('"Not now" installs nothing, and the page is told no', no.ok === false, JSON.stringify(no));
  check('and nothing past the manifest was fetched', !installerFetched(), fetched.join(' '));

  /* ── asked again at once ─────────────────────────────────────────────── */
  /* A question drawn here would hold the call until answered, so it is
     answered, and the check fails rather than waits. */
  const asking = install();
  await sleep(500);
  const drawn = pressDialog(NOT_NOW, 3);
  const again = await asking;
  check(
    'asked again at once: no question, and the reason',
    /asked about this update a moment ago/.test(again.err ?? ''),
    JSON.stringify(again),
  );
  check('with no dialog drawn', drawn === 'no dialog', drawn);
  check('and still nothing fetched', !installerFetched(), fetched.join(' '));

  /* ── half a minute later, the yes ────────────────────────────────────── */
  await sleep(31_000);
  const accepted = install();
  await sleep(500);
  const askedAgain = pressDialog(YES, 60);
  check('half a minute later it asks again', /^pressed: Install ulEditor 9\.9\.9\?$/.test(askedAgain), askedAgain);
  const yes = await accepted;
  check('the yes fetches the installer', installerFetched(), fetched.join(' '));
  check(
    'which a signature that is not one turns away',
    yes.ok === undefined && typeof yes.err === 'string',
    JSON.stringify(yes),
  );
  check(
    'and the program is still running',
    (await page.evaluate(() => document.readyState).catch(() => 'gone')) === 'complete',
  );

  await page.screenshot({ path: resolve(ROOT, 'tools/screenshots/desktop-install.png') });
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await session?.page
    ?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-desktop-install.png') })
    .catch(() => {});
} finally {
  /* A question left on the screen would hold the program open. */
  pressDialog(1001, 1);
  await stopDesktop(session);
  server.close();
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
