/**
 * Making a translation catalogue, or bringing an existing one up to date.
 *
 *   node tools/i18n-template.mjs es          # start Spanish
 *   node tools/i18n-template.mjs es --update # add what is new, keep what is done
 *
 * Why a generator rather than "copy hr.ts and edit it": copying loses the
 * section comments the moment they move, silently keeps the Croatian text as a
 * plausible-looking translation, and gives no way to tell later which strings
 * have been done. Here an untranslated entry is an empty string and stands out,
 * `--update` never touches a line somebody has already written, and both the
 * ordering and the grouping come from the English source, so two catalogues can
 * be read side by side.
 *
 * The list of strings comes from the Croatian catalogue, because it is the only
 * complete inventory: format labels and fidelity notes reach `t()` through a
 * variable, so scanning for `t('…')` alone would miss about fifty of them.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const I18N = resolve(ROOT, 'packages/i18n/src');

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
 * Matched over the whole file rather than line by line: Prettier wraps a long
 * entry onto two lines, and reading line by line drops every one of those — 59
 * of the 322 in the Croatian catalogue.
 */
const ROW = new RegExp(
  [
    '^ {2}(?<divider>\\/\\* .*? \\*\\/)$',
    '|',
    '^ {2}(?:(?<q>[\'"])(?<quoted>(?:\\\\.|(?!\\k<q>).)*)\\k<q>|(?<bare>[A-Za-z_$][\\w$]*))',
    '\\s*:\\s*(?<vq>[\'"])(?<value>(?:\\\\.|(?!\\k<vq>).)*)\\k<vq>,?[ \\t]*$',
  ].join(''),
  'gm',
);

const unquote = (text) => text.replace(/\\(['"`\\])/g, '$1');

/** The dividers and keys of a catalogue, in file order, with their values. */
async function rowsOf(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const m of text.matchAll(ROW)) {
    const g = m.groups;
    if (g.divider) rows.push({ kind: 'divider', text: g.divider });
    else {
      rows.push({
        kind: 'entry',
        key: g.quoted !== undefined ? unquote(g.quoted) : g.bare,
        value: unquote(g.value),
      });
    }
  }
  return rows;
}

const layout = await rowsOf(resolve(I18N, 'hr.ts'));
const target = resolve(I18N, `${code}.ts`);

/** What has already been written, so `--update` never overwrites somebody's work. */
const done = new Map(
  (await rowsOf(target))
    .filter((r) => r.kind === 'entry' && r.value.trim())
    .map((r) => [r.key, r.value]),
);

const keys = layout.filter((r) => r.kind === 'entry').map((r) => r.key);
if (!keys.length) {
  console.error('No entries found in hr.ts — has its formatting changed?');
  process.exit(1);
}

const kept = keys.filter((k) => done.has(k)).length;
const stale = [...done.keys()].filter((k) => !keys.includes(k));

if (done.size && !update) {
  console.error(`packages/i18n/src/${code}.ts already exists.`);
  console.error('Pass --update to add the new strings and keep the finished ones.');
  process.exit(2);
}

/* ── writing it out ──────────────────────────────────────────────────── */

/* A key that is a plain identifier may go unquoted, as hr.ts does. */
const BARE = /^[A-Za-z_$][\w$]*$/;
const quote = (text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const asKey = (key) => (BARE.test(key) ? key : quote(key));

const body = layout
  .map((row) => {
    if (row.kind === 'divider') return `\n  ${row.text}`;
    return `  ${asKey(row.key)}: ${quote(done.get(row.key) ?? '')},`;
  })
  .join('\n')
  .replace(/^\n/, '');

const header = `/**
 * The ${code} interface translation.
 *
 * The key is the English source text. A string left empty here is shown in
 * English — deliberately, so that a missing translation never ends up as a
 * blank button. That is also why this catalogue is allowed to lag behind.
 *
 * Fill in the empty strings and leave the rest alone. \`{n}\`, \`{name}\` and the
 * like are placeholders: they must appear in your translation too, spelled
 * exactly as they are on the left, though they may move within the sentence.
 *
 * Check your work with \`node tools/verify-i18n.mjs\`.
 * The whole procedure is in docs/TRANSLATING.md.
 */

import type { Catalog } from './index.js';

export const ${code.replace('-', '')}: Catalog = {
`;

await writeFile(target, `${header}${body}\n};\n`, 'utf8');

const empty = keys.length - kept;
console.log(`packages/i18n/src/${code}.ts — ${keys.length} strings, ${empty} still to translate`);
if (kept) console.log(`  ${kept} existing translations kept`);
if (stale.length) {
  console.log(`  ${stale.length} no longer used, dropped: ${stale.slice(0, 5).map(quote).join(', ')}`);
}
console.log(`
Three lines in packages/i18n/src/index.ts register it:

  import { ${code.replace('-', '')} } from './${code}.js';
  export type Locale = 'en' | 'hr' | '${code}';
  export const LOCALES = [ …, { id: '${code}', label: '<English name>', native: '<own name>' } ];
  export const CATALOGS = { en: {}, hr, ${code.replace('-', '')} };
`);
