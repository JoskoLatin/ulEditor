/**
 * Assembling the host.
 *
 * The only place that knows which platform we are on. Desktop gets the Rust VFS
 * with its sandbox and atomic saving, the web gets the File System Access API —
 * and the editors above notice no difference.
 */

import type { DirectoryEntry, DocumentHandle, EditorHost, VirtualFileSystem } from '@uleditor/plugin-sdk';
import { isLocale, type Locale } from '@uleditor/i18n';

import { BrowserFileSystem, hasFileSystemAccess } from './browser-fs.js';
import { TauriFileSystem, isTauri } from './tauri-fs.js';
import { EditorRegistry } from './registry.js';
import { Commands, NoConversion, Notifications, Settings, Themes, type ThemePreference } from './services.js';

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

  return {
    fs: desktop ? new TauriFileSystem() : new BrowserFileSystem(),
    commands: new Commands(),
    theme: new Themes(preference),
    settings,
    notify: new Notifications(),
    convert: new NoConversion(),
    registry: new EditorRegistry(),
    platform: desktop ? 'desktop' : 'web',
    canPersist: desktop || hasFileSystemAccess(),
    locale: isLocale(stored) ? stored : 'en',
  };
}

export { hasFileSystemAccess, isTauri };
export type { ThemePreference };
export { EditorRegistry } from './registry.js';
export { detect, detectByName, extensionOf } from './detect.js';
export type { ToastRecord } from './services.js';
