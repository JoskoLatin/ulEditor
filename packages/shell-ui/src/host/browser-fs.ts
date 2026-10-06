/**
 * VirtualFileSystem over the File System Access API.
 *
 * This is the web implementation; the desktop one goes through Tauri commands to
 * the Rust `ul-core`. The editors see no difference — which is why the whole API
 * is async and built on opaque URIs rather than on paths.
 *
 * The FSA API exists in Chromium (and therefore in WebView2, which Tauri uses on
 * Windows). In Firefox and Safari a degraded mode applies: files can be opened
 * through <input type="file">, but not saved back.
 */

import type {
  DirectoryEntry,
  DocumentHandle,
  FileStat,
  Uri,
  VirtualFileSystem,
  WriteOptions,
} from '@uleditor/plugin-sdk';
import { getLocale, t } from '@uleditor/i18n';

import { detect, detectByName } from './detect.js';
import { dropRoot, storeRoot, storedRoots } from './root-store.js';

/** A folder from the last visit that the browser will ask about again. */
export interface WaitingRoot {
  uri: Uri;
  name: string;
  /** Asks the browser, from a person's click; the folder, or null if not given. */
  grant(): Promise<DirectoryEntry | null>;
}

/* ── minimalne deklaracije FSA API-ja ────────────────────────────────── */

interface FsPermissionDescriptor {
  mode?: 'read' | 'readwrite';
}
interface FsHandleBase {
  kind: 'file' | 'directory';
  name: string;
  queryPermission?(desc?: FsPermissionDescriptor): Promise<PermissionState>;
  requestPermission?(desc?: FsPermissionDescriptor): Promise<PermissionState>;
  isSameEntry?(other: FsHandleBase): Promise<boolean>;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
interface FsWritable {
  write(data: BufferSource | Blob | string): Promise<void>;
  close(): Promise<void>;
}
interface FsFileHandle extends FsHandleBase {
  kind: 'file';
  getFile(): Promise<File>;
  createWritable(opts?: { keepExistingData?: boolean }): Promise<FsWritable>;
}
interface FsDirectoryHandle extends FsHandleBase {
  kind: 'directory';
  values(): AsyncIterableIterator<FsFileHandle | FsDirectoryHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle>;
}
type FsHandle = FsFileHandle | FsDirectoryHandle;

interface FsPickerWindow {
  showOpenFilePicker?(opts?: {
    multiple?: boolean;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }): Promise<FsFileHandle[]>;
  showDirectoryPicker?(opts?: { mode?: 'read' | 'readwrite' }): Promise<FsDirectoryHandle>;
  showSaveFilePicker?(opts?: {
    suggestedName?: string;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }): Promise<FsFileHandle>;
}

/* The window itself in a browser, so pickers set on it later are seen; an
   empty object where there is none — the checks that load this under Node. */
const picker = (typeof window === 'undefined' ? {} : window) as unknown as FsPickerWindow;

export function hasFileSystemAccess(): boolean {
  return typeof picker.showOpenFilePicker === 'function';
}

/* ── helpers ─────────────────────────────────────────────────────────── */

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function acceptFor(extensions?: string[]) {
  if (!extensions?.length) return undefined;
  const accept: Record<string, string[]> = {};
  for (const ext of extensions) {
    const clean = ext.replace(/^\./, '').toLowerCase();
    const mime = MIME_BY_EXT[clean] ?? 'application/octet-stream';
    (accept[mime] ??= []).push(`.${clean}`);
  }
  return [{ description: t('Supported files'), accept }];
}

/** Directories that never deserve a place in the tree. */
const NOISE = new Set(['node_modules', '.git', 'target', 'dist', '.next', '.turbo', '.venv']);

/* ── implementacija ──────────────────────────────────────────────────── */

export class BrowserFileSystem implements VirtualFileSystem {
  /** URI → handle. The URI is stable and readable: `ul:/project/src/main.ts`. */
  #handles = new Map<Uri, FsHandle>();
  #parents = new Map<Uri, Uri | null>();
  #roots: Uri[] = [];
  #looseCounter = 0;

  /* — registracija — */

  #register(uri: Uri, handle: FsHandle, parent: Uri | null): void {
    this.#handles.set(uri, handle);
    this.#parents.set(uri, parent);
  }

  #handle(uri: Uri): FsHandle {
    const h = this.#handles.get(uri);
    if (!h) throw new Error(`Unknown URI: ${uri}`);
    return h;
  }

  #fileHandle(uri: Uri): FsFileHandle {
    const h = this.#handle(uri);
    if (h.kind !== 'file') throw new Error(`${uri} is not a file`);
    return h;
  }

  async #statFrom(uri: Uri, handle: FsHandle): Promise<FileStat> {
    const parent = this.#parents.get(uri) ?? null;
    if (handle.kind === 'directory') {
      return { uri, name: handle.name, parent, kind: 'directory', size: 0, modified: null, readonly: false };
    }
    const file = await handle.getFile();
    return {
      uri,
      name: handle.name,
      parent,
      kind: 'file',
      size: file.size,
      modified: file.lastModified || null,
      readonly: !(await this.canWrite(uri)),
    };
  }

  /* — reading — */

  async roots(): Promise<DirectoryEntry[]> {
    const out: DirectoryEntry[] = [];
    for (const uri of this.#roots) {
      const handle = this.#handles.get(uri);
      if (handle) out.push((await this.#statFrom(uri, handle)) as DirectoryEntry);
    }
    return out;
  }

  async stat(uri: Uri): Promise<FileStat> {
    return this.#statFrom(uri, this.#handle(uri));
  }

  async readDirectory(uri: Uri): Promise<DirectoryEntry[]> {
    const handle = this.#handle(uri);
    if (handle.kind !== 'directory') throw new Error(`${uri} is not a directory`);

    const entries: DirectoryEntry[] = [];
    for await (const child of handle.values()) {
      if (child.name.startsWith('.') && child.kind === 'directory') continue;
      if (NOISE.has(child.name)) continue;

      const childUri = `${uri}/${child.name}`;
      this.#register(childUri, child, uri);
      entries.push({
        uri: childUri,
        name: child.name,
        parent: uri,
        kind: child.kind,
        size: 0,
        modified: null,
        readonly: false,
      });
    }

    /* Directories first, then alphabetically — without this the tree is
       unreadable. The language of the comparison is the interface's, the same
       rule as shell/tree-sort.ts, which sorts this again at drawing time — the
       same options too, or `slika10` sorts before `slika2` here and after it
       there, and the two disagree about a folder neither of them has changed.
       It used to be Croatian whatever the interface was in, which is a decision
       nobody made for anybody outside Croatia. */
    const collator = new Intl.Collator(getLocale(), { numeric: true, sensitivity: 'base' });
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return collator.compare(a.name, b.name);
    });
    return entries;
  }

  async readBytes(uri: Uri): Promise<Uint8Array> {
    const file = await this.#fileHandle(uri).getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async readText(uri: Uri, encoding = 'utf-8'): Promise<string> {
    const bytes = await this.readBytes(uri);
    return new TextDecoder(encoding).decode(bytes);
  }

  async open(uri: Uri): Promise<DocumentHandle> {
    const handle = this.#fileHandle(uri);
    const stat = await this.#statFrom(uri, handle);
    const head = new Uint8Array(await (await handle.getFile()).slice(0, 65536).arrayBuffer());
    return this.#makeDocument(uri, handle, stat, detect(handle.name, head));
  }

  #makeDocument(
    uri: Uri,
    handle: FsFileHandle,
    stat: FileStat,
    detection: DocumentHandle['detection'],
  ): DocumentHandle {
    const fs = this;
    let cached: Uint8Array | null = null;

    return {
      uri,
      name: handle.name,
      stat,
      detection,
      async bytes() {
        cached ??= await fs.readBytes(uri);
        return cached;
      },
      async text(encoding = 'utf-8') {
        return new TextDecoder(encoding).decode(await this.bytes());
      },
      async slice(start: number, end: number) {
        const file = await handle.getFile();
        return new Uint8Array(await file.slice(start, end).arrayBuffer());
      },
    };
  }

  /* — writing — */

  async canWrite(uri: Uri): Promise<boolean> {
    const handle = this.#handles.get(uri);
    if (!handle?.queryPermission) return false;
    try {
      return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
    } catch {
      return false;
    }
  }

  async #ensureWritable(handle: FsHandle): Promise<void> {
    if (!handle.queryPermission || !handle.requestPermission) return;
    if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return;
    if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
      throw new Error(t('The browser did not grant permission to write this file.'));
    }
  }

  /**
   * The handle for a file about to be written, made in its folder if the file
   * is new — an image saved in another format, or a copy saved beside the
   * original. Only in a folder the person opened: a file opened on its own
   * has no folder here to write a sibling into.
   */
  async #writableHandle(uri: Uri): Promise<FsFileHandle> {
    if (this.#handles.has(uri)) return this.#fileHandle(uri);
    const slash = uri.lastIndexOf('/');
    const parentUri = uri.slice(0, slash);
    const name = uri.slice(slash + 1);
    const parent = this.#handles.get(parentUri);
    if (!parent || parent.kind !== 'directory' || !name || name === '.' || name === '..') {
      throw new Error(t('A new file can only be written into a folder that is open.'));
    }
    /* Unknown here is not the same as absent there: a file made outside the
       program after the folder was listed has no entry in this map, and
       `create: true` would hand it back and truncate it. So the folder is
       asked, and a file that is already there is refused like any other. */
    const existing = await parent.getFileHandle(name).then(
      () => true,
      () => false,
    );
    if (existing) {
      throw new Error(t('{name} already exists. Use Save as to replace it or to choose another name.', { name }));
    }
    await this.#ensureWritable(parent);
    const handle = await parent.getFileHandle(name, { create: true });
    this.#register(uri, handle, parentUri);
    return handle;
  }

  async writeBytes(uri: Uri, data: Uint8Array, _opts?: WriteOptions): Promise<void> {
    const handle = await this.#writableHandle(uri);
    await this.#ensureWritable(handle);
    const writable = await handle.createWritable();
    // A copy into a fresh ArrayBuffer — writable does not accept views onto a SharedArrayBuffer.
    await writable.write(new Uint8Array(data).buffer as ArrayBuffer);
    await writable.close();
  }

  async writeText(uri: Uri, data: string, opts?: WriteOptions): Promise<void> {
    await this.writeBytes(uri, new TextEncoder().encode(data), opts);
  }

  /* — dijalozi — */

  async pickFiles(opts?: { multiple?: boolean; extensions?: string[] }): Promise<DocumentHandle[]> {
    if (!picker.showOpenFilePicker) throw new Error(t('This browser cannot open files.'));

    const types = acceptFor(opts?.extensions);
    const handles = await picker.showOpenFilePicker(
      types ? { multiple: opts?.multiple ?? false, types } : { multiple: opts?.multiple ?? false },
    );

    const docs: DocumentHandle[] = [];
    for (const handle of handles) {
      const uri = `ul:file/${this.#looseCounter++}/${handle.name}`;
      this.#register(uri, handle, null);
      docs.push(await this.open(uri));
    }
    return docs;
  }

  async pickDirectory(): Promise<DirectoryEntry | null> {
    if (!picker.showDirectoryPicker) throw new Error(t('This browser cannot open folders.'));
    const handle = await picker.showDirectoryPicker({ mode: 'readwrite' });
    const uri = await this.#rootUri(handle);
    // Kept for the next visit (host/root-store.ts); the permission is not.
    void storeRoot({ uri, name: handle.name, handle });
    return this.#adoptRoot(uri, handle);
  }

  /**
   * One folder, one uri. The same folder picked again keeps the uri it had;
   * another folder with the same name gets `~2`. Two folders under one uri
   * would hand one's files to the other — `ul:/docs/a.md` read from one and
   * saved into the other — and a kept record would carry that to every visit.
   */
  async #rootUri(handle: FsDirectoryHandle): Promise<Uri> {
    const known = new Map<Uri, FsHandle>();
    for (const stored of await storedRoots()) known.set(stored.uri, stored.handle as FsHandle);
    for (const root of this.#roots) {
      const open = this.#handles.get(root);
      if (open) known.set(root, open);
    }
    for (const [uri, other] of known) {
      if (await other.isSameEntry?.(handle).catch(() => false)) return uri;
    }
    const base = `ul:/${handle.name}`;
    let uri = base;
    for (let n = 2; known.has(uri) || this.#handles.has(uri); n++) uri = `${base}~${n}`;
    return uri;
  }

  #adoptRoot(uri: Uri, handle: FsDirectoryHandle): DirectoryEntry {
    this.#register(uri, handle, null);
    if (!this.#roots.includes(uri)) this.#roots.push(uri);
    return { uri, name: handle.name, parent: null, kind: 'directory', size: 0, modified: null, readonly: false };
  }

  /** A folder taken off the tree is not brought back on the next visit. */
  async forgetRoot(uri: Uri): Promise<void> {
    this.#roots = this.#roots.filter((r) => r !== uri);
    await dropRoot(uri);
  }

  /**
   * The folders open at the last visit (ADR 0002, step 8), by what the browser
   * still allows. Where it still grants access — Chrome's "allow on every
   * visit" — the folder is back at once. Where it would ask, nothing asks by
   * itself: the folder waits, and `grant()` is for a click on a button that
   * says what it is for, since the browser's prompt needs a person's gesture
   * anyway and a program that opens with permission dialogs is worse than one
   * that opens empty. A folder the browser has refused is forgotten.
   */
  async restoreRoots(): Promise<{ ready: DirectoryEntry[]; waiting: WaitingRoot[] }> {
    const ready: DirectoryEntry[] = [];
    const waiting: WaitingRoot[] = [];
    if (!hasFileSystemAccess()) return { ready, waiting };
    for (const stored of await storedRoots()) {
      const handle = stored.handle as FsDirectoryHandle;
      /* The name shown is the handle's own, never the record's, and the record's
         uri has to be the one this code would give that name: a record written
         by anything else on the origin — "projekt" over a handle to the whole
         home folder — is thrown away, not offered. */
      const own = `ul:/${handle.name}`;
      const ours = stored.uri === own || new RegExp(`^${escapeRegExp(own)}~\\d+$`).test(stored.uri);
      if (handle.kind !== 'directory' || !handle.queryPermission || !handle.requestPermission || !ours) {
        await dropRoot(stored.uri);
        continue;
      }
      const state = await handle.queryPermission({ mode: 'readwrite' }).catch(() => 'denied' as const);
      if (state === 'granted') {
        ready.push(this.#adoptRoot(stored.uri, handle));
      } else if (state === 'prompt') {
        const request = handle.requestPermission.bind(handle);
        waiting.push({
          uri: stored.uri,
          name: handle.name,
          grant: async () => {
            // First, before anything else is awaited: the browser only asks
            // while the click that led here still counts as a gesture.
            const answer = await request({ mode: 'readwrite' }).catch(() => 'prompt' as const);
            if (answer === 'granted') return this.#adoptRoot(stored.uri, handle);
            if (answer === 'denied') await dropRoot(stored.uri);
            return null;
          },
        });
      } else {
        await dropRoot(stored.uri);
      }
    }
    return { ready, waiting };
  }

  async pickSaveTarget(suggestedName: string, extensions?: string[]): Promise<Uri | null> {
    if (!picker.showSaveFilePicker) return null;
    const types = acceptFor(extensions);
    const handle = await picker.showSaveFilePicker(types ? { suggestedName, types } : { suggestedName });
    const uri = `ul:file/${this.#looseCounter++}/${handle.name}`;
    this.#register(uri, handle, null);
    return uri;
  }

  /* — degraded mode: <input type="file"> — */

  /** Opens files without the FSA API. The result is read-only. */
  async adoptFiles(files: FileList | File[]): Promise<DocumentHandle[]> {
    const docs: DocumentHandle[] = [];
    for (const file of Array.from(files)) {
      const uri = `ul:blob/${this.#looseCounter++}/${file.name}`;
      const handle: FsFileHandle = {
        kind: 'file',
        name: file.name,
        getFile: async () => file,
        createWritable: async () => {
          throw new Error(t('The file is open read-only.'));
        },
      };
      this.#register(uri, handle, null);

      const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
      const stat: FileStat = {
        uri,
        name: file.name,
        parent: null,
        kind: 'file',
        size: file.size,
        modified: file.lastModified || null,
        readonly: true,
      };
      docs.push(this.#makeDocument(uri, handle, stat, detect(file.name, head)));
    }
    return docs;
  }

  /** Detection by name for the tree, where the content has not been read yet. */
  detectionForName(name: string) {
    return detectByName(name);
  }
}
