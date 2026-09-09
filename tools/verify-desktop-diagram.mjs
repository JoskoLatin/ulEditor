/**
 * Checking that a diagram is drawn **inside the desktop application**, where the
 * CSP applies.
 *
 * `verify-mermaid.mjs` drives a served build in a browser, and a browser has no
 * `default-src 'self'`. That difference has already cost this project once: OCR
 * worked in the browser and would not have worked in the application, because
 * Tesseract was fetching its worker off a CDN. Mermaid is the same shape of
 * risk — a large library that lazy-loads pieces of itself — so the same two
 * questions are asked of it here:
 *
 * - **is anything refused?** Every console message about the Content Security
 *   Policy is collected, and one is a failure.
 * - **does anything leave the application?** Every request is recorded, and a
 *   diagram must make none: mermaid is bundled, as everything here is.
 *
 *   node tools/verify-desktop-diagram.mjs
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isLocal, startDesktop, stopDesktop } from './desktop-session.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FENCE = '```mermaid';
const MARKDOWN = [
  '# Dijagram u aplikaciji',
  '',
  FENCE,
  'graph LR',
  '  A[Bajtovi] --> B{Potpis?}',
  '  B -->|da| C[Čitač]',
  '  B -->|ne| D[Tekst]',
  '```',
  '',
].join('\n');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

let session;

try {
  session = await startDesktop({ port: 9337 });
  const { page } = session;
  check('attached to the desktop application', true);

  /* Everything that leaves the application is recorded; a diagram must send
     nothing. The local schemes are what the application itself is served over. */
  const external = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!isLocal(url)) external.push(url);
  });

  const violations = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });

  /* A real file on disk, opened the way a person opens one: the folder is
     adopted as a workspace root and the document is reached by name. A `File`
     dropped into the window has no path, and in the application a document
     without a path is a document the Rust side cannot read back. */
  const workspace = await mkdtemp(join(tmpdir(), 'ul-diagram-'));
  await writeFile(join(workspace, 'dijagram.md'), MARKDOWN, 'utf8');

  await page.evaluate(
    (dir) => window.__TAURI_INTERNALS__.invoke('adopt_paths', { paths: [dir] }),
    workspace,
  );

  await page.keyboard.press('Control+P');
  await page.waitForSelector('.palette-input input', { timeout: 10000 });
  await page.locator('.palette-input input').fill('dijagram.md');
  await page.waitForSelector('.palette-item', { timeout: 15000 });
  await page.locator('.palette-item').first().click();

  await page.waitForSelector('.ul-md', { timeout: 30000 });
  check('the document is open in the application', true);

  const pane = page.locator('.ul-md:visible');
  const svg = pane.locator('.ul-md-preview .ul-md-diagram svg').first();

  let drawn = true;
  try {
    await svg.waitFor({ timeout: 60000 });
  } catch {
    drawn = false;
  }

  if (!drawn) {
    const error = await pane
      .locator('.ul-md-diagram-error .why')
      .first()
      .innerText()
      .catch(() => '');
    check('the diagram got through the CSP', false, error.slice(0, 120) || 'no picture, no message');
  } else {
    check('the diagram is drawn inside the application', true);
    const labels = (await svg.locator('text').allTextContents()).join(' ').replace(/\s+/g, ' ');
    check('its labels are there, diacritics and all', labels.includes('Čitač'), labels.slice(0, 80));
  }

  check('the CSP refused nothing', violations.length === 0, violations.slice(0, 2).join(' | '));
  check(
    'no request left the application',
    external.length === 0,
    external.slice(0, 3).join(' | ') || 'no external requests',
  );

  await page.screenshot({ path: resolve(ROOT, 'tools/screenshots/desktop-diagram.png') });
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await session?.page
    ?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-desktop-diagram.png') })
    .catch(() => {});
} finally {
  await stopDesktop(session);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
