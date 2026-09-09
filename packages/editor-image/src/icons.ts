/**
 * The editing tools' icons.
 *
 * The same rules as [`editor-pdf/src/icons.ts`](../../editor-pdf/src/icons.ts)
 * and the shell's `Icons.tsx`: one stroke weight, one 16-unit grid, so the bar
 * inside a picture and the chrome around it are not two different programs.
 *
 * And the same reason for existing. `↺ ↻ ⇄ ⇅ ⬚` are typographic characters
 * pressed into service as pictures: the font decides what they look like, they
 * land at different heights beside one another, and `⬚` is a dotted square in
 * one font and a missing glyph in the next. The PDF bar was cleared of exactly
 * these five years of a habit; this one is not going to start it again.
 */

const NS = 'http://www.w3.org/2000/svg';

/**
 * Every arc here is a semicircle over the top of a circle centred at 8,8 with a
 * radius of 4.5 — `sweep 1` runs clockwise on a screen, where y grows downwards,
 * so the two turns are the same path with that one flag changed. The chevron at
 * the end is the arrowhead, pointing the way the picture will go.
 */
const PATHS: Record<string, string[]> = {
  rotateRight: ['M3.5 9A4.5 4.5 0 0 1 12.5 9', 'm10.7 7.2 1.8 1.8 1.8-1.8'],
  rotateLeft: ['M12.5 9A4.5 4.5 0 0 0 3.5 9', 'm1.7 7.2 1.8 1.8 1.8-1.8'],

  /* A mirror: the axis it happens about, and the two directions it sends the
     picture. Arrowheads pointing outwards rather than inwards — the picture
     moves away from the line, it is not squeezed onto it. */
  flipH: ['M8 2.5v11', 'M5.75 6 3 8l2.75 2', 'M10.25 6 13 8l-2.75 2'],
  flipV: ['M2.5 8h11', 'M6 5.75 8 3l2 2.75', 'M6 10.25 8 13l2-2.75'],

  /* Crop marks, the pair every camera and every darkroom easel has. */
  crop: ['M4.75 2.5v8.75h8.75', 'M2.5 4.75h8.75v8.75'],
};

/**
 * One icon as an element.
 *
 * `aria-hidden`, because the button carries a title and an accessible name of
 * its own — a screen reader announcing the drawing as well would say everything
 * twice.
 */
export function icon(name: keyof typeof PATHS | string): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ul-img-icon');

  for (const d of PATHS[name] ?? []) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }

  return svg;
}
