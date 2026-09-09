/**
 * The cross-format clipboard — the reason this is one application and not five.
 *
 * The `ClipboardPayload` contract and every editor's `copySelection` have
 * existed since the SDK was written, and **nothing carried a payload from one
 * editor to another**: the browser handled Ctrl+C and Ctrl+V, a range copied
 * out of a spreadsheet arrived in a document as tab-separated mush, and the
 * richest representation any editor offered was thrown away between the two
 * keystrokes. This is the wire between them.
 *
 * **Copying is not intercepted.** The browser's own copy is left to do exactly
 * what it does — the system clipboard is its business, and preventing it would
 * mean rewriting it (asynchronously, from inside a synchronous event, with the
 * clipboard API's permissions to worry about) for no gain. What happens instead
 * is that the structure which went with that text is *remembered*: the active
 * editor is asked for its payload, and it is held here until something matching
 * is pasted. The plain text is the key, and it matches by construction, since
 * both sides serialise the same selection.
 *
 * **Pasting is intercepted only when an editor says so, synchronously.** A
 * `paste` event cannot be answered later: by the time a promise resolves, the
 * browser has already pasted or not. So the question is `acceptsPaste`, which
 * an editor answers about a payload it can see — and an editor that does not
 * implement it is never interfered with. That matters more than it sounds: a
 * Word run being edited in a `contenteditable` handles its own paste, and an
 * interception that "helpfully" took it over and then found the editor could
 * not use the payload would paste nothing at all.
 */

import type { ClipboardPayload, RichTextRepresentation } from '@uleditor/plugin-sdk';

import type { Shell } from '../host/index.js';
import { activeInstance } from '../state/workspace.js';

/**
 * The last payload copied inside the application.
 *
 * One, not a history: this is a clipboard, and a clipboard holds one thing. It
 * is dropped as soon as something else is copied anywhere, because a payload
 * whose text no longer matches what is on the clipboard is a payload that would
 * paste the wrong document.
 */
let held: ClipboardPayload | null = null;

/** Exposed for the checks, which have no keyboard. */
export function heldPayload(): ClipboardPayload | null {
  return held;
}

export function forgetPayload(): void {
  held = null;
}

/**
 * The payload a paste should act on.
 *
 * What the event carries is the truth about *what* was copied — it may have
 * come from another program entirely. What is held here is the truth about its
 * *structure*, and it is only allowed to contribute when the two agree letter
 * for letter about the text. Anything else and a table copied an hour ago would
 * be pasted in place of the sentence somebody copied out of their browser a
 * moment ago.
 */
export function payloadFor(text: string, html: string | null): ClipboardPayload {
  if (held && held['text/plain'] === text) return held;

  const payload: ClipboardPayload = { 'text/plain': text };
  if (html) {
    const rich: RichTextRepresentation = { html, origin: 'html' };
    payload['text/html'] = rich;
  }
  return payload;
}

/**
 * Wires both events for the lifetime of the window.
 *
 * `capture: true`, because CodeMirror and the editors' own `contenteditable`
 * regions stop these events on the way up. Their handling still happens: this
 * listener decides nothing unless an editor has said it wants the payload, and
 * calls `preventDefault` only then.
 */
export function watchClipboard(shell: Shell): () => void {
  const onCopy = () => {
    const instance = activeInstance();
    if (!instance?.copySelection) {
      held = null;
      return;
    }

    /* Deliberately not awaited inside the event: the browser is copying the
       text right now and needs nothing from us. The payload lands a tick later,
       which is long before anybody can press Ctrl+V. */
    void instance
      .copySelection()
      .then((payload) => {
        held = payload;
      })
      .catch(() => {
        held = null;
      });
  };

  const onPaste = (event: ClipboardEvent) => {
    const instance = activeInstance();
    if (!instance?.acceptsPaste || !instance.paste) return;

    const data = event.clipboardData;
    if (!data) return;

    const text = data.getData('text/plain');
    if (!text) return;

    const payload = payloadFor(text, data.getData('text/html') || null);
    if (!instance.acceptsPaste(payload)) return;

    /* The editor has taken it. Prevented first and only now, so a decision made
       by anybody else leaves the browser's own paste untouched. */
    event.preventDefault();
    void instance.paste(payload).then((taken) => {
      if (!taken) {
        // It said yes and then did not. That is a bug in that editor rather
        // than a case to paper over, and it is worth seeing.
        shell.notify.show('warning', 'The editor accepted a paste and then refused it.');
      }
    });
  };

  document.addEventListener('copy', onCopy, { capture: true });
  document.addEventListener('paste', onPaste, { capture: true });

  return () => {
    document.removeEventListener('copy', onCopy, { capture: true });
    document.removeEventListener('paste', onPaste, { capture: true });
  };
}
