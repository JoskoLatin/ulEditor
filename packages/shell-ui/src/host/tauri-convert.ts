/**
 * Conversions through LibreOffice, over Tauri commands to `ul-convert`.
 *
 * Only where a `.cdr`, an `.eps` or a `.ps` is concerned. Everything else in
 * this program is read by a reader of its own, deliberately — requiring a
 * four-hundred-megabyte office suite before a spreadsheet will open was
 * rejected once already, and a document that opens differently depending on
 * what somebody has installed is worse than one that does not open.
 *
 * `available()` asks every time it is called rather than answering from
 * something decided at startup. Somebody can install LibreOffice while the
 * program is open — usually *because* the program just told them to — and being
 * told to install what you have installed is the kind of thing that makes a
 * person close a program for good.
 */

import type { ConversionService, ConvertFormat, Uri } from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import { invoke } from './tauri-fs.js';

/** What `ul_convert::Backend` sends back. */
interface Backend {
  path: string;
  formats: string[];
}

export class TauriConversion implements ConversionService {
  #backend: Backend | null = null;

  async available(): Promise<boolean> {
    this.#backend = await invoke<Backend | null>('convert_backend');
    return this.#backend !== null;
  }

  /** Where LibreOffice is, for the formats panel and for a bug report. */
  async backend(): Promise<Backend | null> {
    this.#backend = await invoke<Backend | null>('convert_backend');
    return this.#backend;
  }

  /**
   * The converted file, as a path.
   *
   * Outside the SDK interface on purpose: the shell opens the result as a
   * document, and a document is a path. Sending twenty megabytes of PDF through
   * the IPC bridge only for the page to hand it back to Rust to be read again
   * would be work done twice and held in the webview in between.
   */
  async toPdfFile(source: Uri): Promise<string> {
    return invoke<string>('convert_to_pdf', { path: source });
  }

  async convert(source: Uri, target: ConvertFormat): Promise<Uint8Array> {
    if (target !== 'pdf') {
      throw new Error(
        t('Converting to {format} is not offered — LibreOffice is here for the drawings nobody else reads.', {
          format: target,
        }),
      );
    }
    const path = await this.toPdfFile(source);
    const buffer = await invoke<ArrayBuffer | number[]>('read_file', { path });
    return buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer);
  }
}
