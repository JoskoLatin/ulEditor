/**
 * Ikone. Jedan set, jedna debljina poteza, jedan grid — miješanje setova je
 * prvo što odaje nepromišljen UI.
 */

import type { SVGProps } from 'react';
import type { FormatFamily } from '@uleditor/plugin-sdk';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconFiles = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 1.75H4a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.75Z" />
    <path d="M9 1.75v4h4" />
  </Svg>
);

export const IconLayers = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.75 1.75 5 8 8.25 14.25 5 8 1.75Z" />
    <path d="m1.75 8.75 6.25 3.25 6.25-3.25" />
  </Svg>
);

export const IconChevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 3.5 5 4.5-5 4.5" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.25 10.25 3 3" />
  </Svg>
);

export const IconFolderOpen = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.75 12.5V3.75a1 1 0 0 1 1-1h3l1.5 2h5a1 1 0 0 1 1 1v1" />
    <path d="M1.75 12.5l1.6-5h11.1l-1.6 5a1 1 0 0 1-.95.75H2.7a1 1 0 0 1-.95-1.25Z" />
  </Svg>
);

export const IconSave = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.75 3.75a1 1 0 0 1 1-1h6.6l2.9 2.9v6.6a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1Z" />
    <path d="M5.25 2.75v3.5h5v-3.5M5.25 13.25v-3.5h5.5v3.5" />
  </Svg>
);

export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.5v1.4M8 13.1v1.4M14.5 8h-1.4M2.9 8H1.5M12.6 3.4l-1 1M4.4 11.6l-1 1M12.6 12.6l-1-1M4.4 4.4l-1-1" />
  </Svg>
);

export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.25 9.4A5.6 5.6 0 0 1 6.6 2.75a5.75 5.75 0 1 0 6.65 6.65Z" />
  </Svg>
);

export const IconMonitor = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1" />
    <path d="M5.5 13.75h5" />
  </Svg>
);

export const IconCommand = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 2.75a1.75 1.75 0 1 0 1.75 1.75v7a1.75 1.75 0 1 0 1.75-1.75h-7a1.75 1.75 0 1 0 1.75 1.75v-7A1.75 1.75 0 0 0 5.5 2.75Z" />
  </Svg>
);

export const IconWarning = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.25 1.75 13.25h12.5L8 2.25Z" />
    <path d="M8 6.5v3M8 11.4v.1" />
  </Svg>
);

/* ── ikone formata ───────────────────────────────────────────────────── */

const FAMILY_COLOR: Record<FormatFamily, string> = {
  code: 'var(--fmt-code)',
  document: 'var(--fmt-document)',
  sheet: 'var(--fmt-sheet)',
  slides: 'var(--fmt-slides)',
  fixed: 'var(--fmt-fixed)',
  media: 'var(--fmt-media)',
  other: 'var(--fmt-other)',
};

export function familyColor(family: FormatFamily): string {
  return FAMILY_COLOR[family];
}

/**
 * Ikona formata: silueta datoteke plus obiteljska boja. Oblik razlikuje
 * kategoriju čak i kad boja nije dostupna (daltonizam, visok kontrast).
 */
export function FormatIcon({ family, size = 16 }: { family: FormatFamily; size?: number }) {
  const color = FAMILY_COLOR[family];

  const glyph = () => {
    switch (family) {
      case 'sheet':
        return <path d="M5.25 7.25h5.5M5.25 9.75h5.5M8 7.25v4.5" strokeWidth="1.2" />;
      case 'document':
        return <path d="M5.5 7.5h5M5.5 9.5h5M5.5 11.5h3" strokeWidth="1.2" />;
      case 'fixed':
        return <path d="M5.5 7.75h2a1.1 1.1 0 0 1 0 2.2h-2v-2.2Zm0 4.1v-1.9M9.5 11.85V7.75h1.4" strokeWidth="1.2" />;
      case 'code':
        return <path d="m6.4 8.2-1.5 1.6 1.5 1.6M9.6 8.2l1.5 1.6-1.5 1.6" strokeWidth="1.2" />;
      case 'media':
        return <path d="M5.25 11.5 7 9.4l1.4 1.6 1.4-1.9 1.95 2.4Z" strokeWidth="1.2" />;
      case 'slides':
        return <rect x="5.25" y="7.75" width="5.5" height="3.5" rx="0.4" strokeWidth="1.2" />;
      default:
        return null;
    }
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={color}
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.2 1.9H4.4a.9.9 0 0 0-.9.9v10.4a.9.9 0 0 0 .9.9h7.2a.9.9 0 0 0 .9-.9V5.3Z" opacity="0.85" />
      <path d="M9.2 1.9v3.4h3.3" opacity="0.85" />
      {glyph()}
    </svg>
  );
}

export function FolderIcon({ open, size = 16 }: { open: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="var(--ink-faint)"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {open ? (
        <>
          <path d="M2 12.4V4a.9.9 0 0 1 .9-.9h2.9l1.4 1.9h4.9a.9.9 0 0 1 .9.9v.9" />
          <path d="m2 12.4 1.5-4.6h10.4l-1.5 4.6a.9.9 0 0 1-.85.6H2.85a.9.9 0 0 1-.85-.6Z" />
        </>
      ) : (
        <path d="M2 4a.9.9 0 0 1 .9-.9h2.9l1.4 1.9h5.9a.9.9 0 0 1 .9.9v6.1a.9.9 0 0 1-.9.9H2.9a.9.9 0 0 1-.9-.9Z" />
      )}
    </svg>
  );
}
