/**
 * Every npm package the application ships carries a licence this project can
 * ship it under.
 *
 * `cargo deny` has held the Rust side to a list since phase 0; the npm side —
 * which is most of what runs on the screen — was held to nothing, and the plan
 * named a checker that was never added. This needs no new dependency: pnpm
 * reports the licences itself, and the list is the one in `deny.toml`, so the
 * two sides of the project answer to the same rule.
 *
 * A licence written as an expression is read as one: `A OR B` needs either,
 * `A AND B` both. A package with no licence field is read from its licence
 * file, and only a file that is plainly MIT counts — anything else fails and
 * has to be looked at by a person.
 *
 * Production dependencies only: what is in the build, not what builds it.
 *
 *   node tools/verify-npm-licenses.mjs
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The `allow` list of `deny.toml`, and the permissive ones only npm uses. */
const ALLOWED = new Set([
  'Apache-2.0',
  'Apache-2.0 WITH LLVM-exception',
  'MIT',
  'MIT-0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'Zlib',
  'MPL-2.0',
  'CDLA-Permissive-2.0',
  'Unicode-3.0',
  'CC0-1.0',
  'Unlicense',
  'BSL-1.0',
  'OpenSSL',
  // npm only, both permissive: `argparse` (the PSF licence) and `tslib`.
  'Python-2.0',
  '0BSD',
]);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Whether an SPDX expression is satisfied by the allowed list. */
function allowed(expression) {
  const text = expression.trim().replace(/^\((.*)\)$/, '$1').trim();
  if (/\bOR\b/.test(text)) return text.split(/\bOR\b/).some((part) => allowed(part));
  if (/\bAND\b/.test(text)) return text.split(/\bAND\b/).every((part) => allowed(part));
  return ALLOWED.has(text);
}

/** A package without a licence field, read from its licence file. */
function fromFile(paths) {
  for (const dir of paths ?? []) {
    let names = [];
    try {
      names = readdirSync(dir).filter((name) => /^licen[cs]e/i.test(name));
    } catch {
      continue;
    }
    for (const name of names) {
      const text = readFileSync(join(dir, name), 'utf8');
      if (/^\s*(The )?MIT License/i.test(text) && /Permission is hereby granted, free of charge/.test(text)) {
        return 'MIT';
      }
    }
  }
  return null;
}

const listed = spawnSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
  maxBuffer: 64 * 1024 * 1024,
});
let report = {};
try {
  report = JSON.parse(listed.stdout);
} catch {
  check('pnpm reported the licences', false, (listed.stderr || listed.stdout).slice(0, 200));
}

let packages = 0;
const refused = [];
for (const [licence, entries] of Object.entries(report)) {
  for (const entry of entries) {
    packages += 1;
    const read = licence === 'Unknown' ? fromFile(entry.paths) : licence;
    if (!read || !allowed(read)) refused.push(`${entry.name} (${licence})`);
  }
}

check('pnpm reported the licences of the production dependencies', packages > 0, `${packages} packages`);
check('every one of them may be shipped under this project', refused.length === 0, refused.join(', '));
check('an expression is read as one', allowed('(MPL-2.0 OR Apache-2.0)') && allowed('(MIT AND Zlib)') && !allowed('(MIT AND GPL-3.0)'));
check('a copyleft licence is refused', !allowed('GPL-3.0') && !allowed('AGPL-3.0-only') && !allowed('LGPL-2.1'));

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
