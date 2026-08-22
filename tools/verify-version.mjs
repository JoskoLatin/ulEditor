/**
 * One version number, in four files that all have to say it.
 *
 * `tauri.conf.json` is the source: the installers, the APK's `versionCode` and
 * the number beside the name in the window all read it. But npm needs a version
 * in each package manifest and cargo needs one in the workspace, so the number
 * is mirrored — and a mirror drifts. It already did once, with the root manifest
 * a release behind while everything else moved on.
 *
 * The damage is quiet and late: an installer named `0.2.0` that reports `0.1.0`
 * in the About box, a bug report about a build nobody can identify, an updater
 * comparing the wrong pair of numbers. Nothing fails at the time.
 *
 *   node tools/verify-version.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

async function read(path) {
  return readFile(resolve(ROOT, path), 'utf8');
}

const source = JSON.parse(await read('apps/desktop/src-tauri/tauri.conf.json')).version;
check('tauri.conf.json states a version', /^\d+\.\d+\.\d+/.test(source ?? ''), source ?? 'missing');

/**
 * The workspace version in Cargo.toml, read with a regex rather than a TOML
 * parser: one field, no dependency, and the shape is fixed by cargo itself.
 */
function cargoVersion(text) {
  const workspace = text.split(/^\[workspace\.package\]/m)[1];
  return /^\s*version\s*=\s*"([^"]+)"/m.exec(workspace ?? '')?.[1] ?? null;
}

const mirrors = [
  ['package.json', JSON.parse(await read('package.json')).version],
  ['apps/desktop/package.json', JSON.parse(await read('apps/desktop/package.json')).version],
  ['Cargo.toml', cargoVersion(await read('Cargo.toml'))],
];

for (const [file, version] of mirrors) {
  check(`${file} agrees`, version === source, `${version ?? 'missing'} — tauri.conf.json says ${source}`);
}

const failed = checks.filter((c) => !c.passed);
if (failed.length) {
  console.log(`\n  Set every one of them to ${source}, or change ${source} first if the`);
  console.log('  release is meant to be a different version.');
}
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
