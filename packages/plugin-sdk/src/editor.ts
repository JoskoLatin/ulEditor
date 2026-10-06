/**
 * The contract every editor implements.
 *
 * This is the project's public API and is under semver from v0.1. Adding an
 * optional member is a minor; changing the signature or semantics of an existing
 * one is a major.
 */

import type { Event } from './events.js';
import type { ClipboardPayload } from './clipboard.js';
import type { DocumentHandle, Uri, WriteOptions } from './fs.js';
import type { EditorHost } from './host.js';
import type { ReadingOptions, ReadingSession } from './reading.js';

export type Capability =
  /** Can display content. Every editor must have at least this. */
  | 'view'
  /** Can modify and save back into the source format. */
  | 'edit'
  /** Can add a layer over the content without changing the original (PDF notes). */
  | 'annotate'
  /** Can export to another format. */
  | 'export'
  /** Supports search within the document. */
  | 'search'
  /** Offers a reading mode — see `beginReading`. */
  | 'read'
  /** Ready for realtime collaboration (phase 5). */
  | 'collab';

export interface FormatMatcher {
  /** No dot, lower case: `['ts', 'tsx']`. */
  extensions: string[];
  mimeTypes?: string[];
  /** Signatures at the start of the file. A stronger signal than the extension. */
  magic?: Uint8Array[];
}

export interface FindQuery {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export interface FindResult {
  /** A label for the location, e.g. "line 42" or "page 7". */
  label: string;
  /** The excerpt containing the hit, for the results list. */
  preview: string;
  /** Jump to the hit. */
  reveal(): void;
}

export interface SaveResult {
  uri: Uri;
  /** Features of the source document the save could not reproduce.
   *  An empty array means a complete round trip. */
  lostFidelity: string[];
}

/**
 * A save worked out and not yet written — see ADR 0004.
 *
 * The shell asks about `lost` before it calls `commit`, so nothing is written
 * before the person has answered. Four rules:
 *
 * 1. `prepareSave` writes nothing and records nothing as saved. It may finish
 *    an edit in progress; if the save is then cancelled the document simply
 *    stays dirty.
 * 2. `commit` records as saved **what was prepared**, not what the editor
 *    holds when the write returns: the question is not modal, and the person
 *    may have typed while it was showing.
 * 3. `commit` may be called again after a refused write (the file changed
 *    outside ulEditor, and the person said overwrite), with the same bytes and
 *    the same chosen path.
 * 4. `lost` holds finished, translated sentences.
 */
export interface SavePlan {
  /** What this save cannot reproduce. Empty for a complete round trip. */
  lost: string[];
  commit(options?: WriteOptions): Promise<SaveResult>;
}

export interface SaveTarget {
  uri: Uri;
  /** When given, the editor exports to that format instead of saving the source one. */
  format?: string;
}

export interface EditorInstance {
  mount(container: HTMLElement): void | Promise<void>;
  unmount(): void;

  isDirty(): boolean;

  /**
   * Works out a save without writing it — see `SavePlan`.
   *
   * An editor that can return a non-empty `lostFidelity` implements this, so
   * that the person is asked before anything is written. One that never loses
   * anything may leave it out: the shell then saves through `save`.
   */
  prepareSave?(target?: SaveTarget): Promise<SavePlan>;

  /**
   * Saves in one step. `options` are passed to the write as they come — the
   * shell sends `overwriteChanged` only after the person said so. For an
   * editor with `prepareSave` this is `prepareSave` then `commit`, so a host
   * that does not ask still hears what was lost.
   */
  save(target?: SaveTarget, options?: WriteOptions): Promise<SaveResult>;

  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;

  find(query: FindQuery): Promise<FindResult[]>;

  copySelection(): Promise<ClipboardPayload | null>;
  paste(payload: ClipboardPayload): Promise<boolean>;

  /**
   * Whether this editor wants the payload, asked **synchronously**.
   *
   * It exists because a `paste` event cannot be answered later: by the time a
   * promise resolves the browser has already pasted, or not. So the shell asks
   * this first and takes the event over only if the answer is yes.
   *
   * Optional, and an editor that does not implement it is never interfered
   * with — which is the safe default. A `contenteditable` region handles its
   * own paste perfectly well, and an interception that took the event and then
   * found the payload unusable would paste nothing at all.
   *
   * Answer yes only where the payload beats what the browser would have done.
   * A spreadsheet range in a Markdown document is worth it: tab-separated text
   * becomes a real table. The same range in a code editor is not — the plain
   * text is what was wanted either way.
   */
  acceptsPaste?(payload: ClipboardPayload): boolean;

  /** Focuses the editing surface — the shell calls it when switching tabs. */
  focus(): void;

  /**
   * The whole document as plain text.
   *
   * It exists apart from `copySelection` because it is asked for without a
   * selection: export to another format and, later, indexing for project-wide
   * search. Editors whose document is not text (PDF, image) do not implement it.
   */
  plainText?(): Promise<string | null>;

  /**
   * Entering reading mode. Editors without the `read` capability do not
   * implement it, so the shell does not offer the command at all.
   */
  beginReading?(options: ReadingOptions): ReadingSession;

  /**
   * Follows the name under the cursor to where it was defined.
   *
   * The editor does the asking, because only it knows where the cursor is and
   * which server has the document; the shell offers it as a command so that it
   * has a place in the menu rather than only under a key nobody was told
   * about. Optional, and absent wherever a "name" means nothing — a picture, a
   * spreadsheet, a PDF.
   */
  goToDefinition?(): void;

  /**
   * Puts the cursor at a line and column, and scrolls it into view.
   *
   * It exists for go-to-definition, which is the first thing in this program to
   * name a place in a document that is not open yet — `find()` reaches a
   * *string*, and "the definition" is not a string anybody typed.
   *
   * One-based, both of them, matching every other position in the contract.
   * Optional, because a position means nothing in a picture or a spreadsheet;
   * an editor that does not implement it is simply opened, which is still most
   * of what was asked for.
   */
  revealPosition?(line: number, column: number): void;

  /**
   * Adds a paragraph after the one the cursor is in.
   *
   * Optional twice over, and the second one matters: an editor may implement it
   * and still be unable to do it *here* — a Word document can take a new
   * paragraph and an OpenDocument text opened in the same editor cannot, and
   * inside a table cell neither can. So `canInsertParagraph` is asked before the
   * command is offered, the way `canUndo` is, rather than the shell reading a
   * method's existence as a promise about a particular document.
   */
  insertParagraph?(): void;
  canInsertParagraph?(): boolean;

  /**
   * Removes the paragraph the cursor is in.
   *
   * The same double contract as `insertParagraph`: `canRemoveParagraph` is the
   * coarse question the shell asks to decide whether the entry belongs in this
   * document's menu at all, and the command itself answers the fine one — this
   * cursor, this paragraph — out loud, with a reason, when it refuses.
   */
  removeParagraph?(): void;
  canRemoveParagraph?(): boolean;

  /**
   * Merges the table cells somebody selected into one.
   *
   * The same double contract once more, and one difference that matters: this
   * is the first command here whose subject is a **selection** rather than a
   * cursor. The shell still asks only the coarse question — has this document
   * any answer for the rows of a table — and the editor answers the fine one
   * out loud: which cells those are, whether they are of one row, whether they
   * are next to each other in the file rather than merely on the screen.
   */
  mergeCells?(): void;
  canMergeCells?(): boolean;

  readonly onDirtyChange: Event<boolean>;
  /** A message for the status bar, e.g. "Ln 12, Col 4" or "Page 3 of 18". */
  readonly onStatusChange: Event<string>;
}

export interface EditorProvider {
  /** Reverse-DNS, e.g. `org.uleditor.pdf`. */
  id: string;
  displayName: string;
  matches: FormatMatcher;
  capabilities: Capability[];
  /** The higher number wins when several providers match the same file. */
  priority: number;

  createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance>;
}

export function hasCapability(provider: EditorProvider, cap: Capability): boolean {
  return provider.capabilities.includes(cap);
}
