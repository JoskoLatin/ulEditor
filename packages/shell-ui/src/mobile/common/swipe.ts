/**
 * A swipe across the document, with the screen's edges left to Android.
 *
 * All three concepts let a swipe go somewhere: to the next page, to the
 * document beside this one in the pile. Android's own Back is a swipe too, in
 * from either side of the screen. A swipe that starts at an edge is therefore
 * the system's, and this does not take it as one of ours, so the one gesture
 * never does two things.
 *
 * **The width of that edge was not measured.** Android lets the person set how
 * wide the band of its Back gesture is, and the WebView reports none of it
 * (`env(safe-area-inset-left)` is 0 on the Pixel, ADR 0009, K2 c). So
 * `EDGE_ZONE` is a starting value, passed in where an interface knows better,
 * and to be measured on both phones.
 *
 * The decision is `swipeOf`, plain numbers in and a direction out; `useSwipe`
 * only feeds it from the pointer.
 */

import { useEffect, type RefObject } from 'react';

/** CSS px from either side of the screen in which a swipe is the system's. Not measured. */
export const EDGE_ZONE = 32;
/** How far a finger has to travel before a movement is a swipe and not a tap that slipped. */
export const SWIPE_DISTANCE = 48;

export type SwipeDirection = 'left' | 'right';

export interface Point {
  x: number;
  y: number;
}

export interface SwipeOptions {
  edge?: number;
  distance?: number;
}

/**
 * Which way a movement from `start` to `end` swiped, on a screen `width` wide,
 * or `null` when it was not a swipe of ours: it began at an edge, it was too
 * short, or it went more up and down than across (a scroll).
 */
export function swipeOf(start: Point, end: Point, width: number, options: SwipeOptions = {}): SwipeDirection | null {
  const edge = options.edge ?? EDGE_ZONE;
  const distance = options.distance ?? SWIPE_DISTANCE;
  if (![start.x, start.y, end.x, end.y, width].every(Number.isFinite)) return null;
  if (start.x < edge || start.x > width - edge) return null;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < distance || Math.abs(dx) < 2 * Math.abs(dy)) return null;
  return dx < 0 ? 'left' : 'right';
}

/**
 * Calls `onSwipe` for every swipe of ours that starts on `ref`'s element.
 * `onSwipe` and `options` should be stable; a new one on every render listens
 * afresh on every render.
 */
export function useSwipe(
  ref: RefObject<HTMLElement | null>,
  onSwipe: (direction: SwipeDirection) => void,
  options?: SwipeOptions,
): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let start: (Point & { pointer: number }) | null = null;

    const down = (event: PointerEvent) => {
      start = event.isPrimary ? { x: event.clientX, y: event.clientY, pointer: event.pointerId } : null;
    };
    const up = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.pointer) return;
      const direction = swipeOf(start, { x: event.clientX, y: event.clientY }, window.innerWidth, options);
      start = null;
      if (direction) onSwipe(direction);
    };
    /* The browser took the movement over, for a scroll: it was not a swipe. */
    const cancel = () => {
      start = null;
    };

    element.addEventListener('pointerdown', down);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', cancel);
    return () => {
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', cancel);
    };
  }, [ref, onSwipe, options]);
}
