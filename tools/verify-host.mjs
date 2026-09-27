/**
 * `host/` is the one place in the shell that knows which platform it is on.
 *
 * That sentence heads [host/index.ts](../packages/shell-ui/src/host/index.ts)
 * and had stopped being true: eleven files outside `host/` reached for
 * `@tauri-apps/*` on their own, and one of them — the crash reporter — did it
 * with a static import, so the web build carried the Tauri API into every tab
 * that would never use it. Phase 3 (ADR 0002) writes a second host, and a
 * second host is only possible where the first one is the whole of the seam.
 *
 * So three things are held here:
 *
 *   1. `@tauri-apps/` is named only under `src/host/` — everything else goes
 *      through `host/native.ts`;
 *   2. nothing in the shell imports it statically, `host/` included, because
 *      a static import is a byte of Tauri in the browser;
 *   3. and in the built bundle, what the page loads before any code decides to
 *      load more holds none of the Tauri API — the chunks reached from
 *      `index.html` by static imports, followed to the end.
 *
 * The third needs a build; without one this says so and fails rather than
 * passing on the two it could check.
 *
 *   pnpm --filter @uleditor/shell-ui build
 *   node tools/verify-host.mjs
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'packages/shell-ui/src');
const DIST = join(ROOT, 'packages/shell-ui/dist');

/** In `@tauri-apps/api/core` and nowhere else — and every other Tauri module imports that one. */
const TAURI_MARKER = '__TAURI_TO_IPC_KEY__';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const files = sources(SRC).map((path) => ({
  path,
  name: relative(SRC, path).split(sep).join('/'),
  text: readFileSync(path, 'utf8'),
}));

/* ── 1. named only under host/ ───────────────────────────────────────── */

const outside = files.filter((f) => !f.name.startsWith('host/') && f.text.includes('@tauri-apps/'));
check(
  '@tauri-apps/ is named only under src/host/',
  outside.length === 0,
  outside.length ? outside.map((f) => f.name).join(', ') : `${files.length} files read`,
);

/* ── 2. never imported statically ────────────────────────────────────── */

/* `import type` is erased by the compiler and costs the bundle nothing. */
const STATIC = /^\s*(?:import(?!\s+type\b)[\s\S]*?from\s*|import\s*|export[\s\S]*?from\s*)['"]@tauri-apps\//m;
const staticImports = files.filter((f) => STATIC.test(f.text));
check(
  'nothing imports @tauri-apps/ statically',
  staticImports.length === 0,
  staticImports.length ? staticImports.map((f) => f.name).join(', ') : 'every import of it is a dynamic one',
);

/* ── 3. the bundle the page loads first ──────────────────────────────── */

const html = join(DIST, 'index.html');
if (!existsSync(html)) {
  check('a built web bundle to read', false, 'none — run `pnpm --filter @uleditor/shell-ui build` first');
} else {
  const entries = [...readFileSync(html, 'utf8').matchAll(/<script[^>]*type="module"[^>]*src="\.?\/?([^"]+)"/g)].map(
    (m) => m[1],
  );
  /* A static import in a minified chunk is `import{a as b}from"./x.js"` or
     `import"./x.js"`; `import("./x.js")` is the dynamic kind and is left alone. */
  const IMPORT = /(?:^|[;\s}])(?:import|export)\s*(?:[\w$*{},\s]+?from\s*)?["'](\.\.?\/[^"']+\.js)["']/g;
  const seen = new Set();
  const queue = entries.map((e) => join(DIST, e));
  while (queue.length) {
    const path = queue.pop();
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    for (const m of readFileSync(path, 'utf8').matchAll(IMPORT)) queue.push(join(dirname(path), m[1]));
  }
  const carrying = [...seen].filter((p) => readFileSync(p, 'utf8').includes(TAURI_MARKER));
  check(
    'the chunks index.html loads by static import hold none of the Tauri API',
    entries.length > 0 && carrying.length === 0,
    carrying.length
      ? carrying.map((p) => relative(DIST, p)).join(', ')
      : `${seen.size} chunks from ${entries.length} entry`,
  );

  /* And the marker is the right one: the desktop build still has the API,
     in a chunk of its own. A marker found nowhere would pass the check above
     by never matching anything. */
  const assets = join(DIST, 'assets');
  const anywhere = readdirSync(assets).filter(
    (n) => n.endsWith('.js') && readFileSync(join(assets, n), 'utf8').includes(TAURI_MARKER),
  );
  check('the Tauri API is still in the bundle, loaded on demand', anywhere.length > 0, anywhere.join(', ') || 'marker found nowhere');
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
