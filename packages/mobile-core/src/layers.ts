/**
 * The stack of layers, and what Back does.
 *
 * Everything the mobile shell opens over the document is a layer: the search,
 * the paper strip above the keyboard, the desk under the corner, a question.
 * Back closes the one on top. That is the whole rule, and it is kept here, apart
 * from the `history` that carries it on the phone, so it can be checked without
 * one (ADR 0009, level A).
 *
 * **One `history` entry per open layer.** Measured on the Pixel (ADR 0009, K2
 * b): with an entry of ours pushed, Back keeps the app in front and the page
 * gets `popstate`; with none left, Back leaves the app for the launcher. So the
 * adapter keeps exactly as many entries as there are layers open
 * (`historyDelta`), and Back on the base layer is not caught at all: the app
 * leaves, as every other app does.
 *
 * **On a question, Back is Cancel.** A question offers actions, and the one that
 * means Cancel is marked as such. Back runs that one: never "Discard", and never
 * whichever action happens to come first in the list. Today Cancel is merely
 * first in `confirmDiscard`, `askOverwrite` and `fidelityWarning`, and an order
 * is not a meaning. A question with no action marked stays where it is: Back
 * does not answer it on the person's behalf.
 *
 * Pure: a stack goes in, a stack comes out. Nothing here touches `history`.
 */

/** One of the answers a question offers. */
export interface LayerAction {
  id: string;
  /** This is the action that means Cancel, the one Back runs. */
  cancel?: true;
}

export interface Layer {
  /** Unique among the open layers. */
  id: string;
  /** Present when the layer is a question: what it can be answered with. */
  actions?: readonly LayerAction[];
}

/** The open layers, bottom first. The base layer is not among them. */
export type LayerStack = readonly Layer[];

/** What one Back did, and the stack it left. */
export type BackOutcome =
  /** The top layer closed. */
  | { kind: 'close'; layer: Layer; stack: LayerStack }
  /** The question on top was answered with its cancel, and closed. */
  | { kind: 'cancel'; layer: Layer; action: LayerAction; stack: LayerStack }
  /** A question with no cancel: it stays, and the entry Back used is put back. */
  | { kind: 'stay'; layer: Layer; stack: LayerStack }
  /** Nothing was open: Back leaves the app. */
  | { kind: 'leave'; stack: LayerStack };

export const NO_LAYERS: LayerStack = [];

export function topLayer(stack: LayerStack): Layer | null {
  return stack[stack.length - 1] ?? null;
}

export function isQuestion(layer: Layer): boolean {
  return layer.actions !== undefined;
}

/**
 * The action Back runs on a question, or `null` when none is marked.
 *
 * Found by its mark and nothing else. Falling back to the first action would be
 * the bug this exists to prevent: a question that lists "Discard" first would
 * throw away the person's work on a gesture they make a hundred times a day.
 */
export function cancelOf(layer: Layer): LayerAction | null {
  return layer.actions?.find((action) => action.cancel === true) ?? null;
}

/**
 * Puts a layer on top.
 *
 * A layer already open is left where it is and the stack is returned as it was:
 * two quick taps on the same button must not push two `history` entries, or the
 * second Back would close nothing the person can see.
 */
export function openLayer(stack: LayerStack, layer: Layer): LayerStack {
  if (stack.some((open) => open.id === layer.id)) return stack;
  return [...stack, layer];
}

/**
 * Takes one layer out, wherever it is, and leaves the others.
 *
 * Only that one: a question that arrived over the search stays when the search
 * is closed under it, because a question is answered, not swept away.
 */
export function closeLayer(stack: LayerStack, id: string): LayerStack {
  const kept = stack.filter((open) => open.id !== id);
  return kept.length === stack.length ? stack : kept;
}

/** What Back does to the stack as it stands. */
export function back(stack: LayerStack): BackOutcome {
  const layer = topLayer(stack);
  if (!layer) return { kind: 'leave', stack };
  const below = stack.slice(0, -1);
  if (!isQuestion(layer)) return { kind: 'close', layer, stack: below };
  const action = cancelOf(layer);
  if (!action) return { kind: 'stay', layer, stack };
  return { kind: 'cancel', layer, action, stack: below };
}

/**
 * How many `history` entries the adapter has to add (positive) or take away
 * (negative) so that it holds one per open layer.
 *
 * After the system's Back the entry is already gone, so a Back that closed a
 * layer needs nothing, and one that left a question in place needs its entry
 * back. A layer closed by a tap rather than by Back leaves an entry too many,
 * which the adapter takes away itself; the `popstate` that follows is its own and
 * closes nothing.
 */
export function historyDelta(entries: number, stack: LayerStack): number {
  return stack.length - entries;
}
