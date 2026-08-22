/**
 * The webview inspector.
 *
 * **It opens in a window of its own, and that is not our choice.** WebView2 owns
 * its devtools and exposes no way to dock them beside the page — docking is a
 * feature of the Chrome browser, not of an embedded webview. Nothing in Tauri
 * or in the WebView2 API changes that, so a request for "at the side" can only
 * be answered with a second window, and it is better to say so than to
 * approximate it with something that is not the inspector.
 *
 * Available in debug builds. A release binary has it only when built with
 * `--features devtools`, because putting "Inspect" in the right-click menu of a
 * document editor is a strange thing to hand somebody who opened a PDF. The
 * core reports which of the two this is, so the palette can leave the entry out
 * rather than offer one that quietly does nothing.
 */

import type { Shell } from '../host/index.js';

/**
 * Read once at startup and kept in a plain variable, because `when()` on a
 * command is called while the palette is being filtered and cannot await
 * anything.
 */
export let devtoolsAvailable = false;

export function watchDevtools(shell: Shell): void {
  if (shell.platform !== 'desktop') return;
  void (async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      devtoolsAvailable = await invoke<boolean>('devtools_available');
    } catch {
      // An older core without the command: the entry stays hidden, which is the
      // same outcome as the tools being absent.
    }
  })();
}

export async function openDevtools(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_devtools');
  } catch {
    // Nothing to report: a build without the inspector never offers this.
  }
}
