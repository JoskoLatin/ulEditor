/**
 * Runtime check of the vector and 3D viewers.
 *
 * Both are the kind of feature that looks finished from the outside and is not:
 * a viewer that mounts, shows nothing, and reports no error is indistinguishable
 * from one that works until you look at the window. So nothing here is satisfied
 * by an element existing — the drawing has to have real width, the model has to
 * report triangles it counted itself, and the formats we cannot open yet have to
 * say so in words rather than open blank.
 *
 * Files are injected through a real `drop`, the same route as `verify-ui.mjs`.
 *
 *   node tools/verify-viewers.mjs [--url http://localhost:5273] [--headed]
 */

import { chromium } from 'playwright';

import { makePdf } from './fixtures.mjs';
import { gzipSync } from 'node:zlib';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = resolve(ROOT, 'tools/screenshots');

const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5273';
const headed = args.includes('--headed');

/**
 * Waits for a condition rather than guessing how long it takes.
 *
 * The wait and the assertion must not be the same sentence, or the check proves
 * nothing: here it waits for the status bar to carry *a* size and then asserts
 * *which* size. Waiting for "240" would pass by definition.
 */
async function until(condition, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The size an editor publishes once it has the document open. */
const SIZE_REPORTED = /\d+\s*×\s*\d+/;

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── the files ───────────────────────────────────────────────────────── */

/** A drawing with an explicit size, so `naturalWidth` has something to report. */
const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160">
  <title>ulEditor test drawing</title>
  <rect x="10" y="10" width="220" height="140" fill="#d8ecee" stroke="#0c7079" stroke-width="4"/>
  <circle cx="80" cy="80" r="40" fill="#0c7079"/>
  <text x="130" y="88" font-family="sans-serif" font-size="18" fill="#101619">uniquevector</text>
</svg>
`;

/** A tetrahedron in ASCII STL. Four faces is enough to prove the loader ran and
 *  counted, and small enough to read in the file if a number ever looks wrong. */
function tetrahedronStl() {
  const points = [
    [0, 0, 0],
    [10, 0, 0],
    [5, 8.66, 0],
    [5, 2.89, 8.16],
  ];
  const faces = [
    [0, 1, 2],
    [0, 1, 3],
    [1, 2, 3],
    [2, 0, 3],
  ];
  const body = faces
    .map(
      (face) =>
        `facet normal 0 0 0\n    outer loop\n${face
          .map((i) => `      vertex ${points[i].join(' ')}`)
          .join('\n')}\n    endloop\n  endfacet`,
    )
    .join('\n  ');
  return `solid tetra\n  ${body}\nendsolid tetra\n`;
}

/* ── the browser ─────────────────────────────────────────────────────── */

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

async function dropFile(name, content) {
  const bytes = typeof content === 'string' ? null : Array.from(content);
  await page.evaluate(
    async ([fileName, text, byteArray]) => {
      const body = byteArray ? new Uint8Array(byteArray) : text;
      const file = new File([body], fileName);
      const transfer = new DataTransfer();
      transfer.items.add(file);
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }));
    },
    [name, typeof content === 'string' ? content : null, bytes],
  );
}

try {
  await mkdir(SHOTS, { recursive: true });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shell', { timeout: 15000 });

  /* ── SVG ───────────────────────────────────────────────────────────── */

  await dropFile('drawing.svg', SVG);
  await page.waitForSelector('.ul-vec', { timeout: 15000 });
  check('an SVG opens in the vector viewer, not the code editor', true);

  await page.waitForSelector('.mount:visible .ul-vec-frame img', { timeout: 10000 });
  const drawn = await page.locator('.mount:visible .ul-vec-frame').boundingBox();
  check(
    'the drawing has real size on screen',
    !!drawn && drawn.width > 50 && drawn.height > 30,
    `${Math.round(drawn?.width ?? 0)} × ${Math.round(drawn?.height ?? 0)} px`,
  );

  await until(async () => SIZE_REPORTED.test(await page.locator('.statusbar').innerText()));
  const svgStatus = await page.locator('.statusbar').innerText();
  check(
    'the status bar reports the size from the file',
    svgStatus.includes('240') && svgStatus.includes('160'),
    svgStatus.replace(/\s+/g, ' ').slice(0, 70),
  );

  // The markup is a button away rather than a reopen in another editor.
  await page.locator('.ul-vec-btn', { hasText: 'Source' }).click();
  await page.waitForSelector('.ul-vec-source:not([hidden])', { timeout: 5000 });
  const source = await page.locator('.ul-vec-source').innerText();
  check('the Source button shows the markup', source.includes('<svg') && source.includes('circle'));
  check(
    'the picture is hidden while the source is shown',
    await page.locator('.mount:visible .ul-vec-frame').isHidden(),
  );
  await page.locator('.ul-vec-btn', { hasText: 'Source' }).click();

  await page.screenshot({ path: resolve(SHOTS, 'vector.png') });

  /* ── SVGZ ──────────────────────────────────────────────────────────── */

  await dropFile('drawing.svgz', new Uint8Array(gzipSync(Buffer.from(SVG, 'utf8'))));

  /*
   * Measured off the picture rather than read out of the status bar. The tab
   * becomes active before the editor has finished mounting, so a status line
   * read at that moment still belongs to the drawing before it — which is
   * exactly how this check failed once in five runs before it said anything
   * true. The frame is scoped to the visible pane because every open tab keeps
   * its own, hidden.
   */
  const shown = page.locator('.mount:visible .ul-vec-frame');
  await shown.locator('img').waitFor({ state: 'visible', timeout: 15000 });
  const svgzBox = await until(async () => {
    const box = await shown.boundingBox();
    return box && box.width > 0 ? box : false;
  }).then(() => shown.boundingBox());
  check(
    'a gzipped SVG is unpacked and drawn at the size inside it',
    !!svgzBox && Math.round(svgzBox.width) === 240 && Math.round(svgzBox.height) === 160,
    `${Math.round(svgzBox?.width ?? 0)} × ${Math.round(svgzBox?.height ?? 0)} px`,
  );

  /* ── the ones we cannot open yet ───────────────────────────────────── */

  await dropFile('logo.cdr', new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x01, 0x02, 0x03]));
  await page.waitForSelector('.ul-vec-error', { timeout: 10000 });
  const excuse = await page.locator('.ul-vec-error').innerText();
  check(
    'a Corel file explains itself instead of opening blank',
    excuse.toLowerCase().includes('libcdr') && excuse.toLowerCase().includes('libreoffice'),
    excuse.replace(/\s+/g, ' ').slice(0, 80),
  );

  /* ── Illustrator, which is a PDF ───────────────────────────────────── */

  /*
   * The point of this one is detection, not the PDF viewer: an `.ai` saved by
   * any Illustrator of the last twenty years has a whole PDF inside it, and the
   * signature is read before the file name is. If this ever fails, someone has
   * made the extension win.
   */
  await dropFile('poster.ai', makePdf('Illustrator, with a PDF inside'));
  await page.waitForSelector('.ul-pdf', { timeout: 20000 });
  const aiTab = page.locator('.tab', { hasText: 'poster.ai' });
  check('an Illustrator file opens as the PDF it contains', (await aiTab.count()) === 1);
  /*
   * The active tab's own format, rather than "is a PDF viewer present anywhere"
   * — every tab keeps its pane mounted, so counting elements on the page proves
   * nothing about the document in front.
   */
  const aiFormat = await page.locator('.titlebar-title').innerText();
  check(
    'it is recognised as a PDF and not as a vector drawing',
    aiFormat.includes('PDF'),
    aiFormat.replace(/\s+/g, ' ').slice(0, 60),
  );

  /* ── a 3D model ────────────────────────────────────────────────────── */

  await dropFile('tetra.stl', tetrahedronStl());
  await page.waitForSelector('.ul-3d', { timeout: 20000 });
  await page.waitForSelector('.ul-3d-stage canvas', { timeout: 20000 });
  check('an STL opens in the 3D viewer with a canvas', true);

  const canvas = await page.locator('.ul-3d-stage canvas').boundingBox();
  check(
    'the canvas fills the stage',
    !!canvas && canvas.width > 200 && canvas.height > 100,
    `${Math.round(canvas?.width ?? 0)} × ${Math.round(canvas?.height ?? 0)} px`,
  );

  // The count comes from the loaded geometry, so it is proof the file was parsed
  // rather than proof a renderer started.
  await page.waitForFunction(
    () => document.querySelector('.statusbar')?.textContent?.includes('4') ?? false,
    { timeout: 20000 },
  );
  const modelStatus = await page.locator('.statusbar').innerText();
  check(
    'the status bar reports the four triangles of the tetrahedron',
    /\b4\b/.test(modelStatus) && modelStatus.toLowerCase().includes('vert'),
    modelStatus.replace(/\s+/g, ' ').slice(0, 80),
  );

  /*
   * A canvas of the right size proves a renderer started, not that a model came
   * out of it, so the pixels are looked at. Not with `readPixels`: a WebGL
   * drawing buffer is emptied the moment the frame is composited, and reading it
   * afterwards returns zeroes whatever was drawn — the usual fix, asking three.js
   * for `preserveDrawingBuffer`, would slow every frame in the shipped program
   * to make this one check convenient.
   *
   * The screenshot is taken through the browser instead, which reads the
   * composited result, and is decoded by handing it back to the page — the same
   * pixels a person would see.
   */
  const shot = (await page.locator('.ul-3d-stage canvas').screenshot()).toString('base64');
  const painted = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) return 'no 2d context';
    context.drawImage(image, 0, 0);
    // The middle tenth of the picture, which is where a framed model sits. The
    // background is 0x1a2226, the unlit material 0x9aa7ad — the gap is wide.
    const size = Math.max(8, Math.floor(Math.min(image.width, image.height) / 10));
    const data = context.getImageData(
      Math.floor((image.width - size) / 2),
      Math.floor((image.height - size) / 2),
      size,
      size,
    ).data;
    let lightest = 0;
    for (let i = 0; i < data.length; i += 4) lightest = Math.max(lightest, data[i]);
    return lightest;
  }, shot);
  check(
    'the model itself was drawn, not just a background',
    typeof painted === 'number' && painted > 80,
    typeof painted === 'number'
      ? `brightest red channel ${painted} of 255, background is 26`
      : String(painted),
  );

  await page.screenshot({ path: resolve(SHOTS, 'model.png') });

  await page.locator('.ul-3d-btn', { hasText: 'Wireframe' }).click();
  check(
    'the wireframe button stays on once pressed',
    (await page.locator('.ul-3d-btn', { hasText: 'Wireframe' }).getAttribute('data-active')) === 'true',
  );

  /* ── nothing shouted on the way ────────────────────────────────────── */

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('the run finished', false, err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
