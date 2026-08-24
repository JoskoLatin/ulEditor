/**
 * The OLE2 compound file — the container under every old binary Office file.
 *
 * Before Office moved to ZIPs of XML, a `.doc` or an `.xls` was **a little file
 * system in a file**: a header, 512-byte sectors, a FAT saying which sector
 * follows which, a directory of named entries, and — for anything smaller than
 * 4 KB — a second, finer allocation inside a "mini stream" of 64-byte sectors.
 * A Word file is not one blob but several named streams (`WordDocument`,
 * `1Table`, `Data`) that reference each other by offset.
 *
 * This lives on its own rather than inside [`xls.ts`](./xls.ts), where it was
 * written, because the layer is genuinely shared: the same code opens the old
 * Excel and the old Word, and the two readers above it have nothing else in
 * common. What sits on top of the streams — BIFF records, a Word FIB — belongs
 * to each format's own file.
 */

const ENDOFCHAIN = 0xfffffffe;

/** Sector numbers from 0xFFFFFFFA up are markers, not sectors. */
const isSector = (n: number) => n < 0xfffffffa;

export class Cfb {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  readonly #sectorSize: number;
  readonly #fat: Uint32Array;
  readonly #miniFat: Uint32Array;
  readonly #miniCutoff: number;
  readonly #miniStream: Uint8Array;
  readonly #directory: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    this.#sectorSize = 1 << this.#view.getUint16(30, true);
    this.#miniCutoff = this.#view.getUint32(56, true);

    /* The FAT: which sector follows which. Its own sectors are listed in the
       header's DIFAT, and past 109 of them in a chain of DIFAT sectors. */
    const fatSectors: number[] = [];
    for (let i = 0; i < 109; i++) {
      const sect = this.#view.getUint32(76 + i * 4, true);
      if (isSector(sect)) fatSectors.push(sect);
    }
    let difat = this.#view.getUint32(68, true);
    const perDifat = this.#sectorSize / 4 - 1;
    for (let guard = 0; isSector(difat) && guard < 4096; guard++) {
      const at = this.#sectorOffset(difat);
      for (let i = 0; i < perDifat; i++) {
        const sect = this.#view.getUint32(at + i * 4, true);
        if (isSector(sect)) fatSectors.push(sect);
      }
      difat = this.#view.getUint32(at + perDifat * 4, true);
    }

    const perSector = this.#sectorSize / 4;
    this.#fat = new Uint32Array(fatSectors.length * perSector);
    fatSectors.forEach((sect, index) => {
      const at = this.#sectorOffset(sect);
      for (let i = 0; i < perSector; i++) {
        this.#fat[index * perSector + i] = this.#view.getUint32(at + i * 4, true);
      }
    });

    this.#directory = this.#readChain(this.#view.getUint32(48, true));

    const miniFatBytes = this.#readChain(this.#view.getUint32(60, true));
    this.#miniFat = new Uint32Array(Math.floor(miniFatBytes.length / 4));
    const miniView = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
    for (let i = 0; i < this.#miniFat.length; i++) this.#miniFat[i] = miniView.getUint32(i * 4, true);

    /* The mini stream — where every stream smaller than the cutoff lives — is
       itself an ordinary stream owned by the root entry. */
    const root = this.#entry(0);
    this.#miniStream = root ? this.#readChain(root.start, root.size) : new Uint8Array(0);
  }

  #sectorOffset(sect: number): number {
    return (sect + 1) * this.#sectorSize;
  }

  #readChain(start: number, size?: number): Uint8Array {
    const parts: Uint8Array[] = [];
    let sect = start;
    const visited = new Set<number>();
    while (isSector(sect) && !visited.has(sect)) {
      visited.add(sect);
      const at = this.#sectorOffset(sect);
      parts.push(this.#bytes.subarray(at, at + this.#sectorSize));
      sect = this.#fat[sect] ?? ENDOFCHAIN;
    }
    const whole = new Uint8Array(parts.length * this.#sectorSize);
    parts.forEach((part, index) => whole.set(part, index * this.#sectorSize));
    return size === undefined ? whole : whole.subarray(0, size);
  }

  #readMiniChain(start: number, size: number): Uint8Array {
    const out = new Uint8Array(size);
    let sect = start;
    let written = 0;
    const visited = new Set<number>();
    while (isSector(sect) && written < size && !visited.has(sect)) {
      visited.add(sect);
      const chunk = this.#miniStream.subarray(sect * 64, sect * 64 + 64);
      out.set(chunk.subarray(0, Math.min(64, size - written)), written);
      written += 64;
      sect = this.#miniFat[sect] ?? ENDOFCHAIN;
    }
    return out;
  }

  #entry(index: number): { name: string; type: number; start: number; size: number } | null {
    const at = index * 128;
    if (at + 128 > this.#directory.length) return null;
    const view = new DataView(this.#directory.buffer, this.#directory.byteOffset + at, 128);
    const nameLen = view.getUint16(64, true);
    if (nameLen < 2 || nameLen > 64) return null;
    let name = '';
    for (let i = 0; i < nameLen - 2; i += 2) name += String.fromCharCode(view.getUint16(i, true));
    return {
      name,
      type: view.getUint8(66),
      start: view.getUint32(116, true),
      size: view.getUint32(120, true),
    };
  }

  /** The named stream, or `null` — the caller decides what its absence means. */
  stream(...names: string[]): Uint8Array | null {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    for (let index = 0; index * 128 < this.#directory.length; index++) {
      const entry = this.#entry(index);
      if (!entry || entry.type !== 2 || !wanted.has(entry.name.toLowerCase())) continue;
      return entry.size < this.#miniCutoff
        ? this.#readMiniChain(entry.start, entry.size)
        : this.#readChain(entry.start, entry.size);
    }
    return null;
  }
}
