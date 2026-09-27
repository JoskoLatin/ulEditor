/**
 * Editing a picture **in a browser**, out to the folder and back.
 *
 * The browser half of `verify-desktop-image.mjs` (ADR 0002, phase 3 step 4):
 * the same red corner, the same quarter turn, the same crop and change of
 * format — but the transforms run as WebAssembly in the tab, and the file is
 * written through File System Access rather than by Rust. The window and the
 * bytes have to agree here just as they do there.
 *
 * The folder is a real `FileSystemDirectoryHandle` out of the origin-private
 * file system, handed over in place of `showDirectoryPicker`, and the file is
 * read back out of it directly — not through the application — to see what was
 * really written. The module has to come from the application's own origin,
 * and nothing may leave it.
 *
 *   node tools/wasm-assets.mjs
 *   pnpm --filter @uleditor/shell-ui build
 *   pnpm --filter @uleditor/shell-ui preview --port 5273
 *   node tools/verify-web-image.mjs [--url http://localhost:5273]
 */

import { chromium } from 'playwright';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5273';

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

/* The picked folder: `slika.png`, 40×20, white with a red block top-left. */
const PICKER = () => {
  window.showDirectoryPicker = async () => {
    const storage = await navigator.storage.getDirectory();
    await storage.removeEntry('slike', { recursive: true }).catch(() => {});
    const root = await storage.getDirectoryHandle('slike', { create: true });
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 20;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 40, 20);
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 8, 4);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const out = await (await root.getFileHandle('slika.png', { create: true })).createWritable();
    await out.write(blob);
    await out.close();

    /* And a photograph's worth: 12 megapixels of noise, so that the JPEG is
       as heavy to decode as a real one. */
    const big = new OffscreenCanvas(4000, 3000);
    const bctx = big.getContext('2d');
    const band = bctx.createImageData(4000, 250);
    for (let i = 0; i < band.data.length; i++) band.data[i] = i % 4 === 3 ? 255 : (Math.random() * 255) | 0;
    for (let y = 0; y < 3000; y += 250) bctx.putImageData(band, 0, y);
    const photo = await big.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    const photoOut = await (await root.getFileHandle('fotografija.jpg', { create: true })).createWritable();
    await photoOut.write(photo);
    await photoOut.close();
    return root;
  };
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
const external = [];
const wasmFrom = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('request', (request) => {
  const u = new URL(request.url());
  if (u.pathname.endsWith('.wasm')) wasmFrom.push(u.pathname);
  if (!['localhost', '127.0.0.1'].includes(u.hostname) && !['data:', 'blob:'].includes(u.protocol)) {
    external.push(request.url());
  }
});

/** What the folder holds, read out of it rather than through the application. */
const onDisk = () =>
  page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('slike');
    const files = {};
    for await (const [name, handle] of root.entries()) {
      /* Chrome writes through a `.crswap` beside the file and swaps it in, so
         a read in the middle of a save can meet one that is already gone. */
      if (handle.kind !== 'file' || name.endsWith('.crswap')) continue;
      try {
        const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
        files[name] = { size: bytes.length, head: [...bytes.slice(0, 3)] };
      } catch {
        // Gone between the listing and the read; the next look will see it.
      }
    }
    return files;
  });

try {
  await page.addInitScript(PICKER);
  await page.goto(url);
  await page.waitForSelector('.shell', { timeout: 30_000 });

  await page.keyboard.press('Control+k');
  await page.getByText('slika.png').first().waitFor({ timeout: 10_000 });
  await page.keyboard.press('Control+p');
  await page.locator('.palette input').fill('slika');
  await page.locator('.palette-item').first().waitFor({ timeout: 10_000 });
  await page.keyboard.press('Enter');
  await page.waitForSelector('.ul-img img', { timeout: 30_000 });
  check('the picture is open in the browser', true);

  const pane = page.locator('.ul-img:visible');
  const shown = () =>
    pane.locator('img').first().evaluate((img) => ({ width: img.naturalWidth, height: img.naturalHeight }));
  const cornerOf = (corner) =>
    pane.locator('img').first().evaluate((img, which) => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const x = which === 'top-right' ? img.naturalWidth - 2 : 1;
      const [r, g, b] = ctx.getImageData(x, 1, 1, 1).data;
      return [r, g, b];
    }, corner);
  const red = ([r, g, b]) => r > 200 && g < 70 && b < 70;

  check('the red corner is at the top-left to begin with', red(await cornerOf('top-left')));

  /* ── the tools are drawn, because there is a Rust core under this ──── */

  check('the editing tools are offered in a browser', (await pane.locator('.ul-img-crop').count()) === 1);
  check('and a format to save as', (await pane.locator('.ul-img-format').count()) === 1);

  /* ── a quarter turn, and the file has to agree with the window ─────── */

  const sizeBefore = (await onDisk())['slika.png']?.size;
  await pane.locator('.ul-img-rotate-right').click();
  await page.keyboard.press('Control+s');
  check(
    'the save reaches the file',
    await until(async () => (await onDisk())['slika.png']?.size !== sizeBefore),
    `${sizeBefore} → ${(await onDisk())['slika.png']?.size} bytes`,
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
  await page.mouse.move(box.x + 2, box.y + 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const beforeCrop = (await onDisk())['slika.png']?.size;
  await page.keyboard.press('Control+s');
  await until(async () => (await onDisk())['slika.png']?.size !== beforeCrop);
  await until(async () => (await shown()).height < 40);
  const cropped = await shown();
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
  await page.keyboard.press('Control+s');
  const hasJpeg = await until(async () => 'slika.jpg' in (await onDisk()));
  check('a JPEG is written beside the original rather than inside its name', hasJpeg, Object.keys(await onDisk()).join(', '));
  if (hasJpeg) {
    const head = (await onDisk())['slika.jpg'].head;
    check('and it really is a JPEG', head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff, head.map((b) => b.toString(16)).join(' '));
  }

  /* ── a photograph, and the page keeps drawing while it is written ─── */

  await page.keyboard.press('Control+p');
  await page.locator('.palette input').fill('fotografija');
  await page.locator('.palette-item').first().waitFor({ timeout: 10_000 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.ul-img img')].some((i) => i.naturalWidth === 4000), null, {
    timeout: 30_000,
  });
  const photo = page.locator('.ul-img:visible');
  await photo.locator('.ul-img-rotate-right').waitFor();
  const photoBefore = (await onDisk())['fotografija.jpg']?.size;
  await page.evaluate(() => {
    window.__longestFrame = 0;
    let last = performance.now();
    const tick = (now) => {
      window.__longestFrame = Math.max(window.__longestFrame, now - last);
      last = now;
      if (!window.__stopFrames) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const savedAt = Date.now();
  await photo.locator('.ul-img-rotate-right').click();
  await page.keyboard.press('Control+s');
  const photoSaved = await until(async () => (await onDisk())['fotografija.jpg']?.size !== photoBefore, 60_000);
  const saveMs = Date.now() - savedAt;
  const longest = await page.evaluate(() => {
    window.__stopFrames = true;
    return Math.round(window.__longestFrame);
  });
  check('a 12-megapixel photograph is turned and written', photoSaved, `${saveMs} ms`);
  check(
    'and the page never stops drawing for 200 ms while it is',
    longest < 200,
    `longest frame ${longest} ms over a ${saveMs} ms save`,
  );

  check(
    'the module came from the application itself',
    wasmFrom.length > 0 && wasmFrom.every((p) => p === '/wasm/ul_image_bg.wasm'),
    wasmFrom.join(', ') || 'no module was fetched',
  );
  check('no request left the application', external.length === 0, external.slice(0, 3).join(' | ') || 'no external requests');
  check('nothing threw in the page', errors.length === 0, errors.join(' | '));
  await page.screenshot({ path: resolve(ROOT, 'tools/screenshots/web-image.png') });
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await page.screenshot({ path: resolve(ROOT, 'tools/screenshots/failure-web-image.png') }).catch(() => {});
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
