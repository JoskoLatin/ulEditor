/**
 * Virtualni datotečni sustav.
 *
 * Isti API vrijedi na sva tri targeta; razlikuje se samo implementacija:
 *   desktop / mobile → Tauri commands → Rust `ul-core`
 *   web              → File System Access API + OPFS
 *
 * Editori nikad ne diraju `window.fs`, `fetch` ni Tauri API izravno —
 * uvijek idu kroz `host.fs`. To je ono što ih čini prenosivima.
 */

import type { FormatDetection } from './format.js';

/** Neprozirni identifikator resursa. Na desktopu putanja, na webu handle ključ. */
export type Uri = string;

export interface FileStat {
  uri: Uri;
  name: string;
  /** Roditeljski direktorij, ili `null` za korijen radnog prostora. */
  parent: Uri | null;
  kind: 'file' | 'directory';
  size: number;
  /** Unix ms. `null` kad ga platforma ne daje (npr. neki web handleovi). */
  modified: number | null;
  readonly: boolean;
}

export interface DirectoryEntry extends FileStat {
  /** Popunjeno tek nakon `readDirectory` — direktoriji se učitavaju lijeno. */
  children?: DirectoryEntry[];
}

/**
 * Otvoreni dokument. Sadržaj se čita lijeno i preko `bytes()` ili `text()`,
 * nikad se ne drži cijeli u memoriji shell sloja — veliki PDF-ovi i tablice
 * ovise o tome.
 */
export interface DocumentHandle {
  readonly uri: Uri;
  readonly name: string;
  readonly stat: FileStat;
  readonly detection: FormatDetection;

  bytes(): Promise<Uint8Array>;
  text(encoding?: string): Promise<string>;

  /** Streaming čitanje za formate koji renderiraju po dijelovima. */
  slice(start: number, end: number): Promise<Uint8Array>;
}

export interface WriteOptions {
  /** Kad je `true`, prethodni sadržaj se čuva kao `.bak` uz datoteku. */
  backup?: boolean;
}

export interface VirtualFileSystem {
  /** Korijeni radnog prostora — na webu jedan po odabranom direktoriju. */
  roots(): Promise<DirectoryEntry[]>;

  stat(uri: Uri): Promise<FileStat>;
  readDirectory(uri: Uri): Promise<DirectoryEntry[]>;

  open(uri: Uri): Promise<DocumentHandle>;
  readBytes(uri: Uri): Promise<Uint8Array>;
  readText(uri: Uri, encoding?: string): Promise<string>;

  writeBytes(uri: Uri, data: Uint8Array, opts?: WriteOptions): Promise<void>;
  writeText(uri: Uri, data: string, opts?: WriteOptions): Promise<void>;

  /** Interaktivni odabir — otvara sistemski dijalog. */
  pickFiles(opts?: { multiple?: boolean; extensions?: string[] }): Promise<DocumentHandle[]>;
  pickDirectory(): Promise<DirectoryEntry | null>;
  pickSaveTarget(suggestedName: string, extensions?: string[]): Promise<Uri | null>;

  /** Podržava li platforma pisanje natrag na izvor (web bez dozvole ne podržava). */
  canWrite(uri: Uri): Promise<boolean>;
}
