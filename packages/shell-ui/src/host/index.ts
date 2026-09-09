/**
 * Assembling the host.
 *
 * The only place that knows which platform we are on. Desktop gets the Rust VFS
 * with its sandbox and atomic saving, the web gets the File System Access API —
 * and the editors above notice no difference.
 */

import type {
  ConversionService,
  DirectoryEntry,
  DocumentHandle,
  EditorHost,
  Uri,
  VirtualFileSystem,
} from '@uleditor/plugin-sdk';
import { isLocale, type Locale } from '@uleditor/i18n';

import { BrowserFileSystem, hasFileSystemAccess } from './browser-fs.js';
import { TauriFileSystem, isTauri } from './tauri-fs.js';
import { TauriImages } from './tauri-images.js';
import { TauriConversion } from './tauri-convert.js';
import { TauriLanguageServers } from './tauri-lsp.js';
import { EditorRegistry } from './registry.js';
import {
  Commands,
  NoConversion,
  NoImageEditing,
  NoLanguageServers,
  Notifications,
  Settings,
  Themes,
  type ThemePreference,
} from './services.js';

/**
 * The VFS plus taking in dropped content. The web gets `File` objects, desktop
 * gets paths — both are optional, so the caller checks which exists instead of
 * branching on the platform.
 */
export type ShellFileSystem = VirtualFileSystem & {
  adoptFiles?(files: FileList | File[]): Promise<DocumentHandle[]>;
  adoptPaths?(paths: string[]): Promise<{
    documents: DocumentHandle[];
    directories: DirectoryEntry[];
  }>;
};

export type Platform = 'desktop' | 'web';

export interface Shell extends EditorHost {
  readonly fs: ShellFileSystem;
  /**
   * The SDK's conversion service, plus the one thing the shell needs and a
   * plugin does not: where the converted file *is*. A document is a path, and
   * sending twenty megabytes of PDF through the bridge for the page to hand
   * straight back would be the same work done twice.
   */
  readonly convert: ConversionService & { toPdfFile?(source: Uri): Promise<string> };
  readonly commands: Commands;
  readonly theme: Themes;
  readonly settings: Settings;
  readonly notify: Notifications;
  readonly registry: EditorRegistry;
  readonly platform: Platform;
  /** Whether saving back to disk is possible. */
  readonly canPersist: boolean;
  /** The interface language from settings; English when none is chosen. */
  readonly locale: Locale;
}

export function createShell(): Shell {
  const settings = new Settings();
  const preference = settings.get<ThemePreference>('theme', 'system');
  const stored = settings.get<string>('locale', 'en');
  const desktop = isTauri();

  /* Desktop goes through Rust: the webview's own `window.open` would put the
     page inside another webview, not in the person's browser. */
  const openExternal = desktop
    ? (url: string) => {
        void import('@tauri-apps/api/core').then(({ invoke }) => invoke('open_external', { url }));
      }
    : (url: string) => {
        window.open(url, '_blank', 'noopener');
      };

  return {
    fs: desktop ? new TauriFileSystem() : new BrowserFileSystem(),
    commands: new Commands(),
    theme: new Themes(preference),
    settings,
    notify: new Notifications(),
    /* LibreOffice, and only for the drawings nothing else reads. On the web
       there is nothing to reach, and `NoConversion` says so. */
    convert: desktop ? new TauriConversion() : new NoConversion(),
    /* The transforms are in Rust, so they exist where Rust does. The web build
       keeps the viewer and is told to say so. */
    images: desktop ? new TauriImages() : new NoImageEditing(),
    /* A language server is a process; a browser starts none, and says so. */
    language: desktop ? new TauriLanguageServers() : new NoLanguageServers(),
    registry: new EditorRegistry(),
    platform: desktop ? 'desktop' : 'web',
    canPersist: desktop || hasFileSystemAccess(),
    locale: isLocale(stored) ? stored : 'en',
    openExternal,
  };
}

export { hasFileSystemAccess, isTauri };
export type { ThemePreference };
export { EditorRegistry } from './registry.js';
export { detect, detectByName, extensionOf } from './detect.js';
export type { ToastRecord } from './services.js';
