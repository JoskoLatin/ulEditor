/**
 * A save asks before it writes (ADR 0004, cards 471 and 485).
 *
 * Checked as logic, through the shell's own `saveTab` and `closeTab`, with an
 * editor that counts what is done to it and a shell whose questions the check
 * answers when it chooses. What can be wrong is the order — a write before the
 * answer, a second write nobody asked for, a save that runs on after its tab
 * is gone — and none of that needs a window or a disk to show.
 *
 * What it does not cover, stated plainly: the editors' own `prepareSave`, which
 * the desktop PDF check drives through the real file (verify-desktop-pdf-notes),
 * and the Rust side's refusal, which is tested in ul-core.
 *
 *   node tools/verify-save.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = (path) => import(pathToFileURL(resolve(ROOT, path)).href);

const { saveTab, closeTab } = await load('packages/shell-ui/src/shell/actions.ts');
const { useWorkspace, tabInstances } = await load('packages/shell-ui/src/state/workspace.ts');
const { ChangedOutsideError } = await load('packages/plugin-sdk/src/index.ts');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A shell whose questions stay open until the check answers them. */
function fakeShell() {
  const shell = {
    shown: [],
    asked: [],
    notify: {
      show(level, message, actions = []) {
        const toast = { level, message, actions, disposed: false };
        shell.shown.push(toast);
        return { dispose: () => (toast.disposed = true) };
      },
      fidelityWarning(uri, lost) {
        return new Promise((answer) => shell.asked.push({ uri, lost, answer }));
      },
    },
  };
  return shell;
}

/**
 * An editor that counts. `lost` is what its plan reports; `refusals` how many
 * of its writes Rust turns down as changed outside, before one goes through.
 */
function fakeEditor({ lost = [], refusals = 0, withPlan = true } = {}) {
  const editor = {
    prepared: 0,
    commits: [],
    saves: 0,
    isDirty: () => true,
    async save() {
      editor.saves++;
      return { uri: 'C:/w/doc.pdf', lostFidelity: lost };
    },
  };
  if (withPlan) {
    editor.prepareSave = async () => {
      editor.prepared++;
      return {
        lost,
        async commit(options) {
          editor.commits.push(options ?? {});
          if (editor.commits.length <= refusals) throw new ChangedOutsideError('C:/w/doc.pdf');
          return { uri: 'C:/w/doc.pdf', lostFidelity: lost };
        },
      };
    };
  }
  return editor;
}

let n = 0;
function openTab(editor) {
  const id = `save-${++n}`;
  useWorkspace.getState().addTab({
    id,
    uri: `C:/w/doc-${n}.pdf`,
    name: `doc-${n}.pdf`,
    format: 'pdf',
    providerId: 'test',
    dirty: true,
    status: '',
    error: null,
    readonly: false,
    ready: true,
    group: 'left',
  });
  tabInstances.set(id, editor);
  return id;
}

const press = (toast, label) => toast.actions.find((a) => a.label === label)?.run();

/* ── a loss is asked about before anything is written ────────────────── */

{
  const shell = fakeShell();
  const editor = fakeEditor({ lost: ['Notes lose their appearance'] });
  const id = openTab(editor);

  const saving = saveTab(shell, id);
  await tick();
  check('the question about the loss comes first', shell.asked.length === 1);
  check('and nothing is written while it stands', editor.commits.length === 0, `${editor.commits.length} writes`);

  shell.asked[0].answer('cancel');
  const saved = await saving;
  check('Cancel writes nothing', editor.commits.length === 0 && saved === false);
  check(
    'and the tab is still unsaved',
    useWorkspace.getState().tabs.find((t) => t.id === id)?.dirty === true,
  );
}

{
  const shell = fakeShell();
  const editor = fakeEditor({ lost: ['Notes lose their appearance'] });
  const id = openTab(editor);

  const saving = saveTab(shell, id);
  await tick();
  shell.asked[0].answer('save');
  const saved = await saving;
  check('"Save anyway" writes once', editor.commits.length === 1 && saved === true, `${editor.commits.length}`);
  check('through the plan, never through save()', editor.saves === 0);
}

/* ── one save per tab, and a tab that waits is not closed ────────────── */

{
  const shell = fakeShell();
  const editor = fakeEditor({ lost: ['x'] });
  const id = openTab(editor);

  const first = saveTab(shell, id);
  await tick();
  const second = await saveTab(shell, id);
  check('a second save while the first is asking does nothing', second === false && editor.prepared === 1);

  await closeTab(shell, id);
  check(
    'and the tab is not closed under it',
    useWorkspace.getState().tabs.some((t) => t.id === id),
  );

  shell.asked[0].answer('save');
  await first;
  check('the first save still writes, once', editor.commits.length === 1);
}

/* ── changed outside: asked, and written over once on a yes ─────────── */

{
  const shell = fakeShell();
  const editor = fakeEditor({ refusals: 1 });
  const id = openTab(editor);

  const saving = saveTab(shell, id);
  await tick();
  await tick();
  const question = shell.shown.find((s) => s.actions.some((a) => a.label === 'Overwrite'));
  check('a file changed outside is asked about', question !== undefined, question?.message ?? 'no question');
  check('and nothing more is written while it stands', editor.commits.length === 1);

  press(question, 'Overwrite');
  const saved = await saving;
  check(
    'Overwrite writes once more, saying so',
    saved === true && editor.commits.length === 2 && editor.commits[1].overwriteChanged === true,
    JSON.stringify(editor.commits),
  );
  check('and the first write did not say so', editor.commits[0].overwriteChanged !== true);
}

{
  const shell = fakeShell();
  const editor = fakeEditor({ refusals: 1 });
  const id = openTab(editor);

  const saving = saveTab(shell, id);
  await tick();
  await tick();
  press(shell.shown.find((s) => s.actions.some((a) => a.label === 'Overwrite')), 'Cancel');
  const saved = await saving;
  check('Cancel over a changed file writes nothing more', saved === false && editor.commits.length === 1);
}

{
  const shell = fakeShell();
  const editor = fakeEditor({ refusals: 2 });
  const id = openTab(editor);

  const saving = saveTab(shell, id);
  await tick();
  await tick();
  press(shell.shown.find((s) => s.actions.some((a) => a.label === 'Overwrite')), 'Overwrite');
  const saved = await saving;
  check(
    'a second refusal is a failed save, not a third write',
    saved === false &&
      editor.commits.length === 2 &&
      shell.shown.some((s) => s.level === 'error'),
    `${editor.commits.length} writes`,
  );
}

/* ── an editor without a plan ────────────────────────────────────────── */

{
  const shell = fakeShell();
  const editor = fakeEditor({ withPlan: false, lost: ['something'] });
  const id = openTab(editor);

  const saved = await saveTab(shell, id);
  const told = shell.shown.find((s) => s.level === 'warning');
  check('an editor without prepareSave is saved through save()', saved === true && editor.saves === 1);
  check(
    'and what it lost is told without a Cancel that could undo nothing',
    told !== undefined && told.actions.length === 0 && shell.asked.length === 0,
    told?.message ?? 'nothing told',
  );
}

/* ── every editor that can lose something has a plan ─────────────────── */

{
  const { readFileSync, readdirSync, existsSync } = await import('node:fs');
  const editors = readdirSync(resolve(ROOT, 'packages'))
    .filter((dir) => dir.startsWith('editor-'))
    .map((dir) => resolve(ROOT, 'packages', dir, 'src'))
    .filter((dir) => existsSync(dir));
  const offenders = [];
  for (const dir of editors) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(resolve(dir, file), 'utf8');
      /* A save result whose losses are anything but a literal empty list. */
      const losing = /lostFidelity:\s*\S/.test(text.replace(/lostFidelity:\s*\[\s*\]/g, ''));
      if (losing && !/prepareSave\s*\(/.test(text)) offenders.push(`${dir.split(/[\\/]/).slice(-2)[0]}/${file}`);
    }
  }
  check(
    'an editor that can report a loss works its save out first',
    offenders.length === 0,
    offenders.join(', ') || 'every one',
  );
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
