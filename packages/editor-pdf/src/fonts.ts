/**
 * Fetching the font in the browser.
 *
 * Kept apart from [`text.ts`](./text.ts) because this is the only part that
 * depends on Vite and on `fetch` — the checks under Node import the maths
 * without it and read the font off disk.
 *
 * The font arrives with pdf.js, which carries it anyway to substitute the
 * standard PDF fonts. So no font is committed to the repository, and its licence
 * (SIL OFL 1.1) stays with the package it comes from.
 */

import regularUrl from 'pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf?url';
import boldUrl from 'pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf?url';
import italicUrl from 'pdfjs-dist/standard_fonts/LiberationSans-Italic.ttf?url';

import { FONT_FAMILY, TEXT_FACES, type FontLoader, type TextFace } from './text.js';

const URLS: Record<TextFace, string> = {
  sans: regularUrl,
  'sans-bold': boldUrl,
  'sans-italic': italicUrl,
};

/** The same origin as the application — the CSP allows `'self'`, and offline use survives. */
export const loadFontBytes: FontLoader = async (face) => {
  const response = await fetch(URLS[face]);
  if (!response.ok) throw new Error(`Font ${face} could not be loaded (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
};

const registered = new Map<TextFace, Promise<void>>();

/**
 * Registers the same font in the browser.
 *
 * Without it the box on screen would be drawn in some system font while
 * Liberation went into the file — so the text width would differ from what the
 * user saw while typing. On Windows the difference would be small (Arial is
 * metrically identical); on Android it would not, since the default there is
 * Roboto.
 */
export function ensureWebFont(face: TextFace): Promise<void> {
  const existing = registered.get(face);
  if (existing) return existing;

  const entry = TEXT_FACES.find((f) => f.id === face);
  const pending = (async () => {
    if (!entry || typeof FontFace === 'undefined') return;
    const font = new FontFace(FONT_FAMILY, `url(${URLS[face]})`, {
      weight: String(entry.weight),
      style: entry.style,
    });
    await font.load();
    document.fonts.add(font);
  })();

  registered.set(face, pending);
  void pending.catch(() => registered.delete(face));
  return pending;
}
