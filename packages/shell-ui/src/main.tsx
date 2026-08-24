import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setLocale } from '@uleditor/i18n';

import './styles/app.css';
import '@uleditor/reader-core/style.css';
import '@uleditor/editor-book/style.css';
import '@uleditor/editor-code/style.css';
import '@uleditor/editor-image/style.css';
import '@uleditor/editor-markdown/style.css';
import '@uleditor/editor-office/style.css';
import '@uleditor/editor-pdf/style.css';
import '@uleditor/editor-vector/style.css';
import '@uleditor/editor-3d/style.css';

import { App } from './App.js';
import { createShell } from './host/index.js';
import { lazyProvider } from './shell/lazy.js';
import { restoreZoom } from './shell/zoom.js';

const shell = createShell();

/* Before the first paint rather than from a component: the interface would
   otherwise be drawn at the wrong size and resize itself in front of the user. */
restoreZoom(shell);

/*
 * The language is set before the first render and before commands are registered —
 * command titles are translated once, at registration. Changing the language in
 * settings reloads the window rather than trying to swap strings in live DOM that
 * imperative editors built themselves.
 */
setLocale(shell.locale);

/* The document has to report its real language, not the one written into
   `index.html`: screen readers and hyphenation rules depend on it. */
document.documentElement.lang = shell.locale;

/*
 * Editor registration — the only place in the shell that mentions individual
 * formats at all. The metadata is static (the registry has to know at once who
 * opens what), while the code is fetched when a document of that type is first
 * opened.
 */

const CODE_EXTENSIONS = [
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'jsonc', 'rs', 'py', 'pyi', 'html', 'htm', 'css', 'scss', 'less',
  'toml', 'yaml', 'yml', 'xml', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd', 'sql',
  'go', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'rb', 'php',
  'swift', 'lua', 'vue', 'svelte',
  'txt', 'log', 'csv', 'tsv', 'ini', 'cfg', 'conf', 'env', 'properties', 'diff', 'patch',
];

shell.registry.register(
  lazyProvider(
    {
      id: 'org.uleditor.code',
      displayName: 'Code editor',
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
      displayName: 'Image viewer',
      matches: {
        extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'image'],
      },
      capabilities: ['view'],
      priority: 30,
    },
    () => import('@uleditor/editor-image'),
  ),
);

/*
 * Vector drawings and 3D models. Both are viewers, both are lazy, and both are
 * registered here beside the rest — the shell has no idea what three.js is, and
 * `editor-vector` never loads for a session that opens no drawing.
 */
shell.registry.register(
  lazyProvider(
    {
      id: 'org.uleditor.vector',
      displayName: 'Vector graphics viewer',
      matches: { extensions: ['svg', 'svgz', 'ai', 'eps', 'ps', 'cdr', 'vector'] },
      capabilities: ['view', 'search'],
      priority: 30,
    },
    () => import('@uleditor/editor-vector'),
  ),
);

shell.registry.register(
  lazyProvider(
    {
      id: 'org.uleditor.model',
      displayName: '3D model viewer',
      matches: { extensions: ['stl', 'obj', 'ply', 'gltf', 'glb', '3mf', 'model'] },
      capabilities: ['view'],
      priority: 30,
    },
    () => import('@uleditor/editor-3d'),
  ),
);

shell.registry.register(
  lazyProvider(
    {
      id: 'org.uleditor.book',
      displayName: 'E-book reader',
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
      displayName: 'Word',
      matches: {
        extensions: ['docx'],
        mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      },
      /* This has to match what the editor reports: the shell decides whether a tab
         is read-only before the editor is even loaded. */
      capabilities: ['view', 'search', 'read', 'edit'],
      priority: 30,
    },
    async () => (await import('@uleditor/editor-office')).docxPreviewProvider,
  ),
);

shell.registry.register(
  lazyProvider(
    {
      id: 'org.uleditor.xlsx',
      displayName: 'Excel',
      matches: {
        extensions: ['xlsx'],
        mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      },
      /* This has to match what the editor reports: the shell decides whether a tab
         is read-only before the editor is even loaded. */
      capabilities: ['view', 'search', 'edit'],
      priority: 30,
    },
    async () => (await import('@uleditor/editor-office')).xlsxPreviewProvider,
  ),
);

shell.registry.register(
  lazyProvider(
    {
      id: 'org.uleditor.xls',
      displayName: 'Excel 97-2003',
      matches: {
        extensions: ['xls'],
        mimeTypes: ['application/vnd.ms-excel'],
      },
      /* No `edit`: the old binary format is read, never written — the tab is
         read-only from the moment it opens, and the grid says why. */
      capabilities: ['view', 'search'],
      priority: 30,
    },
    async () => (await import('@uleditor/editor-office')).xlsPreviewProvider,
  ),
);

shell.registry.register(
  lazyProvider(
    {
      id: 'org.uleditor.pdf',
      displayName: 'PDF viewer',
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
if (!container) throw new Error('The #root element is missing.');

createRoot(container).render(
  <StrictMode>
    <App shell={shell} />
  </StrictMode>,
);
