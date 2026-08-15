/**
 * Sastavljanje hosta.
 *
 * Jedino mjesto koje zna na kojoj platformi radimo. Desktop dobiva Rust VFS
 * sa sandboxom i atomarnim spremanjem, web dobiva File System Access API —
 * a editori iznad toga ne primjećuju razliku.
 */

import type { DirectoryEntry, DocumentHandle, EditorHost, VirtualFileSystem } from '@uleditor/plugin-sdk';
import { isLocale, type Locale } from '@uleditor/i18n';

import { BrowserFileSystem, hasFileSystemAccess } from './browser-fs.js';
import { TauriFileSystem, isTauri } from './tauri-fs.js';
import { EditorRegistry } from './registry.js';
import { Commands, NoConversion, Notifications, Settings, Themes, type ThemePreference } from './services.js';

/**
 * VFS uz preuzimanje ispuštenog sadržaja. Web dobiva `File` objekte,
 * desktop putanje — obje mogućnosti su neobavezne, pa pozivatelj provjerava
 * koja postoji umjesto da grana po platformi.
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
  /** Može li se spremati natrag na disk. */
  readonly canPersist: boolean;
  /** Jezik sučelja iz postavki; engleski kad nije odabran. */
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
