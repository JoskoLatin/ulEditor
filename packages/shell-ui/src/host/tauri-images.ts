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
    return invoke<ImageInfo>('image_info', { path: source });
  }

  async write(source: Uri, target: Uri, ops: ImageOps, options?: WriteOptions): Promise<ImageWritten> {
    return writeInvoke<ImageWritten>(target, 'image_write', {
      source,
      target,
      ops,
      overwrite: options?.overwriteChanged === true,
    });
  }

  async preview(source: Uri): Promise<Uint8Array> {
    // Raw bytes, through `tauri::ipc::Response`.
    const buffer = await invoke<ArrayBuffer | number[]>('image_preview', { path: source });
    return new Uint8Array(buffer);
  }
}
