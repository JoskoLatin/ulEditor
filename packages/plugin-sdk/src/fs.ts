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
  /**
   * `link` is a symbolic link or, on Windows, a junction: listed as what it is,
   * with nothing told of what it points at (size 0, no time). Opening one goes
   * through the sandbox like any other path.
   */
  kind: 'file' | 'directory' | 'link';
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
  /**
   * Write over a file that was changed or replaced outside ulEditor since it
   * was opened. Without it such a write is refused with `ChangedOutsideError`.
   * Set for one write, after the person said so — never kept.
   */
  overwriteChanged?: boolean;
}

/**
 * A write refused because the file is not what it was when it was opened:
 * somebody replaced it, or another program wrote it. Nothing was written.
 */
export class ChangedOutsideError extends Error {
  constructor(readonly uri: Uri) {
    super(`${uri} was changed outside ulEditor since it was opened`);
    this.name = 'ChangedOutsideError';
  }
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
