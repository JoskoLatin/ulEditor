/**
 * Rewriting an Office document in **the real desktop application**, out to disk
 * and back — once for Word, once for OpenDocument text.
 *
 * `verify-docx-edit.mjs` and `verify-odt-edit.mjs` prove that each write touches
 * only what it should. Here it is proved that the write reaches the file at all:
 * double-click, typing, `Ctrl+S`, reopening. In between stands everything that
 * cannot be checked from Node — `contenteditable`, the trip through the Rust VFS
 * and reading it back.
 *
 * And then the other direction: a paragraph the file already had is taken
 * away with `Ctrl+Shift+Backspace`, brought back with `Ctrl+Z`, taken away
 * again with `Ctrl+Shift+Z`, saved, and looked for after reopening — and the
 * one paragraph a document cannot lose is pressed on, to see that it stays.
 *
 * Both formats go through the same sequence because they go through the same
 * editor: one class drives them, and what a save costs is settled behind
 * `Preview.source`. A run of this is therefore also the check that the seam
 * holds — that the editor really does not know which format it is looking at.
 *
 *   node tools/verify-office-editing.mjs
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

import { makeDocx, makeOdt } from './fixtures.mjs';
import { alreadyRunning, ALREADY_RUNNING, killTree } from './desktop-session.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9336;
const REPLACEMENT = 'Rewritten in ulEditor — čćžšđ';
const ADDED = 'A paragraph that was not there — čćžšđ ČĆŽŠĐ';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/**
 * The two ways this program writes text into a document it did not create.
 *
 * `adds` is not a preference: a Word document can be given a paragraph it did
 * not have and an OpenDocument text cannot, and the difference lives entirely in
 * the seam behind `Preview.source`. Checking both sides of it here is how we
 * know the editor is reading that seam rather than knowing which format it holds
 * — the same class drives both.
 */
const DOCUMENTS = [
  { label: 'docx', file: 'report.docx', bytes: makeDocx(), part: 'word/document.xml', adds: true },
  { label: 'odt', file: 'izvjestaj.odt', bytes: makeOdt(), part: 'content.xml', adds: false },
];

if (alreadyRunning()) {
  check('no other ulEditor is holding the single-instance lock', false, ALREADY_RUNNING);
  console.log(`\n0/1 checks passed`);
  process.exit(1);
}

const workspace = await mkdtemp(join(tmpdir(), 'ul-office-'));
for (const document of DOCUMENTS) {
  document.path = join(workspace, document.file);
  await writeFile(document.path, document.bytes);
  document.before = unzipSync(await readFile(document.path));
  document.otherParts = Object.keys(document.before).filter((path) => path !== document.part);
}

const app = spawn('pnpm', ['--filter', '@uleditor/desktop', 'dev'], {
  cwd: ROOT,
  shell: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    /* A scratch profile — see desktop-session.mjs: without it the fixtures
       land in the person's real recent list and session. */
    WEBVIEW2_USER_DATA_FOLDER: await mkdtemp(join(tmpdir(), 'ul-profile-')),
  },
  stdio: 'ignore',
});

async function connect(timeoutMs) {
  const until = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < until) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastError ?? new Error('the CDP endpoint never opened');
}

let browser;
let page;

try {
  browser = await connect(240000);
  const contexts = browser.contexts();
  page = contexts[0]?.pages()[0] ?? (await contexts[0].waitForEvent('page'));
  await page.waitForSelector('.shell', { timeout: 30000 });
  check('attached to the desktop application', true);

  for (let guard = 0; guard < 20 && (await page.locator('.tab').count()) > 0; guard++) {
    await page.locator('.tab .close').first().click();
    await page.waitForTimeout(200);
  }

  await page.evaluate(
    (dir) => window.__TAURI_INTERNALS__.invoke('adopt_paths', { paths: [dir] }),
    workspace,
  );

  const open = async (name) => {
    await page.keyboard.press('Control+P');
    await page.waitForSelector('.palette-input input', { timeout: 10000 });
    await page.locator('.palette-input input').fill(name);
    await page.waitForSelector('.palette-item', { timeout: 15000 });
    await page.locator('.palette-item').first().click();
    await page.waitForSelector('.ul-office-doc', { timeout: 30000 });
  };

  for (const document of DOCUMENTS) {
    const say = (name) => `${document.label}: ${name}`;

    await open(document.file);
    check(say('the document is open'), true);

    const pieces = await page.locator('.ul-office-run').count();
    check(say('the rewritable pieces of text are marked'), pieces > 0, `${pieces}`);

    const first = page.locator('.ul-office-run').first();
    const originalText = await first.innerText();
    await first.dblclick();

    const editing = await page.evaluate(
      () => document.querySelector('.ul-office-run')?.isContentEditable ?? false,
    );
    check(say('a double-click opens the text for typing'), editing);

    await page.keyboard.press('Control+A');
    await page.keyboard.type(REPLACEMENT);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    check(say('the text was replaced in the view'), (await first.innerText()) === REPLACEMENT, await first.innerText());
    check(say('the document is marked as modified'), (await page.locator('.tab[data-dirty="true"]').count()) === 1);

    await page.keyboard.press('Control+S');
    let saved = true;
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('.tab[data-dirty="true"]').length === 0,
        { timeout: 30000 },
      );
    } catch {
      saved = false;
    }
    check(
      say('the save went through without obstruction'),
      saved,
      (await page.locator('.toast p').last().innerText().catch(() => '')).slice(0, 160),
    );

    /* ── what is on disk ─────────────────────────────────────────────── */

    const after = unzipSync(await readFile(document.path));

    check(say('the change is in the document'), strFromU8(after[document.part]).includes('Rewritten in ulEditor'));
    check(say('the original text is gone'), !strFromU8(after[document.part]).includes(originalText));

    /*
     * The central check of the whole Office direction: editing must not rewrite
     * styles, numbering or metadata along the way. Quietly losing somebody
     * else's formatting is the one mistake trust does not recover from.
     */
    const drifted = document.otherParts.filter((path) => {
      const a = document.before[path];
      const b = after[path];
      return !b || a.length !== b.length || a.some((byte, i) => byte !== b[i]);
    });
    check(
      say('no other part of the file was touched'),
      drifted.length === 0,
      drifted.join(', ') || `${document.otherParts.length} parts unchanged`,
    );

    /* ── reopening ───────────────────────────────────────────────────── */

    await page.locator('.tab .close').first().click();
    await page.waitForTimeout(400);
    await open(document.file);

    const reopened = await page.locator('.ul-office-doc').innerText();
    check(say('the rewritten text reads back'), reopened.includes(REPLACEMENT));
    check(say('the original text is not in the view either'), !reopened.includes(originalText));

    /* ── a paragraph that was not there ──────────────────────────────── */

    const paragraphsBefore = (strFromU8(after[document.part]).match(/<(w:p|text:p)[\s>]/g) ?? []).length;

    // The cursor has to be somewhere: the command inserts after the paragraph
    // it is in, and refuses out loud when it is nowhere.
    await page.locator('.ul-office-run').first().click();
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(300);

    const fresh = await page.locator('.ul-office-doc [data-new]').count();

    if (!document.adds) {
      /* The whole point of the seam: a format with nothing to say about
         structure is offered nothing, and the keystroke passes through without
         doing something invisible. */
      check(say('a format that cannot take a paragraph is given no way to add one'), fresh === 0);
      check(
        say('and the document is not marked as changed by a key that did nothing'),
        (await page.locator('.tab[data-dirty="true"]').count()) === 0,
      );

      /* And the same for taking one away: no seam, no command, and a key that
         passes through rather than hiding a line the file will keep. */
      await page.locator('.ul-office-run').first().click();
      await page.keyboard.press('Control+Shift+Backspace');
      await page.waitForTimeout(300);
      check(
        say('nor any way to remove one'),
        (await page.locator('.ul-office-doc .is-removed').count()) === 0 &&
          (await page.locator('.tab[data-dirty="true"]').count()) === 0,
      );
      await page.screenshot({ path: resolve(ROOT, `tools/screenshots/desktop-${document.label}-edit.png`) });
      await page.locator('.tab .close').first().click();
      await page.waitForTimeout(400);
      continue;
    }

    check(say('the new paragraph appears in the view'), fresh === 1, `${fresh}`);
    check(
      say('and it is open for typing straight away'),
      await page.evaluate(() => document.querySelector('[data-new] .ul-office-run')?.isContentEditable ?? false),
    );

    await page.keyboard.type(ADDED);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    check(
      say('what was typed stands in the document'),
      (await page.locator('.ul-office-doc [data-new]').innerText()).includes(ADDED),
    );
    check(
      say('and the document says it has unsaved changes'),
      (await page.locator('.tab[data-dirty="true"]').count()) === 1,
    );

    await page.keyboard.press('Control+S');
    let added = true;
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('.tab[data-dirty="true"]').length === 0,
        { timeout: 30000 },
      );
    } catch {
      added = false;
    }
    check(say('the paragraph was saved'), added);

    const grown = unzipSync(await readFile(document.path));
    const grownPart = strFromU8(grown[document.part]);
    const paragraphsAfter = (grownPart.match(/<(w:p|text:p)[\s>]/g) ?? []).length;

    check(say('the new paragraph is in the file'), grownPart.includes(ADDED));
    check(
      say('exactly one paragraph more than before, and not two'),
      paragraphsAfter === paragraphsBefore + 1,
      `${paragraphsBefore} → ${paragraphsAfter}`,
    );
    check(
      say('the text rewritten earlier is still there, not reverted by the second save'),
      grownPart.includes('Rewritten in ulEditor'),
    );

    const stillDrifted = document.otherParts.filter((path) => {
      const a = document.before[path];
      const b = grown[path];
      return !b || a.length !== b.length || a.some((byte, i) => byte !== b[i]);
    });
    check(
      say('adding a paragraph touched no other part of the file'),
      stillDrifted.length === 0,
      stillDrifted.join(', ') || `${document.otherParts.length} parts unchanged`,
    );

    /* Saving again must write the same file: the plan is applied to the
       original every time, so a second save is not a second insertion. */
    await page.keyboard.press('Control+S');
    await page.waitForTimeout(1200);
    const twice = strFromU8(unzipSync(await readFile(document.path))[document.part]);
    check(
      say('saving a second time does not add it a second time'),
      (twice.match(/<(w:p|text:p)[\s>]/g) ?? []).length === paragraphsAfter,
    );

    await page.locator('.tab .close').first().click();
    await page.waitForTimeout(400);
    await open(document.file);
    check(
      say('and it is there when the document is opened again'),
      (await page.locator('.ul-office-doc').innerText()).includes(ADDED),
    );

    /* ── a paragraph the file will no longer have ────────────────────── */

    const shownText = async () => page.locator('.ul-office-doc').innerText();
    const dirty = async () => (await page.locator('.tab[data-dirty="true"]').count()) === 1;

    /*
     * The one it may not lose first. The fixture's last paragraph stands behind
     * a table, and a document cannot end on a table — Word puts a paragraph
     * back, measured — so the command refuses, and the refusal must change
     * nothing: not the view, and not the question of whether to save.
     */
    await page.locator('.ul-office-doc [data-paragraph]', { hasText: 'uniqueword' }).locator('.ul-office-run').first().click();
    await page.keyboard.press('Control+Shift+Backspace');
    await page.waitForTimeout(300);
    check(
      say('the last paragraph behind a table is not removed'),
      (await page.locator('.ul-office-doc .is-removed').count()) === 0 && (await shownText()).includes('uniqueword'),
    );
    check(say('and a refusal does not mark the document as changed'), !(await dirty()));

    const partBefore = strFromU8(unzipSync(await readFile(document.path))[document.part]);
    const countBefore = (partBefore.match(/<w:p[\s>]/g) ?? []).length;
    const GOING = 'An opening paragraph with diacritics';

    await page.locator('.ul-office-doc [data-paragraph]', { hasText: GOING }).locator('.ul-office-run').first().click();
    await page.keyboard.press('Control+Shift+Backspace');
    await page.waitForTimeout(300);

    check(say('Ctrl+Shift+Backspace takes the paragraph out of the view'), !(await shownText()).includes(GOING));
    check(say('and the document says it has unsaved changes'), await dirty());

    /* The critic's case: a second press must not aim at the paragraph that is
       already gone. The cursor is moved to a paragraph that is still there. */
    const landed = await page.evaluate(() => {
      const anchor = document.getSelection()?.anchorNode ?? null;
      const element = anchor instanceof Element ? anchor : anchor?.parentElement;
      const paragraph = element?.closest('[data-paragraph]');
      return paragraph ? !paragraph.classList.contains('is-removed') : false;
    });
    check(say('the cursor is left in a paragraph that is still there'), landed);

    await page.keyboard.press('Control+Z');
    await page.waitForTimeout(300);
    check(say('Ctrl+Z brings it back'), (await shownText()).includes(GOING));
    check(say('and undoing back to the saved state leaves nothing to save'), !(await dirty()));

    await page.keyboard.press('Control+Shift+Z');
    await page.waitForTimeout(300);
    check(say('Ctrl+Shift+Z takes it away again'), !(await shownText()).includes(GOING));

    await page.keyboard.press('Control+S');
    let removedSaved = true;
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('.tab[data-dirty="true"]').length === 0,
        { timeout: 30000 },
      );
    } catch {
      removedSaved = false;
    }
    check(say('the removal was saved'), removedSaved);

    const shrunk = unzipSync(await readFile(document.path));
    const shrunkPart = strFromU8(shrunk[document.part]);
    check(say('the paragraph is not in the file'), !shrunkPart.includes(GOING));
    check(
      say('exactly one paragraph fewer, and not two'),
      (shrunkPart.match(/<w:p[\s>]/g) ?? []).length === countBefore - 1,
      `${countBefore} → ${(shrunkPart.match(/<w:p[\s>]/g) ?? []).length}`,
    );
    check(
      say('and everything saved before it is still there'),
      shrunkPart.includes(ADDED) && shrunkPart.includes('Rewritten in ulEditor'),
    );
    const shrunkDrift = document.otherParts.filter((path) => {
      const a = document.before[path];
      const b = shrunk[path];
      return !b || a.length !== b.length || a.some((byte, i) => byte !== b[i]);
    });
    check(
      say('removing a paragraph touched no other part of the file'),
      shrunkDrift.length === 0,
      shrunkDrift.join(', ') || `${document.otherParts.length} parts unchanged`,
    );

    await page.locator('.tab .close').first().click();
    await page.waitForTimeout(400);
    await open(document.file);
    check(say('and it is still gone when the document is opened again'), !(await shownText()).includes(GOING));

    /*
     * The case the critics called fatal, in the gesture people will use most:
     * add a paragraph, change your mind, take it away. With one planned
     * paragraph already holding text, a second, empty one is opened and removed
     * at once. The blur that finishes the typing drops the empty one from the
     * plan by itself — and the first build then looked for it, got -1, and
     * `splice(-1, 1)` took the LAST paragraph of the plan: the one with text in
     * it, gone without an undo.
     */
    const KEEP = 'Ostaje — čćžšđ';
    const newOnes = async () => page.locator('.ul-office-doc [data-new]').allInnerTexts();

    await page.locator('.ul-office-doc [data-paragraph]', { hasText: ADDED }).locator('.ul-office-run').first().click();
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(200);
    await page.keyboard.type(KEEP);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);

    await page.locator('.ul-office-doc [data-new] .ul-office-run', { hasText: KEEP }).click();
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(200);
    const beforeRemoval = await newOnes();
    await page.keyboard.press('Control+Shift+Backspace');
    await page.waitForTimeout(300);
    const afterRemoval = await newOnes();

    check(
      say('removing an empty paragraph just added takes that one, and not another'),
      beforeRemoval.length === 2 && afterRemoval.length === 1 && afterRemoval[0].includes(KEEP),
      `${beforeRemoval.length} → ${afterRemoval.length}: ${afterRemoval.join(' | ').slice(0, 60)}`,
    );
    check(say('and the paragraph with text in it is still to be saved'), await dirty());

    /* And the half-way case: typed into, not yet finished, and removed. What
       was typed is written down by the blur, so the removal has something to
       undo back to — before the fix, an undo that restored nothing. */
    await page.locator('.ul-office-doc [data-new] .ul-office-run', { hasText: KEEP }).click();
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(200);
    await page.keyboard.type('napola');
    await page.keyboard.press('Control+Shift+Backspace');
    await page.waitForTimeout(300);
    const halfGone = await newOnes();
    await page.keyboard.press('Control+Z');
    await page.waitForTimeout(300);
    const halfBack = await newOnes();
    check(
      say('a paragraph typed into and removed before it was finished comes back with Ctrl+Z'),
      !halfGone.some((one) => one.includes('napola')) && halfBack.some((one) => one.includes('napola')),
      `${halfGone.length} → ${halfBack.length}`,
    );

    /* Back to the file as saved, so the screenshot and the close below ask no
       question about unsaved work. */
    for (let guard = 0; guard < 6 && (await dirty()); guard++) {
      await page.keyboard.press('Control+Z');
      await page.waitForTimeout(200);
    }
    check(say('and undoing all of it leaves the file as it was saved'), !(await dirty()));

    await page.screenshot({ path: resolve(ROOT, `tools/screenshots/desktop-${document.label}-edit.png`) });
    await page.locator('.tab .close').first().click();
    await page.waitForTimeout(400);
  }
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await page
    ?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-office-edit.png') })
    .catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  // By process tree, root still alive — see `killTree` in desktop-session.mjs.
  killTree(app);
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
