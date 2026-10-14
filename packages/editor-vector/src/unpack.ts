/**
 * Unpacking a compressed drawing, apart from the viewer so a check can ask it
 * without the viewer's class (card 528).
 */

import { gunzipWithin, ArchiveTooLarge, ArchiveTooSlow } from '@uleditor/archive';
import { t } from '@uleditor/i18n';

/**
 * The most an `.svgz` unpacks to. A drawing, not a disk: a gzip of a few
 * kilobytes can claim gigabytes (card 528). Asked of the size its trailer
 * declares, and the stream given up as soon as it unpacks to more than that
 * (card 529: one declaring nothing, holding a gigabyte, had taken nine
 * seconds to come to nothing).
 */
export const MOST_SVG_BYTES = 64 * 1024 * 1024;

/** A drawing that would unpack to more than `MOST_SVG_BYTES`, or takes too long to. */
export class DrawingTooLarge extends Error {
  constructor(message = t('This file would unpack to more than this program opens at once, so it is not opened.')) {
    super(message);
  }
}

/** `.svgz` is gzipped SVG and nothing else — the same markup, one layer down. */
export function unpack(bytes: Uint8Array, extension: string): Uint8Array {
  const gzipped = extension === 'svgz' || (bytes[0] === 0x1f && bytes[1] === 0x8b);
  if (!gzipped) return bytes;
  try {
    return gunzipWithin(bytes, MOST_SVG_BYTES);
  } catch (err) {
    if (err instanceof ArchiveTooLarge) throw new DrawingTooLarge();
    if (err instanceof ArchiveTooSlow) throw new DrawingTooLarge(t('This file takes too long to unpack, so it is not opened.'));
    throw err;
  }
}
