import type { ReactElement } from 'react';
import type { FormatFamily } from '@uleditor/plugin-sdk';

/**
 * Arak's icons, drawn here: lines in the colour of the text around them
 * (`currentColor`), on a 24-unit grid, after the prototype's
 * (`tools/screenshots/mobile-od-nule/koncept-2`). No icon package: nine shapes
 * do not need one, and a font or sprite from elsewhere would be one more file
 * to vouch for.
 */

type Shape = 'search' | 'up' | 'down' | 'check' | 'grid' | 'putAway';

const SHAPES: Record<Shape, ReactElement> = {
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.4 15.4 20.5 20.5" />
    </>
  ),
  up: <path d="M6 15l6-6 6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  grid: (
    <>
      <rect x="4" y="3.5" width="7" height="9" rx="1" />
      <rect x="13" y="3.5" width="7" height="6" rx="1" />
      <rect x="4" y="14.5" width="7" height="6" rx="1" />
      <rect x="13" y="11.5" width="7" height="9" rx="1" />
    </>
  ),
  putAway: (
    <>
      <path d="M5.5 13.5v6h13v-6" />
      <path d="M12 3v11m-4-4 4 4 4-4" />
    </>
  ),
};

export function Icon({ shape, size = 24 }: { shape: Shape; size?: number }) {
  return (
    <svg className="arak-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {SHAPES[shape]}
    </svg>
  );
}

/** A page outline every format's mark is drawn on. */
const PAGE = <path d="M6 2.5h8.5l3.5 3.5v15.5H6z" />;

const FAMILIES: Record<FormatFamily, ReactElement> = {
  /* A page laid out once and for all: a picture block above its lines. */
  fixed: (
    <>
      {PAGE}
      <path d="M14.5 2.5V6H18" />
      <rect x="8.5" y="8.5" width="7" height="4.5" rx="0.5" />
      <path d="M8.5 15.5h7M8.5 18.5h4.5" />
    </>
  ),
  document: (
    <>
      {PAGE}
      <path d="M14.5 2.5V6H18" />
      <path d="M8.5 9.5h7M8.5 12.5h7M8.5 15.5h7M8.5 18.5h4" />
    </>
  ),
  sheet: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M3.5 9.5h17M3.5 14.5h17M9 4.5v15M14.5 4.5v15" />
    </>
  ),
  slides: (
    <>
      <rect x="3" y="4.5" width="18" height="12" rx="1.5" />
      <path d="M12 16.5v3.5M8.5 20h7M7 8.5h6M7 11.5h10" />
    </>
  ),
  book: (
    <>
      <path d="M3 5.5c3-1.3 6-1.1 9 .8 3-1.9 6-2.1 9-.8v13c-3-1.3-6-1.1-9 .8-3-1.9-6-2.1-9-.8z" />
      <path d="M12 6.3v13" />
    </>
  ),
  media: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M3.5 16l5-5 4 4 2.5-2.5 5 5" />
      <circle cx="15.5" cy="9" r="1.5" />
    </>
  ),
  code: (
    <>
      {PAGE}
      <path d="M10 10.5l-2.5 2.5 2.5 2.5M14 10.5l2.5 2.5-2.5 2.5" />
    </>
  ),
  other: (
    <>
      {PAGE}
      <path d="M14.5 2.5V6H18" />
    </>
  ),
};

/** The mark of a format's family, where a picture of its first page will be one day (ADR 0009, after K8). */
export function FormatMark({ family, size = 44 }: { family: FormatFamily; size?: number }) {
  return (
    <svg className="arak-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {FAMILIES[family]}
    </svg>
  );
}

/**
 * The folded corner: the flap, its shade, its edge in the stamp's ink, and the
 * desk showing in the triangle the fold uncovers. Drawn from the bottom-right.
 */
export function Fold() {
  return (
    <svg className="arak-fold" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="arak-fold-shade" x1=".5" y1=".5" x2="0" y2="0">
          <stop offset="0" style={{ stopColor: 'var(--ugao)' }} />
          <stop offset="1" style={{ stopColor: 'var(--ugao-shade)' }} />
        </linearGradient>
        <filter id="arak-fold-shadow" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="-1.5" dy="-1.5" stdDeviation="2.2" style={{ floodColor: 'var(--ugao-shadow)' }} />
        </filter>
      </defs>
      <polygon className="arak-fold-under" points="64,0 64,64 0,64" />
      <polygon points="0,0 64,0 0,64" fill="url(#arak-fold-shade)" filter="url(#arak-fold-shadow)" />
      <path className="arak-fold-edge" d="M64 0 0 64" />
    </svg>
  );
}

/** The arrow on a first-time hint, from the note down to the corner. */
export function HintArrow() {
  return (
    <svg className="arak-hint-arrow" viewBox="0 0 60 66" aria-hidden="true" focusable="false">
      <path d="M12 2C6 30 24 52 52 60" />
      <path d="M38 59l14 1-4-13" />
    </svg>
  );
}
