/**
 * Rich Text Format — the one format this program could name and not open.
 *
 * Until now a `.rtf` was recognised and refused, which is the most annoying
 * answer software can give: *I know exactly what this is, and no.* They arrive
 * from everywhere — WordPad, the export button of half the accounting software
 * in the country, e-mail attachments from people whose Word saves this way by
 * habit — and two of the files in the test corpus are `.rtf` wearing a `.doc`
 * name, which is how they were found in the first place.
 *
 * Unlike everything else here, RTF is not a container and not a markup: it is a
 * **stream of instructions to a typewriter**, read from the first byte to the
 * last while a stack of states is pushed and popped by braces. `{\b bold}`
 * turns bold on, prints, and turns it back off by the brace alone. Nothing
 * declares where a paragraph starts; a paragraph ends where `\par` says so, and
 * everything in force at that moment is what it was.
 *
 * Three things decide whether the text comes out right:
 *
 * **The code page is claimed twice, and the two disagree.** The document says
 * `\ansicpg1252` and the font says `\fcharset238`, and Word writing Croatian
 * routinely says both — the second wins for text set in that font. `0xE8` is
 * `è` under one and `č` under the other. See [`codepages.ts`](./codepages.ts).
 *
 * **`\uN` comes with its own rubbish to swallow.** So that old readers see
 * something, every Unicode character is written as the character *and* a
 * replacement for it: `\u269 ?`. `\ucN` says how many characters of that
 * replacement follow, and a reader that does not skip them prints a question
 * mark after every Croatian letter in the file.
 *
 * **A group can be a destination, and most destinations are not text.** The
 * font table, the colour table, the style sheet, the picture data, the
 * generator's signature — all of them are groups full of things that look like
 * text and are not. `\*` marks one as safe to ignore wholesale, which is the
 * only reason an unknown extension does not end up printed into the document.
 *
 * **Read-only.** A `Preview` is handed over without a `source`, which is how
 * this codebase says so. Writing RTF back would mean deciding what to do with
 * every instruction this reader skipped, and the honest answer is that it does
 * not know.
 */

import { charsetPage, fromCodePage } from './codepages.js';
import { buildPreview, headingLevel, type Chp, type Para, type Pap, type Styles } from './doc.js';
import type { Preview } from './docx.js';

/**
 * The five bytes every Rich Text file begins with, as bytes.
 *
 * Not as a string literal. The second of them is a backslash, and a lone
 * backslash inside quotation marks is an escape in this language before it is a
 * character — the first spelling of this check read the file for `{`, a
 * carriage return, `t`, `f`, and declared every RTF in the world to be
 * something else. As numbers there is nothing left to interpret.
 */
const SIGNATURE = [0x7b, 0x5c, 0x72, 0x74, 0x66];

/** A document longer than this is shown to the cap; past it the browser stops being usable. */
const MAX_CHARS = 2_000_000;

/**
 * Groups whose contents are not the document, listed because they are not
 * marked ignorable and would otherwise be printed.
 *
 * Everything under `\*` is skipped without being named — that is what the star
 * is for. These are the ones written plainly: `{\fonttbl...}` really does
 * contain the words `Times New Roman` as text.
 */
const SKIP = new Set([
  'colortbl',
  'listtable',
  'listoverridetable',
  'info',
  'pict',
  'object',
  'filetbl',
  'revtbl',
  'header',
  'headerl',
  'headerr',
  'headerf',
  'footer',
  'footerl',
  'footerr',
  'footerf',
  'footnote',
  'annotation',
  'xe',
  'tc',
  /*
   * The list marker, in both spellings. `pntext` is how Word 6 wrote it and
   * `listtext` is how Word 97 onwards and LibreOffice do — a bare, unstarred
   * group holding the bullet or the number and a tab:
   *
   *     \pard\ls1\ilvl0{\listtext\pard\plain\f2 \'b7\tab}Prva stavka\par
   *
   * Only `pntext` was here, so the modern spelling fell through to the default
   * branch and its contents were printed as body text — and then the renderer,
   * seeing a paragraph in a list, drew its own bullet in front of it. Every
   * list item in every Word file since 1997 came out as "• · Prva stavka", and
   * a numbered one as "• 1. Prva stavka" under a note claiming the numbering
   * had not been carried over. Microsoft's own sdk_license.rtf has ninety of
   * these groups in it.
   */
  'pntext',
  'listtext',
  'fldinst',
]);

/** What a skipped group costs the reader, in words, above the document. */
const SKIP_NOTES: Record<string, string> = {
  pict: 'Pictures are not shown.',
  object: 'Embedded objects are not shown.',
  header: 'This file has headers and footers — they are not shown.',
  footer: 'This file has headers and footers — they are not shown.',
  footnote: 'Footnotes are not shown.',
  annotation: 'Comments are not shown.',
};

/** The characters RTF spells out as control words rather than storing. */
const NAMED: Record<string, string> = {
  tab: '\t',
  emdash: String.fromCharCode(0x2014),
  endash: String.fromCharCode(0x2013),
  emspace: String.fromCharCode(0x2003),
  enspace: String.fromCharCode(0x2002),
  qmspace: String.fromCharCode(0x2005),
  bullet: String.fromCharCode(0x2022),
  lquote: String.fromCharCode(0x2018),
  rquote: String.fromCharCode(0x2019),
  ldblquote: String.fromCharCode(0x201c),
  rdblquote: String.fromCharCode(0x201d),
  ltrmark: '',
  rtlmark: '',
  zwj: '',
  zwnj: '',
};

/**
 * The font charsets whose bytes this reader turns into the right letters:
 * Western, whatever the system default turns out to be, Central European —
 * and Symbol, which is not an alphabet at all but a font of shapes, read as
 * Western because that is where its bullet and its arrows land closest.
 */
const DECODABLE_CHARSETS = new Set([0, 1, 2, 238]);

const PLAIN: Chp = { bold: false, italic: false, underline: false, strike: false };
const BLANK_PAP: Pap = { istd: 0, inTable: false, rowEnd: false, jc: 0, ilfo: 0, ilvl: 0 };

/**
 * One frame of the brace stack.
 *
 * Everything a group can change is copied on `{` and thrown away on `}`, which
 * is the whole of RTF's scoping. `skip` is inherited: a picture inside a header
 * is skipped because the header was.
 */
interface Frame {
  chp: Chp;
  pap: Pap;
  /** Characters of the `\uN` replacement still to be swallowed. */
  uc: number;
  /**
   * The font in force, by the number the font table gave it — not the code page
   * it implies.
   *
   * The page was held here once, and the document's own code-page
   * instruction had to reach back and rewrite
   * every frame on the stack to change it, which meant a page set inside a
   * group survived the brace that closed the group. Keeping the font and asking
   * the table at the moment a byte is decoded has no such seam: whatever the
   * font table says by then is the answer, and it says it for exactly as long
   * as the group that named the font.
   */
  font: number | null;
  skip: boolean;
  /**
   * Text marked hidden — how a table of contents keeps its own workings, and
   * how index entries travel. Kept apart from `skip` because it is a property
   * of the characters and not of the group: it is turned off by an instruction
   * inside the very stretch it turned on, so a reader that treats it as a
   * skipped destination never sees the instruction that ends it and loses the
   * rest of the document.
   */
  hidden: boolean;
  /** Set by `\*`: this group is safe to drop whole, whatever it turns out to be. */
  starred: boolean;
  /** The destination this group opened, for the ones read rather than skipped. */
  destination: 'body' | 'fonttbl' | 'stylesheet';
}

export interface ParsedRtf {
  paragraphs: Para[];
  styles: Styles;
  notes: Set<string>;
}

/**
 * Reads the whole file into paragraphs.
 *
 * One pass, no lookahead beyond the token being read. The size of the thing is
 * in the state, not in the algorithm.
 */
export function parseRtf(bytes: Uint8Array): ParsedRtf {
  if (SIGNATURE.some((code, at) => bytes[at] !== code)) {
    throw new Error('This is not a Rich Text document.');
  }

  const paragraphs: Para[] = [];
  const notes = new Set<string>();
  const styles: Styles = { sti: [], names: [] };
  /** Where a `\outlinelevel` heading gets its style from, made as needed. */
  const outlineStyles = new Map<number, number>();

  let documentPage: 1250 | 1252 = 1252;
  /** The font used where no font instruction has named one — `\deffN` in the header. */
  let defaultFont = 0;
  /** Font index → code page, from the font table. */
  const fontPages = new Map<number, 1250 | 1252>();

  /** The page a byte in this group is written in. */
  const pageOf = (level: Frame): 1250 | 1252 =>
    fontPages.get(level.font ?? defaultFont) ?? documentPage;

  const stack: Frame[] = [
    {
      chp: { ...PLAIN },
      pap: { ...BLANK_PAP },
      uc: 1,
      font: null,
      skip: false,
      hidden: false,
      starred: false,
      destination: 'body',
    },
  ];
  let frame = stack[0]!;

  /* The paragraph being built. `runs` are closed and reopened whenever the
     character properties change, which is the only thing that cuts one. */
  let runs: { text: string; chp: Chp }[] = [];
  let current = '';
  let currentChp: Chp = { ...PLAIN };
  let characters = 0;
  let truncated = false;

  /* The style sheet and the font table are read rather than skipped, and both
     hold one entry per group, ending at a semicolon. */
  let entryText = '';
  let entryNumber = 0;

  const closeRun = () => {
    if (current) runs.push({ text: current, chp: currentChp });
    current = '';
  };

  const closePara = (cell: boolean, rowEnd: boolean) => {
    closeRun();
    const pap = { ...frame.pap, rowEnd };
    /* A row's closing mark is a paragraph of its own in this model — see
       `buildPreview`, which cuts rows at it. It is inside the table whether or
       not the instruction that ended the row said so. */
    if (rowEnd) pap.inTable = true;
    paragraphs.push({ runs, cell, pap });
    runs = [];
    currentChp = { ...frame.chp };
  };

  const emit = (text: string) => {
    if (frame.skip || frame.hidden || !text) return;
    if (characters >= MAX_CHARS) {
      truncated = true;
      return;
    }
    if (frame.destination !== 'body') {
      /*
       * A font name or a style name. Capped because the cap above counts
       * characters that reached the *document*, and this branch reaches none —
       * so a font table that never closes its first entry funnels the rest of
       * the file into one string, one byte at a time, and a twenty-megabyte
       * file takes the renderer down with it. Nothing longer than this is a
       * name.
       */
      if (entryText.length < 4096) entryText += text;
      return;
    }
    /* A run holds one set of properties. Comparing them field by field rather
       than by identity: the frame is copied on every brace, so two runs of
       plain text either side of a group are not the same object and are
       nonetheless the same run. */
    if (
      currentChp.bold !== frame.chp.bold ||
      currentChp.italic !== frame.chp.italic ||
      currentChp.underline !== frame.chp.underline ||
      currentChp.strike !== frame.chp.strike
    ) {
      closeRun();
      currentChp = { ...frame.chp };
    }
    current += text;
    characters += text.length;
  };

  /**
   * How much of a `\uN` replacement is still to be thrown away.
   *
   * Every Unicode character in the file is written twice — once as itself and
   * once as something an old reader could print — and `\ucN` says how long the
   * second copy is. Not swallowing it puts a question mark after every Croatian
   * letter in the document.
   */
  let pendingSkip = 0;
  const swallow = (): boolean => {
    if (pendingSkip <= 0) return false;
    pendingSkip--;
    return true;
  };

  const at = (i: number) => bytes[i] ?? 0;
  const isLetter = (code: number) =>
    (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
  const isDigit = (code: number) => code >= 0x30 && code <= 0x39;

  let i = 1; // past the opening brace, which the header check already saw

  while (i < bytes.length) {
    /*
     * The cap belongs here and not only in `emit`. `emit` counts characters
     * that reach the page, and a file can go on producing paragraphs and
     * frames long after it has stopped producing any: eight megabytes of an
     * ordinary document ended as a hundred and twenty thousand paragraphs, of
     * which eighty-eight thousand were empty, each one drawn as a blank line
     * under a note saying the document had been cut short.
     */
    if (characters >= MAX_CHARS) {
      truncated = true;
      break;
    }

    const code = at(i);

    if (code === 0x7b) {
      // {
      /* A file made of nothing but opening braces would otherwise be a frame
         each, and the depth of a real document is single digits. */
      if (stack.length >= 4096) {
        i++;
        continue;
      }
      stack.push({ ...frame, chp: { ...frame.chp }, pap: { ...frame.pap }, starred: false });
      frame = stack[stack.length - 1]!;
      /* The understudy of a `\u` belongs to the text it stood in for, and that
         text ended at the brace. */
      pendingSkip = 0;
      /* One entry of the font table or the style sheet per group, so whatever
         was gathered belonged to the entry that has just ended. */
      if (frame.destination !== 'body') {
        entryText = '';
        entryNumber = 0;
      }
      i++;
      continue;
    }

    if (code === 0x7d) {
      // }
      if (frame.destination === 'stylesheet' && entryText.trim()) {
        styles.names[entryNumber] = entryText.replace(/;.*$/s, '').trim();
        styles.sti[entryNumber] = -1;
      }
      if (frame.destination === 'fonttbl') entryText = '';
      stack.pop();
      pendingSkip = 0;
      /* The brace that closes the outermost group closes the document. What
         follows it is not RTF at all — a file with anything after that point is
         damaged, and reading it as text adds a paragraph of somebody's stray
         bytes to the end of their document. */
      if (stack.length === 0) break;
      frame = stack[stack.length - 1]!;
      /* The properties in force belong to the group that is now current, and a
         run that was open under the old ones has ended. */
      if (frame.destination === 'body') closeRun();
      i++;
      continue;
    }

    if (code !== 0x5c) {
      // Ordinary text. The line breaks in the file are formatting of the file
      // itself and are not part of the document.
      if (code === 0x0d || code === 0x0a) {
        i++;
        continue;
      }
      i++;
      if (swallow()) continue;
      emit(fromCodePage(code, pageOf(frame)));
      continue;
    }

    /* A backslash: an escape, a hex byte, or a control word. */
    const next = at(i + 1);

    if (next === 0x5c || next === 0x7b || next === 0x7d) {
      i += 2;
      if (swallow()) continue;
      emit(String.fromCharCode(next));
      continue;
    }

    if (next === 0x27) {
      // \'hh — one byte, written in hex because RTF is an ASCII format.
      /* Both digits have to be there. A file that ends mid-escape used to have
         the byte past its end read as the second digit, which turned the last
         letter of a truncated document into a control character. */
      if (i + 4 > bytes.length) break;
      const hex = String.fromCharCode(at(i + 2), at(i + 3));
      i += 4;
      if (swallow()) continue;
      const value = Number.parseInt(hex, 16);
      if (!Number.isNaN(value)) emit(fromCodePage(value, pageOf(frame)));
      continue;
    }

    if (next === 0x2a) {
      // \* — whatever this group turns out to be, it may be dropped whole.
      frame.starred = true;
      i += 2;
      continue;
    }

    if (next === 0x7e) {
      i += 2;
      emit(String.fromCharCode(0x00a0));
      continue;
    }

    if (next === 0x2d || next === 0x5f) {
      // An optional hyphen, and one a line may not break at.
      i += 2;
      if (next === 0x5f) emit(String.fromCharCode(0x2011));
      continue;
    }

    if (next === 0x0d || next === 0x0a) {
      // A backslash at the end of a line is a paragraph mark in older writers.
      i += 2;
      if (!frame.skip && frame.destination === 'body') closePara(false, false);
      continue;
    }

    if (!isLetter(next)) {
      // An escape this reader does not know. Dropping the pair is the only
      // reading that cannot print machinery into the document.
      i += 2;
      continue;
    }

    /* A control word: letters, then an optional number, then one space that
       belongs to the word rather than to the text. */
    /*
     * The format allows a control word thirty-two letters long and a number of
     * ten digits, and both are gathered here to those limits and no further.
     * The bytes past the limit are still walked over — they belong to the word,
     * whatever it turns out to be — but they are not kept.
     *
     * That is not tidiness. This was written as
     * `String.fromCharCode(...bytes.slice(i + 1, j))`, which hands every byte
     * of the run to the function as a separate argument: three hundred thousand
     * letters where a control word should be, and a damaged file takes the
     * whole program down with a stack overflow rather than being called
     * damaged.
     */
    let j = i + 1;
    let word = '';
    while (j < bytes.length && isLetter(at(j))) {
      if (word.length < 32) word += String.fromCharCode(at(j));
      j++;
    }

    let digits = '';
    if (at(j) === 0x2d) {
      digits = '-';
      j++;
    }
    while (j < bytes.length && isDigit(at(j))) {
      if (digits.length < 11) digits += String.fromCharCode(at(j));
      j++;
    }
    if (at(j) === 0x20) j++;
    const value = digits === '' || digits === '-' ? null : Number(digits);
    i = j;

    /* `\bin` is followed by that many bytes of anything at all, including
       braces and backslashes. Skipped by counting, never by reading. */
    if (word === 'bin') {
      i += Math.max(0, value ?? 0);
      continue;
    }

    /* A destination the group opens. Checked before anything else, because a
       skipped group's contents must not be interpreted at all. */
    /* Two groups are read rather than dropped: the font table decides which
       code page the letters are in, and the style sheet is where a heading says
       it is one. Both are lists of entries, one group each, ending at a
       semicolon. */
    if (word === 'fonttbl' || word === 'stylesheet') {
      frame.destination = word;
      entryText = '';
      entryNumber = 0;
      continue;
    }

    if (SKIP.has(word)) {
      frame.skip = true;
      const note = SKIP_NOTES[word];
      if (note) notes.add(note);
      continue;
    }
    if (frame.starred) {
      /* `\*\somethingnew` — an extension written after this reader. The star is
         the format's own promise that dropping it loses nothing a reader is
         required to understand. */
      frame.skip = true;
      continue;
    }

    if (frame.destination === 'fonttbl') {
      if (word === 'f' && value !== null) entryNumber = value;
      if (word === 'fcharset' && value !== null) {
        fontPages.set(entryNumber, charsetPage(value));
        /*
         * Two code pages are decoded here and the rest are read as Western,
         * which is right for the Latin ones and wrong for Cyrillic, Greek and
         * Turkish. Wrong quietly, which is the part worth saying out loud: the
         * letters come back as *different* letters rather than as anything that
         * looks like a failure. Said once, above the document, the way every
         * other thing this view cannot do is said.
         */
        if (!DECODABLE_CHARSETS.has(value)) {
          notes.add('Some of this file is in an alphabet this reader does not decode yet — that text may come out wrong.');
        }
      }
      continue;
    }
    if (frame.destination === 'stylesheet') {
      if ((word === 's' || word === 'cs' || word === 'ds') && value !== null) entryNumber = value;
      continue;
    }
    /* Read before the guard below, because it is what turns itself back off. */
    if (word === 'v') {
      frame.hidden = value !== 0;
      continue;
    }

    if (frame.skip) continue;

    switch (word) {
      /* — the document — */
      case 'ansicpg':
        /* Document-wide and deliberately not scoped to the group it appears in:
           it is a statement about the file, written once in the header, and a
           file that moves it is telling us about all of itself either way. What
           *is* scoped is the font, and the font is what usually disagrees with
           this. */
        if (value !== null) documentPage = value === 1250 ? 1250 : 1252;
        break;

      case 'deff':
        if (value !== null) defaultFont = value;
        break;

      case 'f':
        /* The font decides the code page, and this is the instruction that made
           the Croatian files in the corpus readable: the document claims 1252
           throughout and every word of Croatian in it is set in a font that
           says 238. */
        if (value !== null) frame.font = value;
        break;

      /* — characters — */
      case 'u': {
        if (value === null) break;
        /*
         * Negative means the writer stored the value as a signed 16-bit number,
         * so it wraps — that much is the format. What is not the format is a
         * value outside Unicode altogether, and a damaged file carries any
         * number at all. `String.fromCodePoint` throws on one, and the throw
         * escapes all the way out of the reader: a single bad escape in an
         * otherwise readable document loses the whole document and shows the
         * engine's own English sentence in place of it.
         *
         * The replacement is still swallowed. The characters after a `\\u` are
         * its understudy whether or not the value was usable, and leaving them
         * would put a question mark on the page instead of nothing.
         */
        const point = value < 0 ? value + 0x10000 : value;
        if (point >= 0 && point <= 0x10ffff) emit(String.fromCodePoint(point));
        pendingSkip = frame.uc;
        break;
      }
      case 'uc':
        if (value !== null) frame.uc = Math.max(0, value);
        break;

      /* — runs — */
      case 'plain':
        frame.chp = { ...PLAIN };
        break;
      case 'b':
        frame.chp = { ...frame.chp, bold: value !== 0 };
        break;
      case 'i':
        frame.chp = { ...frame.chp, italic: value !== 0 };
        break;
      case 'ul':
        frame.chp = { ...frame.chp, underline: value !== 0 };
        break;
      case 'ulnone':
        frame.chp = { ...frame.chp, underline: false };
        break;
      case 'strike':
        frame.chp = { ...frame.chp, strike: value !== 0 };
        break;
      /* — paragraphs — */
      case 'pard':
        frame.pap = { ...BLANK_PAP };
        break;
      case 'par':
      case 'sect':
        closePara(false, false);
        break;
      case 'line':
        emit('\n');
        break;
      case 'page':
        closePara(false, false);
        break;
      case 'ql':
        frame.pap = { ...frame.pap, jc: 0 };
        break;
      case 'qc':
        frame.pap = { ...frame.pap, jc: 1 };
        break;
      case 'qr':
        frame.pap = { ...frame.pap, jc: 2 };
        break;
      case 'qj':
        frame.pap = { ...frame.pap, jc: 3 };
        break;
      case 's':
        if (value !== null) frame.pap = { ...frame.pap, istd: value };
        break;
      case 'outlinelevel': {
        /* A heading that carries no heading style — the outline level is then
           the only thing that says so. It is given a style of its own, named
           the way `headingLevel` reads names, rather than a second route
           through the renderer. */
        if (value === null || value > 8) break;
        let index = outlineStyles.get(value);
        if (index === undefined) {
          /* Far above any index a file uses for its own styles, so the two
             cannot collide however many the document defines. */
          index = 5000 + value;
          styles.names[index] = `heading ${value + 1}`;
          styles.sti[index] = -1;
          outlineStyles.set(value, index);
        }
        if (headingLevel(styles, frame.pap.istd) === 0) frame.pap = { ...frame.pap, istd: index };
        break;
      }

      /* — lists — */
      case 'ls':
        if (value !== null) frame.pap = { ...frame.pap, ilfo: value };
        break;
      case 'ilvl':
        if (value !== null) frame.pap = { ...frame.pap, ilvl: value };
        break;

      /* — tables — */
      case 'intbl':
        frame.pap = { ...frame.pap, inTable: true };
        break;
      case 'cell':
      case 'nestcell':
        frame.pap = { ...frame.pap, inTable: true };
        closePara(true, false);
        break;
      case 'row':
      case 'nestrow':
        closePara(false, true);
        break;

      default:
        if (word in NAMED) emit(NAMED[word]!);
        break;
    }
  }

  // Whatever the last paragraph mark left behind still belongs to the document.
  closeRun();
  if (runs.length > 0) closePara(false, false);

  notes.add('Fonts, sizes, colours and spacing are not shown — the text is set in the reading font.');
  if (paragraphs.some((para) => para.pap.ilfo !== 0)) {
    notes.add('Numbering is not carried over — numbered lists are shown as plain ones.');
  }
  if (truncated) {
    notes.add('This document is very long — only the beginning is shown.');
  }

  return { paragraphs, styles, notes };
}

export function readRtf(bytes: Uint8Array): Preview {
  const { paragraphs, styles, notes } = parseRtf(bytes);
  return buildPreview(paragraphs, styles, notes);
}
