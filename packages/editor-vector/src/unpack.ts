/**
 * Unpacking a compressed drawing, apart from the viewer so a check can ask it
 * without the viewer's class (card 528).
 */

import { gunzipSync } from 'fflate';
import { t } from '@uleditor/i18n';

/**
 * The most an `.svgz` unpacks to. A drawing, not a disk: a gzip of a few
 * kilobytes can claim gigabytes (card 528). Asked of the size its trailer
 * declares, which fflate keeps to — measured, one declaring 100 bytes of
 * fifty megabytes came out 100 bytes.
 */
export const MOST_SVG_BYTES = 64 * 1024 * 1024;

/** A drawing that would unpack to more than `MOST_SVG_BYTES`. */
export class DrawingTooLarge extends Error {
  constructor() {
    super(t('This file would unpack to more than this program opens at once, so it is not opened.'));
  }
}

/** `.svgz` is gzipped SVG and nothing else — the same markup, one layer down. */
export function unpack(bytes: Uint8Array, extension: string): Uint8Array {
  const gzipped = extension === 'svgz' || (bytes[0] === 0x1f && bytes[1] === 0x8b);
  if (!gzipped) return bytes;
  const declared =
    bytes.length >= 4 ? new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 4, 4).getUint32(0, true) : 0;
  if (declared > MOST_SVG_BYTES) throw new DrawingTooLarge();
  return gunzipSync(bytes);
}
