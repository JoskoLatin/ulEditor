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

import { isLocal, startDesktop, stopDesktop, openFromOutside } from './desktop-session.mjs';

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
  session = await startDesktop({ port: 9338, identifier: 'org.uleditor.app.check' });
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

  await openFromOutside(page, [workspace]);

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

  /* What the editor itself asks the core for, written down on the way: the
     core refuses a name that is taken only when told the name is one the
     editor worked out (card 522), and nothing else shows that it was told. */
  /* Read off the IPC request itself — the page's own `invoke` cannot be
     wrapped, Tauri does not let it be replaced. */
  const imageWrites = [];
  page.on('request', (request) => {
    if (!/\/image_write(\?|$)/.test(request.url())) return;
    try {
      const args = JSON.parse(request.postData() ?? '{}');
      imageWrites.push({ target: args.target, fresh: args.fresh });
    } catch {
      imageWrites.push({ unreadable: request.postData()?.slice(0, 80) });
    }
  });
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
    const asked = [...imageWrites];
    check(
      'the editor told the core the new name is one it worked out, which replaces nothing',
      asked.length === 1 && asked[0].target.endsWith('slika.jpg') && asked[0].fresh === true,
      JSON.stringify(asked),
    );
    check(
      'the tab followed the file it wrote',
      await until(async () => (await page.locator('.tab.active, .tab[data-active="true"]').innerText().catch(() => '')).includes('slika.jpg')),
      await page.locator('.tab.active, .tab[data-active="true"]').innerText().catch(() => ''),
    );

    /* ── and the next save goes to the file the tab now shows (card 511) ──
       The editor used to keep the path it was opened with: its second save
       worked out the same new `.jpg`, found it there, and refused with
       "already exists" — and had it not, it would have applied the plan to
       the original PNG and thrown the first change away. */
    const first = await shown();
    const pngAfter = await readFile(file);
    const jpegBefore = await readFile(jpeg);
    await pane.locator('.ul-img-rotate-right').click();
    await page.keyboard.press('Control+S');
    const wrote = await until(async () => !(await readFile(jpeg)).equals(jpegBefore), 15000);
    const toasts = (await page.locator('.toast').allInnerTexts()).join(' | ');
    check(
      'a second save writes the file the tab follows, and is not refused',
      wrote && !/already exists/.test(toasts),
      toasts.slice(0, 120) || 'no message',
    );
    const again = [...imageWrites];
    check(
      'and a save of the file it follows is not fresh: that file is its own',
      again.length === 2 && again[1].fresh !== true,
      JSON.stringify(again),
    );
    await until(async () => (await shown()).width === first.height, 10000);
    const second = await shown();
    check(
      'the picture shown is the one it wrote, turned once more',
      second.width === first.height && second.height === first.width,
      `${first.width} × ${first.height} → ${second.width} × ${second.height}`,
    );
    const turnedAgain = await readFile(jpeg);
    check(
      'it is still a JPEG, and is the first save turned (the sizes above), not the original again',
      turnedAgain[0] === 0xff && turnedAgain[1] === 0xd8 && turnedAgain.length > 0,
      `${turnedAgain.length} bytes`,
    );
    check('the original is as the first saves left it', (await readFile(file)).equals(pngAfter));

    /* ── a name worked out by the program replaces nothing (card 522) ──
       The editor looks first and says "already exists"; a file put there
       after the look is refused by the core itself. Asked of the commands
       the editor uses, with `fresh`, over a file that is there. */
    const jpegNow = await readFile(jpeg);
    const refusals = await page.evaluate(
      async ({ source, target }) => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        const refusal = (call) => call.then(() => 'written', (err) => String(err));
        return {
          image: await refusal(invoke('image_write', { source, target, ops: { rotate: 90 }, begin: true, fresh: true })),
          file: await refusal(invoke('write_file', { path: target, contents: [1, 2, 3], begin: true, fresh: true })),
        };
      },
      { source: file, target: jpeg },
    );
    check(
      'the core refuses a fresh picture over a file that is there',
      /already exists/.test(refusals.image),
      refusals.image.slice(0, 120),
    );
    check('and a fresh file the same way', /already exists/.test(refusals.file), refusals.file.slice(0, 120));
    check('and the file there is untouched', (await readFile(jpeg)).equals(jpegNow));
    check(
      'and no other file appeared',
      (await readdir(workspace)).sort().join(',') === 'slika.jpg,slika.png',
      (await readdir(workspace)).join(', '),
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
