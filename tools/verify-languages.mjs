/**
 * Every language the detector can name has to be one the editor can colour.
 *
 * These are two lists in two packages, and nothing connected them. `detect`
 * would report `shell` for a `.sh` file, the code editor would look for a loader
 * called `shell`, find none, and mount with no highlighting — no error, no
 * warning, just grey text. Seven languages were in that state at once: shell,
 * YAML, TOML, Go, Ruby, Swift and Lua.
 *
 * That is the failure this catches. The other direction is fine and deliberate:
 * a loader with nothing pointing at it is a language waiting for its extensions,
 * not a fault — it is reported, never failed.
 *
 *   node tools/verify-languages.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/*
 * The loaders are read as text rather than imported. Importing them would pull
 * in CodeMirror, which expects a DOM at module scope — and what is being checked
 * is the set of keys, which the source states plainly.
 */
const source = await readFile(resolve(ROOT, 'packages/editor-code/src/languages.ts'), 'utf8');
const block = source.slice(source.indexOf('const LOADERS'), source.indexOf('export const LANGUAGE_IDS'));
const loaders = new Set([...block.matchAll(/^\s{2}([A-Za-z][\w]*)\s*:/gm)].map((m) => m[1]));
check('the loader list was read', loaders.size > 10, `${loaders.size} languages`);

/* The detector is imported: it is plain data with no DOM behind it. */
const detect = await import(
  pathToFileURL(resolve(ROOT, 'packages/shell-ui/src/host/detect.ts')).href
);

/*
 * `CODE_LANGUAGES` and `KNOWN_NAMES` are private to the module, so the languages
 * are collected the way the program produces them: by asking the detector about
 * a file name. The extensions come from the source of the table itself, so a new
 * one is covered the moment it is added.
 */
const detectSource = await readFile(resolve(ROOT, 'packages/shell-ui/src/host/detect.ts'), 'utf8');
const table = detectSource.slice(
  detectSource.indexOf('const CODE_LANGUAGES'),
  detectSource.indexOf('const PLAIN_TEXT'),
);
const extensions = [...table.matchAll(/^\s{2}([A-Za-z][\w]*)\s*:\s*'([^']+)'/gm)].map((m) => m[1]);
check('the extension table was read', extensions.length > 20, `${extensions.length} extensions`);

const named = new Map();
for (const extension of extensions) {
  const language = detect.detectByName(`file.${extension}`).language;
  if (language) named.set(language, `.${extension}`);
}
for (const name of ['dockerfile', 'makefile', 'readme']) {
  const language = detect.detectByName(name).language;
  if (language) named.set(language, name);
}

const missing = [...named].filter(([language]) => !loaders.has(language));
check(
  'every language the detector names can be coloured',
  missing.length === 0,
  missing.length
    ? missing.map(([language, example]) => `${language} (${example})`).join(', ')
    : `${named.size} languages, all covered`,
);

/* Reported, not failed: a loader nobody points at yet is a language waiting for
   its extensions. */
const unused = [...loaders].filter((language) => !named.has(language));
if (unused.length) console.log(`\n  ${unused.length} loaded but not detected yet: ${unused.join(', ')}`);

console.log(`\n  ${named.size} languages reachable from a file name`);

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
