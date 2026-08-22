/**
 * A CodeMirror theme built on CSS variables.
 *
 * Colours are not written literally but through `var(--…)`, so the editor
 * follows the application theme without a single listener — switching between
 * light and dark is pure CSS cascade, with no EditorState rebuilt.
 */

import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

const base = EditorView.theme({
  '&': {
    color: 'var(--ink)',
    backgroundColor: 'var(--ground)',
    height: '100%',
    fontSize: '13px',
  },
  '.cm-scroller': {
    fontFamily: 'var(--mono)',
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-content': {
    padding: '10px 0 60vh 0',
    caretColor: 'var(--cm-cursor)',
  },
  '.cm-line': {
    padding: '0 16px 0 8px',
  },

  '.cm-cursor, .cm-dropCursor': {
    borderLeft: '2px solid var(--cm-cursor)',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
    {
      background: 'var(--cm-selection)',
    },
  '.cm-activeLine': {
    backgroundColor: 'var(--cm-active-line)',
  },

  '.cm-gutters': {
    backgroundColor: 'var(--ground)',
    color: 'var(--cm-gutter)',
    border: 'none',
    borderRight: '1px solid var(--rule-soft)',
    fontFamily: 'var(--mono)',
    fontSize: '11px',
    userSelect: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 12px 0 16px',
    minWidth: '48px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--cm-gutter-active)',
  },
  '.cm-foldGutter .cm-gutterElement': {
    padding: '0 4px',
    color: 'var(--ink-ghost)',
  },

  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--cm-match)',
    outline: 'none',
  },
  '.cm-nonmatchingBracket': {
    color: 'var(--syn-invalid)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--cm-match)',
    borderRadius: '2px',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--accent-glow)',
    outline: '1px solid var(--accent)',
  },

  '.cm-tooltip': {
    backgroundColor: 'var(--surface-raised)',
    border: '1px solid var(--rule-strong)',
    borderRadius: '4px',
    boxShadow: 'var(--shadow-md)',
    color: 'var(--ink)',
    fontFamily: 'var(--sans)',
    fontSize: '12px',
  },
  '.cm-tooltip-autocomplete > ul > li': {
    fontFamily: 'var(--mono)',
    padding: '3px 8px',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent-wash)',
    color: 'var(--accent-ink)',
  },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
  { tag: [t.comment, t.blockComment, t.lineComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-function)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-type)' },
  { tag: [t.variableName, t.propertyName], color: 'var(--syn-variable)' },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: 'var(--syn-constant)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--syn-operator)' },
  /* Labels: `:install` in a batch file, and the `goto` that reaches it. They
     name a place in the script, which is what a function name does. */
  { tag: [t.labelName], color: 'var(--syn-function)' },
  { tag: [t.meta], color: 'var(--syn-comment)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--syn-tag)' },
  { tag: [t.attributeName], color: 'var(--syn-attribute)' },
  { tag: [t.invalid], color: 'var(--syn-invalid)', textDecoration: 'underline wavy' },

  { tag: t.heading, color: 'var(--syn-function)', fontWeight: '600' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--syn-type)', textDecoration: 'underline' },
  { tag: t.monospace, color: 'var(--syn-string)' },
]);

export const ulTheme: Extension = [base, syntaxHighlighting(highlight)];
