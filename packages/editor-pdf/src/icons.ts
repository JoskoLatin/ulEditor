/**
 * The toolbar's icons.
 *
 * One set, one stroke weight, one 16-unit grid — the same rules as the shell's
 * [`Icons.tsx`](../../shell-ui/src/components/Icons.tsx), so the bar inside a
 * document and the chrome around it do not look like two different programs.
 * They cannot be the same file: the shell is React, this is plain DOM.
 *
 * Why icons at all, when the bar used to carry `⌖`, `▬`, `〰` and `T✎`. Those
 * are typographic characters pressed into service as pictures: the font decides
 * what they look like, they land off the baseline next to one another, and half
 * of them mean nothing to anybody who has not been told. A drawn set is read at
 * a glance and looks the same on every machine.
 */

const NS = 'http://www.w3.org/2000/svg';

/** The letterforms, drawn rather than typed, so `B` and `I` sit on the same grid. */
const PATHS: Record<string, string[]> = {
  /* ── view ────────────────────────────────────────────────────────── */
  pages: ['M2.25 2.75h11.5v10.5H2.25z', 'M6.25 2.75v10.5'],
  prev: ['m9.75 3.5-4.5 4.5 4.5 4.5'],
  next: ['m6.25 3.5 4.5 4.5-4.5 4.5'],
  zoomOut: ['M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z', 'M10.4 10.4 14 14', 'M5 7h4'],
  zoomIn: [
    'M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z',
    'M10.4 10.4 14 14',
    'M5 7h4',
    'M7 5v4',
  ],
  fitWidth: ['M2 3.25v9.5', 'M14 3.25v9.5', 'M4.75 8h6.5', 'm6.5 6-2 2 2 2', 'm9.5 6 2 2-2 2'],
  fitPage: [
    'M3.25 2.75h9.5v10.5h-9.5z',
    'M6 5.5h4',
    'm8 5.5-.001 5',
    'm6.5 7 1.5-1.5L9.5 7',
    'm6.5 9 1.5 1.5L9.5 9',
  ],

  download: ['M8 2.75v7.5', 'm5.25 7.5 2.75 2.75 2.75-2.75', 'M2.75 13.25h10.5'],

  /* ── tools ───────────────────────────────────────────────────────── */
  cursor: ['M3.5 2.25 12 8.4l-3.6.5-1.6 3.3z'],
  highlight: ['M4.25 8.5 9.5 3.25l3.25 3.25-5.25 5.25H4.25z', 'M2.5 14.25h11'],
  note: ['M2.25 3.75h11.5v7.5H7.5l-3.25 2.5v-2.5H2.25z'],
  ink: ['M2.5 11.5c2.5-6 4-6 5.5-2s3 4 5.5-2', 'M2.5 14.25h11'],
  textAdd: ['M2.75 4.25V2.75h8v1.5', 'M6.75 2.75v10.5', 'M4.75 13.25h4', 'M11.5 9.5h3.5', 'M13.25 7.75v3.5'],
  textEdit: [
    'M2.25 4.25V2.75h8v1.5',
    'M6.25 2.75v10.5',
    'M4.25 13.25h4',
    'm10.75 13.75 3.5-3.5-1.5-1.5-3.5 3.5-.5 2z',
  ],
  erase: ['M6.5 13.25 2.75 9.5l6-6 3.75 3.75-5.5 5.5z', 'M6.5 13.25h6.75', 'm5.5 6.75 3.75 3.75'],

  /* ── the letterforms ─────────────────────────────────────────────── */
  bold: [
    'M4.75 3h3.75a2.25 2.25 0 0 1 0 4.5H4.75z',
    'M4.75 7.5h4.25a2.5 2.5 0 0 1 0 5H4.75z',
  ],
  italic: ['M6.5 3h5', 'M4.5 13h5', 'm9.5 3-3 10'],
  underline: ['M4.5 2.75v5.5a3.5 3.5 0 0 0 7 0V2.75', 'M3.75 13.25h8.5'],
};

/**
 * One icon as an element.
 *
 * `aria-hidden`, because every button carries a title and an accessible name of
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
  svg.classList.add('ul-pdf-icon');

  for (const d of PATHS[name] ?? []) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }

  return svg;
}
