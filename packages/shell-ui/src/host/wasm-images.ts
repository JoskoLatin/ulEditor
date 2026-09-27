/**
 * The image transforms in a browser: `ul-image`, built to WebAssembly.
 *
 * The same Rust the desktop reaches over a Tauri command (ADR 0002), loaded
 * from the application's own origin — `tools/wasm-assets.mjs` puts it in
 * `public/wasm/` — and run in a worker, because a photograph out of a phone
 * blocks for seconds (see `image-worker.ts`). On desktop the bytes never enter
 * the webview; here there is nowhere else for them to be, so the file is read,
 * handed to the worker and the result written back through the same VFS the
 * editor opened it with.
 *
 * **A worker whose instance trapped is ended.** The core is built with
 * `panic = "abort"`, and a WebAssembly instance that aborts is not usable
 * again. So a trap — or a worker that dies outright, which is how running out
 * of memory can end — terminates it, and the next call starts a fresh one; the
 * failed operation still fails, and says so.
 *
 * `available()` is synchronous and answers for the build: the worker and the
 * module are started on first use, so opening a picture costs nothing until it
 * is edited or asked about.
 */

import type { ImageInfo, ImageOps, ImageService, ImageWritten, Uri, VirtualFileSystem } from '@uleditor/plugin-sdk';

import type { ImageRequest, ImageResponse } from './image-worker.js';

type Pending = { resolve(response: ImageResponse): void; reject(err: Error): void };
type Request = { op: 'info'; bytes: ArrayBuffer } | { op: 'apply'; bytes: ArrayBuffer; ops: ImageOps };

class ImageWorker {
  #worker: Worker | null = null;
  #next = 0;
  #pending = new Map<number, Pending>();

  #start(): Worker {
    const worker = new Worker(new URL('./image-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<ImageResponse>) => {
      const pending = this.#pending.get(event.data.id);
      this.#pending.delete(event.data.id);
      if (!event.data.ok && event.data.trapped) this.#end();
      pending?.resolve(event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.#fail(new Error(event.message || 'The image worker stopped.'));
    };
    this.#worker = worker;
    return worker;
  }

  #end(): void {
    this.#worker?.terminate();
    this.#worker = null;
  }

  #fail(err: Error): void {
    this.#end();
    for (const pending of this.#pending.values()) pending.reject(err);
    this.#pending.clear();
  }

  ask(request: Request): Promise<ImageResponse> {
    const worker = this.#worker ?? this.#start();
    const id = this.#next++;
    const message = { ...request, id, base: new URL('wasm/', document.baseURI).href } as ImageRequest;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      worker.postMessage(message, [request.bytes]);
    });
  }
}

/** The buffer a view covers, as its own buffer — transferring must not take anything else with it. */
function own(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer);
}

function answer(response: ImageResponse): Extract<ImageResponse, { ok: true }> {
  if (!response.ok) throw new Error(response.error);
  return response;
}

export class WasmImages implements ImageService {
  #worker = new ImageWorker();

  constructor(private readonly fs: VirtualFileSystem) {}

  available(): boolean {
    return typeof WebAssembly === 'object' && typeof Worker === 'function';
  }

  async info(source: Uri): Promise<ImageInfo> {
    const bytes = own(await this.fs.readBytes(source));
    return answer(await this.#worker.ask({ op: 'info', bytes })).info as ImageInfo;
  }

  async write(source: Uri, target: Uri, ops: ImageOps): Promise<ImageWritten> {
    const bytes = own(await this.fs.readBytes(source));
    const done = answer(await this.#worker.ask({ op: 'apply', bytes, ops }));
    await this.fs.writeBytes(target, new Uint8Array(done.bytes as ArrayBuffer));
    return done.written as ImageWritten;
  }
}
