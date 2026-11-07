/**
 * The keyboard's inset, written where CSS can read it: `--kb-inset` on the root.
 *
 * Every field in all three interfaces stands above the keyboard, and each of
 * them places itself with `bottom: var(--kb-inset)`. The arithmetic is
 * `keyboardInset` in `mobile-core`; this only reads what it needs out of the
 * window and writes the answer, every time either of them reports a change.
 *
 * Measured on both phones (ADR 0009, K2 a): with the keyboard up `innerHeight`
 * stays put while `visualViewport.height` shrinks, and `visualViewport` fires
 * `resize`. So both are read afresh on every event, never kept: the numbers are
 * the window's, and a copy of them would be the one thing here that could be
 * wrong. `scroll` too, because the visible part can be moved down the layout
 * and `offsetTop` with it.
 */

import { keyboardInset } from '@uleditor/mobile-core';

export const KB_INSET = '--kb-inset';

/** Keeps `--kb-inset` on `root` up to date; returns what takes it away again. */
export function watchKeyboard(root: HTMLElement = document.documentElement): () => void {
  const viewport = window.visualViewport;

  const apply = () => {
    const inset = keyboardInset({
      layoutHeight: window.innerHeight,
      /* A WebView without `visualViewport` has no way to say a keyboard is up,
         so it is taken to be down rather than guessed at. */
      viewportHeight: viewport ? viewport.height : window.innerHeight,
      viewportOffsetTop: viewport ? viewport.offsetTop : 0,
    });
    root.style.setProperty(KB_INSET, `${inset}px`);
  };

  apply();
  viewport?.addEventListener('resize', apply);
  viewport?.addEventListener('scroll', apply);
  window.addEventListener('resize', apply);

  return () => {
    viewport?.removeEventListener('resize', apply);
    viewport?.removeEventListener('scroll', apply);
    window.removeEventListener('resize', apply);
    root.style.removeProperty(KB_INSET);
  };
}
