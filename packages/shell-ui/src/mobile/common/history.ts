/**
 * Back, through `history`: the open layers and the entries that carry them.
 *
 * The rule is `layers.ts` in `mobile-core`: Back closes the layer on top, and on
 * a question runs the action marked as its cancel, or leaves the question where
 * it is. This is the part that touches the window. Measured on both phones
 * (ADR 0009, K2 b): with an entry of ours pushed, Back keeps the app in front
 * and the page gets `popstate`; with none left, Back leaves the app. So:
 *
 * - **One entry per open layer** (`historyDelta`), pushed when a layer opens and
 *   taken back when one closes by a tap. Back on the base layer is never
 *   caught: there is no entry of ours left, and the app leaves as every app
 *   does.
 * - **Each entry says how deep it is** (`ulLayers` in its state). A reload keeps
 *   the entries and loses the layers, and an entry that knows its depth is one
 *   this can find and take back at the next start, rather than a Back the
 *   person presses for nothing.
 * - **Its own `popstate` is not a Back.** A layer closed by a tap leaves an
 *   entry too many; `history.go` takes it away, and the `popstate` that follows
 *   lands where it was sent and closes nothing. Nothing else is pushed while
 *   that is under way, because an entry pushed in the middle of a traversal is
 *   taken away by it.
 *
 * The stack is a store so an interface can draw it; what a layer does when Back
 * closes it is kept beside it, by id, since a `Layer` is plain data.
 */

import { create } from 'zustand';
import {
  NO_LAYERS,
  back,
  closeLayer as withoutLayer,
  historyDelta,
  openLayer as withLayer,
  type Layer,
  type LayerAction,
  type LayerStack,
} from '@uleditor/mobile-core';

export interface LayerHandlers {
  /** Back closed the layer. Not called when the layer is closed with `closeLayer`. */
  onBack?(): void;
  /** Back answered the question with the action marked as its cancel. */
  onCancel?(action: LayerAction): void;
}

export const useLayers = create<{ stack: LayerStack }>(() => ({ stack: NO_LAYERS }));

const handlers = new Map<string, LayerHandlers>();

/** Opens a layer over the others. One already open stays as it is, with the handlers it was opened with. */
export function openLayer(layer: Layer, on: LayerHandlers = {}): void {
  const { stack } = useLayers.getState();
  const next = withLayer(stack, layer);
  if (next === stack) return;
  handlers.set(layer.id, on);
  useLayers.setState({ stack: next });
}

/** Closes a layer by a tap rather than by Back: its entry is taken away, and no handler runs. */
export function closeLayer(id: string): void {
  const { stack } = useLayers.getState();
  const next = withoutLayer(stack, id);
  if (next === stack) return;
  handlers.delete(id);
  useLayers.setState({ stack: next });
}

export function isLayerOpen(stack: LayerStack, id: string): boolean {
  return stack.some((layer) => layer.id === id);
}

const DEPTH = 'ulLayers';

/** How deep an entry is; 0 for one that is not ours, the base included. */
function depthOf(state: unknown): number {
  if (!state || typeof state !== 'object') return 0;
  const depth = (state as Record<string, unknown>)[DEPTH];
  return typeof depth === 'number' && Number.isInteger(depth) && depth > 0 ? depth : 0;
}

/**
 * Ties the stack to `history` and the system's Back to the stack; returns what
 * unties them. Started once, by the mobile shell.
 */
export function watchBack(): () => void {
  /** Entries of ours above the base, as far as this knows. */
  let entries = depthOf(window.history.state);
  /** Where a `history.go` of ours is going; `null` when none is under way. */
  let heading: number | null = null;

  const sync = () => {
    if (heading !== null) return;
    const delta = historyDelta(entries, useLayers.getState().stack);
    if (delta > 0) {
      for (let i = 0; i < delta; i++) {
        entries += 1;
        window.history.pushState({ [DEPTH]: entries }, '');
      }
    } else if (delta < 0) {
      heading = entries + delta;
      window.history.go(delta);
    }
  };

  const onPopState = (event: PopStateEvent) => {
    const depth = depthOf(event.state);
    const own = heading !== null && depth === heading;
    heading = null;
    entries = depth;
    if (own) {
      sync();
      return;
    }

    /* The system took the entries above `depth` away: one Back for each. */
    let stack = useLayers.getState().stack;
    const after: Array<() => void> = [];
    while (stack.length > entries) {
      const outcome = back(stack);
      if (outcome.kind === 'leave' || outcome.kind === 'stay') break;
      stack = outcome.stack;
      const on = handlers.get(outcome.layer.id);
      handlers.delete(outcome.layer.id);
      if (outcome.kind === 'close') after.push(() => on?.onBack?.());
      else after.push(() => on?.onCancel?.(outcome.action));
    }

    /* The stack first, the handlers after. A cancel's own `run` dismisses its
       question, and whoever follows the questions then closes a layer that is
       already gone; the other way round, it would be closed twice. A question
       that stayed gets its entry back here. */
    useLayers.setState({ stack });
    sync();
    for (const run of after) run();
  };

  window.addEventListener('popstate', onPopState);
  const unsubscribe = useLayers.subscribe(sync);
  sync();

  return () => {
    window.removeEventListener('popstate', onPopState);
    unsubscribe();
  };
}
