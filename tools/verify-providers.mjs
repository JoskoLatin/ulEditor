/**
 * The two places every format is declared, held against each other.
 *
 * An editor package declares what it can do, and the shell declares the same
 * thing a second time in `main.tsx` — deliberately, because the tab has to know
 * whether a document can be edited *before* the editor's code is fetched, and
 * fetching it to find out would undo the laziness that keeps 1.3 MB of pdf.js
 * out of the startup path. A second declaration is the price of that, and a
 * second declaration goes out of step.
 *
 * It already had. `.odt` became editable in the reader and stayed read-only in
 * the shell's copy, so the editor offered the text, the person retyped it,
 * pressed `Ctrl+S` — and the program said the file was open read-only. Nothing
 * threw, nothing was logged, and the only place the disagreement was visible was
 * a warning at the moment somebody expected their work to be saved.
 *
 * So the two are compared here, by field, for every provider: what it is called,
 * what it opens, what it can do, and which one wins when both match a file.
 *
 *   node tools/verify-providers.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── reading an object literal out of the source ─────────────────────── */

/**
 * The text of the object literal that starts at `from`, brace-matched.
 *
 * Quotes and comments are respected, because a brace inside either is not a
 * brace — a `displayName: 'Word {97}'` would otherwise end the object early.
 */
function literalAt(source, from) {
  let depth = 0;
  let quote = '';
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (source.startsWith('//', i)) {
      i = source.indexOf('\n', i);
      if (i === -1) return null;
      continue;
    }
    if (source.startsWith('/*', i)) {
      i = source.indexOf('*/', i);
      if (i === -1) return null;
      i += 1;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  return null;
}

/** The members of an array literal, as they are written: `'md'` → `md`, a spread kept whole. */
function listOf(block, field) {
  const match = new RegExp(`${field}:\\s*\\[([^\\]]*)\\]`).exec(block);
  if (!match) return null;
  return match[1]
    .split(',')
    .map((item) => item.trim().replace(/^['"`]|['"`]$/g, ''))
    .filter((item) => item !== '')
    .sort();
}

function stringOf(block, field) {
  const match = new RegExp(`${field}:\\s*['"\`]([^'"\`]*)['"\`]`).exec(block);
  return match ? match[1] : null;
}

function numberOf(block, field) {
  const match = new RegExp(`${field}:\\s*(-?\\d+)`).exec(block);
  return match ? Number(match[1]) : null;
}

function fieldsOf(block, where) {
  return {
    where,
    id: stringOf(block, 'id'),
    displayName: stringOf(block, 'displayName'),
    capabilities: listOf(block, 'capabilities'),
    priority: numberOf(block, 'priority'),
    extensions: listOf(block, 'extensions'),
    mimeTypes: listOf(block, 'mimeTypes'),
  };
}

/* ── the two sides ───────────────────────────────────────────────────── */

/** What the shell registers before any editor code is fetched. */
function declaredInShell() {
  const path = 'packages/shell-ui/src/main.tsx';
  const source = readFileSync(join(ROOT, path), 'utf8');
  const found = [];

  for (let at = source.indexOf('lazyProvider('); at !== -1; at = source.indexOf('lazyProvider(', at + 1)) {
    const brace = source.indexOf('{', at);
    const block = brace === -1 ? null : literalAt(source, brace);
    if (block) found.push(fieldsOf(block, path));
  }
  return found;
}

/** What each editor package declares about itself. */
function declaredInEditors() {
  const found = [];

  for (const pkg of readdirSync(join(ROOT, 'packages')).filter((name) => name.startsWith('editor-'))) {
    const dir = join(ROOT, 'packages', pkg, 'src');
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const path = `packages/${pkg}/src/${file}`;
      const source = readFileSync(join(dir, file), 'utf8');
      const marker = /:\s*EditorProvider\s*=\s*\{/g;

      for (let match = marker.exec(source); match; match = marker.exec(source)) {
        const block = literalAt(source, source.indexOf('{', match.index));
        if (block) found.push(fieldsOf(block, path));
      }
    }
  }
  return found;
}

const shell = declaredInShell();
const editors = declaredInEditors();

check('the shell registers providers', shell.length > 0, `${shell.length}`);
check('the editors declare providers', editors.length > 0, `${editors.length}`);

/* Neither side may hold a format the other has never heard of: an editor nobody
   registers is dead code, and a registration with no editor behind it is a tab
   that fails at the moment it is opened. */
const shellIds = new Set(shell.map((p) => p.id));
const editorIds = new Set(editors.map((p) => p.id));

const unregistered = [...editorIds].filter((id) => !shellIds.has(id));
check('every editor is registered by the shell', unregistered.length === 0, unregistered.join(', ') || 'none missing');

const unbacked = [...shellIds].filter((id) => !editorIds.has(id));
check('every registration has an editor behind it', unbacked.length === 0, unbacked.join(', ') || 'none missing');

/* ── field by field ──────────────────────────────────────────────────── */

const FIELDS = ['displayName', 'capabilities', 'priority', 'extensions', 'mimeTypes'];

for (const id of [...shellIds].filter((candidate) => editorIds.has(candidate)).sort()) {
  const here = shell.find((p) => p.id === id);
  const there = editors.find((p) => p.id === id);

  const drifted = FIELDS.filter(
    (field) => JSON.stringify(here[field]) !== JSON.stringify(there[field]),
  );

  check(
    `${id} says the same thing in both places`,
    drifted.length === 0,
    drifted
      .map((field) => `${field}: shell ${JSON.stringify(here[field])} ≠ editor ${JSON.stringify(there[field])}`)
      .join(' · ') || `${FIELDS.length} fields agree`,
  );
}

/* A repeated extension is harmless and reads as a second format the editor
   opens, which it is not. */
for (const provider of [...shell, ...editors]) {
  for (const field of ['extensions', 'mimeTypes']) {
    const list = provider[field];
    if (!list) continue;
    const twice = list.filter((item, i) => list.indexOf(item) !== i);
    if (twice.length > 0) {
      check(`${provider.id} lists no ${field} twice`, false, `${twice.join(', ')} in ${provider.where}`);
    }
  }
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
