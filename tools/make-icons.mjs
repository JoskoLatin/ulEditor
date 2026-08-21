/**
 * The application icon generator.
 *
 * PNG and ICO are written by hand rather than through `tauri icon`, so the build
 * depends on no extra tool and no binary asset in the repository — the icon is
 * derived from the same tokens as the rest of the interface.
 *
 *   node tools/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'apps/desktop/src-tauri/icons');

/* ── PNG zapis ───────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** @param {Uint8Array} rgba RGBA pikseli, `size * size * 4` bajta. */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // dubina po kanalu
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Every row gets filter byte 0 — no prediction, but the icons are small.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const offset = y * (size * 4 + 1);
    raw[offset] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, offset + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── crtanje ─────────────────────────────────────────────────────────── */

const GROUND = [10, 16, 19, 255];
const TEAL = [63, 178, 187, 255];
const PAPER = [232, 241, 242, 255];
const AMBER = [217, 162, 74, 255];

function blend(dst, index, color, alpha) {
  for (let c = 0; c < 3; c++) {
    dst[index + c] = Math.round(dst[index + c] * (1 - alpha) + color[c] * alpha);
  }
  dst[index + 3] = Math.max(dst[index + 3], Math.round(255 * alpha));
}

/**
 * The mark: three stacked sheets of paper — the three architectural layers and
 * "many formats, one window" at once. The edges are smoothed by 3×3
 * supersampling.
 */
function draw(size) {
  const px = new Uint8Array(size * size * 4);
  const S = size;
  const u = S / 32; // the grid unit; the icon is designed on a 32×32

  const roundedRect = (x, y, w, h, r) => (fx, fy) => {
    if (fx < x || fy < y || fx > x + w || fy > y + h) return false;
    const cx = Math.min(Math.max(fx, x + r), x + w - r);
    const cy = Math.min(Math.max(fy, y + r), y + h - r);
    return (fx - cx) ** 2 + (fy - cy) ** 2 <= r * r;
  };

  const layers = [
    { shape: roundedRect(7 * u, 5 * u, 17 * u, 21 * u, 2 * u), color: TEAL },
    { shape: roundedRect(5 * u, 7 * u, 17 * u, 21 * u, 2 * u), color: PAPER },
  ];
  const background = roundedRect(0, 0, S, S, 7 * u);
  const accent = roundedRect(8 * u, 12 * u, 8 * u, 1.6 * u, 0.8 * u);
  const line1 = roundedRect(8 * u, 16 * u, 11 * u, 1.4 * u, 0.7 * u);
  const line2 = roundedRect(8 * u, 19.5 * u, 7 * u, 1.4 * u, 0.7 * u);

  const SAMPLES = 3;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const index = (y * S + x) * 4;

      const coverage = (shape) => {
        let hits = 0;
        for (let sy = 0; sy < SAMPLES; sy++) {
          for (let sx = 0; sx < SAMPLES; sx++) {
            const fx = x + (sx + 0.5) / SAMPLES;
            const fy = y + (sy + 0.5) / SAMPLES;
            if (shape(fx, fy)) hits++;
          }
        }
        return hits / (SAMPLES * SAMPLES);
      };

      const bg = coverage(background);
      if (bg === 0) continue;
      blend(px, index, GROUND, bg);

      for (const layer of layers) {
        const a = coverage(layer.shape) * bg;
        if (a > 0) blend(px, index, layer.color, a);
      }

      const a1 = coverage(accent) * bg;
      if (a1 > 0) blend(px, index, AMBER, a1);
      for (const line of [line1, line2]) {
        const a = coverage(line) * bg;
        if (a > 0) blend(px, index, GROUND, a * 0.72);
      }
    }
  }

  return px;
}

/* ── ICO kontejner ───────────────────────────────────────────────────── */

function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = ikona
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + pngs.length * 16;

  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 0 means 256
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bitova po pikselu
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

/* ── execution ───────────────────────────────────────────────────────── */

await mkdir(OUT, { recursive: true });

const PNG_SIZES = [32, 128, 256, 512];
const rendered = new Map();

for (const size of PNG_SIZES) {
  const data = encodePng(draw(size), size);
  rendered.set(size, data);
}

await writeFile(resolve(OUT, '32x32.png'), rendered.get(32));
await writeFile(resolve(OUT, '128x128.png'), rendered.get(128));
await writeFile(resolve(OUT, '128x128@2x.png'), rendered.get(256));
await writeFile(resolve(OUT, 'icon.png'), rendered.get(512));

const ico = encodeIco(
  [16, 32, 48, 256].map((size) => ({
    size,
    data: rendered.get(size) ?? encodePng(draw(size), size),
  })),
);
await writeFile(resolve(OUT, 'icon.ico'), ico);

console.log(`Ikone zapisane u ${OUT}`);
for (const name of ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.ico']) {
  console.log(`  ${name}`);
}
