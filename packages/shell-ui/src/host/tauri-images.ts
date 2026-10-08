/**
 * The image transforms, over Tauri commands to `ul-image`.
 *
 * Nothing but the plan crosses the boundary. The Rust side reads the file,
 * applies the plan and writes the result, and what comes back is three numbers
 * and two flags — so a forty-megapixel photograph is never decoded in the
 * webview, on a phone least of all.
 */

import type {
  ImageInfo,
  ImageOps,
  ImageService,
  ImageWritten,
  Uri,
  WriteOptions,
} from '@uleditor/plugin-sdk';

import { invoke, writeInvoke } from './tauri-fs.js';

export class TauriImages implements ImageService {
  available(): boolean {
    return true;
  }

  async info(source: Uri): Promise<ImageInfo> {
    const { reading: _, ...info } = await invoke<ImageInfo & { reading: number | null }>('image_info', {
      path: source,
    });
    return info;
  }

  async write(source: Uri, target: Uri, ops: ImageOps, options?: WriteOptions): Promise<ImageWritten> {
    const { written } = await this.writeDocument(source, target, ops, options, undefined, false);
    return written;
  }

  /** The image editor's reading of its document (ADR 0006): for a tab's scope. */
  async infoDocument(source: Uri, reading?: number): Promise<{ info: ImageInfo; reading: number }> {
    const { reading: made, ...info } = await invoke<ImageInfo & { reading: number }>('image_info', {
      path: source,
      reading: reading ?? null,
      asDocument: true,
    });
    return { info, reading: made };
  }

  /** A write compared with the reading it continues, or beginning one. */
  async writeDocument(
    source: Uri,
    target: Uri,
    ops: ImageOps,
    options: WriteOptions | undefined,
    reading: number | undefined,
    begin: boolean,
  ): Promise<{ written: ImageWritten; reading: number | null }> {
    const { reading: made, ...written } = await writeInvoke<ImageWritten & { reading: number | null }>(
      target,
      'image_write',
      {
        source,
        target,
        ops,
        overwrite: options?.overwriteChanged === true,
        reading: reading ?? null,
        begin,
      },
    );
    return { written, reading: made };
  }

  async preview(source: Uri): Promise<Uint8Array> {
    // Raw bytes, through `tauri::ipc::Response`.
    const buffer = await invoke<ArrayBuffer | number[]>('image_preview', { path: source });
    return new Uint8Array(buffer);
  }
}
