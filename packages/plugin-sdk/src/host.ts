/**
 * The services the shell offers editors. An editor that uses only `EditorHost`
 * runs unchanged on desktop, web and mobile.
 */

import type { Disposable, Event } from './events.js';
import type { VirtualFileSystem, Uri } from './fs.js';

/* ── commands ────────────────────────────────────────────────────────── */

export interface Command {
  id: string;
  /** The text in the command palette. */
  title: string;
  /** The group in the palette, e.g. "PDF" or "File". */
  category?: string;
  /** E.g. `['Ctrl', 'Shift', 'P']`. Displayed only; it does not register a binding by itself. */
  keybinding?: string[];
  /** When it returns `false`, the command is hidden from the palette. */
  when?: () => boolean;
  run(...args: unknown[]): void | Promise<void>;
}

export interface CommandRegistry {
  register(command: Command): Disposable;
  execute(id: string, ...args: unknown[]): Promise<void>;
  all(): Command[];
}

/* ── themes ──────────────────────────────────────────────────────────── */

export type ThemeKind = 'light' | 'dark';

export interface Theme {
  kind: ThemeKind;
  /** The resolved CSS custom properties, so editors with a canvas of their own
   *  (PDF, spreadsheets) can paint in step with the rest of the application. */
  tokens: Readonly<Record<string, string>>;
}

export interface ThemeService {
  readonly current: Theme;
  readonly onDidChange: Event<Theme>;
}

/* ── settings ────────────────────────────────────────────────────────── */

export interface SettingsService {
  get<T>(key: string, fallback: T): T;
  set<T>(key: string, value: T): void;
  readonly onDidChange: Event<{ key: string }>;
}

/* ── notifications ───────────────────────────────────────────────────── */

export type NotificationLevel = 'info' | 'warning' | 'error';

export interface NotificationAction {
  label: string;
  run(): void | Promise<void>;
}

export interface NotificationService {
  show(level: NotificationLevel, message: string, actions?: NotificationAction[]): Disposable;
  /**
   * A warning about fidelity loss on save.
   *
   * An editor that knows it cannot reproduce everything from the source document
   * MUST call this before saving. Quietly corrupting a user's formatting is the
   * one mistake that destroys trust in an editor for good.
   */
  fidelityWarning(uri: Uri, unsupported: string[]): Promise<'save' | 'cancel'>;
}

/* ── conversion ──────────────────────────────────────────────────────── */

export type ConvertFormat = 'pdf' | 'docx' | 'odt' | 'xlsx' | 'ods' | 'html' | 'txt';

export interface ConversionService {
  /** Whether the conversion backend (LibreOffice) is available on this platform. */
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
  /**
   * Opens a web link in the system browser — outside the application, so
   * nothing of the document travels with it. Optional: a host without a
   * browser around it (a check harness) simply does not offer it.
   */
  readonly openExternal?: (url: string) => void;
}
