/**
 * Prepisivanje teksta koji je već u dokumentu.
 *
 * Izmjena je sastavljena od dvije stvari koje projekt već ima: stari se redak
 * **makne iz sadržaja** (vidi [`redact.ts`](./redact.ts)), a novi se **upiše
 * kao tekst** (vidi [`text.ts`](./text.ts)). Ništa se ne prekriva i ništa ne
 * ostaje ispod.
 *
 * Piše se **našim ugrađenim fontom**, ne izvornim. To je svjestan izbor s
 * cijenom koju treba znati:
 *
 * - Za Helveticu i Arial razlike nema — Liberation Sans je napravljen da im
 *   se širine poklapaju, pa prepisani redak sjedne točno kao stari.
 * - Za sve ostalo veličina, boja i položaj ostaju isti, ali oblik slova nije.
 *   To se kaže prije nego se počne tipkati, a ne poslije spremanja.
 *
 * Zašto ne izvornim fontom: ugrađeni podskup sadrži samo glifove koje je
 * dokument već koristio. Čim se dopiše slovo kojeg ondje nema — a `č`, `ć`,
 * `ž`, `š` i `đ` u tuđim dokumentima gotovo nikad nema — ispalo bi prazno
 * mjesto usred rečenice.
 */

import type { PDFPage } from 'pdf-lib';
import { t } from '@uleditor/i18n';

import type { Rect, Rgb } from './annotations.js';
import { boundsOfOperation, readPageContent, textOf } from './content.js';
import type { StandardWidths } from './text.js';

/** Redak dokumenta ponuđen na prepisivanje. */
export interface EditableLine {
  text: string;
  /** Područje koje zauzima; iz njega nastaje oznaka za brisanje. */
  bounds: Rect;
  /** Početak osnovne linije — po njemu se poravnava zamjena. */
  origin: { x: number; y: number };
  size: number;
  color: Rgb;
  baseFont: string;
  /** Koliko glifova odlazi; pokazuje se prije potvrde. */
  glyphs: number;
  /**
   * Poklapaju li se mjere našeg fonta s izvornim.
   *
   * Kad ne, zamjena je iste veličine i na istom mjestu, ali drukčijeg oblika
   * slova — pa se to kaže unaprijed.
   */
  metricsMatch: boolean;
}

/** Fontovi kojima Liberation Sans odgovara u širinu, znak za znak. */
function matchesOurMetrics(baseFont: string): boolean {
  const lower = baseFont.toLowerCase();
  return lower.startsWith('helvetica') || lower.startsWith('arial') || lower.startsWith('liberationsans');
}

/**
 * Traži redak pod zadanom točkom.
 *
 * Jedinica je jedna naredba iz toka sadržaja, jer je to jedini komad za koji
 * se pouzdano zna gdje počinje i gdje završava. Vizualni redak zna biti
 * razlomljen na više naredbi; tada se prepisuje samo dio pod prstom, a
 * korisniku se pokaže točno koji.
 */
export function findEditableLine(
  page: PDFPage,
  point: { x: number; y: number },
  standard?: StandardWidths,
): { line: EditableLine } | { refusal: string } | null {
  const content = readPageContent(page, standard);

  for (const operation of content.operations) {
    const bounds = boundsOfOperation(operation);
    if (!bounds) continue;
    if (
      point.x < bounds.x ||
      point.x > bounds.x + bounds.width ||
      point.y < bounds.y ||
      point.y > bounds.y + bounds.height
    ) {
      continue;
    }

    if (operation.renderMode === 3) {
      // Nevidljiv tekst je sloj iz prepoznavanja; mijenja se slika ispod, ne on.
      return { refusal: t('That text is invisible — it is a recognition layer, not the page.') };
    }
    if (!operation.axisAligned) {
      return { refusal: t('That text is rotated or skewed, so it cannot be retyped in place.') };
    }
    if (operation.horizontalScale !== 1) {
      return { refusal: t('That text is horizontally stretched, so a replacement would not match.') };
    }
    if (!operation.fill) {
      return { refusal: t('The colour of that text comes from a colour space we do not read.') };
    }

    const text = textOf(operation);
    if (text === null) {
      return {
        refusal: t('That text cannot be read back as letters — the font has no /ToUnicode map.'),
      };
    }

    const glyphs = operation.parts.reduce(
      (sum, part) => sum + (part.kind === 'glyphs' ? part.glyphs.length : 0),
      0,
    );

    return {
      line: {
        text,
        bounds,
        origin: operation.origin,
        size: operation.effectiveSize,
        color: operation.fill,
        baseFont: operation.font.baseFont,
        glyphs,
        metricsMatch: matchesOurMetrics(operation.font.baseFont),
      },
    };
  }

  return null;
}

/** Upozorenje kad se oblik slova neće poklopiti s izvornim. */
export function metricsWarning(line: EditableLine): string | null {
  if (line.metricsMatch) return null;
  return t('{font} is not the font we write with — size and position stay, the letterforms change.', {
    font: line.baseFont || t('The original font'),
  });
}
