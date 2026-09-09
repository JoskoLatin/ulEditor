/**
 * Editing a picture **in the desktop application**, out to disk and back.
 *
 * The transforms themselves are checked in `cargo test -p ul-image`, against
 * pixels. What cannot be checked there is the part that has burned this kind of
 * feature before: whether the preview and the file agree.
 *
 * The picture has a red block in one corner, and the corner is the whole
 * instrument. A quarter turn clockwise must put it top-right — in the window
 * *and* in the bytes — so a preview that turns the other way, or a Rust side
 * that does, is caught rather than admired. CSS applies its transforms right to
 * left and `ul-image` applies rotate before flip, which is exactly the sort of
 * disagreement nobody notices until a file is written.
 *
 * Then: a crop dragged over the picture arrives as the rectangle that was drawn,
 * and a change of format writes a new file beside the original instead of
 * putting JPEG bytes in something called `.png`.
 *
 *   node tools/verify-desktop-image.mjs
 */

import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isLocal, startDesktop, stopDesktop } from './desktop-session.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

async function until(condition, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

let session;

try {
  session = await startDesktop({ port: 9338 });
  const { page } = session;
  check('attached to the desktop application', true);

  const external = [];
  page.on('request', (request) => {
    if (!isLocal(request.url())) external.push(request.url());
  });

  /* A picture drawn inside the application, so no binary fixture has to live in
     the repository: 40×20, white, with a red block in the top-left corner. */
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 20;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 40, 20);
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 8, 4);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });

  const workspace = await mkdtemp(join(tmpdir(), 'ul-image-'));
  const file = join(workspace, 'slika.png');
  await writeFile(file, Buffer.from(bytes));

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
    await page.waitForSelector('.ul-img img', { timeout: 30000 });
  };

  await open('slika.png');
  check('the picture is open in the application', true);

  const pane = page.locator('.ul-img:visible');

  /* The size the page sees, and the colour of a corner of the file as it now
     stands — drawn into a canvas, which is the only way to ask. */
  const shown = async () =>
    await pane.locator('img').first().evaluate((img) => ({
      width: img.naturalWidth,
      height: img.naturalHeight,
    }));

  const cornerOf = async (corner) =>
    await pane.locator('img').first().evaluate((img, which) => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const x = which === 'top-right' ? img.naturalWidth - 2 : 1;
      const [r, g, b] = ctx.getImageData(x, 1, 1, 1).data;
      return [r, g, b];
    }, corner);

  const before = await shown();
  check('it is the size it was drawn', before.width === 40 && before.height === 20, `${before.width} × ${before.height}`);

  const red = ([r, g, b]) => r > 200 && g < 70 && b < 70;
  check('the red corner is at the top-left to begin with', red(await cornerOf('top-left')), String(await cornerOf('top-left')));

  /* ── the tools are drawn, because there is a Rust core under this ──── */

  check('the editing tools are offered', (await pane.locator('.ul-img-crop').count()) === 1);
  check('and a format to save as', (await pane.locator('.ul-img-format').count()) === 1);

  /* ── a quarter turn, and the file has to agree with the window ─────── */

  const frameBox = async () =>
    await pane.locator('.ul-img-frame').evaluate((el) => ({
      width: Math.round(el.getBoundingClientRect().width),
      height: Math.round(el.getBoundingClientRect().height),
    }));

  const wideBefore = await frameBox();
  await pane.locator('.ul-img-rotate-right').click();
  const tallAfter = await frameBox();
  check(
    'the preview turns before anything is written',
    tallAfter.height > tallAfter.width && wideBefore.width > wideBefore.height,
    `${wideBefore.width}×${wideBefore.height} → ${tallAfter.width}×${tallAfter.height}`,
  );

  const sizeOnDisk = async (path) => (await readFile(path)).length;
  const sizeBefore = await sizeOnDisk(file);

  await page.keyboard.press('Control+S');
  check(
    'the save reaches the file',
    await until(async () => (await sizeOnDisk(file)) !== sizeBefore),
    `${sizeBefore} → ${await sizeOnDisk(file)} bytes`,
  );

  await until(async () => (await shown()).width === 20);
  const turned = await shown();
  check('the sides swapped in the file', turned.width === 20 && turned.height === 40, `${turned.width} × ${turned.height}`);
  check(
    'and the red corner went clockwise, in the bytes as on the screen',
    red(await cornerOf('top-right')),
    String(await cornerOf('top-right')),
  );

  /* ── a crop is the rectangle that was drawn ────────────────────────── */

  await pane.locator('.ul-img-crop').click();
  const box = await pane.locator('.ul-img-frame').evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });

  // The top half of the picture, dragged with the mouse.
  await page.mouse.move(box.x + 2, box.y + 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  check('the pending crop is drawn on the picture', (await pane.locator('.ul-img-selection').count()) === 1);

  const beforeCrop = await sizeOnDisk(file);
  await page.keyboard.press('Control+S');
  await until(async () => (await sizeOnDisk(file)) !== beforeCrop);
  await until(async () => (await shown()).height < 40);
  const cropped = await shown();
  /* What the drag asked for, in the pixels of the picture: the frame is the
     picture as shown, so the rectangle maps through its own box. A small picture
     is never enlarged to fit, which is why this is computed rather than
     assumed — at 1:1 a two-pixel inset really is two pixels of picture. */
  const expected = {
    width: Math.round(((box.width - 4) / box.width) * turned.width),
    height: Math.round(((box.height / 2 - 2) / box.height) * turned.height),
  };
  check(
    'the crop is the rectangle that was drawn',
    Math.abs(cropped.width - expected.width) <= 2 && Math.abs(cropped.height - expected.height) <= 2,
    `${cropped.width} × ${cropped.height}, asked for ${expected.width} × ${expected.height}`,
  );

  /* ── a change of format writes a file that is not lying about itself ─ */

  await pane.locator('.ul-img-format').selectOption('jpeg');
  await page.keyboard.press('Control+S');

  const jpeg = join(workspace, 'slika.jpg');
  check(
    'a JPEG is written beside the original rather than inside its name',
    await until(async () => (await readdir(workspace)).includes('slika.jpg')),
    (await readdir(workspace)).join(', '),
  );

  if (await until(async () => (await readdir(workspace)).includes('slika.jpg'))) {
    const head = await readFile(jpeg);
    check(
      'and it really is a JPEG',
      head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
      `${head[0].toString(16)} ${head[1].toString(16)} ${head[2].toString(16)}`,
    );
    check(
      'the tab followed the file it wrote',
      await until(async () => (await page.locator('.tab.active, .tab[data-active="true"]').innerText().catch(() => '')).includes('slika.jpg')),
      await page.locator('.tab.active, .tab[data-active="true"]').innerText().catch(() => ''),
    );
  }

  check(
    'no request left the application',
    external.length === 0,
    external.slice(0, 3).join(' | ') || 'no external requests',
  );

  await page.screenshot({ path: resolve(ROOT, 'tools/screenshots/desktop-image.png') });
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await session?.page
    ?.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-desktop-image.png') })
    .catch(() => {});
} finally {
  await stopDesktop(session);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
