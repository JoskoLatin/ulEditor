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
/* Without the service worker: this watches and refuses the module's own
   requests, and a worker in between answers them where Playwright cannot see.
   The worker has its own check, tools/verify-web-offline.mjs. */
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
const page = await context.newPage();
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

/**
 * The pane showing a picture `width` pixels wide, once it is in front — marked,
 * so the clicks that follow go to it and not to a tab being hidden beside it.
 * With three pictures open, `.ul-img:visible` can catch one on its way out.
 */
async function paneOf(width, mark) {
  await page.waitForFunction(
    ([w, m]) => {
      const pane = [...document.querySelectorAll('.ul-img')].find(
        (p) => p.offsetParent !== null && p.querySelector('img')?.naturalWidth === w,
      );
      if (pane) pane.dataset.underTest = m;
      return !!pane;
    },
    [width, mark],
    { timeout: 30_000 },
  );
  return page.locator(`.ul-img[data-under-test="${mark}"]`);
}

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

  /* ── and a second change of format does not replace what the first wrote ─ */

  if (hasJpeg) {
    const jpegBefore = (await onDisk())['slika.jpg'];
    await page.keyboard.press('Control+p');
    await page.locator('.palette input').fill('slika.png');
    await page.locator('.palette-item').first().waitFor({ timeout: 10_000 });
    await page.keyboard.press('Enter');
    // The PNG as the crop left it, 16 × 18, and in front. The JPEG beside it
    // is 16 wide too, so the tab has to say which one is in front first.
    await page
      .locator('.tab.active, .tab[data-active="true"]', { hasText: 'slika.png' })
      .first()
      .waitFor({ timeout: 15_000 });
    const again = await paneOf(16, 'png-again');
    await again.locator('.ul-img-format').waitFor();
    await again.locator('.ul-img-rotate-right').click();
    await again.locator('.ul-img-format').selectOption('jpeg');
    await page.keyboard.press('Control+s');
    const said = await page
      .locator('.toast', { hasText: 'already exists' })
      .first()
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    const jpegAfter = (await onDisk())['slika.jpg'];
    check(
      'a plain save does not replace a file that already has the name',
      said && jpegAfter?.size === jpegBefore?.size,
      `${jpegBefore?.size} → ${jpegAfter?.size} bytes${said ? ', and it says so' : ', nothing said'}`,
    );

    /* And one the program has never seen: made beside it by something else,
       after the folder was listed. Not knowing it is not the same as it not
       being there. */
    await page.evaluate(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('slike');
      const out = await (await root.getFileHandle('slika.webp', { create: true })).createWritable();
      await out.write('not mine to replace');
      await out.close();
    });
    await page.locator('.toast .toast-close, .toast button').first().click().catch(() => {});
    await again.locator('.ul-img-format').selectOption('webp');
    await page.keyboard.press('Control+s');
    const saidAgain = await page
      .locator('.toast', { hasText: 'slika.webp already exists' })
      .first()
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    const foreign = (await onDisk())['slika.webp'];
    check(
      'nor one made outside the program after the folder was read',
      saidAgain && foreign?.size === 'not mine to replace'.length,
      `${foreign?.size} bytes${saidAgain ? ', and it says so' : ', nothing said'}`,
    );
  }

  /* ── a photograph, and the page keeps drawing while it is written ─── */

  await page.keyboard.press('Control+p');
  await page.locator('.palette input').fill('fotografija');
  await page.locator('.palette-item').first().waitFor({ timeout: 10_000 });
  await page.keyboard.press('Enter');
  const photo = await paneOf(4000, 'photo');
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
  /* Judged against the save itself, not a fixed 200 ms: the macOS runner once
     drew a 313 ms frame over a 2069 ms save on unchanged code. Off the main
     thread the longest frame is 1% of the save on the Ubuntu runner, 6% here
     and 15% at the macOS runner's worst; the same save done on the main
     thread stops the page for 81% of it (1333 ms of 1645). The line is 40%,
     and a whole second stays as a loose fence. */
  check(
    'and the page keeps drawing while it is, not stopping for most of the save',
    longest < saveMs * 0.4 && longest < 1000,
    `longest frame ${longest} ms over a ${saveMs} ms save — ${Math.round((100 * longest) / saveMs)}%`,
  );

  /* ── a module that failed to arrive once is fetched again ─────────── */

  {
    // The same context, so the same origin-private folder.
    const fresh = await context.newPage();
    let refused = 0;
    // The glue, not the module: a failed import() is what a worker remembers.
    await fresh.route('**/wasm/ul_image.js', (route) => {
      if (refused++ === 0) return route.abort();
      return route.continue();
    });
    await fresh.goto(url);
    await fresh.waitForSelector('.shell', { timeout: 30_000 });
    /* The folder is the one already written; the picker hands it back. */
    await fresh.evaluate(() => {
      window.showDirectoryPicker = async () =>
        (await navigator.storage.getDirectory()).getDirectoryHandle('slike');
    });
    await fresh.keyboard.press('Control+k');
    await fresh.getByText('fotografija.jpg').first().waitFor({ timeout: 10_000 });
    await fresh.keyboard.press('Control+p');
    await fresh.locator('.palette input').fill('slika.png');
    await fresh.locator('.palette-item').first().waitFor({ timeout: 10_000 });
    await fresh.keyboard.press('Enter');
    await fresh.waitForSelector('.ul-img img', { timeout: 30_000 });
    const sizeOf = () =>
      fresh.evaluate(async () => {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('slike');
        return (await (await root.getFileHandle('slika.png')).getFile()).size;
      });
    // The first ask, at opening, is the one refused.
    await until(async () => refused > 0, 10_000);
    const before = await sizeOf();
    await fresh.locator('.ul-img:visible .ul-img-rotate-right').click();
    await fresh.keyboard.press('Control+s');
    const recovered = await until(async () => (await sizeOf()) !== before, 20_000);
    check(
      'a module that failed to load is fetched again on the next edit',
      refused >= 2 && recovered,
      `${refused} fetches, ${before} → ${await sizeOf()} bytes`,
    );
    await fresh.close();
  }

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
