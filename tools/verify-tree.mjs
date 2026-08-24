/**
 * The order the file tree is drawn in, and the two controls beside a root.
 *
 * Checked as logic rather than through the interface: sorting is a pure
 * function over nodes, and the cases worth pinning are the ones a screenshot
 * would never show — a Croatian name landing where a Croatian reader expects
 * it, `slika10` after `slika2`, and an entry whose date the platform does not
 * report going last instead of pretending to be from 1970.
 *
 *   node tools/verify-tree.mjs
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { sortTree, isTreeSort } = await import(
  pathToFileURL(resolve(ROOT, 'packages/shell-ui/src/shell/tree-sort.ts')).href
);
const { refreshRoot, removeRoot, addRoot } = await import(
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

/** A node, with only what sorting looks at. */
const node = (name, kind = 'file', modified = null) => ({
  uri: `C:/w/${name}`,
  name,
  kind,
  depth: 1,
  children: null,
  expanded: false,
  format: 'unknown',
  modified,
});

const names = (nodes) => nodes.map((n) => n.name).join(', ');

/* ── by name ─────────────────────────────────────────────────────────── */

{
  const nodes = [node('slika10.png'), node('slika2.png'), node('Album', 'directory'), node('čaj.txt'), node('cvijet.txt')];
  const sorted = sortTree(nodes, 'name');

  check('folders come before files', sorted[0]?.name === 'Album', names(sorted));
  check(
    'numbers in a name read as numbers',
    sorted.indexOf(sorted.find((n) => n.name === 'slika2.png')) <
      sorted.indexOf(sorted.find((n) => n.name === 'slika10.png')),
    names(sorted),
  );
  check(
    'a Croatian letter lands where a Croatian reader looks for it',
    names(sorted) === 'Album, cvijet.txt, čaj.txt, slika2.png, slika10.png',
    names(sorted),
  );
}

/* ── by type ─────────────────────────────────────────────────────────── */

{
  const nodes = [node('b.pdf'), node('a.txt'), node('c.pdf'), node('Mapa', 'directory'), node('README')];
  const sorted = sortTree(nodes, 'type');

  check('the folder still leads', sorted[0]?.name === 'Mapa', names(sorted));
  check(
    'files group by extension, and by name inside the group',
    names(sorted) === 'Mapa, README, b.pdf, c.pdf, a.txt',
    names(sorted),
  );
}

/* ── by date ─────────────────────────────────────────────────────────── */

{
  const nodes = [
    node('old.txt', 'file', 1_000),
    node('new.txt', 'file', 9_000),
    node('undated.txt', 'file', null),
    node('middle.txt', 'file', 5_000),
  ];
  const sorted = sortTree(nodes, 'date');

  check(
    'the newest comes first — that is what the order is asked for',
    names(sorted) === 'new.txt, middle.txt, old.txt, undated.txt',
    names(sorted),
  );
  check(
    'and an entry with no date goes last, not to 1970',
    sorted.at(-1)?.name === 'undated.txt',
    names(sorted),
  );
}

/* ── the nodes themselves ────────────────────────────────────────────── */

{
  /* Sorting is a way of looking at a folder, not a change to it: the stored
     nodes must come back untouched, or a re-sort would be a mutation React
     never hears about. */
  const nodes = [node('b.txt'), node('a.txt')];
  const before = names(nodes);
  sortTree(nodes, 'name');
  check('sorting leaves the array it was given alone', names(nodes) === before, names(nodes));

  const nested = [
    { ...node('Mapa', 'directory'), children: [node('z.txt'), node('a.txt')], expanded: true },
  ];
  const sorted = sortTree(nested, 'name');
  check('children are sorted too', names(sorted[0].children) === 'a.txt, z.txt');
  check('and the branch stays open', sorted[0].expanded === true);
}

check('a stored order that means nothing is rejected', !isTreeSort('by-colour') && isTreeSort('date'));

/* ── refresh and remove ──────────────────────────────────────────────── */

function fakeShell(entries) {
  return {
    platform: 'desktop',
    settings: { get: (k, f) => f, set: () => {} },
    fs: {
      readDirectory: async (uri) => entries(uri),
      adoptPaths: async (paths) => ({
        documents: [],
        directories: paths.map((uri) => ({ uri, name: uri.split('/').pop(), kind: 'directory' })),
      }),
    },
    notify: {
      shown: [],
      show(level, message) {
        this.shown.push({ level, message });
      },
    },
  };
}

{
  /* A file saved by another program is simply not in the tree — nothing
     watches the folder. This is how it arrives, and what must survive the
     arrival is which branches were open. */
  let extra = false;
  const shell = fakeShell((uri) =>
    uri.endsWith('/sub')
      ? [{ uri: 'C:/w/root/sub/deep.txt', name: 'deep.txt', kind: 'file' }]
      : [
          { uri: 'C:/w/root/sub', name: 'sub', kind: 'directory' },
          { uri: 'C:/w/root/a.txt', name: 'a.txt', kind: 'file' },
          ...(extra ? [{ uri: 'C:/w/root/new.txt', name: 'new.txt', kind: 'file' }] : []),
        ],
  );

  await addRoot(shell, { uri: 'C:/w/root', name: 'root' });
  const root = () => useWorkspace.getState().tree.find((n) => n.uri === 'C:/w/root');
  check('the root was read', root()?.children?.length === 2, `${root()?.children?.length}`);

  // Open the subfolder, so the refresh has something to put back.
  const { updateNode } = useWorkspace.getState();
  updateNode('C:/w/root/sub', {
    expanded: true,
    children: [{ ...node('deep.txt'), depth: 2 }],
  });

  extra = true;
  await refreshRoot(shell, root());

  check('a file that appeared since is now in the tree', root()?.children?.length === 3, `${root()?.children?.length}`);
  const sub = root()?.children?.find((n) => n.name === 'sub');
  check('the branch that was open is still open', sub?.expanded === true);
  check('and it was read again rather than emptied', sub?.children?.length === 1, `${sub?.children?.length}`);
  check(
    'the refresh says what it found',
    shell.notify.shown.some((n) => /3/.test(n.message)),
    JSON.stringify(shell.notify.shown.at(-1)),
  );
}

{
  /* A folder that has gone away since leaves the tree rather than staying as a
     row that fails every time it is touched. */
  const shell = fakeShell(() => {
    throw new Error('no such directory');
  });
  useWorkspace.getState().setTree([{ ...node('gone', 'directory'), depth: 0, uri: 'C:/w/gone' }]);

  await refreshRoot(shell, useWorkspace.getState().tree[0]);
  check(
    'refreshing a folder that has gone drops it, and says why',
    useWorkspace.getState().tree.length === 0 &&
      shell.notify.shown.some((n) => n.level === 'error' && /no such directory/.test(n.message)),
    JSON.stringify(shell.notify.shown.at(-1)),
  );
}

{
  const shell = fakeShell(() => []);
  useWorkspace.getState().setTree([
    { ...node('one', 'directory'), depth: 0, uri: 'C:/w/one' },
    { ...node('two', 'directory'), depth: 0, uri: 'C:/w/two' },
  ]);

  removeRoot(shell, useWorkspace.getState().tree[0]);
  const left = useWorkspace.getState().tree;
  check('removing takes only the one asked for', left.length === 1 && left[0].uri === 'C:/w/two', names(left));
  check('and says nothing — nothing went wrong', shell.notify.shown.length === 0);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
