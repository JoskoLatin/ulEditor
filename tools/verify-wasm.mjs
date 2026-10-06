/**
 * The Rust the browser runs, run — before any page is involved.
 *
 * `tools/wasm-assets.mjs` builds `ul-image` to WebAssembly (ADR 0002). What
 * this proves is that the thing it built works through the glue `wasm-bindgen`
 * wrote for it, which is where a mismatch between the two halves would show:
 * a picture goes in, is turned, and the pixels are looked at where they landed.
 * A turn in the wrong direction produces a perfectly valid picture, so the
 * picture has a corner that can be told apart and the check reads the corner.
 *
 * The output is asked for as a BMP because a BMP can be read in twenty lines;
 * the input is a PNG because that is the decoder a person's files go through.
 *
 *   node tools/wasm-assets.mjs
 *   node tools/verify-wasm.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'packages/shell-ui/public/wasm');
/** What one crate may cost a browser to download, compressed. */
const MOST_GZIP = 400 * 1024;

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}
function finish() {
  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

if (!existsSync(resolve(DIR, 'ul_image_bg.wasm'))) {
  check('a built module to run', false, 'none — run `node tools/wasm-assets.mjs` first');
  finish();
}

const glue = await import(pathToFileURL(resolve(DIR, 'ul_image.js')).href);
glue.initSync({ module: readFileSync(resolve(DIR, 'ul_image_bg.wasm')) });

/** A PNG, `width`×`height`, white with a red top-left pixel. */
function cornerPng(width, height, claim = null) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(claim?.width ?? width, 0);
  header.writeUInt32BE(claim?.height ?? height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(height * (1 + width * 4), 0xff);
  for (let y = 0; y < height; y++) rows[y * (1 + width * 4)] = 0; // filter: none
  rows.set([255, 0, 0, 255], 1); // (0,0) red
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** A BMP's size and the colour at (x, y), counted from the top. */
function readBmp(bytes) {
  const view = Buffer.from(bytes);
  const offset = view.readUInt32LE(10);
  const width = view.readInt32LE(18);
  const rawHeight = view.readInt32LE(22);
  const height = Math.abs(rawHeight);
  const bpp = view.readUInt16LE(28);
  const stride = Math.ceil((bpp * width) / 32) * 4;
  const at = (x, y) => {
    const row = rawHeight > 0 ? height - 1 - y : y;
    const i = offset + row * stride + x * (bpp / 8);
    return [view[i + 2], view[i + 1], view[i]]; // stored as BGR
  };
  return { width, height, at };
}
const isRed = ([r, g, b]) => r > 200 && g < 50 && b < 50;

/* ── what it is ──────────────────────────────────────────────────────── */

const png = cornerPng(4, 2);
const info = glue.imageInfo(png);
check(
  'imageInfo reads the size and the format',
  info.width === 4 && info.height === 2 && info.encoding === 'png' && info.editable && !info.reoriented,
  JSON.stringify(info),
);

/* ── a quarter turn, clockwise ───────────────────────────────────────── */

const applied = glue.imageApply(png, { rotate: 90, encoding: 'bmp' });
const out = applied.takeBytes();
const written = applied.written;
applied.free();
const bmp = readBmp(out);
check('the turned picture is two wide and four high', bmp.width === 2 && bmp.height === 4, `${bmp.width}×${bmp.height}`);
check(
  'and the red corner went to the top right, not the bottom left',
  isRed(bmp.at(1, 0)) && !isRed(bmp.at(0, 0)) && !isRed(bmp.at(0, 3)),
  `top right ${bmp.at(1, 0)}, top left ${bmp.at(0, 0)}`,
);
check(
  'what it says it wrote is what it wrote',
  written.width === 2 && written.height === 4 && written.encoding === 'bmp' && written.bytes === out.length && !written.lossy,
  JSON.stringify(written),
);

/* ── a TIFF, which a webview cannot draw, as a PNG it can ────────────── */

{
  const made = glue.imageApply(png, { encoding: 'tiff' });
  const tiff = made.takeBytes();
  made.free();
  const shown = glue.imagePreview(tiff);
  const isPng = shown[0] === 0x89 && shown[1] === 0x50 && shown[2] === 0x4e && shown[3] === 0x47;
  const back = glue.imageApply(shown, { encoding: 'bmp' });
  const seen = readBmp(back.takeBytes());
  back.free();
  check(
    'a TIFF is previewed as a PNG of the same picture',
    isPng && seen.width === 4 && seen.height === 2 && isRed(seen.at(0, 0)) && !isRed(seen.at(3, 1)),
    `${isPng ? 'PNG' : 'not PNG'}, ${seen.width}×${seen.height}, corner ${seen.at(0, 0)}`,
  );
}

/* ── what somebody else's file may not do ────────────────────────────── */

let refused = '';
try {
  glue.imageInfo(cornerPng(4, 2, { width: 20_000, height: 20_000 }));
} catch (err) {
  refused = String(err);
}
check('a header claiming 400 megapixels is refused, not allocated', /too large/.test(refused), refused || 'accepted');

let resized = '';
try {
  glue.imageApply(png, { resize: { width: 20_000, height: 20_000 } });
} catch (err) {
  resized = String(err);
}
check('and so is a resize to that size', /too large/.test(resized), resized || 'accepted');

let unknown = '';
try {
  glue.imageApply(png, { rotate: 'sideways' });
} catch (err) {
  unknown = String(err);
}
check('a plan that is not a plan is an error, not a guess', unknown.length > 0, unknown || 'accepted');

check(
  'and after all three the same instance still works',
  glue.imageInfo(png).width === 4,
);

/* ── what it costs to download ───────────────────────────────────────── */

const manifest = JSON.parse(readFileSync(resolve(DIR, 'manifest.json'), 'utf8'));
const gz = manifest.files['ul_image_bg.wasm']?.gzip ?? Infinity;
check(
  `ul-image is at most ${MOST_GZIP / 1024} KB to download`,
  gz <= MOST_GZIP,
  `${Math.round(gz / 1024)} KB gzipped, wasm-bindgen ${manifest.wasmBindgen}`,
);

finish();
