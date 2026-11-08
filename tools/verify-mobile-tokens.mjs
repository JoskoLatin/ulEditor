/**
 * The mobile interfaces' colours, checked from their JSON (ADR 0009, "Look").
 *
 * For every `packages/shell-ui/src/mobile/ui/<name>/tokens.json`:
 *
 * - **its shape**: every colour an opaque `#rrggbb` for light and dark, every
 *   role naming a colour that is there, nothing defined twice;
 * - **its contrast**, computed here from the JSON (WCAG 2.1): every declared
 *   pair in both schemes, failing below 4.5:1 for text and 3:1 for anything
 *   else;
 * - **the contract with the editors**: every colour token the editors read
 *   (`var(--…)` in `packages/<editor>/src/**.css`, among the colours the
 *   desktop defines in `shell-ui/src/styles/tokens.css`) is given a value, so
 *   no editor falls back to the desktop's colours inside the interface;
 * - **one source**: `tokens.css` is exactly what `tools/mobile-tokens.mjs`
 *   writes from the JSON, and no colour is written into the interface's own CSS
 *   or components (Kapa's rule: a colour lives in the tokens, not in a
 *   component).
 *
 *   node tools/verify-mobile-tokens.mjs
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MINIMUM, audit, interfaces, problems, render } from './mobile-tokens.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = resolve(ROOT, 'packages');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

async function files(dir, test) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path, test)));
    else if (test(entry.name)) out.push(path);
  }
  return out;
}

/* ── what the editors read ───────────────────────────────────────────── */

/* The desktop's colour tokens: a custom property whose value is a colour. */
const desktopTokens = await readFile(resolve(PACKAGES, 'shell-ui/src/styles/tokens.css'), 'utf8');
const desktopColours = new Set(
  [...desktopTokens.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))\s*;/g)].map((m) => m[1]),
);

/* Every package but the shell: the editors and the readers they share. */
const editorCss = [];
for (const entry of await readdir(PACKAGES, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === 'shell-ui') continue;
  const src = join(PACKAGES, entry.name, 'src');
  try {
    editorCss.push(...(await files(src, (name) => name.endsWith('.css'))));
  } catch {
    /* A package without `src` has no CSS to read. */
  }
}
const editorsRead = new Set();
for (const path of editorCss) {
  for (const m of (await readFile(path, 'utf8')).matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
    if (desktopColours.has(m[1])) editorsRead.add(m[1]);
  }
}
check(
  'the editors\' colour tokens were read out of their CSS',
  editorsRead.size >= 10,
  `${editorsRead.size} of the desktop's ${desktopColours.size} colours, from ${editorCss.length} files`,
);

/* ── each interface ──────────────────────────────────────────────────── */

const found = await interfaces();
check('at least one interface has a tokens.json', found.length > 0, found.map((one) => one.name).join(', '));

/* A colour written as a literal: `#abc`, `#aabbcc`, `rgb(`, `hsl(`. Not inside
   a `var(…, fallback)` either: the fallback would be the colour that shows. */
const LITERAL = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b|\b(?:rgba?|hsla?)\(/;

for (const { name, json, css, tokens } of found) {
  const where = relative(ROOT, json).replace(/\\/g, '/');
  const shape = problems(tokens);
  check(`${name}: ${where} has the right shape`, shape.length === 0, shape.join('; ') || `${Object.keys(tokens.palette).length} colours, ${Object.keys(tokens.roles).length} roles`);
  if (shape.length) continue;

  const rows = audit(tokens);
  for (const row of rows) {
    check(
      `${name} ${row.scheme}: ${row.fg} on ${row.bg} ≥ ${row.minimum}:1 (${row.kind})`,
      row.ok,
      `${row.ratio.toFixed(2)}:1 — ${row.what}`,
    );
  }
  for (const kind of Object.keys(MINIMUM)) {
    check(`${name}: some ${kind} pair is declared in each scheme`, rows.some((row) => row.kind === kind));
  }

  const given = new Set([...Object.keys(tokens.roles), ...Object.keys(tokens.values ?? {})]);
  const missing = [...editorsRead].filter((token) => !given.has(token)).sort();
  check(`${name}: every colour the editors read is given a value`, missing.length === 0, missing.join(', ') || [...editorsRead].sort().join(' '));

  let onDisk = '';
  try {
    onDisk = (await readFile(css, 'utf8')).replace(/\r\n/g, '\n');
  } catch {
    onDisk = '';
  }
  check(`${name}: tokens.css is what tools/mobile-tokens.mjs writes from the JSON`, onDisk === render(tokens), onDisk ? 'run node tools/mobile-tokens.mjs if not' : 'tokens.css is missing');

  const dir = dirname(json);
  const own = await files(dir, (file) => /\.(css|tsx?)$/.test(file) && file !== 'tokens.css');
  const literals = [];
  let imported = false;
  for (const path of own) {
    const text = await readFile(path, 'utf8');
    if (/import\s+['"]\.\/tokens\.css['"]/.test(text)) imported = true;
    text.split(/\r?\n/).forEach((line, index) => {
      if (LITERAL.test(line)) literals.push(`${relative(dir, path)}:${index + 1}`);
    });
  }
  check(`${name}: no colour is written into its own CSS or components`, literals.length === 0, literals.slice(0, 6).join(', ') || `${own.length} files`);
  check(`${name}: its tokens.css is imported`, imported);
}

const failed = checks.filter((one) => !one.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
