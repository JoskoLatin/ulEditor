import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles/app.css';
import '@uleditor/reader-core/style.css';
import '@uleditor/editor-book/style.css';
import '@uleditor/editor-code/style.css';
import '@uleditor/editor-image/style.css';
import '@uleditor/editor-markdown/style.css';
import '@uleditor/editor-office/style.css';
import '@uleditor/editor-pdf/style.css';

import { App } from './App.js';
import { createShell } from './host/index.js';
import { lazyProvider } from './shell/lazy.js';

const shell = createShell();

/*
 * Registracija editora — jedino mjesto u shellu koje uopće spominje pojedine
 * formate. Metapodaci su statični (registar mora odmah znati tko što otvara),
 * a kod se dohvaća pri prvom otvaranju dokumenta tog tipa.
 */

const CODE_EXTENSIONS = [
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'jsonc', 'rs', 'py', 'pyi', 'html', 'htm', 'css', 'scss', 'less',
  'toml', 'yaml', 'yml', 'xml', 'svg', 'sh', 'bash', 'zsh', 'ps1', 'sql',
  'go', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'rb', 'php',
  'swift', 'lua', 'vue', 'svelte',
  'txt', 'log', 'csv', 'tsv', 'ini', 'cfg', 'conf', 'env',
];

shell.registry.register(
  lazyProvider(
    {
      id: 'org.uleditor.code',
      displayName: 'Editor koda',
      matches: { extensions: [...CODE_EXTENSIONS, 'code', 'text'] },
      capabilities: ['view', 'edit', 'search'],
      priority: 20,
    },
    () => import('@uleditor/editor-code'),
  ),
);

shell.registry.register(
  lazyProvider(
    {
      id: 'org.uleditor.markdown',
      displayName: 'Markdown editor',
      matches: { extensions: ['md', 'markdown', 'mdx'], mimeTypes: ['text/markdown'] },
      capabilities: ['view', 'edit', 'search', 'export'],
      priority: 30,
    },
    () => import('@uleditor/editor-markdown'),
  ),
);

shell.registry.register(
  lazyProvider(
    {
      id: 'org.uleditor.image',
      displayName: 'Preglednik slika',
      matches: {
        extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'image'],
      },
      capabilities: ['view'],
      priority: 30,
    },
    () => import('@uleditor/editor-image'),
  ),
);

shell.registry.register(
  lazyProvider(
    {
      id: 'org.uleditor.book',
      displayName: 'Čitač e-knjiga',
      matches: {
        extensions: ['epub'],
        mimeTypes: ['application/epub+zip'],
      },
      capabilities: ['view', 'search', 'read'],
      priority: 30,
    },
    () => import('@uleditor/editor-book'),
  ),
);

shell.registry.register(
  lazyProvider(
    {
      id: 'org.uleditor.docx',
      displayName: 'Word pregled',
      matches: {
        extensions: ['docx'],
        mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      },
      capabilities: ['view', 'search', 'read'],
      priority: 30,
    },
    async () => (await import('@uleditor/editor-office')).docxPreviewProvider,
  ),
);

shell.registry.register(
  lazyProvider(
    {
      id: 'org.uleditor.xlsx',
      displayName: 'Excel pregled',
      matches: {
        extensions: ['xlsx'],
        mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      },
      capabilities: ['view', 'search'],
      priority: 30,
    },
    async () => (await import('@uleditor/editor-office')).xlsxPreviewProvider,
  ),
);

shell.registry.register(
  lazyProvider(
    {
      id: 'org.uleditor.pdf',
      displayName: 'PDF preglednik',
      matches: {
        extensions: ['pdf'],
        mimeTypes: ['application/pdf'],
        magic: [new Uint8Array([0x25, 0x50, 0x44, 0x46])],
      },
      capabilities: ['view', 'edit', 'annotate', 'search', 'read'],
      priority: 30,
    },
    () => import('@uleditor/editor-pdf'),
  ),
);

const container = document.getElementById('root');
if (!container) throw new Error('Nedostaje #root element.');

createRoot(container).render(
  <StrictMode>
    <App shell={shell} />
  </StrictMode>,
);
