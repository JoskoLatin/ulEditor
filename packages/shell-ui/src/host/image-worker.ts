/**
 * `ul-image` off the main thread.
 *
 * Measured in Chromium on the served module: a 12-megapixel JPEG takes a
 * quarter of a second to read and 1.4 s to turn and write, a 50-megapixel one
 * 1.0 s and 4.7 s. ADR 0002 set 200 ms of a blocked page as the line past which
 * the work moves to a worker, and every photograph out of a phone is past it.
 *
 * One request at a time, each answered with its `id`. The bytes travel as a
 * transferred buffer both ways, so a picture is never copied between threads.
 */

interface UlImage {
  default(input: { module_or_path: URL }): Promise<unknown>;
  imageInfo(bytes: Uint8Array): unknown;
  imagePreview(bytes: Uint8Array): Uint8Array;
  imageApply(bytes: Uint8Array, ops: unknown): { takeBytes(): Uint8Array; written: unknown; free(): void };
}

export type ImageRequest =
  | { id: number; base: string; op: 'info'; bytes: ArrayBuffer }
  | { id: number; base: string; op: 'preview'; bytes: ArrayBuffer }
  | { id: number; base: string; op: 'apply'; bytes: ArrayBuffer; ops: unknown };

export type ImageResponse =
  | { id: number; ok: true; info?: unknown; written?: unknown; bytes?: ArrayBuffer }
  | { id: number; ok: false; error: string; trapped: boolean };

let glue: Promise<UlImage> | null = null;

function load(base: string): Promise<UlImage> {
  glue ??= (async () => {
    const module = (await import(/* @vite-ignore */ new URL('ul_image.js', base).href)) as UlImage;
    await module.default({ module_or_path: new URL('ul_image_bg.wasm', base) });
    return module;
  })().catch((err: unknown) => {
    // A fetch that failed once is not the answer for ever.
    glue = null;
    throw err;
  });
  return glue;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ImageRequest>) => void) | null;
  postMessage(message: ImageResponse, transfer?: Transferable[]): void;
};

scope.onmessage = async (event) => {
  const request = event.data;
  let module: UlImage;
  try {
    module = await load(request.base);
  } catch (err) {
    /* A module that failed to load is remembered by the worker's module map,
       and asking again here would be answered from it. Reported as a trap,
       so the page ends this worker and the next request gets a fresh one. */
    scope.postMessage({
      id: request.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      trapped: true,
    });
    return;
  }
  try {
    const bytes = new Uint8Array(request.bytes);
    if (request.op === 'info') {
      scope.postMessage({ id: request.id, ok: true, info: module.imageInfo(bytes) });
      return;
    }
    if (request.op === 'preview') {
      const buffer = module.imagePreview(bytes).buffer as ArrayBuffer;
      scope.postMessage({ id: request.id, ok: true, bytes: buffer }, [buffer]);
      return;
    }
    const applied = module.imageApply(bytes, request.ops);
    try {
      const out = applied.takeBytes();
      const buffer = out.buffer as ArrayBuffer;
      scope.postMessage({ id: request.id, ok: true, written: applied.written, bytes: buffer }, [buffer]);
    } finally {
      applied.free();
    }
  } catch (err) {
    /* A trap leaves this instance unusable; the page ends the worker and the
       next request starts a new one. */
    scope.postMessage({
      id: request.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      trapped: err instanceof WebAssembly.RuntimeError,
    });
  }
};
