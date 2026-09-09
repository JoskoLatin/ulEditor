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
  /** Everything currently available — `when` has already been applied. */
  all(): Command[];
  /**
   * One command by id, available or not.
   *
   * `all()` is the right question for a palette, which lists what can be done
   * now. A menu asks the other one: it draws a fixed list and greys what is out
   * of reach, because a menu whose items come and go moves every item below
   * them and has to be re-read each time it is opened.
   */
  get(id: string): Command | undefined;
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

/* ── images ──────────────────────────────────────────────────────────── */

export type ImageEncoding = 'png' | 'jpeg' | 'webp' | 'bmp' | 'tiff';

/**
 * A plan for a picture. Every field absent still writes the file, and still
 * re-encodes it — which is why what that costs comes back from `write`.
 *
 * The order is fixed and not the order of the fields: the Exif orientation is
 * applied first, then the rotation, then the flips, then the crop, then the
 * resize. That order is what makes `crop` mean what it looks like — the
 * rectangle is in the pixels of the picture *as shown*, turned and mirrored
 * included, so the page never has to map a drag back through its own preview.
 */
export interface ImageOps {
  /** Clockwise degrees — 90, 180 or 270. Anything else is no rotation. */
  rotate?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
  /** In the pixels of the picture as shown — after `rotate` and the flips. */
  crop?: { x: number; y: number; width: number; height: number };
  resize?: { width: number; height: number };
  /** Absent keeps the format the file already had. */
  encoding?: ImageEncoding;
  /** 1–100, for the formats that have such a thing. */
  quality?: number;
}

export interface ImageInfo {
  /** The size as a person sees it — after the Exif orientation is applied. */
  width: number;
  height: number;
  encoding: ImageEncoding | null;
  /** Whether the file is stored sideways with a tag saying which way is up. */
  reoriented: boolean;
  /** Whether this format can be written back at all. */
  editable: boolean;
}

export interface ImageWritten {
  width: number;
  height: number;
  encoding: ImageEncoding;
  bytes: number;
  /** Whether the encoding itself threw information away. */
  lossy: boolean;
}

/**
 * Transforms done where the pixels are rather than in the page.
 *
 * A canvas would have been fewer lines and was the wrong instrument twice over:
 * a photograph out of a phone is forty megapixels, which is a hundred and sixty
 * megabytes of RGBA in the JS heap before anything is done to it, and every
 * browser draws the encoder's quality knob differently. So the page sends a plan
 * and gets dimensions back, and the bytes never enter the webview.
 *
 * `available()` is synchronous, unlike the conversion service's: whether
 * LibreOffice is installed has to be looked for, whereas this is a fact about
 * the build. The editor draws its tools or does not, at mount, without waiting.
 */
export interface ImageService {
  available(): boolean;
  info(source: Uri): Promise<ImageInfo>;
  write(source: Uri, target: Uri, ops: ImageOps): Promise<ImageWritten>;
}

/* ── language servers ────────────────────────────────────────────────── */

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

/**
 * One thing a language server has to say about a line of code.
 *
 * **Lines and columns are one-based**, and the columns are counted in UTF-16
 * code units, which is what both the protocol and a JavaScript string use — so
 * a column here is an index into the line as the page holds it, and no
 * conversion is needed on this side.
 */
export interface CodeDiagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: DiagnosticSeverity;
  message: string;
  /** `E0308`, `unused_variables` — what the server calls this, when it does. */
  code?: string | null;
  /** `rustc`, `clippy`, `typescript` — which tool inside the server said it. */
  source?: string | null;
}

/**
 * What a server said about one document, at one moment.
 *
 * A publication **replaces** what was said before about that document, and an
 * empty list is how a server says "fixed". An editor that merged instead of
 * replacing would leave every corrected mistake underlined until the file was
 * closed.
 */
export interface DiagnosticsPublished {
  uri: Uri;
  language: string;
  diagnostics: CodeDiagnostic[];
  /**
   * Which version of the document this is about, when the server says.
   *
   * A server's own analysis answers about the text it was told and gives the
   * number back; a compiler run answers about the file on disk and has no idea
   * which keystroke the editor is on, so it gives none. An editor drops an
   * answer that is older than what it has sent since — a stale underline under
   * a line somebody has already corrected is worse than a moment with none.
   */
  version?: number | null;
}

/**
 * The half of an editor that knows what the code *means*.
 *
 * Diagnostics only, for now: the underline under a mistake, with the compiler's
 * own words. Hover, definition and completion are the same plumbing asked
 * different questions.
 *
 * **Nothing is bundled.** A language server is somebody else's program and
 * installing one is a decision about the machine rather than about this editor.
 * `open` therefore answers whether anything is listening at all, and `false` is
 * the ordinary answer rather than a failure — an editor that got it stops
 * expecting underlines instead of reporting a problem nobody has.
 */
export interface LanguageService {
  /** Which languages this machine can serve. Asked, never assumed. */
  languages(): Promise<string[]>;
  /** Returns whether a server took the document. */
  open(uri: Uri, language: string, text: string): Promise<boolean>;
  change(uri: Uri, language: string, version: number, text: string): Promise<void>;
  /**
   * A save, which for some languages is what makes the real diagnostics
   * arrive: rust-analyzer runs `cargo check` on this and publishes what the
   * compiler says, which its own parser never reports.
   */
  save(uri: Uri, language: string): Promise<void>;
  close(uri: Uri, language: string): Promise<void>;
  readonly onDiagnostics: Event<DiagnosticsPublished>;
}

/* ── host ────────────────────────────────────────────────────────────── */

export interface EditorHost {
  readonly fs: VirtualFileSystem;
  readonly commands: CommandRegistry;
  readonly theme: ThemeService;
  readonly settings: SettingsService;
  readonly notify: NotificationService;
  readonly convert: ConversionService;
  readonly images: ImageService;
  readonly language: LanguageService;
  /**
   * Opens a web link in the system browser — outside the application, so
   * nothing of the document travels with it. Optional: a host without a
   * browser around it (a check harness) simply does not offer it.
   */
  readonly openExternal?: (url: string) => void;
}
