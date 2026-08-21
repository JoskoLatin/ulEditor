/**
 * Making a translation catalogue, or bringing an existing one up to date.
 *
 *   node tools/i18n-template.mjs es          # start Spanish
 *   node tools/i18n-template.mjs es --update # add what is new, keep what is done
 *
 * A catalogue is `packages/i18n/locales/<code>.json`: English on the left, your
 * language on the right, nothing else in the file. That is the shape Weblate,
 * Crowdin, Lokalise and Poedit read, and it is editable by someone who has
 * never opened a TypeScript file.
 *
 * Why a generator rather than "copy hr.json and edit it": copying keeps the
 * Croatian text as a plausible-looking translation, gives no way to tell later
 * which strings are done, and drifts the moment a string is added. Here an
 * untranslated entry is an empty string and stands out, `--update` never
 * touches a line somebody has already written, and the order and grouping come
 * from the English source, so two catalogues read side by side.
 *
 * The inventory comes from the Croatian catalogue, because it is the only
 * complete one: format labels and fidelity notes reach `t()` through a
 * variable, so scanning the source for `t('…')` alone would miss about fifty.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = resolve(ROOT, 'packages/i18n/locales');
const REFERENCE = resolve(LOCALES, 'hr.json');

const args = process.argv.slice(2);
const code = args.find((a) => !a.startsWith('-'));
const update = args.includes('--update');

if (!code || !/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(code)) {
  console.error('Usage: node tools/i18n-template.mjs <code> [--update]');
  console.error('       <code> is a language tag: es, de, pt-BR');
  process.exit(2);
}
if (code === 'en') {
  console.error('English needs no catalogue: the key is the English source text.');
  process.exit(2);
}

/* ── the inventory, in the order and grouping of the source ──────────── */

/*
 * The reference is read as text, not with JSON.parse: the blank lines between
 * groups are what carries the grouping now that there are no comments, and
 * parsing would throw them away.
 */
const reference = await readFile(REFERENCE, 'utf8');
const ENTRY = /^ {2}("(?:\\.|[^"])*")\s*:\s*("(?:\\.|[^"])*")/;

const rows = [];
for (const line of reference.split('\n')) {
  if (!line.trim()) {
    rows.push({ kind: 'gap' });
    continue;
  }
  const m = ENTRY.exec(line);
  if (m) rows.push({ kind: 'entry', key: JSON.parse(m[1]) });
}

const keys = rows.filter((r) => r.kind === 'entry').map((r) => r.key);
if (!keys.length) {
  console.error(`No entries found in ${REFERENCE} — has its formatting changed?`);
  process.exit(1);
}

/* ── what is already translated ──────────────────────────────────────── */

const target = resolve(LOCALES, `${code}.json`);
let done = new Map();
try {
  const existing = JSON.parse(await readFile(target, 'utf8'));
  done = new Map(Object.entries(existing).filter(([, v]) => String(v).trim()));
} catch (err) {
  if (err.code !== 'ENOENT') {
    console.error(`${target} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}

if (done.size && !update) {
  console.error(`packages/i18n/locales/${code}.json already exists.`);
  console.error('Pass --update to add the new strings and keep the finished ones.');
  process.exit(2);
}

const kept = keys.filter((k) => done.has(k)).length;
const stale = [...done.keys()].filter((k) => !keys.includes(k));

/* ── writing it out ──────────────────────────────────────────────────── */

/*
 * Written line by line rather than with JSON.stringify, to keep the blank line
 * between groups. It is legal JSON whitespace and every tool ignores it, but a
 * translator reading 322 strings gets to see where the toolbar ends and the PDF
 * begins.
 */
const lines = ['{'];
let written = 0;
for (const row of rows) {
  if (row.kind === 'gap') {
    if (written) lines.push('');
    continue;
  }
  if (written) lines[lines.length - 1] += ',';
  lines.push(`  ${JSON.stringify(row.key)}: ${JSON.stringify(done.get(row.key) ?? '')}`);
  written++;
}
lines.push('}');

const text = lines.join('\n') + '\n';
JSON.parse(text); // never write a file that will not parse
await writeFile(target, text, 'utf8');

const empty = keys.length - kept;
console.log(
  `packages/i18n/locales/${code}.json — ${keys.length} strings, ${empty} still to translate`,
);
if (kept) console.log(`  ${kept} existing translations kept`);
if (stale.length) {
  console.log(
    `  ${stale.length} no longer used, dropped: ${stale.slice(0, 5).map((s) => JSON.stringify(s)).join(', ')}`,
  );
}

const ident = code.replace('-', '');
console.log(`
Three lines in packages/i18n/src/index.ts register it:

  import ${ident} from '../locales/${code}.json' with { type: 'json' };
  export type Locale = 'en' | 'hr' | '${code}';
  export const LOCALES = [ …, { id: '${code}', label: '<English name>', native: '<own name>' } ];
  export const CATALOGS = { en: {}, hr, ${ident} };

Then check it:  node tools/verify-i18n.mjs
`);
