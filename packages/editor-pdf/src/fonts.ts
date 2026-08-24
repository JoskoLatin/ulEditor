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
import boldItalicUrl from 'pdfjs-dist/standard_fonts/LiberationSans-BoldItalic.ttf?url';

import { FONT_FAMILY, TEXT_FACES, type FontLoader, type TextFace } from './text.js';

const URLS: Record<TextFace, string> = {
  sans: regularUrl,
  'sans-bold': boldUrl,
  'sans-italic': italicUrl,
  'sans-bold-italic': boldItalicUrl,
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
/* ── a document font the screen does not have ────────────────────────── */

let measureContext: CanvasRenderingContext2D | null | undefined;

/** Wide and narrow letters both, so two different fonts cannot tie by luck. */
const MEASURE_SAMPLE = 'mmmWWWiiil10 rijeci';

function widthIn(stack: string): number {
  if (measureContext === undefined) {
    measureContext = document.createElement('canvas').getContext('2d');
  }
  if (!measureContext) return 0;
  measureContext.font = `48px ${stack}`;
  return measureContext.measureText(MEASURE_SAMPLE).width;
}

/**
 * Whether the screen can already draw this family — installed on the machine,
 * or registered by an earlier fetch. What it decides is only how the box being
 * typed in is drawn; the file never depends on it.
 *
 * Measured, not asked: `document.fonts.check()` answers *"is anything still
 * loading for this?"* and says `true` for a family it has never heard of. So
 * the family is put in front of two fallbacks instead — if it changes the
 * metrics of neither, nothing on this machine answers to its name.
 */
export function screenHasFont(family: string): boolean {
  if (typeof document === 'undefined') return false;
  const quoted = `"${family.replace(/"/g, '')}"`;
  return (
    widthIn(`${quoted}, monospace`) !== widthIn('monospace') ||
    widthIn(`${quoted}, serif`) !== widthIn('serif')
  );
}

/**
 * `false` stays cached — a family Google Fonts does not carry will not appear
 * there between two clicks. A network failure is not cached, so the next click
 * tries again.
 */
const displayFetched = new Map<string, Promise<boolean>>();

/**
 * Fetches a missing family from Google Fonts and registers it for display.
 *
 * Display only, deliberately: an edited line still goes into the file with the
 * document's own embedded glyphs, or with ours. What this changes is the box
 * being typed in, which until then is drawn in a substitute the reader never
 * sees. Resolves `false` when Google Fonts does not carry the family or the
 * network is not there — the caller then falls back to a search.
 */
export async function fetchDisplayFont(family: string): Promise<boolean> {
  const existing = displayFetched.get(family);
  if (existing) return existing;

  const pending = (async () => {
    /* The four faces the toolbar can ask for. A family that only has some of
       them still registers — the browser synthesises the rest, which is what
       it would do for an installed font too. */
    const query = encodeURIComponent(family.trim()).replace(/%20/g, '+');
    const css = await fetch(
      `https://fonts.googleapis.com/css2?family=${query}:ital,wght@0,400;0,700;1,400;1,700`,
    );
    if (!css.ok) return false;

    const text = await css.text();
    const faces = [...text.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '');
    let registered = 0;
    for (const block of faces) {
      const url = /src:\s*url\((https:[^)\s]+)\)/.exec(block)?.[1];
      if (!url) continue;
      const style = /font-style:\s*(\w+)/.exec(block)?.[1] ?? 'normal';
      const weight = /font-weight:\s*(\d+)/.exec(block)?.[1] ?? '400';
      /* Bytes over connect-src rather than a url() FontFace: the CSP then
         needs no font-src of its own. */
      const bytes = await fetch(url);
      if (!bytes.ok) continue;
      const face = new FontFace(family, await bytes.arrayBuffer(), { style, weight });
      await face.load();
      document.fonts.add(face);
      registered += 1;
    }
    return registered > 0;
  })().catch(() => {
    displayFetched.delete(family);
    return false;
  });

  displayFetched.set(family, pending);
  return pending;
}

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
