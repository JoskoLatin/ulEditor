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
 * The other half is what happens when one is clicked, and that is here too: a
 * folder added with nothing visibly changing reads as a dead button, which is
 * exactly how it was reported.
 *
 * What it does not cover, stated plainly: the click itself. That the button on
 * the welcome screen calls these functions is checked by hand.
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
const { addRoot, openRecentFolder } = await import(
  pathToFileURL(resolve(ROOT, 'packages/shell-ui/src/shell/actions.ts')).href
);
const { useWorkspace } = await import(
  pathToFileURL(resolve(ROOT, 'packages/shell-ui/src/state/workspace.ts')).href
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
    /** Filled in by the checks that need a file system. */
    fs: {
      readDirectory: async () => [],
    },
    notify: {
      shown: [],
      show(level, message) {
        this.shown.push({ level, message });
      },
    },
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

/* ── opening one ─────────────────────────────────────────────────────── */

{
  const shell = fakeShell();
  shell.fs.readDirectory = async () => [
    { uri: 'C:/w/demo/one.md', name: 'one.md', kind: 'file' },
  ];

  /* The panel starts somewhere else entirely, which is the case that made this
     look broken: the root was added and the screen did not change. */
  useWorkspace.getState().setSidebarView('library');
  useWorkspace.getState().setSidebarVisible(false);

  await openRecentFolder(shell, { uri: 'C:/w/demo', name: 'demo' });

  const state = useWorkspace.getState();
  check('the folder became a root', state.tree.some((node) => node.uri === 'C:/w/demo'));
  check('with what is inside it', state.tree.at(-1)?.children?.length === 1);
  check('the tree is the panel that is showing', state.sidebarView === 'explorer', state.sidebarView);
  check('and the panel is open', state.sidebarVisible === true);
  check('it is remembered as recent', recent.recentFolders(shell)[0]?.name === 'demo');
}

{
  /* The session restore re-adds every root from last time. It must not decide
     which panel the person is looking at while doing so. */
  const shell = fakeShell();
  useWorkspace.getState().setSidebarView('library');

  await addRoot(shell, { uri: 'C:/w/restored', name: 'restored' }, { reveal: false });
  check(
    'a restored root leaves the panel alone',
    useWorkspace.getState().sidebarView === 'library',
    useWorkspace.getState().sidebarView,
  );
}

{
  const shell = fakeShell();
  recent.rememberFolder(shell, { uri: 'C:/w/moved', name: 'moved' });
  shell.fs.readDirectory = async () => {
    throw new Error('no such directory');
  };

  await openRecentFolder(shell, { uri: 'C:/w/moved', name: 'moved' });
  check(
    'a folder that has moved is dropped from the list',
    recent.recentFolders(shell).length === 0,
  );
  check(
    'and the reason is said out loud',
    shell.notify.shown.some((n) => n.level === 'error' && /no such directory/.test(n.message)),
    JSON.stringify(shell.notify.shown[0] ?? null),
  );
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
