/**
 * Dohvat fonta u pregledniku.
 *
 * Odvojeno od [`text.ts`](./text.ts) jer je ovo jedini dio koji ovisi o Viteu i
 * o `fetch`-u — provjere pod Nodeom uvoze račun bez ovoga i čitaju font s
 * diska.
 *
 * Font stiže s pdf.js-om, koji ga ionako nosi za zamjenu standardnih PDF
 * fontova. Zato u repou nema priloženog fonta, a licenca (SIL OFL 1.1) ostaje
 * uz paket iz kojeg dolazi.
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

/** Isti izvor kao aplikacija — CSP dopušta `'self'`, a rad bez mreže ostaje. */
export const loadFontBytes: FontLoader = async (face) => {
  const response = await fetch(URLS[face]);
  if (!response.ok) throw new Error(`Font ${face} se ne da učitati (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
};

const registered = new Map<TextFace, Promise<void>>();

/**
 * Registrira isti font u pregledniku.
 *
 * Bez toga bi se okvir na ekranu crtao nekim sistemskim fontom, a u datoteku
 * bi otišao Liberation — pa bi se širina teksta razlikovala od onoga što je
 * korisnik vidio dok je tipkao. Na Windowsu bi razlika bila mala (Arial je
 * metrički jednak), na Androidu ne bi: ondje je zadani Roboto.
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
