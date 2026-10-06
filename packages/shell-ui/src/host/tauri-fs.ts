/**
 * VirtualFileSystem over Tauri commands to the Rust `ul-core`.
 *
 * The same interfaces as `BrowserFileSystem` — the editors see no difference. The
 * differences are in what the web cannot do: real system dialogs, atomic saving,
 * a sandbox enforced by Rust, and reading bytes without JSON serialisation.
 *
 * A URI here is an absolute path on disk.
 */

import {
  ChangedOutsideError,
  type DirectoryEntry,
  type DocumentHandle,
  type FileStat,
  type FormatDetection,
  type Uri,
  type VirtualFileSystem,
  type WriteOptions,
} from '@uleditor/plugin-sdk';

import { detectByName } from './detect.js';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

let invokeFn: Invoke | null = null;

/** A dynamic import: the web build must not pull the Tauri API into the bundle. */
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!invokeFn) {
    const core = await import('@tauri-apps/api/core');
    invokeFn = core.invoke as Invoke;
  }
  return invokeFn<T>(command, args);
}

/**
 * What a write refused over a changed file begins with, from Rust
 * (`ul_core::vfs::CHANGED_OUTSIDE`). A code, so it is matched here rather than
 * the sentence, which is for people.
 */
const CHANGED_OUTSIDE = 'ul:changed-outside:';

/** A write, with Rust's refusal over a changed file turned into its own error. */
export async function writeInvoke<T>(uri: Uri, command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    if (typeof err === 'string' && err.startsWith(CHANGED_OUTSIDE)) throw new ChangedOutsideError(uri);
    throw err;
  }
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** The shape `ul_core::vfs::Stat` returns. */
interface RawStat {
  uri: string;
  name: string;
  parent: string | null;
  kind: 'file' | 'directory' | 'link';
  size: number;
  modified: number | null;
  readonly: boolean;
}

interface RawEntry extends RawStat {
  detection: { format: FormatDetection['format']; via: FormatDetection['via']; language: string | null };
}

function toStat(raw: RawStat): FileStat {
  return {
    uri: raw.uri,
    name: raw.name,
    parent: raw.parent,
    kind: raw.kind,
    size: raw.size,
    modified: raw.modified,
    readonly: raw.readonly,
  };
}

function toDetection(raw: RawEntry['detection']): FormatDetection {
  return raw.language ? { format: raw.format, via: raw.via, language: raw.language } : { format: raw.format, via: raw.via };
}

export class TauriFileSystem implements VirtualFileSystem {
  async roots(): Promise<DirectoryEntry[]> {
    const raw = await invoke<RawStat[]>('roots');
    return raw.map((entry) => toStat(entry) as DirectoryEntry);
  }

  async stat(uri: Uri): Promise<FileStat> {
    return toStat(await invoke<RawStat>('stat', { path: uri }));
  }

  async readDirectory(uri: Uri): Promise<DirectoryEntry[]> {
    const raw = await invoke<RawEntry[]>('read_directory', { path: uri });
    return raw.map((entry) => toStat(entry) as DirectoryEntry);
  }

  async readBytes(uri: Uri): Promise<Uint8Array> {
    // Rust returns raw bytes through `tauri::ipc::Response`.
    const buffer = await invoke<ArrayBuffer | number[]>('read_file', { path: uri });
    return buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer);
  }

  async #readDocument(uri: Uri): Promise<Uint8Array> {
    const buffer = await invoke<ArrayBuffer | number[]>('read_document', { path: uri });
    return buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer);
  }

  async readText(uri: Uri, encoding = 'utf-8'): Promise<string> {
    return new TextDecoder(encoding).decode(await this.readBytes(uri));
  }

  async open(uri: Uri): Promise<DocumentHandle> {
    const [stat, detection] = await Promise.all([
      this.stat(uri),
      invoke<RawEntry['detection']>('detect_format', { path: uri }),
    ]);
    return this.#document(stat, toDetection(detection));
  }

  #document(stat: FileStat, detection: FormatDetection): DocumentHandle {
    const fs = this;
    let cached: Uint8Array | null = null;

    return {
      uri: stat.uri,
      name: stat.name,
      stat,
      detection,
      async bytes() {
        /* Read as a document: Rust remembers it as it is now, so a save can
           tell whether somebody changed it while it was open (ADR 0004). */
        cached ??= await fs.#readDocument(stat.uri);
        return cached;
      },
      async text(encoding = 'utf-8') {
        return new TextDecoder(encoding).decode(await this.bytes());
      },
      async slice(start: number, end: number) {
        // Rust has no range read yet; until phase 1 we slice in memory.
        return (await this.bytes()).slice(start, end);
      },
    };
  }

  async writeBytes(uri: Uri, data: Uint8Array, opts?: WriteOptions): Promise<void> {
    await writeInvoke(uri, 'write_file', {
      path: uri,
      contents: Array.from(data),
      overwrite: opts?.overwriteChanged === true,
    });
  }

  async writeText(uri: Uri, data: string, opts?: WriteOptions): Promise<void> {
    await this.writeBytes(uri, new TextEncoder().encode(data), opts);
  }

  async pickFiles(): Promise<DocumentHandle[]> {
    const picked = await invoke<RawStat[]>('pick_files');
    const docs: DocumentHandle[] = [];
    for (const raw of picked) docs.push(await this.open(raw.uri));
    return docs;
  }

  /**
   * Takes in paths dropped onto the window. On desktop Tauri gives paths rather
   * than `File` objects, so the web route through `adoptFiles` does not exist
   * here.
   *
   * Dropped folders do not become tabs but new tree roots — which is why one call
   * returns both, kept apart.
   */
  async adoptPaths(paths: string[]): Promise<{
    documents: DocumentHandle[];
    directories: DirectoryEntry[];
  }> {
    const stats = await invoke<RawStat[]>('adopt_paths', { paths });

    const documents: DocumentHandle[] = [];
    const directories: DirectoryEntry[] = [];
    for (const stat of stats) {
      if (stat.kind === 'directory') directories.push(toStat(stat) as DirectoryEntry);
      else documents.push(await this.open(stat.uri));
    }
    return { documents, directories };
  }

  /** A folder off the tree is out of the sandbox too — see `ShellFileSystem`. */
  async forgetRoot(uri: Uri, keep: Uri[] = [], remember = false): Promise<void> {
    await invoke('forget_root', { path: uri, keep, remember });
  }

  async forgetConsents(): Promise<void> {
    await invoke('forget_consents');
  }

  async pickDirectory(): Promise<DirectoryEntry | null> {
    const raw = await invoke<RawStat | null>('pick_directory');
    return raw ? (toStat(raw) as DirectoryEntry) : null;
  }

  async pickSaveTarget(suggestedName: string): Promise<Uri | null> {
    return invoke<string | null>('pick_save_target', { suggestedName });
  }

  async canWrite(uri: Uri): Promise<boolean> {
    try {
      return !(await this.stat(uri)).readonly;
    } catch {
      return false;
    }
  }

  /** Detection by name for the tree, where the content has not been read yet. */
  detectionForName(name: string): FormatDetection {
    return detectByName(name);
  }
}
