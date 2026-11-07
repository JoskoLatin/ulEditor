/**
 * The name a new note is offered under, from its first line.
 *
 * All three concepts name a note by its first line ("Ideje za balkon.md"). This
 * is only the proposal: on Android, Rust decides the file's name and where it
 * goes, `Documents/ulEditor/Bilješke` and nowhere else (ADR 0009, O5 and K5),
 * and a proposal it does not like becomes "untitled" there. So what comes out of
 * here is made to pass the rules "Save as" already applies to a name
 * (`offered_name` in `apps/desktop/src-tauri/src/lib.rs`), and is stricter
 * than they are, never looser.
 *
 * The first line is the person's text and may be anything: a heading, a list
 * item, a link, a right-to-left override, a path. Out of it comes letters,
 * digits, single spaces and a few marks names are made of; never a separator, a
 * control or bidirectional character, a letter drawn as nothing, a leading or
 * trailing dot or space, or a Windows device. And short enough to read whole.
 *
 * `null` when the line leaves nothing to name the note by: the interface then
 * offers its own default.
 */

export const NOTE_EXTENSION = '.md';

/** Long enough for a title, short enough to show whole under a page on *zid*. */
export const NOTE_STEM_MAX = 60;

/* `offered_name` takes no more than 8 spaces and 16 marks in all (spaces, dots,
   dashes: whatever is not a letter or a digit), the extension's dot included. */
const MOST_SPACES = 8;
const MOST_MARKS = 16 - 1;

/**
 * Only the start of a long text is looked through for its first line, which
 * also bounds the line: a note of a megabyte on one line is not normalised
 * whole to name it. A note blank for this long has no name to offer.
 */
export const LOOK_AHEAD = 4096;

/* The punctuation kept in a name; everything else that is not a letter or a
   digit becomes a space. A subset of what `offered_name` lets through. */
const MARKS = new Set([' ', '-', '_', '.', ',', '(', ')', "'", '!', '&']);

/* Letters drawn as nothing (`trust::BLANK_LETTERS`: the Hangul fillers and
   the Egyptian hieroglyph blanks), and the tatweel, which stretches a line of
   Arabic and is counted as a mark there. */
const BLANK = new Set(['\u{115F}', '\u{1160}', '\u{3164}', '\u{FFA0}', '\u{13441}', '\u{13442}', '\u{0640}']);

/* `CON`, `NUL.md` and the rest are devices on Windows, whatever follows the
   first dot; `COM0` and `LPT0` are kept out as `offered_name` keeps them. */
const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;

function firstLine(text: string): string | null {
  for (const line of text.slice(0, LOOK_AHEAD).split(/\r\n|\r|\n|\u{2028}|\u{2029}/u)) {
    if (line.trim() !== '') return line;
  }
  return null;
}

/** A heading's `#`, a quote's `>`, a list's `-` or `1.` and a task's `[ ]`, however they nest. */
const BLOCK_MARKER = /^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+)/;

function withoutMarkdown(line: string): string {
  let rest = line;
  for (let marker = BLOCK_MARKER.exec(rest); marker; marker = BLOCK_MARKER.exec(rest)) {
    rest = rest.slice(marker[0].length);
  }
  /* A link is named by its text, not by its address. */
  return rest.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

const isKept = (c: string): boolean => (LETTER_OR_DIGIT.test(c) && !BLANK.has(c)) || MARKS.has(c);
const isLetterOrDigit = (c: string): boolean => LETTER_OR_DIGIT.test(c) && !BLANK.has(c);
const EDGE = /^[\s.,\-_]+|[\s.,\-_]+$/g;

/**
 * The name proposed for a note whose text is `text`, with its extension; or
 * `null` when its first line holds nothing to name it by.
 */
export function proposeNoteName(text: string): string | null {
  const line = firstLine(text);
  if (line === null) return null;

  /* Compatibility forms folded first, so a full-width `ＣＯＮ` or a superscript
     `COM¹` is read as what it shows. Croatian letters come out of it whole. */
  const plain = Array.from(withoutMarkdown(line).normalize('NFKC'), (c) => (isKept(c) ? c : ' '))
    .join('')
    .replace(/\s+/g, ' ')
    .replace(EDGE, '');

  let stem = '';
  let length = 0;
  let spaces = 0;
  let marks = 0;
  let cut = false;
  for (const c of plain) {
    const space = c === ' ';
    const mark = !isLetterOrDigit(c);
    if (length + 1 > NOTE_STEM_MAX) {
      /* Cut for length in the middle of a word, that word goes whole. */
      cut = !space;
      break;
    }
    if ((space && spaces + 1 > MOST_SPACES) || (mark && marks + 1 > MOST_MARKS)) break;
    stem += c;
    length++;
    if (space) spaces++;
    if (mark) marks++;
  }
  const lastSpace = stem.lastIndexOf(' ');
  if (cut && lastSpace > 0) stem = stem.slice(0, lastSpace);
  /* A first line that already ends in `.md` is not given a second. */
  stem = stem.replace(EDGE, '').replace(/\.md$/i, '').replace(EDGE, '');

  if (!Array.from(stem).some(isLetterOrDigit)) return null;
  const device = stem.split('.')[0]?.trimEnd() ?? '';
  if (DEVICE.test(device)) return null;
  return stem + NOTE_EXTENSION;
}
