/**
 * How much of the screen the keyboard covers.
 *
 * Every field in all three interfaces stands above the keyboard, so every one
 * of them needs this number, and it is one subtraction. Measured on the Pixel
 * (ADR 0009, K2 a), in the app as it is, with `enableEdgeToEdge()` and nothing
 * changed in `MainActivity.kt`: with the keyboard up `innerHeight` stays 997
 * CSS px while `visualViewport.height` falls to 632, and both fire `resize`. The
 * layout is not resized under the keyboard; only the visible part shrinks. So
 * the keyboard is what lies between the bottom of the visible part and the
 * bottom of the layout, and a field placed `var(--kb-inset)` above the layout's
 * bottom sits on the keyboard's top edge.
 *
 * Numbers in, a number out. The adapter in `mobile/common` reads `innerHeight`
 * and `visualViewport` and writes `--kb-inset`; nothing here reads the DOM.
 *
 * Not handled, because not measured: a pinch zoom also shrinks the visual
 * viewport, and these numbers alone cannot tell it from a keyboard.
 */

export interface ViewportMeasure {
  /** The layout viewport's height, `innerHeight`. It stays put when the keyboard opens. */
  layoutHeight: number;
  /** `visualViewport.height`: what is left visible above the keyboard. */
  viewportHeight: number;
  /** `visualViewport.offsetTop`: how far the visible part has been scrolled down the layout. */
  viewportOffsetTop?: number;
}

/**
 * A fraction of a pixel left over from the arithmetic is not a keyboard; a
 * keyboard's height that comes out fractional is rounded up, so the field's
 * lower edge lands at or above the keyboard's top and never a fraction into it.
 */
const SLACK = 0.01;

/** The keyboard's inset in CSS px: 0 when it is down, never negative, never more than the layout. */
export function keyboardInset(measure: ViewportMeasure): number {
  const layout = measure.layoutHeight;
  const height = measure.viewportHeight;
  const offset = measure.viewportOffsetTop ?? 0;
  /* What the WebView reports is trusted for its type and nothing more: a value
     that is not a number, or not a sane one, says nothing about a keyboard. */
  if (![layout, height, offset].every(Number.isFinite) || layout <= 0 || height < 0 || offset < 0) {
    return 0;
  }
  const covered = layout - offset - height;
  return Math.min(layout, Math.max(0, Math.ceil(covered - SLACK)));
}
