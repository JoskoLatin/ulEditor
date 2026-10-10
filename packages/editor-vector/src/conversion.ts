/**
 * What the page offers for a drawing only LibreOffice reads, decided apart from
 * the page so that it can be checked without one (tools/verify-eps.mjs).
 */

import type { ConversionService } from '@uleditor/plugin-sdk';

/**
 * - `missing`: no LibreOffice here, and the page says so.
 * - `refused`: LibreOffice is here but not given this format on this system —
 *   PostScript outside Windows, where it would run it through Ghostscript
 *   (ul-convert, card 512). A button could only ever end in that refusal.
 * - `offered`: the button.
 */
export type ConversionOffer = 'missing' | 'refused' | 'offered';

export async function conversionOffer(convert: ConversionService, extension: string): Promise<ConversionOffer> {
  if (!(await convert.available())) return 'missing';
  /* A host that cannot say what it converts is taken at its word that it
     converts all of it, as before `formats` was asked. */
  if (convert.formats && !(await convert.formats()).includes(extension)) return 'refused';
  return 'offered';
}
