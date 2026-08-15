/**
 * Usluge koje shell nudi editorima. Editor koji koristi samo `EditorHost`
 * radi neizmijenjen na desktopu, webu i mobitelu.
 */

import type { Disposable, Event } from './events.js';
import type { VirtualFileSystem, Uri } from './fs.js';

/* ── naredbe ─────────────────────────────────────────────────────────── */

export interface Command {
  id: string;
  /** Tekst u command palette. */
  title: string;
  /** Grupa u palette, npr. "PDF" ili "Datoteka". */
  category?: string;
  /** Npr. `['Ctrl', 'Shift', 'P']`. Prikazuje se; ne registrira binding sam po sebi. */
  keybinding?: string[];
  /** Kad vrati `false`, naredba je skrivena iz palette. */
  when?: () => boolean;
  run(...args: unknown[]): void | Promise<void>;
}

export interface CommandRegistry {
  register(command: Command): Disposable;
  execute(id: string, ...args: unknown[]): Promise<void>;
  all(): Command[];
}

/* ── teme ────────────────────────────────────────────────────────────── */

export type ThemeKind = 'light' | 'dark';

export interface Theme {
  kind: ThemeKind;
  /** Razriješeni CSS custom properties, da editori s vlastitim canvasom
   *  (PDF, tablice) mogu bojati u skladu s ostatkom aplikacije. */
  tokens: Readonly<Record<string, string>>;
}

export interface ThemeService {
  readonly current: Theme;
  readonly onDidChange: Event<Theme>;
}

/* ── postavke ────────────────────────────────────────────────────────── */

export interface SettingsService {
  get<T>(key: string, fallback: T): T;
  set<T>(key: string, value: T): void;
  readonly onDidChange: Event<{ key: string }>;
}

/* ── obavijesti ──────────────────────────────────────────────────────── */

export type NotificationLevel = 'info' | 'warning' | 'error';

export interface NotificationAction {
  label: string;
  run(): void | Promise<void>;
}

export interface NotificationService {
  show(level: NotificationLevel, message: string, actions?: NotificationAction[]): Disposable;
  /**
   * Upozorenje o gubitku vjernosti pri spremanju.
   *
   * Editor koji zna da ne može reproducirati sve iz izvornog dokumenta MORA
   * ovo pozvati prije spremanja. Tiho kvarenje korisnikovog formatiranja je
   * jedina greška koja trajno ubija povjerenje u editor.
   */
  fidelityWarning(uri: Uri, unsupported: string[]): Promise<'save' | 'cancel'>;
}

/* ── konverzija ──────────────────────────────────────────────────────── */

export type ConvertFormat = 'pdf' | 'docx' | 'odt' | 'xlsx' | 'ods' | 'html' | 'txt';

export interface ConversionService {
  /** Je li konverzijski backend (LibreOffice) dostupan na ovoj platformi. */
  available(): Promise<boolean>;
  convert(source: Uri, target: ConvertFormat): Promise<Uint8Array>;
}

/* ── host ────────────────────────────────────────────────────────────── */

export interface EditorHost {
  readonly fs: VirtualFileSystem;
  readonly commands: CommandRegistry;
  readonly theme: ThemeService;
  readonly settings: SettingsService;
  readonly notify: NotificationService;
  readonly convert: ConversionService;
}
