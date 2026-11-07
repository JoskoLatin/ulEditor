/**
 * The open documents, as the phone shows them.
 *
 * A phone shows one document at a time, so the others are a pile: Arak's
 * *hrpa*, Palac's dots under the name bar, Četiri boje's "još 2 otvorena". All
 * three put the one used last on top, and all three let a swipe go to the one
 * beside it. Which document is in front is the workspace's (`active` in
 * `state/workspace.ts`); this keeps the order, each document's mode and when it
 * was last saved.
 *
 * **A swipe is not a use.** If moving to a neighbour put it on top, the next
 * swipe would come straight back: two documents would take turns and the third
 * would never be reached. So `neighbourOf` walks the order without changing it,
 * and only `bringToFront` (an opening, a choice from the pile, a change made in
 * the document) moves a document up.
 *
 * Pure: a list goes in, a list comes out, newest first. `id` is the
 * workspace's tab id.
 */

/** Reading turns a tap into a page turn; correcting turns it into a target (`setTouchEditing`). */
export type DocumentMode = 'read' | 'correct';

export interface OpenDocument {
  id: string;
  mode: DocumentMode;
  /** Unix ms, when it was last brought to the front. */
  usedAt: number;
  /** Unix ms, when it was last saved in this run; `null` if not yet. */
  savedAt: number | null;
}

/** Newest first. */
export type OpenDocuments = readonly OpenDocument[];

export const NO_DOCUMENTS: OpenDocuments = [];

/** A document opened is read until the person says otherwise. */
export const DEFAULT_MODE: DocumentMode = 'read';

/**
 * Opens a document, or brings an open one to the front.
 *
 * An open document keeps its mode unless one is given: coming back to a table
 * one was correcting is coming back to correcting it.
 */
export function bringToFront(docs: OpenDocuments, id: string, now: number, mode?: DocumentMode): OpenDocuments {
  const open = docs.find((doc) => doc.id === id);
  const front: OpenDocument = {
    id,
    mode: mode ?? open?.mode ?? DEFAULT_MODE,
    usedAt: now,
    savedAt: open?.savedAt ?? null,
  };
  return [front, ...docs.filter((doc) => doc.id !== id)];
}

export function closeDocument(docs: OpenDocuments, id: string): OpenDocuments {
  const kept = docs.filter((doc) => doc.id !== id);
  return kept.length === docs.length ? docs : kept;
}

/** Changes a document's mode where it stands; changing the mode is not using it. */
export function setDocumentMode(docs: OpenDocuments, id: string, mode: DocumentMode): OpenDocuments {
  return docs.map((doc) => (doc.id === id && doc.mode !== mode ? { ...doc, mode } : doc));
}

/** Remembers that a document was saved; the stamp "Spremljeno u 13:15" reads it. */
export function markSaved(docs: OpenDocuments, id: string, at: number): OpenDocuments {
  return docs.map((doc) => (doc.id === id ? { ...doc, savedAt: at } : doc));
}

export function documentMode(docs: OpenDocuments, id: string): DocumentMode | null {
  return docs.find((doc) => doc.id === id)?.mode ?? null;
}

export function lastSaved(docs: OpenDocuments, id: string): number | null {
  return docs.find((doc) => doc.id === id)?.savedAt ?? null;
}

/**
 * The document a swipe goes to: the next older or the next newer in the pile.
 *
 * `null` at either end, and for a document that is not open. The pile does not
 * wrap: the dots under Palac's name bar have two ends, and a swipe past the last
 * that came back to the first would look like a document that had vanished.
 */
export function neighbourOf(docs: OpenDocuments, id: string, toward: 'older' | 'newer'): string | null {
  const at = docs.findIndex((doc) => doc.id === id);
  if (at < 0) return null;
  return docs[toward === 'older' ? at + 1 : at - 1]?.id ?? null;
}
