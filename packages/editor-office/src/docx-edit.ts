/**
 * Editing text in a Word document — surgically, one run at a time.
 *
 * **Why a run and not a paragraph.** In OOXML a `w:r` is a piece of text with a
 * single formatting. A paragraph often holds a dozen of them: a bold name, a
 * plain sentence, an italic aside. To rewrite a paragraph, the program would
 * have to guess which formatting applies to which new letter — and that is
 * precisely the silent loss of somebody else's formatting this project forbids.
 * A run is rewritten without a single such decision: its formatting stays, only
 * the text changes.
 *
 * **Why the XML is not re-serialised.** `XMLSerializer` would walk the whole
 * document and change quotation marks, namespaces, attribute order and
 * whitespace along the way. The diff would bear no resemblance to what the user
 * asked for. So the replacement is done **by byte range**: everything but the
 * rewritten text stays character for character identical.
 *
 * There is no DOM and no zip here, so the same code runs in the browser and in
 * the checks.
 */

import { strToU8, zipSync } from 'fflate';

import type { Archive } from './ooxml.js';

/* ── walking the tags ────────────────────────────────────────────────── */

interface Tag {
  /** The name with its prefix, as it stands in the file: `w:r`, `w:t`. */
  name: string;
  start: number;
  end: number;
  closing: boolean;
  selfClosing: boolean;
}

/**
 * Yields every XML tag in order, with its range.
 *
 * Quotes are respected because an attribute value may contain `>`, and comments
 * and CDATA are skipped whole — otherwise a `<` inside them would look like the
 * start of a tag.
 */
function* scanTags(xml: string): Generator<Tag> {
  let i = 0;

  while (i < xml.length) {
    const open = xml.indexOf('<', i);
    if (open === -1) return;

    if (xml.startsWith('<!--', open)) {
      const close = xml.indexOf('-->', open);
      i = close === -1 ? xml.length : close + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', open)) {
      const close = xml.indexOf(']]>', open);
      i = close === -1 ? xml.length : close + 3;
      continue;
    }
    if (xml.startsWith('<?', open) || xml.startsWith('<!', open)) {
      const close = xml.indexOf('>', open);
      i = close === -1 ? xml.length : close + 1;
      continue;
    }

    let at = open + 1;
    let quote = '';
    while (at < xml.length) {
      const ch = xml[at]!;
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      at++;
    }
    if (at >= xml.length) return;

    const body = xml.slice(open + 1, at);
    const closing = body.startsWith('/');
    const selfClosing = body.endsWith('/');
    const name = body
      .replace(/^\//, '')
      .replace(/\/$/, '')
      .trim()
      .split(/[\s/]/, 1)[0]!;

    yield { name, start: open, end: at + 1, closing, selfClosing };
    i = at + 1;
  }
}

function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/* ── runovi ──────────────────────────────────────────────────────────── */

export interface RunSpan {
  /** The ordinal in the document; the same order as a DOM tree walk. */
  index: number;
  start: number;
  end: number;
  /** The range of the single `w:t` element and of its content. */
  text: { start: number; end: number; contentStart: number; contentEnd: number } | null;
  /** Why this run cannot be rewritten; `null` when it can. */
  refusal: string | null;
}

/**
 * Content that makes a run un-rewritable.
 *
 * A line break and a tab carry position, while a drawing, a field or a nested
 * run carries content of its own — replacing the text alone would shift or lose
 * them. Such a run is still readable, it is simply not offered for editing.
 */
const BLOCKING = new Set(['br', 'tab', 'drawing', 'pict', 'object', 'fldChar', 'instrText', 'ruby']);

/** Finds every `w:r` element in the document, in order. */
export function findRuns(xml: string): RunSpan[] {
  const runs: RunSpan[] = [];
  /** The open runs; the innermost is last. Drawings can contain runs. */
  const open: { span: RunSpan; texts: RunSpan['text'][]; blocked: Set<string> }[] = [];
  let pendingText: { start: number; contentStart: number } | null = null;

  for (const tag of scanTags(xml)) {
    const local = localName(tag.name);

    if (local === 'r' && !tag.closing) {
      const span: RunSpan = { index: runs.length, start: tag.start, end: tag.end, text: null, refusal: null };
      runs.push(span);
      if (!tag.selfClosing) open.push({ span, texts: [], blocked: new Set() });
      else span.refusal = 'the run is empty';
      continue;
    }

    const current = open[open.length - 1];

    if (local === 'r' && tag.closing) {
      const finished = open.pop();
      if (!finished) continue;

      finished.span.end = tag.end;
      if (finished.blocked.size > 0) {
        finished.span.refusal = `contains ${[...finished.blocked].join(', ')}`;
      } else if (finished.texts.length === 0) {
        finished.span.refusal = 'the run has no text';
      } else if (finished.texts.length > 1) {
        // Word tends to split a word across several `w:t` after a spell check.
        finished.span.refusal = 'the text is split across several parts';
      } else {
        finished.span.text = finished.texts[0] ?? null;
      }

      // A run inside a run makes the outer one un-rewritable, as it carries foreign content.
      open[open.length - 1]?.blocked.add('a nested run');
      continue;
    }

    if (!current) continue;

    if (local === 't') {
      if (tag.closing) {
        if (pendingText) {
          current.texts.push({
            start: pendingText.start,
            end: tag.end,
            contentStart: pendingText.contentStart,
            contentEnd: tag.start,
          });
          pendingText = null;
        }
        continue;
      }
      if (tag.selfClosing) {
        // `<w:t/>` is empty text; content is inserted between the tags.
        current.texts.push({
          start: tag.start,
          end: tag.end,
          contentStart: tag.end,
          contentEnd: tag.end,
        });
        continue;
      }
      pendingText = { start: tag.start, contentStart: tag.end };
      continue;
    }

    if (!tag.closing && BLOCKING.has(local)) current.blocked.add(local);
  }

  return runs;
}

/* ── text ────────────────────────────────────────────────────────────── */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function unescapeXml(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) return String.fromCodePoint(Number(body.slice(1)));
    return ENTITIES[body] ?? whole;
  });
}

export function escapeXml(text: string): string {
  return text.replace(/[&<>]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));
}

export function runText(xml: string, run: RunSpan): string {
  if (!run.text) return '';
  return unescapeXml(xml.slice(run.text.contentStart, run.text.contentEnd));
}

/* ── writing ─────────────────────────────────────────────────────────── */

export interface RunEdit {
  index: number;
  text: string;
}

/**
 * Writes the new texts into the document, changing only their ranges.
 *
 * It works from the end backwards so the offsets do not shift underfoot. The new
 * element always gets `xml:space="preserve"`: without it Word discards leading
 * and trailing spaces, so "name " would quietly become "name".
 */
export function applyRunEdits(xml: string, runs: RunSpan[], edits: RunEdit[]): string {
  const byIndex = new Map(runs.map((run) => [run.index, run]));

  const ordered = [...edits]
    .map((edit) => ({ edit, run: byIndex.get(edit.index) }))
    .filter((pair): pair is { edit: RunEdit; run: RunSpan } => !!pair.run?.text && !pair.run.refusal)
    .sort((a, b) => b.run.text!.start - a.run.text!.start);

  let out = xml;
  for (const { edit, run } of ordered) {
    const span = run.text!;
    out =
      out.slice(0, span.start) +
      `<w:t xml:space="preserve">${escapeXml(edit.text)}</w:t>` +
      out.slice(span.end);
  }
  return out;
}

/**
 * Assembles a new `.docx` with the edited text.
 *
 * Every other part of the archive passes through **untouched**: styles,
 * numbering, images, headers, metadata. Exactly one part changes, and inside it
 * exactly the ranges the user rewrote.
 */
export function writeDocx(archive: Archive, runs: RunSpan[], xml: string, edits: RunEdit[]): Uint8Array {
  const next: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(archive)) next[path] = data;
  next['word/document.xml'] = strToU8(applyRunEdits(xml, runs, edits));
  return zipSync(next);
}
