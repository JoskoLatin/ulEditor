/**
 * Consent is given in Rust, never by the page (ADR 0005), **in the desktop
 * application**.
 *
 * This check is the script in the webview that ADR 0005 is about. It does what
 * code injected into the page could do — ask the core for folders, hand the
 * page an `open-paths` event of its own, write the file the consents are kept
 * in, navigate with a query — and every one of them has to be refused. Then it
 * does what the system does — hands a folder over from outside, through a
 * second copy of the program — and that has to be let in, remembered across a
 * restart, and forgotten when the folder is taken out of Recent.
 *
 * Windows only, like the other desktop checks. It starts the program on a
 * scratch profile and leaves the person's own consents alone.
 *
 *   node tools/verify-desktop-consent.mjs
 */

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDesktop, stopDesktop, openFromOutside } from './desktop-session.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const windows = process.env.SystemRoot ?? 'C:\\Windows';
const base = await mkdtemp(join(tmpdir(), 'ul-consent-'));
const project = join(base, 'project');
const never = join(base, 'never-opened');
await mkdir(project);
await mkdir(never);
await writeFile(join(project, 'notes.txt'), 'Prvi redak.\n');
await writeFile(join(never, 'secret.txt'), 'nobody consented to this\n');

const attach = (page) => ({
  invoke: (cmd, args) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]),
  refused: (cmd, args) =>
    page.evaluate(
      ([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a).then(() => false, () => true),
      [cmd, args],
    ),
});

let session;
try {
  session = await startDesktop({ port: 9351 });
  const { page, profile } = session;
  let { invoke, refused } = attach(page);
  check('attached to the desktop application', true);
  const home = page.url();

  /* ── what the page asks for is not given ─────────────────────────── */

  const claimed = await invoke('adopt_paths', { paths: [windows, never, join(never, 'secret.txt')] });
  check(
    'a folder or file nobody consented to is not let in by asking for it',
    Array.isArray(claimed) && claimed.length === 0,
    JSON.stringify(claimed),
  );
  check(
    `and ${windows} cannot be read`,
    await refused('read_directory', { path: windows }),
  );
  check('nor a file the page named', await refused('read_file', { path: join(never, 'secret.txt') }));
  check('the command that let a file in is gone', await refused('grant_file', { path: join(never, 'secret.txt') }));

  /* An open-paths event the page makes itself: the page's own listener asks
     for the paths, and is refused like any other asking. */
  await invoke('plugin:event|emit', { event: 'uleditor://open-paths', payload: [never] });
  await sleep(2500);
  check(
    'an open-paths event the page makes opens nothing',
    (await refused('read_directory', { path: never })) &&
      (await page.locator('.tree-row', { hasText: 'never-opened' }).count()) === 0,
  );

  /* The file the consents are kept in is the core's: the page writes it
     neither with a folder open above it nor by naming it. */
  const kept = join(profile, 'consents.json');
  check(
    'the consents file cannot be written by the page',
    await refused('write_file', { path: kept, contents: Array.from(Buffer.from('{"consents":[]}')) }),
  );

  /* A navigation with a query goes nowhere but the application's own page. */
  await page.evaluate((target) => {
    window.location.href = target;
  }, `${home}?open=${encodeURIComponent(windows)}`);
  await sleep(2500);
  check(
    'a navigation with a query goes nowhere',
    page.url() === home && (await page.locator('.shell').count()) > 0,
    page.url(),
  );

  /* ── what the system hands over is ───────────────────────────────── */

  await openFromOutside(page, [project]);
  check('a folder handed over from outside is let in', !(await refused('read_directory', { path: project })));
  await invoke('write_file', {
    path: join(project, 'notes.txt'),
    contents: Array.from(Buffer.from('Drugi redak.\n')),
  });
  check(
    'and written',
    (await readFile(join(project, 'notes.txt'), 'utf8')) === 'Drugi redak.\n',
  );
  check('and remembered, by the core', existsSync(kept) && (await readFile(kept, 'utf8')).includes('project'));

  /* ── remembered across a restart ─────────────────────────────────── */

  await stopDesktop(session);
  session = await startDesktop({ port: 9351, profile });
  ({ invoke, refused } = attach(session.page));
  const again = await invoke('adopt_paths', { paths: [project, never] });
  check(
    'after a restart the remembered folder is claimed, and nothing else',
    Array.isArray(again) && again.length === 1 && again[0].name === 'project',
    JSON.stringify(again?.map((stat) => stat.name)),
  );

  /* ── forgotten when taken out of Recent ──────────────────────────── */

  await invoke('forget_root', { path: project, keep: [], remember: false });
  check('a folder taken out of Recent leaves the sandbox', await refused('read_directory', { path: project }));
  const afterForget = await invoke('adopt_paths', { paths: [project] });
  check(
    'and cannot be claimed again',
    Array.isArray(afterForget) && afterForget.length === 0,
    JSON.stringify(afterForget),
  );
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await session?.page
    ?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-desktop-consent.png') })
    .catch(() => {});
} finally {
  await stopDesktop(session);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
