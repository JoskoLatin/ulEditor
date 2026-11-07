/**
 * Where each document was left.
 *
 * Android ends an app in the background whenever it likes, and coming back to it
 * should not mean finding the page again. So per document this keeps three
 * things: the position the editor last reported (`position()`, an opaque token
 * handed back to `restorePosition`), the intent it was last opened with (Četiri
 * boje's "Nastavi Ugovor o najmu na 3. stranici"), and when it was last opened.
 *
 * **Capped, newest first.** One entry per document, the one opened last at the
 * front; past `MEMORY_LIMIT` the oldest is forgotten. Kept in the order it was
 * written rather than sorted by its times, so a phone whose clock was set back
 * still puts the document just opened first.
 *
 * Data class `privatno`: the names of documents and places in them. Nothing of
 * their content is kept, and the store is the host's (`KeyValueStore`), so it is
 * removed with the rest of the settings.
 */

import type { KeyValueStore } from './store.js';

/** Četiri boje's four intents: *čitati*, *ispraviti*, *pisati*, *slikati*. */
export type Intent = 'read' | 'correct' | 'write' | 'scan';

export const INTENTS: readonly Intent[] = ['read', 'correct', 'write', 'scan'];

export interface Remembered {
  uri: string;
  /** Unix ms, last opened. */
  openedAt: number;
  /** The editor's token for where the document was; `null` for its start. */
  position: string | null;
  intent: Intent | null;
}

export const MEMORY_KEY = 'mobile.memory';

/**
 * More than the library shows on one screen and fewer than a settings file
 * should carry; a document not opened since fifty others were starts at its
 * beginning.
 */
export const MEMORY_LIMIT = 50;

/**
 * A position is the editor's to write, and an editor that wrote a page of it
 * would carry that page into the settings on every scroll. Past this the token
 * is not kept, and the document opens at its start.
 */
export const POSITION_LIMIT = 1024;

function isIntent(value: unknown): value is Intent {
  return typeof value === 'string' && (INTENTS as readonly string[]).includes(value);
}

function asRemembered(value: unknown): Remembered | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.uri !== 'string' || entry.uri === '') return null;
  if (typeof entry.openedAt !== 'number' || !Number.isFinite(entry.openedAt)) return null;
  const position =
    typeof entry.position === 'string' && entry.position.length <= POSITION_LIMIT ? entry.position : null;
  return { uri: entry.uri, openedAt: entry.openedAt, position, intent: isIntent(entry.intent) ? entry.intent : null };
}

/** Everything remembered, newest first, checked entry by entry. */
export function remembered(store: KeyValueStore): Remembered[] {
  const stored = store.get<unknown>(MEMORY_KEY, []);
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  const kept: Remembered[] = [];
  for (const value of stored) {
    const entry = asRemembered(value);
    /* Written once per document; a second one only comes from a hand-edited file,
       and the first, being newer, is the one that counts. */
    if (!entry || seen.has(entry.uri)) continue;
    seen.add(entry.uri);
    kept.push(entry);
    if (kept.length === MEMORY_LIMIT) break;
  }
  return kept;
}

function write(store: KeyValueStore, entries: Remembered[]): void {
  store.set(MEMORY_KEY, entries.slice(0, MEMORY_LIMIT));
}

export function recall(store: KeyValueStore, uri: string): Remembered | null {
  return remembered(store).find((entry) => entry.uri === uri) ?? null;
}

/**
 * A document was opened: it moves to the front.
 *
 * Its position is kept. An intent replaces the one remembered only when one is
 * given; an interface without intents opens with none and leaves Četiri boje's
 * memory as it was.
 */
export function rememberOpening(store: KeyValueStore, uri: string, now: number, intent?: Intent): void {
  if (uri === '' || !Number.isFinite(now)) return;
  const entries = remembered(store);
  const before = entries.find((entry) => entry.uri === uri);
  const entry: Remembered = {
    uri,
    openedAt: now,
    position: before?.position ?? null,
    intent: intent !== undefined && isIntent(intent) ? intent : (before?.intent ?? null),
  };
  write(store, [entry, ...entries.filter((one) => one.uri !== uri)]);
}

/**
 * Where the document is now. Written where the entry stands, since moving
 * through a document is not opening it; a document with no entry yet gets one
 * at the front.
 */
export function rememberPosition(store: KeyValueStore, uri: string, position: string | null, now: number): void {
  if (uri === '' || !Number.isFinite(now)) return;
  const kept = position !== null && position.length <= POSITION_LIMIT ? position : null;
  const entries = remembered(store);
  const at = entries.findIndex((entry) => entry.uri === uri);
  const before = entries[at];
  if (before) {
    entries[at] = { ...before, position: kept };
    write(store, entries);
  } else {
    write(store, [{ uri, openedAt: now, position: kept, intent: null }, ...entries]);
  }
}

/** The document last opened with an intent: the line on Četiri boje's start. */
export function lastWithIntent(store: KeyValueStore, intent: Intent): Remembered | null {
  return remembered(store).find((entry) => entry.intent === intent) ?? null;
}

/** For a document that is gone: a line that opens nothing is worse than no line. */
export function forgetDocument(store: KeyValueStore, uri: string): void {
  const entries = remembered(store);
  const kept = entries.filter((entry) => entry.uri !== uri);
  if (kept.length !== entries.length) write(store, kept);
}
