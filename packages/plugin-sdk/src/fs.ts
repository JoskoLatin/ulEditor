/**
 * The virtual file system.
 *
 * The same API holds on all three targets; only the implementation differs:
 *   desktop / mobile → Tauri commands → Rust `ul-core`
 *   web              → File System Access API + OPFS
 *
 * Editors never touch `window.fs`, `fetch` or the Tauri API directly — they
 * always go through `host.fs`. That is what makes them portable.
 */

import type { FormatDetection } from './format.js';

/** An opaque resource identifier. A path on desktop, a handle key on the web. */
export type Uri = string;

export interface FileStat {
  uri: Uri;
  name: string;
  /** The parent directory, or `null` for a workspace root. */
  parent: Uri | null;
  kind: 'file' | 'directory';
  size: number;
  /** Unix ms. `null` when the platform does not provide it (e.g. some web handles). */
  modified: number | null;
  readonly: boolean;
}

export interface DirectoryEntry extends FileStat {
  /** Filled in only after `readDirectory` — directories load lazily. */
  children?: DirectoryEntry[];
}

/**
 * An open document. Its content is read lazily through `bytes()` or `text()` and
 * is never held whole in the shell layer's memory — large PDFs and spreadsheets
 * depend on that.
 */
export interface DocumentHandle {
  readonly uri: Uri;
  readonly name: string;
  readonly stat: FileStat;
  readonly detection: FormatDetection;

  bytes(): Promise<Uint8Array>;
  text(encoding?: string): Promise<string>;

  /** Streaming reads for formats that render in pieces. */
  slice(start: number, end: number): Promise<Uint8Array>;
}

export interface WriteOptions {
  /** When `true`, the previous content is kept as a `.bak` beside the file. */
  backup?: boolean;
}

export interface VirtualFileSystem {
  /** The workspace roots — on the web, one per chosen directory. */
  roots(): Promise<DirectoryEntry[]>;

  stat(uri: Uri): Promise<FileStat>;
  readDirectory(uri: Uri): Promise<DirectoryEntry[]>;

  open(uri: Uri): Promise<DocumentHandle>;
  readBytes(uri: Uri): Promise<Uint8Array>;
  readText(uri: Uri, encoding?: string): Promise<string>;

  writeBytes(uri: Uri, data: Uint8Array, opts?: WriteOptions): Promise<void>;
  writeText(uri: Uri, data: string, opts?: WriteOptions): Promise<void>;

  /** Interactive selection — opens a system dialog. */
  pickFiles(opts?: { multiple?: boolean; extensions?: string[] }): Promise<DocumentHandle[]>;
  pickDirectory(): Promise<DirectoryEntry | null>;
  pickSaveTarget(suggestedName: string, extensions?: string[]): Promise<Uri | null>;

  /** Whether the platform supports writing back to the source (the web does not without permission). */
  canWrite(uri: Uri): Promise<boolean>;
}
