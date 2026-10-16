/**
 * Unpacking a ZIP or a gzip within bounds of size and of time.
 *
 * A ZIP of a megabyte can hold a gigabyte of zeros in one part that says it
 * holds a hundred bytes. fflate unpacks such a part only as far as it says,
 * so memory was bounded (card 528), but it decodes the whole stream to get
 * there: six seconds for a gigabyte, ninety for four, in the page, with the
 * person's other documents in it (card 529). Here a part is decoded a slice
 * at a time and given up the moment it unpacks to more than it says, so the
 * work done for a lie is at most one slice's worth.
 *
 * The directory is walked as fflate's `unzipSync` walks it, the same
 * records read the same way (fflate 0.8.3, which every package pins), so
 * the bounds are asked of the very sizes the parts are then unpacked by,
 * and an honest archive unpacks to what `unzipSync` gives — byte for byte,
 * checked against the documents of the corpus. The bounds are the caller's:
 * an Office file, a book and a drawing each say their own.
 *
 * Shared because it is a parser: three copies of it would drift.
 */

import { Inflate, inflateSync } from 'fflate';

/** An archive that would unpack to more than its caller's bounds. */
export class ArchiveTooLarge extends Error {
  constructor() {
    super('the archive would unpack to more than its bounds');
  }
}

/** An archive whose records do not add up — a part that unpacks to more than it says among them. */
export class ArchiveDamaged extends Error {
  constructor(why: string) {
    super(why);
  }
}

/**
 * An archive that took longer to unpack than its caller allows. Deflate
 * can cost time without giving anything: fflate builds two tables of
 * 32 768 entries for every block, and an empty block takes 13 bytes, so a
 * megabyte of them took three seconds and gave nothing (the review of card
 * 529). A deadline, not a count, because what such a stream costs is
 * fflate's, not the format's.
 */
export class ArchiveTooSlow extends Error {
  constructor() {
    super('the archive took longer to unpack than its bounds allow');
  }
}

export interface ZipBounds {
  /** The most one part may unpack to — the same for every part, or asked
   *  by its name, for a format whose parts cost differently (card 530). */
  part: number | ((name: string) => number);
  /** The most all of them may unpack to together. */
  archive: number;
  /** The most parts. */
  parts: number;
  /** The most seconds all of it may take; `MOST_SECONDS` if not said. */
  seconds?: number;
}

/**
 * How long unpacking one archive may take. The most an honest one is let
 * unpack to, 128 MiB, took under a second here; five leaves a slower
 * machine room, and holds a stream of empty blocks to five seconds where a
 * file of 24 MiB of them took forty.
 */
export const MOST_SECONDS = 5;

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now());

/**
 * Compressed bytes handed to the decoder at a time. Deflate gives at most
 * about 1032 bytes for one, so a part that lies is given up within about
 * 17 MB of decoding however much it holds — measured, a megabyte holding a
 * gigabyte: some 50 ms, where decoding it whole took seconds. The price is
 * on the honest ones, decoded a slice at a time: 1.45 times fflate's own
 * time over the 102 Office files and books of the corpus (64 KiB slices:
 * 1.33 times, and 200 ms for the lie).
 */
export const SLICE = 16 * 1024;

const b2 = (d: Uint8Array, b: number): number => d[b]! | (d[b + 1]! << 8);
const b4 = (d: Uint8Array, b: number): number => (d[b]! | (d[b + 1]! << 8) | (d[b + 2]! << 16) | (d[b + 3]! << 24)) >>> 0;
const b8 = (d: Uint8Array, b: number): number => b4(d, b) + b4(d, b + 4) * 4294967296;

interface Part {
  name: string;
  compression: number;
  /** Its size in the file. */
  size: number;
  /** The size it says it unpacks to. */
  originalSize: number;
  /** Where its bytes begin. */
  at: number;
}

/** The sizes of a central record, from its ZIP64 extra field where it says so — fflate's `z64hs`. */
function sizes(d: Uint8Array, b: number, l: number, z: boolean, size: number, original: number, offset: number): [number, number, number] {
  const nsc = size === 4294967295;
  const nsu = original === 4294967295;
  const noff = offset === 4294967295;
  if (z && (nsc || nsu || noff)) {
    const e = b + l;
    for (; b + 4 < e; b += 4 + b2(d, b + 2)) {
      if (b2(d, b) === 1) {
        return [
          nsc ? b8(d, b + 4 + 8 * +nsu) : size,
          nsu ? b8(d, b + 4) : original,
          noff ? b8(d, b + 4 + 8 * (+nsu + +nsc)) : offset,
        ];
      }
    }
    throw new ArchiveDamaged('invalid zip data');
  }
  return [size, original, offset];
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 16384) out += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return out;
}

/** The parts the central directory lists, in its order — fflate's `unzipSync` walk. */
function directory(d: Uint8Array, most: number): Part[] {
  let e = d.length - 22;
  for (; b4(d, e) !== 0x6054b50; --e) {
    if (e <= 0 || d.length - e > 65558) throw new ArchiveDamaged('invalid zip data');
  }
  let count = b2(d, e + 8);
  if (!count) return [];
  let o = b4(d, e + 16);
  let z = b4(d, e - 20) === 0x7064b50;
  if (z) {
    const ze = b4(d, e - 12);
    z = b4(d, ze) === 0x6064b50;
    if (z) {
      count = b4(d, ze + 32);
      o = b4(d, ze + 48);
    }
  }
  /* Before any record is read: a directory end can claim four billion of
     them in a few bytes. */
  if (count > most) throw new ArchiveTooLarge();
  const parts: Part[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; ++i) {
    if (o + 46 > d.length || b4(d, o) !== 0x2014b50) throw new ArchiveDamaged('invalid zip data');
    const nameLength = b2(d, o + 28);
    const extraLength = b2(d, o + 30);
    const nameBytes = d.subarray(o + 46, o + 46 + nameLength);
    /* UTF-8 when the record says so (bit 11), else each byte its own
       character, as fflate's `strFromU8(…, latin1)` reads it. */
    const name = b2(d, o + 8) & 2048 ? decoder.decode(nameBytes) : latin1(nameBytes);
    const extra = o + 46 + nameLength;
    const [size, originalSize, offset] = sizes(d, extra, extraLength, z, b4(d, o + 20), b4(d, o + 24), b4(d, o + 42));
    /* Where its bytes begin is the local record's to say, by its own name
       and extra lengths, as `slzh` reads it. */
    if (offset + 30 > d.length || b4(d, offset) !== 0x4034b50) throw new ArchiveDamaged('invalid zip data');
    const at = offset + 30 + b2(d, offset + 26) + b2(d, offset + 28);
    if (at + size > d.length) throw new ArchiveDamaged('invalid zip data');
    /* A plain object holds the parts, as fflate's does, and this name
       would be its prototype, not a part (the review of card 529). */
    if (name === '__proto__') throw new ArchiveDamaged('invalid zip data');
    parts.push({ name, compression: b2(d, o + 10), size, originalSize, at });
    o = extra + extraLength + b2(d, o + 32);
  }
  return parts;
}

/** What fflate's streaming `Inflate` keeps of where it is: `f` once the last block is read, `l` while one is being read. */
interface InflateState {
  s?: { f?: number; l?: unknown };
}

/**
 * A deflate stream decoded a slice at a time, given up once it gives more
 * than `most` bytes, or once the time until `deadline` (on `now()`'s clock)
 * is out.
 */
export function inflateWithin(data: Uint8Array, most: number, deadline = now() + MOST_SECONDS * 1000): Uint8Array {
  if (!data.length) return new Uint8Array(0);
  /* A stream of one slice is decoded at once: the work is a slice's either
     way, and the streaming decoder's window and buffer, made for each part,
     had made ten thousand empty parts forty times slower than fflate. One
     byte more than it says is room enough to see it say too little. */
  if (data.length <= SLICE) {
    const got = inflateSync(data, { out: new Uint8Array(most + 1) });
    if (got.length > most) throw new ArchiveDamaged('a part unpacks to more than it says');
    return got.slice();
  }
  /* The size it says, as fflate makes it: the bounds were asked of it. */
  const out = new Uint8Array(most);
  let length = 0;
  const inflate = new Inflate((chunk) => {
    if (length + chunk.length > most) throw new ArchiveDamaged('a part unpacks to more than it says');
    out.set(chunk, length);
    length += chunk.length;
  });
  const state = (inflate as unknown as InflateState).s;
  for (let at = 0; at < data.length; at += SLICE) {
    inflate.push(data.subarray(at, at + SLICE), at + SLICE >= data.length);
    /* Once the last block is read, fflate keeps what follows and copies all
       of it again at every push without reading it — megabytes after the
       end took seconds, growing as their square (the review of card 529).
       What follows the end is not the part's: stop there. `f` and `l` are
       fflate 0.8.3's own, pinned; verify-archive-limits times what
       follows the end, so a renamed field shows. */
    if (state?.f && !state.l) break;
    if (now() > deadline) throw new ArchiveTooSlow();
  }
  return length === most ? out : out.slice(0, length);
}

/**
 * Every part of a ZIP, unpacked within `bounds`: the directory is read
 * first and alone, and asked of them before any part is unpacked — a stored
 * part at its packed size, a deflated one at the size it says; the packed
 * sizes together no more than the file, so parts cannot share bytes. Then
 * each is unpacked, and a deflated one that unpacks to more than it said is
 * given up as soon as it does.
 *
 * Throws `ArchiveTooLarge` past the bounds, `ArchiveTooSlow` past the
 * time, `ArchiveDamaged` for records that do not add up.
 */
export function unzipWithin(bytes: Uint8Array, bounds: ZipBounds): Record<string, Uint8Array> {
  const parts = directory(bytes, bounds.parts);
  let total = 0;
  let packed = 0;
  let count = 0;
  for (const part of parts) {
    count += 1;
    packed += part.size;
    const out = part.compression === 0 ? part.size : part.originalSize;
    total += out;
    const most = typeof bounds.part === 'number' ? bounds.part : bounds.part(part.name);
    if (count > bounds.parts || out > most || total > bounds.archive || packed > bytes.length) {
      throw new ArchiveTooLarge();
    }
  }
  const deadline = now() + (bounds.seconds ?? MOST_SECONDS) * 1000;
  const files: Record<string, Uint8Array> = {};
  for (const part of parts) {
    const data = bytes.subarray(part.at, part.at + part.size);
    if (part.compression === 0) files[part.name] = data.slice();
    else if (part.compression === 8) files[part.name] = inflateWithin(data, part.originalSize, deadline);
    else throw new ArchiveDamaged(`unknown compression type ${part.compression}`);
    /* After every part too: a part of one slice is decoded at once, with
       no look at the time, and a file of a thousand of them had gone
       round the deadline (the second review of card 529). */
    if (now() > deadline) throw new ArchiveTooSlow();
  }
  return files;
}

/** Where a gzip member's deflate stream begins — fflate's `gzs`. */
function gzipStart(d: Uint8Array): number {
  if (d[0] !== 31 || d[1] !== 139 || d[2] !== 8) throw new ArchiveDamaged('invalid gzip data');
  const flags = d[3]!;
  let st = 10;
  if (flags & 4) st += (d[10]! | (d[11]! << 8)) + 2;
  for (let zs = ((flags >> 3) & 1) + ((flags >> 4) & 1); zs > 0; zs -= +!d[st++]) {
    if (st >= d.length) throw new ArchiveDamaged('invalid gzip data');
  }
  return st + (flags & 2);
}

/**
 * A gzip unpacked within `most` bytes, as `gunzipSync` unpacks it — its
 * first member, by the size its trailer says — and given up as soon as it
 * unpacks to more than that, or takes longer than `seconds`.
 */
export function gunzipWithin(bytes: Uint8Array, most: number, seconds = MOST_SECONDS): Uint8Array {
  const start = gzipStart(bytes);
  if (start + 8 > bytes.length) throw new ArchiveDamaged('invalid gzip data');
  const said = b4(bytes, bytes.length - 4);
  if (said > most) throw new ArchiveTooLarge();
  return inflateWithin(bytes.subarray(start, -8), said, now() + seconds * 1000);
}
