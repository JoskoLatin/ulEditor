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

import { isInterface, type InterfaceId } from '@uleditor/mobile-core';

import { App } from './App.js';
import { createShell, isHandheld, isTauri } from './host/index.js';
import { keepForOffline } from './host/offline.js';
import { lazyProvider } from './shell/lazy.js';
import { isTreeSort } from './shell/tree-sort.js';
import { watchClipboard } from './shell/clipboard.js';
import { record, watchForCrashes } from './shell/crash.js';
import { checkOnStart } from './shell/updates.js';
import { restoreZoom } from './shell/zoom.js';
import { SIDEBAR_WIDTH, useWorkspace } from './state/workspace.js';

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

/* The order the tree was left in, and how wide the panel was left. Read before
   the first render: drawn at one size and corrected afterwards, the interface
   rearranges itself in front of the person while they are looking at it. */
const storedSort = shell.settings.get<string>('explorer.sort', 'name');
if (isTreeSort(storedSort)) useWorkspace.getState().setTreeSort(storedSort);

const storedWidth = shell.settings.get<number>('sidebar.width', SIDEBAR_WIDTH);
if (Number.isFinite(storedWidth)) useWorkspace.getState().setSidebarWidth(storedWidth);

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
      capabilities: ['view', 'edit', 'search', 'read'],
      priority: 30,
    },
    () => import('@uleditor/editor-markdown'),
  ),
);

shell.registry.register(
  lazyProvider(
    {
      id: 'org.uleditor.image',
      displayName: 'Image editor',
      matches: {
        extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'tif', 'tiff', 'image'],
      },
      capabilities: ['view', 'edit', 'export'],
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
      matches: {
        extensions: ['svg', 'svgz', 'ai', 'eps', 'ps', 'cdr', 'vector'],
        mimeTypes: ['image/svg+xml', 'application/postscript'],
      },
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
      matches: {
        extensions: ['stl', 'obj', 'ply', 'gltf', 'glb', '3mf', 'model'],
        mimeTypes: ['model/stl', 'model/obj', 'model/gltf+json', 'model/gltf-binary'],
      },
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
      id: 'org.uleditor.doc',
      displayName: 'Word 97-2003',
      matches: {
        extensions: ['doc'],
        mimeTypes: ['application/msword'],
      },
      /* No `edit`: everything in the old binary format is indexed by byte
         offset, so there is no seam to write into. See `docPreviewProvider`. */
      capabilities: ['view', 'search', 'read'],
      priority: 30,
    },
    async () => (await import('@uleditor/editor-office')).docPreviewProvider,
  ),
);

shell.registry.register(
  lazyProvider(
    {
      id: 'org.uleditor.rtf',
      displayName: 'Rich Text',
      matches: {
        extensions: ['rtf'],
        mimeTypes: ['application/rtf', 'text/rtf'],
      },
      /* No `edit`. Writing RTF back would mean deciding what to do with every
         instruction the reader skipped, and it does not know. */
      capabilities: ['view', 'search', 'read'],
      priority: 30,
    },
    async () => (await import('@uleditor/editor-office')).rtfPreviewProvider,
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
      /* `edit`, though the file it came from is never written: saving writes a
         new .xlsx beside it. See `xlsPreviewProvider`. */
      capabilities: ['view', 'search', 'edit'],
      priority: 30,
    },
    async () => (await import('@uleditor/editor-office')).xlsPreviewProvider,
  ),
);

shell.registry.register(
  lazyProvider(
    {
      id: 'org.uleditor.odt',
      displayName: 'OpenDocument Text',
      matches: {
        extensions: ['odt', 'ott'],
        mimeTypes: ['application/vnd.oasis.opendocument.text'],
      },
      /* `edit`, and written back into the `.odt` itself — only the retyped text
         changes. The tab has to know this before the editor is even loaded:
         while this said `read`, the editor offered the text, somebody retyped
         it, and the save refused the file as read-only. */
      capabilities: ['view', 'search', 'read', 'edit'],
      priority: 30,
    },
    async () => (await import('@uleditor/editor-office')).odtPreviewProvider,
  ),
);

shell.registry.register(
  lazyProvider(
    {
      id: 'org.uleditor.ods',
      displayName: 'OpenDocument Spreadsheet',
      matches: {
        extensions: ['ods', 'ots'],
        mimeTypes: ['application/vnd.oasis.opendocument.spreadsheet'],
      },
      /* `edit`, and written back into the .ods itself — only the retyped cells
         change. See `#saveOds`. */
      capabilities: ['view', 'search', 'edit'],
      priority: 30,
    },
    async () => (await import('@uleditor/editor-office')).odsPreviewProvider,
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

/*
 * Before the interface exists rather than after it, because the interface
 * failing to come up at all is one of the things worth hearing about — and
 * because a listener registered later would miss whatever happened first.
 */
watchForCrashes();

const container = document.getElementById('root');
if (!container) throw new Error('The #root element is missing.');

const root = createRoot(container);

/**
 * Whether this window starts the phone's own shell, and which interface it was
 * asked for (ADR 0009, "Entering the mobile shell").
 *
 * - The app on Android, a tablet included: `isTauri() && isHandheld()`, in a
 *   debug build only until Arak passes K6. The release keeps the old narrow
 *   layout until then.
 * - `?ui=arak`, `?ui=palac` or `?ui=boje` in Vite's development mode, over the
 *   web host, so a browser check can drive the mobile shell.
 *
 * A narrow window on a computer, a computer with a touch screen and the web
 * build on a phone all stay on the desktop shell, and so does a debug build
 * told to for this run (`DESKTOP_SHELL_KEY`).
 */
function mobileShell(): { requested: InterfaceId | null } | null {
  if (import.meta.env.DEV) {
    const ui = new URLSearchParams(window.location.search).get('ui');
    if (isInterface(ui)) return { requested: ui };
  }
  if (__TAURI_DEBUG__ && isTauri() && isHandheld() && !keptOnDesktop()) return { requested: null };
  return null;
}

/**
 * A debug build on the phone keeps the desktop shell when this key is in
 * `sessionStorage`. The device checks of ADR 0003 (`tools/verify-mobile-*.mjs`)
 * set it and reload: until Arak passes K6 the release still ships the old
 * narrow layout, they measure that layout, and a release cannot be driven over
 * devtools. `sessionStorage` lasts across the reload and goes with the process,
 * so the next start of the app is the mobile shell again and no setting is left
 * behind. A release never reads it. The same name is in
 * `tools/device-session.mjs`.
 */
const DESKTOP_SHELL_KEY = 'ulEditor.debug.desktopShell';

function keptOnDesktop(): boolean {
  try {
    return sessionStorage.getItem(DESKTOP_SHELL_KEY) !== null;
  } catch {
    return false;
  }
}

function renderDesktop(): void {
  root.render(
    <StrictMode>
      <App shell={shell} />
    </StrictMode>,
  );
}

/*
 * Both halves of the condition are constants Vite writes into the bundle, so in
 * a release build this reads `if (false)`, and the mobile shell's code is not in
 * the build at all: not a chunk, not a line. Proved by `verify-mobile-common`,
 * which looks for it in a release build's files.
 */
if (import.meta.env.DEV || __TAURI_DEBUG__) {
  const mobile = mobileShell();
  if (mobile) {
    import('./mobile/MobileApp.js')
      .then(({ MobileApp, localeForPhone }) => {
        /* Before the first render, as `setLocale` asks: nothing has been
           translated yet, the desktop's `App` was never drawn. */
        setLocale(localeForPhone(shell));
        root.render(
          <StrictMode>
            <MobileApp shell={shell} requested={mobile.requested} />
          </StrictMode>,
        );
      })
      /* A debug build whose mobile shell does not load still opens a document:
         the desktop's, with the failure reported. */
      .catch((error: unknown) => {
        record(error, { where: 'starting the mobile shell' });
        renderDesktop();
      });
  } else {
    renderDesktop();
  }
} else {
  renderDesktop();
}

/*
 * The check for a new version, after the interface exists rather than before it.
 *
 * It is silent unless there is something to say, at most once a day, and only
 * on the desktop — see `shell/updates.ts` for what it sends, which is one GET
 * for a static file. Deliberately not awaited: a program that waited on the
 * network before drawing itself would open slowly on a bad connection, and
 * there is nothing here worth a single frame of that.
 */
void checkOnStart(shell);

/*
 * The cross-format clipboard. Both events for the lifetime of the window: the
 * copy remembers the structure that went with the text, and the paste hands it
 * to an editor that has said it wants it. Nothing is intercepted otherwise —
 * see `shell/clipboard.ts`.
 */
watchClipboard(shell);

/* A reload without a network still opens a document — in the browser only;
   see `host/offline.ts`. */
if (shell.platform === 'web') keepForOffline();
