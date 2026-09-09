/**
 * The three questions, where a person asks them: over a word, on a keystroke,
 * on `F12`.
 *
 * Diagnostics arrive on their own — a server publishes and the margin fills in.
 * Everything here is the other direction, and the difference is not plumbing
 * but timing: **an answer is about the document as it was when the question
 * went out**, and by the time it comes back the person has kept typing. So
 * every one of these can arrive too late to be true, and each of them says
 * below what it does about that.
 *
 * Nothing here runs on a machine with no language server. `served()` is false,
 * every question returns nothing, and the tooltip, the list and the jump simply
 * never appear — which is the same thing that happens over a keyword, and is
 * not a state worth reporting.
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, hoverTooltip } from '@codemirror/view';

import type { CodeCompletion, CodeHover, CodeLocation, CodeSpan } from '@uleditor/plugin-sdk';

/**
 * What the editor can ask, without knowing who answers.
 *
 * The instance implements this over the host; the extensions below take it as
 * a value. That is what lets the whole file be about CodeMirror and nothing
 * else — and what lets a document with no server keep every extension mounted
 * and idle rather than being reconfigured after the fact.
 */
export interface CodeIntel {
  /** Whether a server took this document. False means nothing below asks. */
  served(): boolean;
  hover(line: number, column: number): Promise<CodeHover | null>;
  definition(line: number, column: number): Promise<CodeLocation[]>;
  completions(line: number, column: number): Promise<CodeCompletion[]>;
  /** Opening somewhere else is the shell's business, not the editor's. */
  jump(location: CodeLocation): void;
  /** Said when an explicit gesture found nothing. Silence would read as broken. */
  report(message: string): void;
  /** `Go to definition`, translated by whoever mounted this. */
  readonly nothingFound: string;
}

/** Spelled the same way the title bar and the menu spell it. */
const IS_MAC =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

/* ── positions ───────────────────────────────────────────────────────── */

/**
 * An offset into the document, as a one-based line and column.
 *
 * The column is an index into the line as JavaScript holds it, which is UTF-16
 * code units — which is what the protocol counts in as well. So there is no
 * conversion here beyond the two ones, and a `č` costs the same as an `a`.
 */
function positionOf(state: EditorState, offset: number): { line: number; column: number } {
  const line = state.doc.lineAt(offset);
  return { line: line.number, column: offset - line.from + 1 };
}

/**
 * And back — clamped, because an answer is about text that has since changed.
 *
 * A server answers about the document it was last told about, the person has
 * kept typing, and a position past the end of a shorter document would throw
 * where a mark in roughly the right place is what was wanted.
 */
function offsetOf(state: EditorState, line: number, column: number): number {
  const which = Math.min(Math.max(line, 1), state.doc.lines);
  const at = state.doc.line(which);
  return Math.min(at.from + Math.max(column - 1, 0), at.to);
}

function spanToRange(state: EditorState, span: CodeSpan): { from: number; to: number } {
  return {
    from: offsetOf(state, span.line, span.column),
    to: offsetOf(state, span.endLine, span.endColumn),
  };
}

/* ── drawing what a server said ──────────────────────────────────────── */

/**
 * A server's Markdown, as DOM nodes.
 *
 * **Built rather than parsed, and that is the security argument as much as the
 * size one.** The text comes from doc comments in somebody's dependencies;
 * setting it as `innerHTML` would mean a Markdown library and a sanitiser
 * beside it, and `markdown-it` and `dompurify` already live in the Markdown
 * editor — which depends on this package, so they cannot come the other way
 * without a cycle. Every node here is created and every string goes in as
 * `textContent`, so there is no parser to get wrong.
 *
 * What it understands is what a hover actually contains: fenced code, inline
 * code, rules, and paragraphs. Emphasis is left as the asterisks it was
 * written with, and a link is shown as its text — a tooltip nobody can click
 * should not pretend to be clickable.
 */
export function renderMarkdown(markdown: string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'cm-ul-doc';

  /* Split on fences first, so nothing inside one is read as anything but
     text — a doc comment full of `#[derive(...)]` is code, not headings. */
  const parts = markdown.split(/```/g);
  parts.forEach((part, index) => {
    const fenced = index % 2 === 1;

    if (fenced) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      /* The first line of a fence is the language, and it is not content. */
      const newline = part.indexOf('\n');
      code.textContent = (newline === -1 ? '' : part.slice(newline + 1)).replace(/\n$/, '');
      pre.append(code);
      root.append(pre);
      return;
    }

    for (const block of part.split(/\n{2,}/)) {
      const text = block.trim();
      if (!text) continue;

      if (/^(?:-{3,}|_{3,}|\*{3,})$/.test(text)) {
        root.append(document.createElement('hr'));
        continue;
      }

      const paragraph = document.createElement('p');
      /* Inline code, and nothing else: a signature written as `Vec<T>` inside
         a sentence is the one piece of formatting that changes what the
         sentence means. */
      for (const [at, piece] of text.split(/`/g).entries()) {
        if (!piece) continue;
        if (at % 2 === 1) {
          const code = document.createElement('code');
          code.textContent = piece;
          paragraph.append(code);
        } else {
          paragraph.append(document.createTextNode(piece.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')));
        }
      }
      root.append(paragraph);
    }
  });

  return root;
}

/* ── what is this thing ──────────────────────────────────────────────── */

/**
 * The tooltip under the pointer.
 *
 * `side` is which side of the offset the pointer was on, and it is used rather
 * than ignored. `-1` means the pointer was *before* the position, so the
 * character it is actually over is the one before it — and at the boundary
 * between two words, asking at the offset itself asks about the word on the
 * right while the pointer is sitting on the one on the left.
 */
function hovers(intel: CodeIntel): Extension {
  return hoverTooltip(async (view, position, side) => {
    if (!intel.served()) return null;

    const { line, column } = positionOf(view.state, position);
    const answer = await intel.hover(line, side < 0 ? Math.max(column - 1, 1) : column);
    if (!answer) return null;

    /* Where the tooltip points. A server that gave a range gets it underlined;
       one that did not gets the position that was asked about, which is the
       honest fallback and looks the same to a person. */
    const range = answer.span ? spanToRange(view.state, answer.span) : null;

    return {
      pos: range?.from ?? position,
      end: range?.to ?? position,
      above: true,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-ul-hover';
        dom.append(renderMarkdown(answer.markdown));
        return { dom };
      },
    };
  });
}

/* ── what could this word become ─────────────────────────────────────── */

/** The protocol's kinds, as the icons CodeMirror already draws. */
const KINDS: Partial<Record<CodeCompletion['kind'], string>> = {
  method: 'method',
  function: 'function',
  constructor: 'function',
  field: 'property',
  variable: 'variable',
  class: 'class',
  interface: 'interface',
  module: 'namespace',
  property: 'property',
  value: 'constant',
  enum: 'enum',
  keyword: 'keyword',
  enumMember: 'constant',
  constant: 'constant',
  struct: 'class',
  typeParameter: 'type',
  text: 'text',
};

/**
 * A snippet with its tab stops taken out.
 *
 * The client declares `snippetSupport: false`, so this should never be needed;
 * a server that sends one anyway is not to be argued with, and the text has to
 * be made safe before it goes into somebody's file. `${1:value}` becomes
 * `value`, `$0` and `$1` go, and `\$` was always a literal dollar.
 *
 * Nested placeholders are not unwound, which is why the caller checks the
 * result: anything still holding a `$` is refused in favour of the label. A
 * completion that inserts a slightly wrong name is a typo somebody will see; a
 * completion that inserts `${1:${2:x}}` is a bug they will file.
 */
function withoutTabStops(text: string): string {
  return text
    .replace(/\$\{\d+:([^{}$]*)\}/g, '$1')
    .replace(/\$\{\d+\|([^|]*)\|\}/g, (_, choices: string) => choices.split(',')[0] ?? '')
    .replace(/\$\{\d+\}/g, '')
    .replace(/\$\d+/g, '')
    .replace(/\\\$/g, '$');
}

/**
 * How much of a list is worth drawing.
 *
 * rust-analyzer will offer every trait method in scope — several hundred — and
 * a person reads the first dozen. The cut is after the server's own ordering,
 * so what goes is the tail it ranked last.
 */
const MOST = 200;

/**
 * Where a completion list is worth asking for.
 *
 * Without this the list opens on every keystroke including a space, which is a
 * panel appearing over the code for no reason. A word character, or one of the
 * three things that mean "and now something from inside that": a dot, a `::`,
 * an arrow. Explicit — somebody pressed the key for it — always asks.
 */
const WORTH_ASKING = /(?:[\w$]|\.|::|->)$/;

function completions(intel: CodeIntel): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    if (!intel.served()) return null;

    const before = context.state.sliceDoc(Math.max(0, context.pos - 2), context.pos);
    if (!context.explicit && !WORTH_ASKING.test(before)) return null;

    const { line, column } = positionOf(context.state, context.pos);
    const offered = await intel.completions(line, column);
    if (context.aborted || offered.length === 0) return null;

    /*
     * Where the word being completed began. The server's own opinion first,
     * because it knows things this side would have to guess — that `::` is
     * part of a path in Rust and `-` part of a property in CSS. Its answers
     * agree with each other, so the first one that carries a range settles it
     * for the list; where none does, the word under the cursor is the fallback.
     */
    const ranged = offered.find((item) => item.replace);
    const from = ranged?.replace
      ? offsetOf(context.state, ranged.replace.line, ranged.replace.column)
      : (context.matchBefore(/[\w$]*/)?.from ?? context.pos);

    /*
     * Sorted by the server and shown unfiltered, and the two go together.
     * rust-analyzer scores fuzzily — it offers `push_str` for `psh` — and
     * CodeMirror's own filter is a prefix match that would throw exactly those
     * answers away. Since the list is asked for again on every keystroke, the
     * server's ordering is never stale, and re-ranking it here would only be a
     * second opinion overruling a better-informed first one.
     */
    /* Compared as opaque strings, not with `localeCompare`. `sortText` is a
       sort key a server invented — rust-analyzer's look like `ffffffef` — and
       collation rules exist to order words in a language, which these are
       not. */
    const options: Completion[] = offered
      .slice()
      .sort((a, b) => {
        const left = a.sortText ?? a.label;
        const right = b.sortText ?? b.label;
        return left < right ? -1 : left > right ? 1 : 0;
      })
      .slice(0, MOST)
      .map((item) => {
        /* A snippet that survived being told we take none. If unwinding it
           leaves anything that still looks like a placeholder, the label goes
           in instead — `$` in ordinary insert text is a PHP variable or a
           template, and is left alone. */
        const unwound = item.snippet ? withoutTabStops(item.insert) : null;
        const insert =
          unwound === null ? item.insert : !unwound || unwound.includes('$') ? item.label : unwound;

        /* Held in a local so the closure below keeps the narrowing — a
           property read inside one is a fresh read, and would need a cast to
           say what the line above already checked. */
        const documentation = item.documentation;

        return {
          label: item.label,
          detail: item.detail ?? undefined,
          type: KINDS[item.kind] ?? 'text',
          apply: insert,
          info: documentation ? () => renderMarkdown(documentation) : undefined,
        };
      });

    return { from, options, filter: false };
  };
}

/* ── where was it defined ────────────────────────────────────────────── */

/**
 * Follows the name under the cursor, if a server knows where it goes.
 *
 * The **first** of several, and there is no picker. A definition is genuinely
 * plural — a trait method has implementations, a symbol behind a `cfg` is
 * declared twice — and a list to choose from is a feature of its own with a
 * panel and a keyboard path through it. Servers put the declaration first, so
 * one jump is right nearly always and near enough the rest of the time; a
 * chooser can be built the day somebody misses it.
 */
export async function goToDefinition(view: EditorView, intel: CodeIntel): Promise<void> {
  if (!intel.served()) return;

  const { line, column } = positionOf(view.state, view.state.selection.main.head);
  const found = await intel.definition(line, column);

  /* Said out loud, unlike everything else here. A tooltip that does not appear
     was never promised; a key that was pressed on purpose and did nothing
     reads as an editor that is broken rather than as an answer. */
  const first = found[0];
  if (!first) {
    intel.report(intel.nothingFound);
    return;
  }

  intel.jump(first);
}

/* ── the whole of it, as one extension ───────────────────────────────── */

export function intelligence(intel: CodeIntel): Extension[] {
  return [
    hovers(intel),

    /*
     * Added to the language's own completions rather than replacing them.
     * `override` would take the list over entirely, and the CSS, HTML and JSON
     * modes carry good static completions that no language server improves on
     * — and that keep working on a machine where none is installed.
     */
    EditorState.languageData.of(() => [{ autocomplete: completions(intel) }]),
    autocompletion(),

    /*
     * **No keymap here, and that is not an omission.** The shell listens for
     * keys on the window with `capture: true`, so it sees every one of them
     * before CodeMirror does; a binding here for `F12` would be a binding that
     * never fires, which is the worst kind — it reads as working. `F12` is
     * routed through `edit.goToDefinition` instead, where every other shortcut
     * in the program lives. What is left below is the mouse, which the shell
     * does not listen for.
     */

    /*
     * **Ctrl+Click follows the name; Alt+Click makes another cursor.**
     *
     * CodeMirror's own default puts adding a selection range on Ctrl (Cmd on a
     * Mac), which is the same gesture every code editor uses for going to a
     * definition — so one of the two has to move, and moving multiple cursors
     * to Alt is what VS Code did for the same reason. Losing multiple cursors
     * altogether would be the wrong trade: it is a real editing feature, and it
     * is still here, one modifier over.
     */
    EditorView.clickAddsSelectionRange.of((event) => event.altKey),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        const following = IS_MAC ? event.metaKey : event.ctrlKey;
        if (!following || event.altKey || event.button !== 0 || !intel.served()) return false;

        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position === null) return false;

        /* The cursor is moved first, so the jump is about the word that was
           clicked rather than about wherever the cursor happened to be. */
        view.dispatch({ selection: { anchor: position } });
        void goToDefinition(view, intel);
        return true;
      },
    }),
  ];
}
