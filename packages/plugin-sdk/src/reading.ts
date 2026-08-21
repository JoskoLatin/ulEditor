/**
 * Reading mode.
 *
 * Reading a book is not "an editor without toolbars". It demands different
 * typography, a different flow of content (pages instead of a scroll), a table
 * of contents by chapter and a memory of where you stopped. That is why it is
 * part of the contract rather than a trick in the shell: the shell offers one
 * reading room, and each editor knows for itself what a "page" and a "chapter"
 * are.
 *
 * An editor that does not implement this simply has no `beginReading` — the
 * shell then does not offer the command. An optional member is a minor change to
 * the contract.
 */

import type { Event } from './events.js';

/** The reading room background. Three on purpose, not a palette — nobody uses more. */
export type ReadingTint = 'day' | 'sepia' | 'night';

/** Pages (columns that turn) or an unbroken scroll. */
export type ReadingFlow = 'paged' | 'scroll';

export interface ReadingOptions {
  /** Serif for prose, sans-serif for technical text. */
  typeface: 'serif' | 'sans';
  /** The base text size in pixels. */
  fontSize: number;
  lineHeight: number;
  /** Column width in characters. Past ~90 the eye loses the start of the next line. */
  measure: number;
  tint: ReadingTint;
  flow: ReadingFlow;
}

export const DEFAULT_READING: ReadingOptions = {
  typeface: 'serif',
  fontSize: 19,
  lineHeight: 1.65,
  measure: 68,
  tint: 'day',
  flow: 'paged',
};

/** A table-of-contents entry — a chapter in a book, a heading in Markdown, a page in a PDF. */
export interface ReadingOutlineItem {
  id: string;
  label: string;
  /** 0 = the root level. */
  depth: number;
}

export interface ReadingProgress {
  /** The fraction read, 0..1. */
  fraction: number;
  /** A short label for the location, e.g. "Chapter 3 · p. 2/14". */
  label: string;
  /** An estimate of the time left in minutes, where the editor can supply one. */
  minutesLeft?: number;
}

/**
 * A live reading session. It lasts until the user leaves the reading room;
 * `end()` returns the editor to its usual state and must be idempotent.
 */
export interface ReadingSession {
  /** New typography settings without losing the place being read. */
  apply(options: ReadingOptions): void;

  /** A move of ±1 page (or screen, in scroll flow). */
  page(delta: number): void;

  /** A jump to a relative position 0..1 — dragging the progress bar. */
  seek(fraction: number): void;

  outline(): ReadingOutlineItem[];
  goTo(id: string): void;

  readonly onProgress: Event<ReadingProgress>;

  end(): void;
}
