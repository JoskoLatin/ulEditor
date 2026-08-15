/**
 * VirtualFileSystem preko Tauri komandi na Rust `ul-core`.
 *
 * Ista sučelja kao `BrowserFileSystem` — editori razliku ne vide. Razlike su
 * u onome što web ne može: pravi sistemski dijalozi, atomarno spremanje,
 * sandbox koji provodi Rust, i čitanje bajtova bez JSON serijalizacije.
 *
 * URI je ovdje apsolutna putanja na disku.
 */

import type {
  DirectoryEntry,
  DocumentHandle,
  FileStat,
  FormatDetection,
  Uri,
  VirtualFileSystem,
  WriteOptions,
} from '@uleditor/plugin-sdk';

import { detectByName } from './detect.js';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

let invokeFn: Invoke | null = null;

/** Dinamički uvoz: web build ne smije povući Tauri API u bundle. */
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!invokeFn) {
    const core = await import('@tauri-apps/api/core');
    invokeFn = core.invoke as Invoke;
  }
  return invokeFn<T>(command, args);
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Oblik koji vraća `ul_core::vfs::Stat`. */
interface RawStat {
  uri: string;
  name: string;
  parent: string | null;
  kind: 'file' | 'directory';
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
    // Rust vraća sirove bajtove kroz `tauri::ipc::Response`.
    const buffer = await invoke<ArrayBuffer | number[]>('read_file', { path: uri });
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
        cached ??= await fs.readBytes(stat.uri);
        return cached;
      },
      async text(encoding = 'utf-8') {
        return new TextDecoder(encoding).decode(await this.bytes());
      },
      async slice(start: number, end: number) {
        // Rust još nema range-read; do faze 1 režemo u memoriji.
        return (await this.bytes()).slice(start, end);
      },
    };
  }

  async writeBytes(uri: Uri, data: Uint8Array, _opts?: WriteOptions): Promise<void> {
    await invoke('write_file', { path: uri, contents: Array.from(data) });
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

  /** Detekcija po imenu za stablo, gdje sadržaj još nije pročitan. */
  detectionForName(name: string): FormatDetection {
    return detectByName(name);
  }
}
