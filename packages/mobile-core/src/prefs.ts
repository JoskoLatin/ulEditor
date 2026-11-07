/**
 * The phone's own settings: which interface, which hand, what has been shown.
 *
 * - `mobile.ui`: the interface, `arak`, `palac` or `boje`. The default is the
 *   first one built, Arak, until Čovik chooses (ADR 0009, O1).
 * - `mobile.hand`: one setting for the left or the right hand, shared by all
 *   three (O11).
 * - `mobile.asked`: whether the question "which interface?" was put. It is put
 *   once two interfaces exist, at a first start or to an installation that
 *   updated into the second, and then not again (O2).
 * - `mobile.hints`: the first-time hints already seen, by id, so Arak's
 *   *ceduljica* by the corner shows once per kind of document.
 *
 * And `canSwitch`, the rule for changing the interface. The change reloads the
 * window, so it is allowed only while nothing is unsaved (O3); what holds it up
 * is listed, so the person is told what to save or discard rather than only
 * that something is in the way.
 */

import type { KeyValueStore } from './store.js';

export const INTERFACES = ['arak', 'palac', 'boje'] as const;
export type InterfaceId = (typeof INTERFACES)[number];
export const DEFAULT_INTERFACE: InterfaceId = 'arak';

export type Hand = 'right' | 'left';
export const DEFAULT_HAND: Hand = 'right';

export const PREF_KEYS = {
  ui: 'mobile.ui',
  hand: 'mobile.hand',
  asked: 'mobile.asked',
  hints: 'mobile.hints',
} as const;

/** Enough for every kind of hint in every kind of document, few enough to read at once. */
export const HINTS_LIMIT = 100;
const HINT_ID_LIMIT = 64;

export function isInterface(value: unknown): value is InterfaceId {
  return typeof value === 'string' && (INTERFACES as readonly string[]).includes(value);
}

/**
 * The interface to start.
 *
 * What was chosen, if it is one this build has; otherwise the default, if this
 * build has it; otherwise the first it has. A setting written by a newer build,
 * or by hand, must not start an interface that is not there.
 */
export function chosenInterface(store: KeyValueStore, built: readonly InterfaceId[] = [DEFAULT_INTERFACE]): InterfaceId {
  const stored = store.get<unknown>(PREF_KEYS.ui, DEFAULT_INTERFACE);
  if (isInterface(stored) && built.includes(stored)) return stored;
  if (built.includes(DEFAULT_INTERFACE)) return DEFAULT_INTERFACE;
  return built[0] ?? DEFAULT_INTERFACE;
}

export function setInterface(store: KeyValueStore, id: InterfaceId): void {
  if (isInterface(id)) store.set(PREF_KEYS.ui, id);
}

export function chosenHand(store: KeyValueStore): Hand {
  const stored = store.get<unknown>(PREF_KEYS.hand, DEFAULT_HAND);
  return stored === 'left' || stored === 'right' ? stored : DEFAULT_HAND;
}

export function setHand(store: KeyValueStore, hand: Hand): void {
  if (hand === 'left' || hand === 'right') store.set(PREF_KEYS.hand, hand);
}

/**
 * Whether to ask which interface. With one built there is nothing to choose,
 * and the flag stays unset, so the installation that updates into the second is
 * asked then.
 */
export function shouldAskInterface(store: KeyValueStore, built: readonly InterfaceId[]): boolean {
  return new Set(built.filter(isInterface)).size >= 2 && store.get<unknown>(PREF_KEYS.asked, false) !== true;
}

export function markInterfaceAsked(store: KeyValueStore): void {
  store.set(PREF_KEYS.asked, true);
}

function seenHints(store: KeyValueStore): string[] {
  const stored = store.get<unknown>(PREF_KEYS.hints, []);
  if (!Array.isArray(stored)) return [];
  return stored.filter((id): id is string => typeof id === 'string' && id !== '' && id.length <= HINT_ID_LIMIT);
}

export function hintSeen(store: KeyValueStore, id: string): boolean {
  return seenHints(store).includes(id);
}

/** Newest first, so past the cap it is the oldest hint that may show once more. */
export function markHintSeen(store: KeyValueStore, id: string): void {
  if (id === '' || id.length > HINT_ID_LIMIT) return;
  const seen = seenHints(store);
  if (seen.includes(id)) return;
  store.set(PREF_KEYS.hints, [id, ...seen].slice(0, HINTS_LIMIT));
}

/** What the shell holds unsaved at the moment of a change. */
export interface Unsaved {
  /** Tabs with changes, a note not yet saved among them. */
  tabs: ReadonlyArray<{ id: string; name: string }>;
  /** The scratch panel holds text. */
  scratch: boolean;
  /** An edit session holds a text typed and not written (`editPending`), an OCR result among them. */
  editSession: boolean;
}

export type SwitchBlocker = { kind: 'tab'; id: string; name: string } | { kind: 'scratch' } | { kind: 'edit-session' };

export type SwitchVerdict = { ok: true } | { ok: false; blockers: SwitchBlocker[] };

/**
 * Whether the interface may be changed now.
 *
 * The change reloads the window, and a reload takes with it whatever was not
 * saved. So everything unsaved is in the way, and all of it is listed: the
 * person is told what to save or discard, in one go, not one item per refusal.
 */
export function canSwitch(unsaved: Unsaved): SwitchVerdict {
  const blockers: SwitchBlocker[] = unsaved.tabs.map((tab) => ({ kind: 'tab', id: tab.id, name: tab.name }));
  if (unsaved.scratch) blockers.push({ kind: 'scratch' });
  if (unsaved.editSession) blockers.push({ kind: 'edit-session' });
  return blockers.length === 0 ? { ok: true } : { ok: false, blockers };
}
