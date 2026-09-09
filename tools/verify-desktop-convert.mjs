/**
 * A drawing nothing here reads, opened **through LibreOffice, in the real
 * application**.
 *
 * `cargo test -p ul-convert` checks the arguments and the discovery, and one
 * ignored test runs the suite for real. What neither can reach is the seam this
 * feature is made of: a viewer that offers a button, a command that converts
 * without the viewer knowing what a tab is, and a PDF that ends up on the
 * screen. Only the running program has all three.
 *
 * **Both outcomes are checked, and neither is a silent pass.** With LibreOffice
 * installed the button has to produce a rendered PDF; without it, the page has
 * to say so in words and offer somewhere to get it. The detail line says which
 * branch ran, so a machine that quietly lost its office suite cannot look like
 * a machine where the conversion works.
 *
 * The other claim is what does **not** happen: the folder the drawing lives in
 * is somebody's work, and nothing may be written into it. The converted file
 * goes to the temporary folder, and the check counts the files beside the
 * original before and after.
 *
 *   node tools/verify-desktop-convert.mjs
 */

import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDesktop, stopDesktop } from './desktop-session.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* PostScript is text, so the fixture is written here rather than committed as a
   binary. It goes through the same `draw_pdf_Export` filter a `.cdr` does. */
const EPS = [
  '%!PS-Adobe-3.0 EPSF-3.0',
  '%%BoundingBox: 0 0 240 120',
  '%%Title: Proba',
  '/Helvetica findfont 18 scalefont setfont',
  '20 70 moveto',
  '(Pozdrav iz EPS-a) show',
  '0 0 1 setrgbcolor',
  '20 25 200 20 rectfill',
  'showpage',
  '%%EOF',
  '',
].join('\n');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

async function until(condition, timeout = 180000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

let session;

try {
  session = await startDesktop({ port: 9340 });
  const { page } = session;
  check('attached to the desktop application', true);

  const workspace = await mkdtemp(join(tmpdir(), 'ul-convert-'));
  await writeFile(join(workspace, 'crtez.eps'), EPS, 'utf8');
  const before = (await readdir(workspace)).sort();

  await page.evaluate(
    (dir) => window.__TAURI_INTERNALS__.invoke('adopt_paths', { paths: [dir] }),
    workspace,
  );

  await page.keyboard.press('Control+P');
  await page.waitForSelector('.palette-input input', { timeout: 10000 });
  await page.locator('.palette-input input').fill('crtez.eps');
  await page.waitForSelector('.palette-item', { timeout: 15000 });
  await page.locator('.palette-item').first().click();

  await page.waitForSelector('.ul-vec', { timeout: 30000 });
  check('the drawing opens in the vector viewer', true);

  const explanation = await page.locator('.ul-vec-error').first().innerText();
  check(
    'and the page says why it is not drawn here',
    /PostScript|interpreter/i.test(explanation),
    explanation.replace(/\s+/g, ' ').slice(0, 90),
  );

  /* The button is added after LibreOffice has been asked for, so it is waited
     for rather than looked for once. */
  const offered = await until(async () => (await page.locator('.ul-vec-convert').count()) > 0, 20000);

  if (!offered) {
    /* No LibreOffice on this machine. That is a correct outcome and it has its
       own claim: the reason has to be on the page, in words. */
    const note = await page.locator('.ul-vec-note').first().innerText().catch(() => '');
    check(
      'without LibreOffice, the page says so instead of offering a button',
      /LibreOffice/i.test(note),
      note.replace(/\s+/g, ' ').slice(0, 90) || '(nothing said)',
    );
  } else {
    check('LibreOffice was found, so the conversion is offered', true);

    await page.locator('.ul-vec-convert').first().click();

    /* Two minutes: the first run of a fresh profile builds it, and this is the
       one place in the program where something genuinely takes that long. */
    const opened = await until(
      async () => (await page.locator('.tab').allInnerTexts()).some((t) => /\.pdf/i.test(t)),
      180000,
    );
    check(
      'a PDF tab opens',
      opened,
      (await page.locator('.tab').allInnerTexts()).join(' | '),
    );

    if (opened) {
      const rendered = await until(
        async () => (await page.locator('.ul-pdf-page[data-rendered="true"]').count()) > 0,
        60000,
      );
      check('and the page is drawn from it', rendered);

      const box = await page.locator('.ul-pdf-page canvas').first().boundingBox();
      check(
        'the drawing has a page of a real size',
        Boolean(box && box.width > 50 && box.height > 50),
        box ? `${Math.round(box.width)} × ${Math.round(box.height)}` : '(no canvas)',
      );

      const said = (await page.locator('.toast p').allInnerTexts()).join(' | ');
      check(
        'and the person is told it is a copy, not their drawing',
        /temporary folder|original is untouched/i.test(said),
        said.slice(0, 100) || '(nothing said)',
      );
    }

    const after = (await readdir(workspace)).sort();
    check(
      'nothing was written beside the original',
      after.join(',') === before.join(','),
      after.join(', '),
    );

    check(
      'and the drawing is still open in its own tab',
      (await page.locator('.tab').allInnerTexts()).some((t) => /crtez\.eps/i.test(t)),
    );
  }

  await page.screenshot({ path: resolve(ROOT, 'tools/screenshots/desktop-convert.png') });
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await session?.page
    ?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-desktop-convert.png') })
    .catch(() => {});
} finally {
  await stopDesktop(session);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
