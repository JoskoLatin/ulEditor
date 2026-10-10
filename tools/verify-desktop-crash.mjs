/**
 * **A report of something that went wrong in a check ends up in the check's
 * profile, not in the person's own folder** — in the desktop application.
 *
 * `crash.rs` used to work the reports' folder out from a fixed identifier, so
 * every debug build and every desktop check wrote into the person's real
 * `%LOCALAPPDATA%\org.uleditor.app\logs`. The ulEditor they have installed then
 * opened with "stopped unexpectedly last time" about a program that was not
 * theirs and had not stopped. A debug build started with `UL_DATA_DIR` now
 * writes into that profile, as `trust.rs`'s answers always did.
 *
 * What is proved here, with the program as it ships and under an identifier of
 * its own:
 *
 * - an error nobody caught is recorded, and the report is in the profile's
 *   `logs`, and **nothing at all** is new in the real folder;
 * - the next start's announcement reads that same folder;
 * - a keydown dispatched on `window` or on `document` — a script's, an
 *   assistive tool's — has no element to be the target of, and used to throw
 *   `target?.closest is not a function` in the shell, which was recorded as a
 *   crash. It records nothing now;
 * - the folder is still the program's own (ADR 0005, "a protected folder is
 *   absolute"): opened from above, the page can neither write into it nor
 *   read what is in it, while a file beside it can be written — so the refusal
 *   is the protection and not a folder nobody opened.
 *
 * Nothing here may leave a report in the real folder even when the program is
 * broken: the files this run causes there are found by the name list taken
 * before and by the marker only this run knows, and removed — only those.
 *
 * Windows only.
 *
 *   node tools/verify-desktop-crash.mjs            (builds first, ~1-2 min)
 *   node tools/verify-desktop-crash.mjs --no-build (the binary is current)
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { buildDesktop, openFromOutside, startDesktop, stopDesktop } from './desktop-session.mjs';

const IDENTIFIER = 'org.uleditor.app.check';

/* Both folders a report could end up in by the old formula: the real
   program's, and the one this identifier names. */
const LOCAL = process.env.LOCALAPPDATA;
const WATCHED = LOCAL
  ? [join(LOCAL, 'org.uleditor.app', 'logs'), join(LOCAL, IDENTIFIER, 'logs')]
  : [];

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

async function listing(folder) {
  try {
    return (await readdir(folder)).sort();
  } catch {
    return [];
  }
}

async function until(condition, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

if (process.platform !== 'win32' || !LOCAL) {
  console.log('this check runs on Windows, where LOCALAPPDATA is the folder in question');
  process.exit(0);
}

if (!process.argv.includes('--no-build')) {
  console.log('building the program as it ships …');
  await buildDesktop(IDENTIFIER);
}

/* A marker only this run knows: the one thing a file must carry to be
   removed from a folder that is not ours. */
const MARKER = `ul-check-crash-${randomBytes(6).toString('hex')}`;

const before = new Map();
for (const folder of WATCHED) before.set(folder, await listing(folder));

const parent = await mkdtemp(join(tmpdir(), 'ul-crash-'));
const profile = join(parent, 'profile');
await mkdir(profile);
const logs = join(profile, 'logs');

let session;
try {
  session = await startDesktop({ port: 9359, identifier: IDENTIFIER, built: true, profile });
  const { page } = session;
  const invoke = (cmd, args) =>
    page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  const refusal = (cmd, args) =>
    page.evaluate(
      ([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a).then(() => null, (err) => JSON.stringify(err)),
      [cmd, args],
    );
  const reports = async () => (await listing(logs)).filter((n) => n.startsWith('crash-'));
  check('attached to the program as it ships', true);

  /* ── a keydown with no element behind it ─────────────────────────── */

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.waitForTimeout(1000);
  const quiet = (await reports()).length;
  await page.evaluate(() => {
    for (const target of [window, document]) {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    }
  });
  await page.waitForTimeout(1500);
  check(
    'a keydown dispatched on the window or the document throws nothing',
    pageErrors.length === 0,
    pageErrors[0] ?? '',
  );
  check('and records nothing', (await reports()).length === quiet, `${(await reports()).length} reports`);

  /* ── an error nobody caught ──────────────────────────────────────── */

  await page.evaluate((marker) => {
    setTimeout(() => {
      throw new Error(marker);
    }, 0);
  }, MARKER);
  const written = await until(async () => {
    for (const name of await reports()) {
      if ((await readFile(join(logs, name), 'utf8')).includes(MARKER)) return true;
    }
    return false;
  });
  check("an uncaught error's report is written into the profile's logs", written, logs);

  const after = new Map();
  let leaked = [];
  for (const folder of WATCHED) {
    const was = before.get(folder);
    const now = await listing(folder);
    after.set(folder, now);
    leaked = leaked.concat(now.filter((name) => !was.includes(name)).map((name) => join(folder, name)));
  }
  check(
    "and nothing is new in the person's own folders",
    leaked.length === 0,
    leaked.length === 0 ? WATCHED.join(' | ') : leaked.join(', '),
  );

  /* ── still the program's own ─────────────────────────────────────── */

  await openFromOutside(page, [parent]);
  const control = await refusal('write_file', {
    path: join(parent, 'beside.txt'),
    contents: Array.from(Buffer.from('a file beside the profile')),
  });
  check('a folder opened from above lets a file beside the profile be written', control === null, control ?? '');

  const planted = join(logs, 'crash-planted.txt');
  const planting = await refusal('write_file', {
    path: planted,
    contents: Array.from(Buffer.from('forged report')),
  });
  check('but the page cannot write into the reports', planting !== null, planting ?? 'written');
  check('and nothing is there', !(await listing(logs)).includes('crash-planted.txt'));

  const name = (await reports())[0] ?? 'no-report-was-written';
  const reading = await refusal('read_file', { path: join(logs, name) });
  check('nor read one by opening the folder above it', reading !== null, reading ?? 'read');
  const listed = await refusal('read_directory', { path: logs });
  check('nor list the folder', listed !== null, listed ?? 'listed');

  /* ── the announcement reads the same folder, and only it lets a report be read ── */

  const told = await invoke('take_crash_reports');
  check(
    "the next start's announcement lists the report from the profile",
    Array.isArray(told) && told.some((p) => resolve(p).startsWith(resolve(logs))),
    JSON.stringify(told),
  );
} catch (err) {
  check('the check ran to its end', false, err instanceof Error ? err.message : String(err));
} finally {
  await stopDesktop(session);
  await new Promise((r) => setTimeout(r, 500));

  /* Whatever this run caused in a folder that is not its own goes, found by
     the list taken before and by the marker — nothing else is touched, and a
     report of the person's own never carries it. */
  for (const folder of WATCHED) {
    const was = before.get(folder) ?? [];
    for (const name of await listing(folder)) {
      if (was.includes(name)) continue;
      try {
        if ((await readFile(join(folder, name), 'utf8')).includes(MARKER)) {
          await rm(join(folder, name), { force: true });
          console.log(`removed ${relative(LOCAL, join(folder, name))}, which this run caused there`);
        }
      } catch {
        /* a file that is not readable text is not ours */
      }
    }
  }
  await rm(parent, { recursive: true, force: true }).catch(() => {});
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
