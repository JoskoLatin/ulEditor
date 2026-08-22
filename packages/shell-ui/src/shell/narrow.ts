/**
 * What counts as a narrow screen.
 *
 * A single line of CSS, and a module of its own — because everything else that
 * knows about the side panel also knows about React. `actions.ts` asks this
 * question and nothing else about the layout; going through
 * [`views.ts`](./views.ts) for it would drag the icon components, and with them
 * a DOM, into every place the actions are used.
 */

/** The threshold matches the CSS — one place decides what "narrow" means. */
export const NARROW = '(max-width: 720px)';

export function isNarrow(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(NARROW).matches;
}
