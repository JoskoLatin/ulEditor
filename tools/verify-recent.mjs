/**
 * The list of recently opened files and folders.
 *
 * Checked as logic rather than through the interface, because the list is
 * desktop-only by design — on the web a stored `Uri` reopens nothing — and the
 * browser checks run as the web build. So this drives `recent.ts` directly with
 * a stand-in for the settings store, which is where the behaviour that can be
 * wrong actually lives: the ordering, the cap, and what happens to an entry that
 * will not open.
 *
 * What it does not cover, stated plainly: the wiring from the welcome screen to
 * these functions. That needs the desktop app, and is checked by hand.
 *
 *   node tools/verify-recent.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const recent = await import(
  pathToFileURL(resolve(ROOT, 'packages/shell-ui/src/shell/recent.ts')).href
);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Just enough shell: the settings store and which platform we claim to be. */
function fakeShell(platform = 'desktop') {
  const values = new Map();
  return {
    platform,
    settings: {
      get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
      set: (key, value) => values.set(key, value),
    },
    values,
  };
}

const names = (entries) => entries.map((e) => e.name).join(', ');

/* ── the ordering ────────────────────────────────────────────────────── */

{
  const shell = fakeShell();
  for (const name of ['one.md', 'two.pdf', 'three.docx']) {
    recent.rememberFile(shell, { uri: `C:/w/${name}`, name });
  }
  check(
    'the newest is first',
    names(recent.recentFiles(shell)) === 'three.docx, two.pdf, one.md',
    names(recent.recentFiles(shell)),
  );

  /* The same file again moves up rather than appearing twice — matched on the
     path, since two `notes.md` in different folders are two different files. */
  recent.rememberFile(shell, { uri: 'C:/w/one.md', name: 'one.md' });
  const after = recent.recentFiles(shell);
  check('reopening moves it to the front', after[0]?.name === 'one.md', names(after));
  check('and does not duplicate it', after.length === 3, `${after.length} entries`);

  recent.rememberFile(shell, { uri: 'D:/other/one.md', name: 'one.md' });
  check(
    'the same name in another folder is a different file',
    recent.recentFiles(shell).length === 4,
    `${recent.recentFiles(shell).length} entries`,
  );
}

/* ── the cap ─────────────────────────────────────────────────────────── */

{
  const shell = fakeShell();
  for (let i = 0; i < 40; i++) {
    recent.rememberFile(shell, { uri: `C:/w/file-${i}.md`, name: `file-${i}.md` });
  }
  const files = recent.recentFiles(shell);
  check('the list is capped', files.length === 12, `${files.length} entries`);
  check('and it keeps the newest end', files[0]?.name === 'file-39.md', files[0]?.name);

  for (let i = 0; i < 20; i++) {
    recent.rememberFolder(shell, { uri: `C:/w/dir-${i}`, name: `dir-${i}` });
  }
  check('folders have their own, shorter cap', recent.recentFolders(shell).length === 8);
  check('and they did not disturb the files', recent.recentFiles(shell).length === 12);
}

/* ── a file that will not open ───────────────────────────────────────── */

{
  const shell = fakeShell();
  recent.rememberFile(shell, { uri: 'C:/w/gone.pdf', name: 'gone.pdf' });
  recent.rememberFile(shell, { uri: 'C:/w/here.pdf', name: 'here.pdf' });
  recent.rememberFolder(shell, { uri: 'C:/w/gone.pdf', name: 'gone.pdf' });

  recent.forget(shell, 'C:/w/gone.pdf');
  check(
    'an entry that failed to open is dropped',
    names(recent.recentFiles(shell)) === 'here.pdf',
    names(recent.recentFiles(shell)),
  );
  check('from the folders as well', recent.recentFolders(shell).length === 0);
}

/* ── the web ─────────────────────────────────────────────────────────── */

{
  const shell = fakeShell('web');
  recent.rememberFile(shell, { uri: 'blob:whatever', name: 'dropped.pdf' });
  check(
    'nothing is remembered on the web',
    recent.recentFiles(shell).length === 0 && !shell.values.has('recent.files'),
    'a stored handle key reopens nothing there',
  );
}

/* ── settings edited by hand, or left by an older version ────────────── */

{
  const shell = fakeShell();
  shell.settings.set('recent.files', [
    { uri: 'C:/w/good.md', name: 'good.md', at: 1 },
    { name: 'no uri.md', at: 2 },
    null,
    'not an object',
    { uri: 42, name: 'wrong type', at: 3 },
  ]);
  check(
    'a damaged list is filtered rather than thrown on',
    names(recent.recentFiles(shell)) === 'good.md',
    names(recent.recentFiles(shell)),
  );

  shell.settings.set('recent.files', 'not a list at all');
  check('and so is one that is not a list', recent.recentFiles(shell).length === 0);
}

/* ── clearing ────────────────────────────────────────────────────────── */

{
  const shell = fakeShell();
  recent.rememberFile(shell, { uri: 'C:/w/a.md', name: 'a.md' });
  recent.rememberFolder(shell, { uri: 'C:/w', name: 'w' });
  check('there is something to clear', recent.hasRecent(shell));
  recent.clearRecent(shell);
  check(
    'clearing empties both lists',
    !recent.hasRecent(shell) && recent.recentFiles(shell).length === 0,
  );
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
