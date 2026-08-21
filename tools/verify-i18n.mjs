/**
 * Checking that every translation catalogue keeps up with the source.
 *
 * The design of `@uleditor/i18n` makes a missing translation invisible: the key
 * IS the English source text, so an untranslated string renders as English and
 * nothing fails. That is right for the user — a missing translation must never
 * come out as a blank button — but it means nothing tells us a catalogue has
 * fallen behind. This check is that something.
 *
 * The interesting part is not the count of missing keys but the placeholders. A
 * translation that renames `{n}` to `{broj}` still looks like a translation, and
 * `t()` will print the brace form literally: the reader sees "p. {n}/18". No
 * type catches it, because both sides are strings.
 *
 * Missing keys are reported, never failed — a translation is allowed to lag
 * behind, and a contributor who has done half a language should not be met with
 * a red build. Placeholder drift and a malformed catalogue do fail: those are
 * bugs, not incompleteness.
 *
 *   node tools/verify-i18n.mjs
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const I18N = resolve(ROOT, 'packages/i18n/src');
const CATALOGUES = resolve(ROOT, 'packages/i18n/locales');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── the catalogues parse at all ─────────────────────────────────────── */

/*
 * Checked before anything is imported. A missing comma is the likeliest mistake
 * for someone editing a catalogue by hand, and importing it first would abort
 * the whole run with a Node stack trace pointing at the module loader — no line
 * number, no file, nothing a translator can act on.
 */
for (const name of (await readdir(CATALOGUES)).filter((f) => f.endsWith('.json')).sort()) {
  const file = resolve(CATALOGUES, name);
  const raw = await readFile(file, 'utf8');
  try {
    JSON.parse(raw);
    check(`locales/${name} is valid JSON`, true);
  } catch (err) {
    const at = /position (\d+)/.exec(err.message);
    const where = at
      ? (() => {
          const upto = raw.slice(0, Number(at[1]));
          const line = upto.split('\n').length;
          return `line ${line}: ${raw.split('\n')[line - 1]?.trim().slice(0, 60)}`;
        })()
      : err.message;
    check(`locales/${name} is valid JSON`, false, where);
    console.log(`\n${checks.length - 1}/${checks.length} checks passed`);
    process.exit(1);
  }
}

/* The catalogues are imported rather than parsed: what ships is what is checked. */
const { CATALOGS, LOCALES, t, setLocale } = await import(
  pathToFileURL(resolve(I18N, 'index.ts')).href
);

/* ── collecting the t() calls ────────────────────────────────────────── */

/*
 * `\bt\(` and not `t\(`: without the boundary this also matches the tail of
 * `format(`, `useEffect(` and every other identifier ending in t.
 */
const CALL = /\bt\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gs;
const PLACEHOLDER = /\{(\w+)\}/g;
const SKIP = new Set(['node_modules', 'dist', 'gen', 'public', '.vite']);

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(path)));
    else if (/\.tsx?$/.test(entry.name) && dirname(path) !== I18N) out.push(path);
  }
  return out;
}

const files = [
  ...(await sources(resolve(ROOT, 'packages'))),
  ...(await sources(resolve(ROOT, 'apps'))),
];

/** Every literal key passed to `t()`, and where it was first found. */
const used = new Map();
let dynamic = 0;

for (const path of files) {
  const text = await readFile(path, 'utf8');
  for (const [, , raw] of text.matchAll(CALL)) {
    /* `t(`Page ${n}`)` is not a key — the value is only known at run time. */
    if (raw.includes('${')) {
      dynamic++;
      continue;
    }
    const key = raw.replace(/\\(['"`\\])/g, '$1');
    if (!used.has(key)) used.set(key, relative(ROOT, path).replace(/\\/g, '/'));
  }
}

check('the source was scanned', used.size > 0, `${used.size} keys in ${files.length} files`);

const placeholdersOf = (text) => new Set([...String(text).matchAll(PLACEHOLDER)].map((m) => m[1]));

/**
 * A key written twice is not a JSON error either: `JSON.parse` keeps the last
 * one and the earlier translation disappears without a word. So the file is
 * scanned as text, not through the parser that would hide the problem.
 */
async function duplicatesIn(file) {
  const raw = await readFile(file, 'utf8');
  const seen = new Map();
  const found = [];
  for (const m of raw.matchAll(/^ {2}("(?:\\.|[^"])*")\s*:/gm)) {
    const key = JSON.parse(m[1]);
    const line = raw.slice(0, m.index).split('\n').length;
    if (seen.has(key)) found.push(`${JSON.stringify(key)} (lines ${seen.get(key)} and ${line})`);
    else seen.set(key, line);
  }
  return found;
}

/* ── each catalogue in turn ──────────────────────────────────────────── */

const translated = LOCALES.filter((l) => Object.keys(CATALOGS[l.id] ?? {}).length > 0);
check(
  'the registered languages have catalogues',
  translated.length === LOCALES.length - 1,
  `${LOCALES.map((l) => l.native).join(', ')} — en is empty by design`,
);

const summary = [];

for (const locale of translated) {
  const catalogue = CATALOGS[locale.id];
  const file = resolve(CATALOGUES, `${locale.id}.json`);
  const name = `${locale.native} (${locale.id})`;

  /*
   * An empty value counts as untranslated, exactly like an absent key — the
   * state a fresh catalogue from `tools/i18n-template.mjs` is in, and the same
   * reading `t()` takes at run time.
   */
  const filled = (key) => Boolean(String(catalogue[key] ?? '').trim());

  /*
   * Incompleteness is reported, not failed. Half a language in the tree beats
   * none, and a contributor who has done a third of it should not be met with a
   * red build.
   */
  const missing = [...used.keys()].filter((key) => !filled(key)).sort();
  const done = Math.round(((used.size - missing.length) / used.size) * 100);
  /* Translated, but with no literal call site — reached through `t(note)`. */
  const indirect = Object.keys(catalogue).filter((key) => filled(key) && !used.has(key)).length;
  summary.push({ name, done, missing: missing.length, indirect });

  if (missing.length) {
    console.log(`\n  ${name} is missing ${missing.length} of ${used.size}:`);
    for (const key of missing.slice(0, 15)) {
      console.log(`      ${JSON.stringify(key).slice(0, 72)}   ${used.get(key)}`);
    }
    if (missing.length > 15) console.log(`      … and ${missing.length - 15} more`);
    console.log();
  }

  /*
   * This is the failure the English fallback cannot save us from. A missing
   * translation still reads correctly; one that loses `{n}` prints the braces
   * at the user, and one that invents a placeholder the caller never passes
   * does the same.
   */
  const drifted = [];
  for (const [key, value] of Object.entries(catalogue)) {
    if (!String(value).trim()) continue; // untranslated, not drifted
    const source = placeholdersOf(key);
    const target = placeholdersOf(value);
    const lost = [...source].filter((p) => !target.has(p));
    const invented = [...target].filter((p) => !source.has(p));
    if (lost.length || invented.length) {
      drifted.push(
        `${JSON.stringify(key)} → ${JSON.stringify(value)}` +
          `${lost.length ? `  lost {${lost.join('} {')}}` : ''}` +
          `${invented.length ? `  invented {${invented.join('} {')}}` : ''}`,
      );
    }
  }
  check(
    `${name}: the placeholders match on both sides`,
    drifted.length === 0,
    drifted.join('\n           ') || `${Object.keys(catalogue).length} entries`,
  );

  const duplicates = await duplicatesIn(file);
  check(
    `${name}: no key appears twice`,
    duplicates.length === 0,
    duplicates.join(', ') || 'none',
  );

  /*
   * A key nobody asks for. Not fatal — format labels and fidelity notes reach
   * `t()` through a variable, so most entries have no literal call site — but a
   * key that is in no catalogue *and* in no source file is worth knowing about.
   */
  setLocale(locale.id);
  const sample = [...used.keys()].find(filled);
  check(
    `${name}: the catalogue is actually applied`,
    sample !== undefined && t(sample) === catalogue[sample],
    sample ? `${JSON.stringify(sample)} → ${JSON.stringify(t(sample))}` : 'nothing translated yet',
  );

  /* An untranslated entry has to reach the user as English, never as a blank. */
  const blank = missing.find((key) => key in catalogue);
  check(
    `${name}: an unfinished entry falls back to English`,
    blank === undefined || t(blank) === blank,
    blank ? `${JSON.stringify(blank)} → ${JSON.stringify(t(blank))}` : 'nothing left blank',
  );
}

/* ── the source language ─────────────────────────────────────────────── */

/*
 * English stays empty on purpose — it is the source text, so there is nothing
 * to fall out of step with. Filling it in would create a second place where the
 * English wording lives, and the two would drift.
 */
setLocale('en');
check(
  'English falls through to the source text',
  Object.keys(CATALOGS.en).length === 0 && t('Open folder') === 'Open folder',
);
check(
  'every listed language is selectable',
  LOCALES.length > 1 && LOCALES.every((l) => l.id && l.label && l.native && l.id in CATALOGS),
  LOCALES.map((l) => `${l.id}/${l.native}`).join(', '),
);

/* ── outcome ─────────────────────────────────────────────────────────── */

/*
 * Reported, never failed. Format labels and fidelity notes reach `t()` through
 * a variable — `t(note)`, `t(label)` — so a key with no literal call site is
 * the normal case, not a dead entry.
 */
console.log(`\n  ${used.size} literal keys · ${dynamic} interpolated calls`);
for (const row of summary) {
  console.log(
    `  ${row.name.padEnd(18)} ${String(row.done).padStart(3)} % of the interface · ` +
      `${row.missing} left · ${row.indirect} more reached through a variable`,
  );
}
console.log('\n  A new language: node tools/i18n-template.mjs <code> — see docs/TRANSLATING.md');

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
