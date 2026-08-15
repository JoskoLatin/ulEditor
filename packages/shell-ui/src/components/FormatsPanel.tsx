import { FORMATS, type FormatId } from '@uleditor/plugin-sdk';

import { useShell } from '../shell/context.js';
import { FormatIcon } from './Icons.js';

/**
 * Popis formata i njihovog stvarnog stanja.
 *
 * Namjerno pokazuje i ono što još ne radi: korisnik koji otvori .docx mora
 * unaprijed znati na čemu je, umjesto da to otkrije preko prazne kartice.
 */

interface Row {
  format: FormatId;
  note: string;
  phase: string;
}

const ROADMAP: Row[] = [
  { format: 'code', note: 'CodeMirror 6, 13 jezika', phase: '' },
  { format: 'text', note: 'običan tekst', phase: '' },
  { format: 'markdown', note: 'izvor + živi pregled', phase: '' },
  { format: 'pdf', note: 'pregled, anotacije, stranice', phase: '' },
  { format: 'epub', note: 'čitanje, sadržaj, pretraga', phase: '' },
  { format: 'image', note: 'pregled', phase: 'faza 1' },
  { format: 'docx', note: 'pregled (uređivanje: faza 2)', phase: 'faza 2' },
  { format: 'xlsx', note: 'pregled (uređivanje: faza 2)', phase: 'faza 2' },
  { format: 'odf', note: 'LibreOffice konverzija', phase: 'faza 2' },
  { format: 'pptx', note: 'Univer Slides', phase: 'faza 5' },
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
          Formati
        </h3>

        {ROADMAP.map((row) => {
          const descriptor = FORMATS[row.format];
          const live = supported.has(row.format) || supported.has(row.format === 'markdown' ? 'md' : row.format);
          return (
            <div key={row.format} className="fmt-line" data-planned={!live}>
              <FormatIcon family={descriptor.family} size={15} />
              <span>{descriptor.label}</span>
              <span className="tag">{live ? row.note : row.phase}</span>
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
          Učitani editori
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
