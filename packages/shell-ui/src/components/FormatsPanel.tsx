import { FORMATS, type FormatId } from '@uleditor/plugin-sdk';

import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { formatLabel } from '../shell/formats.js';
import { FormatIcon } from './Icons.js';

/**
 * The list of formats and their real state.
 *
 * It deliberately shows what does not work yet too: a user opening a .docx has to
 * know where they stand in advance, rather than discovering it through a blank
 * tab.
 */

interface Row {
  format: FormatId;
  note: string;
  phase: string;
}

const ROADMAP: Row[] = [
  { format: 'code', note: 'CodeMirror 6, 13 languages', phase: '' },
  { format: 'text', note: 'plain text', phase: '' },
  { format: 'markdown', note: 'source + live preview', phase: '' },
  { format: 'pdf', note: 'view, annotate, pages', phase: '' },
  { format: 'epub', note: 'reading, contents, search', phase: '' },
  { format: 'image', note: 'view, OCR', phase: 'phase 1' },
  { format: 'docx', note: 'view, retype text', phase: 'phase 2' },
  { format: 'xlsx', note: 'view, retype cells', phase: 'phase 2' },
  { format: 'xls', note: 'view, edit — saves as .xlsx', phase: '' },
  { format: 'odf', note: 'LibreOffice conversion', phase: 'phase 2' },
  { format: 'pptx', note: 'Univer Slides', phase: 'phase 5' },
];

export function FormatsPanel() {
  const shell = useShell();
  const providers = shell.registry.all();

  const supported = new Set<string>();
  for (const provider of providers) {
    for (const ext of provider.matches.extensions) supported.add(ext);
  }

  return (
    <div style={{ padding: '10px 14px 20px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <section>
        <h3
          style={{
            margin: '0 0 8px',
            fontFamily: 'var(--mono)',
            fontSize: 'var(--fs-xs)',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--ink-faint)',
            fontWeight: 500,
          }}
        >
          {t('Formats')}
        </h3>

        {ROADMAP.map((row) => {
          const descriptor = FORMATS[row.format];
          const live = supported.has(row.format) || supported.has(row.format === 'markdown' ? 'md' : row.format);
          return (
            <div key={row.format} className="fmt-line" data-planned={!live}>
              <FormatIcon family={descriptor.family} size={15} />
              <span>{formatLabel(descriptor.id)}</span>
              <span className="tag">{t(live ? row.note : row.phase)}</span>
            </div>
          );
        })}
      </section>

      <section>
        <h3
          style={{
            margin: '0 0 8px',
            fontFamily: 'var(--mono)',
            fontSize: 'var(--fs-xs)',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--ink-faint)',
            fontWeight: 500,
          }}
        >
          {t('Registered editors')}
        </h3>
        {providers.map((provider) => (
          <div key={provider.id} className="fmt-line">
            <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--fs-xs)' }}>{provider.displayName}</span>
            <span className="tag">{provider.capabilities.join(' · ')}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
