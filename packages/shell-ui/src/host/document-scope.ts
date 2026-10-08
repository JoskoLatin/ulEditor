/**
 * A tab's own view of the host (ADR 0006).
 *
 * Rust keeps a **reading** of each document a tab opened — which file it
 * was, how it was protected — named by a token, and compares every save with
 * the reading it continues. The token never reaches an editor: the editor is
 * given this scope instead of the shell, and the scope adds the tab's reading
 * to what the editor reads and writes, by the exact path the tab read it
 * under. Nothing in `plugin-sdk` changes, and no editor knows readings exist.
 *
 * What the scope does with a path:
 *
 * - the tab's document, read through `doc.bytes()`, is read as a reading;
 * - a write of a path this tab read or wrote carries that reading, and the
 *   reading then describes what was written;
 * - a write of any other path — a save in another format, extracted pages —
 *   carries none and begins one, so the next write of it is compared too;
 * - a reading is never lent to another tab or to the shell: an export or the
 *   scratch panel writing over a document open here goes without one, and
 *   the tab's next save is asked about it.
 *
 * Where the file system has no readings — the web build keeps no records —
 * the scope is the host itself.
 */

import type {
  DocumentHandle,
  EditorHost,
  ImageOps,
  ImageService,
  ImageWritten,
  Uri,
  VirtualFileSystem,
  WriteOptions,
} from '@uleditor/plugin-sdk';

export interface ReadingFileSystem {
  readDocument(uri: Uri, reading?: number): Promise<{ reading: number; bytes: Uint8Array }>;
  writeDocument(
    uri: Uri,
    data: Uint8Array,
    opts: WriteOptions | undefined,
    reading: number | undefined,
    begin: boolean,
  ): Promise<number | null>;
  forgetReadings(readings: number[]): Promise<void>;
}

export interface ReadingImages {
  infoDocument(source: Uri, reading?: number): Promise<{ info: Awaited<ReturnType<ImageService['info']>>; reading: number }>;
  writeDocument(
    source: Uri,
    target: Uri,
    ops: ImageOps,
    options: WriteOptions | undefined,
    reading: number | undefined,
    begin: boolean,
  ): Promise<{ written: ImageWritten; reading: number | null }>;
}

export interface DocumentScope {
  /** What the tab's editor is given in place of the shell. */
  readonly host: EditorHost;
  /** The tab's document, read as a reading. */
  readonly doc: DocumentHandle;
  /** Forgets the tab's readings — when it closes. */
  release(): Promise<void>;
}

function hasReadings(fs: unknown): fs is ReadingFileSystem {
  return typeof (fs as Partial<ReadingFileSystem>).readDocument === 'function';
}

function imagesHaveReadings(images: unknown): images is ReadingImages {
  return typeof (images as Partial<ReadingImages>).infoDocument === 'function';
}

/** Every other member of `target`, as it is: methods bound to it. */
function through<T extends object>(target: T, own: Record<PropertyKey, unknown>): T {
  return new Proxy(target, {
    get(object, key) {
      if (Object.prototype.hasOwnProperty.call(own, key)) return own[key];
      const value = Reflect.get(object, key, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

export function documentScope(host: EditorHost, doc: DocumentHandle): DocumentScope {
  const fs = host.fs;
  if (!hasReadings(fs)) {
    return { host, doc, release: async () => {} };
  }

  /* The tab's readings, by the exact path it read or wrote — not folded,
     not resolved: another spelling is another document to the core. */
  const readings = new Map<Uri, number>();

  /* One read however many ask at once: two before the first answer would
     make two readings, and the second would never be forgotten. */
  let reading: Promise<Uint8Array> | null = null;
  const scopedDoc: DocumentHandle = {
    uri: doc.uri,
    name: doc.name,
    stat: doc.stat,
    detection: doc.detection,
    bytes() {
      reading ??= fs.readDocument(doc.uri, readings.get(doc.uri)).then(
        (read) => {
          readings.set(doc.uri, read.reading);
          return read.bytes;
        },
        (err: unknown) => {
          reading = null;
          throw err;
        },
      );
      return reading;
    },
    async text(encoding = 'utf-8') {
      return new TextDecoder(encoding).decode(await this.bytes());
    },
    async slice(start: number, end: number) {
      return (await this.bytes()).slice(start, end);
    },
  };

  /* The tab's own document is never written as a file nobody read: an
     editor that wrote it before reading it through `doc` would otherwise
     save with no question and the security of whatever is there. */
  const unread = (uri: Uri) => new Error(`${doc.name} was not read here, so it is not saved over.`);

  const writeBytes = async (uri: Uri, data: Uint8Array, opts?: WriteOptions): Promise<void> => {
    const known = readings.get(uri);
    if (uri === doc.uri && known === undefined) throw unread(uri);
    const made = await fs.writeDocument(uri, data, opts, known, known === undefined);
    if (made !== null) readings.set(uri, made);
  };
  /* What the scope does with readings is its own: the editor is not handed
     the calls that name them. */
  const scopedFs = through(fs as unknown as VirtualFileSystem, {
    readDocument: undefined,
    writeDocument: undefined,
    forgetReadings: undefined,
    writeBytes,
    writeText: (uri: Uri, data: string, opts?: WriteOptions) =>
      writeBytes(uri, new TextEncoder().encode(data), opts),
  });

  const images = host.images;
  const scopedImages = imagesHaveReadings(images)
    ? through(images, {
        infoDocument: undefined,
        writeDocument: undefined,
        info: async (source: Uri) => {
          /* The tab's own document, or a file it wrote: read as a reading.
             Anything else is only looked at. */
          if (source !== doc.uri && !readings.has(source)) return images.info(source);
          const { info, reading } = await images.infoDocument(source, readings.get(source));
          readings.set(source, reading);
          return info;
        },
        write: async (source: Uri, target: Uri, ops: ImageOps, options?: WriteOptions) => {
          const reading = readings.get(target);
          if (target === doc.uri && reading === undefined) throw unread(target);
          const { written, reading: made } = await images.writeDocument(
            source,
            target,
            ops,
            options,
            reading,
            reading === undefined,
          );
          if (made !== null) readings.set(target, made);
          return written;
        },
      })
    : images;

  return {
    host: { ...host, fs: scopedFs, images: scopedImages },
    doc: scopedDoc,
    release: () => fs.forgetReadings([...readings.values()]),
  };
}
