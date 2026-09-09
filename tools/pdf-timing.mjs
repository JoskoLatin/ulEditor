/**
 * How long pdf.js actually takes, over real documents, **in the application**.
 *
 * The plan holds one more deferral: `editor-pdf` on pdfium instead of pdf.js,
 * "deferred — pdf.js suffices, the swap is an optimisation". Like the `tantivy`
 * decision beside it, that rested on a number nobody had measured.
 *
 * **The first version of this file measured itself.** It dropped each document
 * into a browser by handing the bytes to `page.evaluate`, which serialises a
 * five-megabyte file as an array of five million numbers over the debugging
 * protocol: it reported sixteen seconds for a one-page PDF and the shape of the
 * curve followed the file size rather than the page count, which is the
 * signature of a harness and not of a renderer. So it runs in the real
 * application now, opening files from disk the way a person does, and nothing
 * but a path crosses any boundary.
 *
 * What is timed is what a person waits for: the document opening and one page
 * appearing. A swap to pdfium would cost a native library per platform in every
 * installer and a rewrite of the text layer, the annotations, the redaction and
 * the retyping, all of which are built on pdf.js today — so the bar is not
 * "pdfium is faster" but "pdf.js is slow enough to be worth that".
 *
 *   node tools/pdf-timing.mjs "C:/Users/you/Documents" [--limit 12]
 */

import { mkdtemp, copyFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startDesktop, stopDesktop } from './desktop-session.mjs';

const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 12;
const roots = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));

if (roots.length === 0) {
  console.error('usage: node tools/pdf-timing.mjs <folder> [--limit 12]');
  process.exit(2);
}

/** Every PDF under a folder. */
async function pdfsUnder(root, found = []) {
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      /* The same noise the program itself refuses to walk — see `is_noise` in
         ul-core: a portable Python installation holds no documents. */
      if (
        ['node_modules', '.git', 'target', 'site-packages', '__pycache__', 'venv'].includes(
          entry.name,
        )
      ) {
        continue;
      }
      await pdfsUnder(path, found);
    } else if (entry.name.toLowerCase().endsWith('.pdf')) {
      found.push(path);
    }
  }
  return found;
}

const all = [];
for (const root of roots) await pdfsUnder(resolve(root), all);

const sized = [];
for (const path of all) {
  try {
    sized.push({ path, size: (await stat(path)).size });
  } catch {
    /* Gone between the listing and the reading. */
  }
}
sized.sort((a, b) => a.size - b.size);

/* A spread rather than the first dozen: sorted by size, then sampled evenly, so
   a one-page invoice and a five-hundred-page book are both in the sample. */
const step = Math.max(1, Math.floor(sized.length / limit));
const sample = sized.filter((_, index) => index % step === 0).slice(0, limit);

if (sample.length === 0) {
  console.error('no PDFs found under that folder');
  process.exit(1);
}

/* Copied into one folder of their own, with names nothing else will match: the
   documents are opened by name through quick open, and two files called
   `Racun.pdf` in different folders would be a coin toss. */
const workspace = await mkdtemp(join(tmpdir(), 'ul-pdf-timing-'));
const staged = [];
for (const [index, entry] of sample.entries()) {
  const name = `t${String(index).padStart(2, '0')}-${entry.path.split(/[\\/]/).pop()}`;
  await copyFile(entry.path, join(workspace, name));
  staged.push({ ...entry, name });
}

console.log(`${all.length} PDFs found, ${staged.length} timed, in the real application\n`);

let session;
const rows = [];

try {
  session = await startDesktop({ port: 9342 });
  const { page } = session;

  await page.evaluate(
    (dir) => window.__TAURI_INTERNALS__.invoke('adopt_paths', { paths: [dir] }),
    workspace,
  );

  for (const entry of staged) {
    await page.keyboard.press('Control+P');
    await page.waitForSelector('.palette-input input', { timeout: 15000 });
    await page.locator('.palette-input input').fill(entry.name);
    await page.waitForSelector('.palette-item', { timeout: 15000 });

    const started = Date.now();
    await page.locator('.palette-item').first().click();

    let first = null;
    try {
      await page.waitForSelector('.ul-pdf-page[data-rendered="true"]', { timeout: 120000 });
      first = Date.now() - started;
    } catch {
      /* Left as null and reported as such: a document that does not open is a
         far more interesting result than a slow one. */
    }

    const pages = await page.locator('.ul-pdf-page').count();
    rows.push({ name: entry.name, size: entry.size, pages, first });

    // Closed before the next, so nothing is measured against a busy window.
    await page.keyboard.press('Control+W');
    await page.waitForTimeout(300);
  }
} catch (err) {
  console.error(`the run stopped: ${err instanceof Error ? err.message : err}`);
} finally {
  await stopDesktop(session);
}

const human = (bytes) =>
  bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} kB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

console.log('name                                          size    pages   to first page');
for (const row of rows) {
  const shown = row.name.replace(/^t\d\d-/, '');
  const name = shown.length > 44 ? `${shown.slice(0, 41)}…` : shown.padEnd(44);
  const first = row.first === null ? 'did not open' : `${row.first} ms`;
  console.log(
    `${name} ${human(row.size).padStart(8)}  ${String(row.pages || '—').padStart(5)}  ${first.padStart(14)}`,
  );
}

const opened = rows.filter((r) => r.first !== null);
if (opened.length > 0) {
  const firsts = opened.map((r) => r.first).sort((a, b) => a - b);
  console.log(
    `\nmedian ${firsts[Math.floor(firsts.length / 2)]} ms · worst ${firsts[firsts.length - 1]} ms · ${opened.length}/${rows.length} opened`,
  );
}
