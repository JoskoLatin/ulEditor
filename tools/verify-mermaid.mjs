/**
 * Diagrams in Markdown, checked in a real browser.
 *
 * Four claims, and none of them can be made without one:
 *
 * - **a fence becomes a picture**, and its labels are `<text>` rather than HTML
 *   in a `foreignObject` — which is what lets the sanitiser and the reading flow
 *   both keep them;
 * - **the library is not fetched until a diagram is on the page.** Mermaid is
 *   two thirds of a megabyte gzipped and almost no Markdown holds a diagram, so
 *   the network is watched: nothing mermaid-shaped may be requested while a file
 *   without a fence is open;
 * - **a drawn diagram is kept.** The id mermaid writes into its own SVG is the
 *   receipt: if typing a word in the paragraph below leaves that id alone,
 *   nothing was drawn again. Changing the theme must change it, since the
 *   colours are baked in;
 * - **a diagram that will not parse says so**, in the place the picture would
 *   have taken, with the source still in front of the person who typed it.
 *
 *   node tools/verify-mermaid.mjs [--url http://localhost:5273] [--headed]
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = resolve(ROOT, 'tools/screenshots');

const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5273';
const headed = args.includes('--headed');

const FENCE = '```mermaid';

/* The labels carry diacritics on purpose: an SVG that cannot draw `č` is a
   diagram nobody here can use, and the failure would be a silent one. */
const PLAIN = ['# Bez dijagrama', '', 'Obična bilješka, jedan odlomak i ništa više.', ''].join('\n');

const WITH_DIAGRAM = [
  '# S dijagramom',
  '',
  'Prvo odlomak, da se vidi da tekst oko dijagrama ostaje tekst.',
  '',
  FENCE,
  'graph TD',
  '  A[Datoteka] --> B{Potpis?}',
  '  B -->|da| C[Čitač za taj format]',
  '  B -->|ne| D[Otvara se kao tekst]',
  '```',
  '',
  'A ovaj je pokvaren namjerno:',
  '',
  FENCE,
  'nijedijagram',
  '  A --> B',
  '```',
  '',
].join('\n');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

async function until(condition, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function dropFile(page, name, text) {
  await page.evaluate(
    ([fileName, body]) => {
      const file = new File([body], fileName);
      const transfer = new DataTransfer();
      transfer.items.add(file);
      window.dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
      );
    },
    [name, text],
  );
}

/** The palette route, because the theme is a command rather than a switch. */
async function cycleTheme(page) {
  await page.keyboard.press('Control+Shift+P');
  await page.waitForSelector('.palette', { timeout: 5000 });
  await page.locator('.palette-input input').pressSequentially('cycle theme');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
}

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });

const requested = [];
page.on('request', (req) => requested.push(req.url()));

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

/*
 * The library, not every URL with the word in it.
 *
 * Under the dev server our own wrapper is a module of its own —
 * `editor-markdown/src/mermaid.ts`, a few dozen lines imported statically by
 * the editor — and it is fetched the moment any Markdown opens. Matching on the
 * word alone reported that as the library arriving early, and the check failed
 * against a program keeping its promise: the one URL it named was the wrapper.
 * A production build inlines the wrapper into the editor's chunk, which is
 * presumably where this passed when it was written.
 */
const mermaidRequests = () =>
  requested.filter((u) => /mermaid/i.test(u) && !/\/editor-markdown\/src\/[^/?]*$/.test(u.split('?')[0]));

try {
  await mkdir(SHOTS, { recursive: true });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shell', { timeout: 15000 });

  /* ── a document with no diagram pays nothing ───────────────────────── */

  await dropFile(page, 'biljeske.md', PLAIN);
  await page.waitForSelector('.ul-md', { timeout: 15000 });
  await page.waitForTimeout(500);

  /* Every tab keeps its own mounted pane and the inactive ones are merely
     hidden, so a bare `.ul-md-source` matches both documents once the second is
     open. `:visible` is the tab in front. */
  const pane = page.locator('.ul-md:visible');
  const heading = pane.locator('.ul-md-preview .inner h1').first();
  check(
    'a Markdown file opens with the preview beside it',
    await heading.isVisible(),
    await heading.innerText(),
  );
  check(
    'mermaid is not fetched for a document without a diagram',
    mermaidRequests().length === 0,
    mermaidRequests().slice(0, 2).join(' ') || 'nothing mermaid-shaped was requested',
  );

  /* ── and one with a diagram draws it ───────────────────────────────── */

  await dropFile(page, 'dijagram.md', WITH_DIAGRAM);
  await page.waitForTimeout(300);

  const svg = pane.locator('.ul-md-preview .ul-md-diagram svg').first();
  check('the fence is drawn as a picture', await until(async () => (await svg.count()) > 0));
  check(
    'and the library was fetched only now',
    mermaidRequests().length > 0,
    `${mermaidRequests().length} requests`,
  );

  const shapes = await svg.locator('.node').count();
  check('the diagram holds its own nodes', shapes >= 4, `${shapes} nodes`);

  // `innerText` is an HTML notion and comes back empty off an SVG `<text>`.
  const labels = (await svg.locator('text').allTextContents()).join(' ').replace(/\s+/g, ' ');
  check('a Croatian label keeps its diacritics', labels.includes('Čitač'), labels.slice(0, 80));
  check(
    'the labels are text, not HTML inside the picture',
    (await svg.locator('foreignObject').count()) === 0,
  );

  const source = await pane.locator('.ul-md-source .cm-content').innerText();
  check('the source still holds the fence', source.includes('graph TD'));

  /* ── the diagram that will not parse ───────────────────────────────── */

  const error = pane.locator('.ul-md-preview .ul-md-diagram-error').first();
  check('a broken diagram is reported where it stood', (await error.count()) === 1);

  const why = (await error.locator('.why').innerText().catch(() => '')).trim();
  check('and it says what is wrong', why.length > 0, why.slice(0, 70));
  check(
    'with the source kept in front of the person who typed it',
    (await error.locator('pre code').innerText().catch(() => '')).includes('nijedijagram'),
  );

  await page.screenshot({ path: resolve(SHOTS, 'mermaid.png') });

  /* ── typing beside a diagram does not redraw it ────────────────────── */

  const idOf = async () => await svg.getAttribute('id');
  const drawnId = await idOf();
  check('the picture carries the id it was drawn under', Boolean(drawnId), drawnId ?? '');

  await pane.locator('.ul-md-source .cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\nJos jedan odlomak.\n');
  await page.waitForTimeout(800);
  check(
    'the diagram survives typing beside it, undrawn',
    (await idOf()) === drawnId,
    `${drawnId} → ${await idOf()}`,
  );
  check(
    'and the new paragraph reached the preview',
    (await pane.locator('.ul-md-preview .inner').innerText()).includes('Jos jedan odlomak'),
  );

  /* ── the theme is baked into the picture, so it is drawn again ─────── */

  let dark = false;
  for (let i = 0; i < 3 && !dark; i += 1) {
    await cycleTheme(page);
    dark =
      (await page.evaluate(() => document.documentElement.dataset.theme ?? 'system')) === 'dark';
  }
  check('the theme can be taken to dark', dark);

  await until(async () => (await idOf()) !== drawnId, 10000);
  check(
    'a diagram is drawn again for the new theme',
    (await idOf()) !== drawnId,
    `${drawnId} → ${await idOf()}`,
  );

  /* ── and it is in the reading room too ─────────────────────────────── */

  await pane.locator('.ul-md-source .cm-content').click();
  await page.keyboard.press('Control+Shift+R');
  check(
    'the diagram is drawn in reading mode as well',
    await until(async () => (await pane.locator('.ul-md-reading .ul-md-diagram svg').count()) > 0),
  );
  await page.screenshot({ path: resolve(SHOTS, 'mermaid-reading.png') });
  await page.keyboard.press('Escape');

  const ignorable = (text) =>
    text.includes('Download the React DevTools') || text.includes('[vite]');
  const real = consoleErrors.filter((t) => !ignorable(t));
  check('no console errors', real.length === 0, real.slice(0, 3).join(' | '));
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await page.screenshot({ path: resolve(SHOTS, 'failure-mermaid.png') }).catch(() => {});
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.passed);
await writeFile(
  resolve(SHOTS, 'report-mermaid.json'),
  JSON.stringify({ checks, consoleErrors, mermaidRequests: mermaidRequests() }, null, 2),
);

console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
