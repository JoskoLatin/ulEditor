/**
 * Language servers, over Tauri commands to `ul-lsp`.
 *
 * The commands go one way and the news comes back the other: a server publishes
 * when it has something to say — after it has finished indexing, after a
 * `cargo check` — so there is nothing to poll and nothing to await. Rust emits
 * an event, this listens for it, and every editor that has a document open gets
 * told about its own.
 *
 * **The path is already a path.** A server answers with
 * `file:///c:/dev/x.rs` for a file the editor calls `C:\dev\x.rs`, and the Rust
 * side converts it before emitting — three slashes, a lowercased drive letter
 * and percent-encoded spaces are the platform's business, and it has one.
 *
 * The three questions below go the other way, and they are the reason the Rust
 * client had to learn to correlate a reply with a request at all. **None of
 * them rejects**: a server with nothing to say, a server that refused the
 * question and a server still indexing are all answered here as nothing, on
 * purpose. There is no tooltip, no jump and no list — which is exactly what
 * "it does not know" looks like, and is not a thing to interrupt anybody over.
 */

import {
  Emitter,
  type CodeCompletion,
  type CodeHover,
  type CodeLocation,
  type DiagnosticsPublished,
  type LanguageService,
  type Uri,
} from '@uleditor/plugin-sdk';

import { invoke } from './tauri-fs.js';

/** The shape the Rust side emits. */
type Message =
  | ({ kind: 'diagnostics' } & DiagnosticsPublished)
  | { kind: 'stopped'; language: string; detail: string };

export class TauriLanguageServers implements LanguageService {
  #emitter = new Emitter<DiagnosticsPublished>();
  #listening = false;

  readonly onDiagnostics = this.#emitter.event;

  async languages(): Promise<string[]> {
    return invoke<string[]>('lsp_languages');
  }

  async open(uri: Uri, language: string, text: string): Promise<boolean> {
    await this.#listen();
    return invoke<boolean>('lsp_open', { path: uri, language, text });
  }

  async change(uri: Uri, language: string, version: number, text: string): Promise<void> {
    await invoke('lsp_change', { path: uri, language, version, text });
  }

  async save(uri: Uri, language: string): Promise<void> {
    await invoke('lsp_save', { path: uri, language });
  }

  async close(uri: Uri, language: string): Promise<void> {
    await invoke('lsp_close', { path: uri, language });
  }

  async hover(uri: Uri, language: string, line: number, column: number): Promise<CodeHover | null> {
    try {
      return await invoke<CodeHover | null>('lsp_hover', { path: uri, language, line, column });
    } catch {
      return null;
    }
  }

  async definition(
    uri: Uri,
    language: string,
    line: number,
    column: number,
  ): Promise<CodeLocation[]> {
    try {
      return await invoke<CodeLocation[]>('lsp_definition', { path: uri, language, line, column });
    } catch {
      return [];
    }
  }

  async completions(
    uri: Uri,
    language: string,
    line: number,
    column: number,
  ): Promise<CodeCompletion[]> {
    try {
      return await invoke<CodeCompletion[]>('lsp_completion', { path: uri, language, line, column });
    } catch {
      return [];
    }
  }

  /**
   * Subscribes once, on the first document that is served.
   *
   * Not at startup: a session that opens nothing but PDFs should not have
   * loaded the event plugin at all, and a listener with nothing to hear is a
   * listener nobody remembers to remove.
   */
  async #listen(): Promise<void> {
    if (this.#listening) return;
    this.#listening = true;

    const { listen } = await import('@tauri-apps/api/event');
    await listen<Message>('uleditor://language', ({ payload }) => {
      if (payload.kind === 'diagnostics') {
        this.#emitter.fire({
          uri: payload.uri,
          language: payload.language,
          diagnostics: payload.diagnostics,
        });
        return;
      }

      /* A server that stopped. Nothing is reported to the person: it happens on
         the way out of the program, and an editor that announced "rust-analyzer
         has stopped" while the window was closing would be alarming about
         nothing. What matters is that the underlines stop being updated, and
         they do, because nothing is publishing them. */
      console.info(`[uleditor] ${payload.language} language server stopped: ${payload.detail}`);
    });
  }
}
