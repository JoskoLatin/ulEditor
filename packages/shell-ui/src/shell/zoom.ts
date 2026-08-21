/**
 * The size of the interface.
 *
 * Ctrl with the wheel, Ctrl+plus, Ctrl+minus, Ctrl+0 — the gesture every browser
 * and every editor already has. Somebody who wants larger text tries it before
 * they go looking for a setting, so it has to be there before the setting is.
 *
 * On the desktop this is the webview's own zoom, the same mechanism as Ctrl+plus
 * in a browser: the page is laid out again at the new scale, so everything the
 * editors measure for themselves — the PDF page, the annotation layer, the text
 * ruler — keeps agreeing with what is drawn. A CSS transform over the whole
 * shell would scale the picture and leave every one of those measuring the old
 * size, which is how an annotation lands next to the word instead of on it.
 *
 * In a browser tab there is nothing for us to do: Ctrl and the wheel is already
 * the browser's own zoom and it survives a reload by itself. Taking that over to
 * reimplement it worse is not an improvement, so on the web this module stands
 * aside entirely.
 */

import type { Shell } from '../host/index.js';

/**
 * The browser's own ladder. Steps rather than a free factor because a person
 * pressing Ctrl+plus wants a legible next size, not 1.03.
 */
const STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];

const DEFAULT = 1;
const SETTING = 'ui.zoom';

/** The desktop only — see the note at the top about the browser. */
export function canZoom(shell: Shell): boolean {
  return shell.platform === 'desktop';
}

export function zoomFactor(shell: Shell): number {
  const stored = shell.settings.get<number>(SETTING, DEFAULT);
  return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT;
}

async function apply(factor: number): Promise<void> {
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  await getCurrentWebview().setZoom(factor);
}

/**
 * Sets the zoom and remembers it.
 *
 * The setting is written even if the webview refuses, so a size chosen once is
 * not silently lost; the next start applies it again.
 */
export async function setZoom(shell: Shell, factor: number): Promise<number> {
  const clamped = Math.min(STEPS[STEPS.length - 1]!, Math.max(STEPS[0]!, factor));
  shell.settings.set(SETTING, clamped);
  if (canZoom(shell)) await apply(clamped);
  return clamped;
}

/** One step up (+1) or down (-1) the ladder. */
export function stepZoom(shell: Shell, direction: number): Promise<number> {
  const current = zoomFactor(shell);
  /*
   * The nearest step rather than an index lookup: the stored value can sit
   * between two steps, either from an older ladder or from a setting edited by
   * hand, and from there a step still has to move exactly one step.
   */
  let index = STEPS.findIndex((step) => Math.abs(step - current) < 0.001);
  if (index === -1) {
    index = STEPS.reduce(
      (best, step, i) => (Math.abs(step - current) < Math.abs(STEPS[best]! - current) ? i : best),
      0,
    );
    // Landing on the nearest step and then moving would swallow the keystroke
    // when the nearest one is already in the direction asked for.
    if (direction > 0 && STEPS[index]! > current) direction = 0;
    if (direction < 0 && STEPS[index]! < current) direction = 0;
  }
  const next = STEPS[Math.min(STEPS.length - 1, Math.max(0, index + direction))]!;
  return setZoom(shell, next);
}

export function resetZoom(shell: Shell): Promise<number> {
  return setZoom(shell, DEFAULT);
}

/** Whether the interface is at its normal size — for the label in settings. */
export function isDefaultZoom(shell: Shell): boolean {
  return Math.abs(zoomFactor(shell) - DEFAULT) < 0.001;
}

/**
 * Applies the remembered size at startup.
 *
 * Failure is not reported: an interface at the wrong size is a nuisance, a
 * dialog on every start over a webview that would not zoom is worse.
 */
export function restoreZoom(shell: Shell): void {
  if (!canZoom(shell) || isDefaultZoom(shell)) return;
  void apply(zoomFactor(shell)).catch(() => {});
}

/**
 * Ctrl and the wheel.
 *
 * The listener has to be non-passive, because preventing the default is the only
 * thing that stops the webview from zooming on its own on top of ours — two
 * zooms on one gesture, one of them not remembered anywhere.
 */
export function watchZoomGesture(shell: Shell): () => void {
  if (!canZoom(shell)) return () => {};

  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    if (event.deltaY === 0) return;
    void stepZoom(shell, event.deltaY < 0 ? 1 : -1);
  };

  window.addEventListener('wheel', onWheel, { passive: false });
  return () => window.removeEventListener('wheel', onWheel);
}
