/**
 * The update the world can actually reach.
 *
 * [verify-updates.mjs](verify-updates.mjs) compares the pieces of the updater
 * against each other and needs no network to do it, which is both its strength
 * and the one thing it cannot see: every piece can be right and no installed
 * copy ever be offered anything. The endpoint is a static file on a release
 * page, and a release page has a state of its own that nothing in this
 * repository can read.
 *
 * A release left as a **draft** is invisible to everybody who is not signed in
 * as its author. `/releases/latest/` walks past it to the newest published one,
 * the manifest answers 404, and the program concludes there is nothing to say —
 * which is exactly what it is written to conclude. The designed silence meets an
 * undesigned cause, and produces the symptom this project keeps building
 * instruments to avoid: nothing at all, for three releases in a row, on every
 * machine the program is installed on.
 *
 * So this asks from outside, the way a stranger's copy asks: **unauthenticated**,
 * at the URL compiled into the build, and it requires the answer to be a
 * manifest offering the newest tag the remote has.
 *
 * Unauthenticated is the whole point. `gh` carries a token, sees a draft, and
 * would report a healthy endpoint while everyone else got a 404 — the instrument
 * agreeing with the author instead of with the user. That is the failure
 * `readback` was built to stop in the writers, and this stops the same one here.
 *
 * **The newest tag, not the version in `tauri.conf.json`**, because those two are
 * allowed to differ: a version bumped for the next release is ahead of every
 * release that exists, and failing on that would be reporting work in progress
 * as a fault. A tag is a release that was built; a tag whose manifest is not
 * being served is a release nobody can have.
 *
 * It needs the network, so it is asked for by name rather than run with the
 * rest:
 *
 *   pnpm verify:release-live
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Every platform the manifest writer knows how to serve; see `updater-manifest.mjs`. */
const PLATFORMS = ['windows-x86_64', 'darwin-aarch64', 'darwin-x86_64', 'linux-x86_64'];

const conf = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json'));
const endpoints = conf.plugins?.updater?.endpoints ?? [];

/* ── the release that exists ─────────────────────────────────────────── */

/**
 * The newest tag on the remote the release lives on.
 *
 * `git ls-remote` rather than `git tag`, because a tag that was never pushed
 * built nothing: the question is which release exists, not which one was
 * prepared here.
 */
function newestTag() {
  const out = execFileSync('git', ['ls-remote', '--tags', '--refs', 'origin'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const versions = out
    .split('\n')
    .map((line) => /refs\/tags\/v(\d+\.\d+\.\d+)$/.exec(line.trim()))
    .filter((found) => found !== null)
    .map((found) => found[1].split('.').map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const newest = versions[versions.length - 1];
  return newest ? newest.join('.') : null;
}

let released = null;
try {
  released = newestTag();
  check('the remote has a release to serve', released !== null, released ? `v${released}` : 'no version tag on origin');
} catch (error) {
  check('the remote can be asked which releases exist', false, String(error.message).split('\n')[0]);
}

/* ── the endpoint, asked the way the program asks ────────────────────── */

check('the build names an endpoint to ask', endpoints.length > 0, endpoints.join(' '));

/** A GET with no credentials at all — the request an installed copy makes. */
async function fetchText(url) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'uleditor-verify' } });
  return { status: response.status, body: response.ok ? await response.text() : '' };
}

/** Whether an artefact's bytes are there, without pulling twenty megabytes to find out. */
async function reachable(url) {
  const shapes = [{ method: 'HEAD' }, { method: 'GET', headers: { range: 'bytes=0-0' } }];
  for (const init of shapes) {
    try {
      const response = await fetch(url, { ...init, redirect: 'follow' });
      if (response.ok || response.status === 206) return response.status;
    } catch {
      /* the next shape of the question, or the failure reported below */
    }
  }
  return null;
}

let manifest = null;

for (const endpoint of endpoints) {
  let answer = { status: 0, body: '' };
  try {
    answer = await fetchText(endpoint);
  } catch (error) {
    answer = { status: 0, body: String(error.message) };
  }

  check(
    'the endpoint answers a signed-out request',
    answer.status === 200,
    answer.status === 404
      ? '404 — nothing is served there, which is what a release still in draft answers'
      : `HTTP ${answer.status || 'no answer at all'}`,
  );

  if (answer.status !== 200) continue;

  try {
    manifest = JSON.parse(answer.body);
    check('what comes back is a manifest', true, `version ${manifest.version}`);
  } catch (error) {
    manifest = null;
    check('what comes back is a manifest', false, String(error.message).split('\n')[0]);
  }
}

/* ── and it offers the release that exists ───────────────────────────── */

check(
  'the manifest offers the newest release the remote has',
  manifest !== null && released !== null && manifest.version === released,
  manifest === null ? 'no manifest to ask' : `serving ${manifest.version}, newest tag v${released ?? '?'}`,
);

const platforms = manifest?.platforms ?? {};
const absent = PLATFORMS.filter((key) => !platforms[key]);
check(
  'every platform the manifest writer can serve is in it',
  manifest !== null && absent.length === 0,
  manifest === null
    ? 'no manifest to ask'
    : absent.length > 0
      ? `missing: ${absent.join(', ')}`
      : PLATFORMS.join(', '),
);

for (const [key, platform] of Object.entries(platforms)) {
  let decoded = '';
  try {
    decoded = Buffer.from(platform.signature ?? '', 'base64').toString('utf8');
  } catch {
    decoded = '';
  }
  /* A draft release answers a browser URL with a login page, and a login page is
     a perfectly good string: it would sit in the manifest looking like a
     signature, and every application would refuse the update it described. */
  check(
    `${key}: the signature is a signature`,
    decoded.includes('signature from'),
    decoded.split('\n')[0] || '(nothing that decodes)',
  );

  const status = await reachable(platform.url ?? '');
  check(
    `${key}: the artefact it names is there`,
    status !== null,
    status !== null ? `HTTP ${status}` : `unreachable — ${platform.url ?? '(no url)'}`,
  );
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);

if (failed.length > 0) {
  const tag = released ? `v${released}` : 'vX.Y.Z';
  console.log(
    [
      '',
      'A release that was built and then left as a draft is the usual cause: every',
      'artefact is on the page and /releases/latest/ can see none of them, because',
      'it walks past a draft to the newest published release.',
      '',
      `  gh release edit ${tag} --draft=false`,
    ].join('\n'),
  );
}

process.exit(failed.length === 0 ? 0 : 1);
