/**
 * The underline under a mistake, and the compiler's words beside it.
 *
 * A language server publishes when it has something to say — after it has
 * finished indexing, after a `cargo check` — so nothing here polls and nothing
 * awaits. What arrives is *everything* the server currently has to say about one
 * document, and it **replaces** what it said before: an empty list is how a
 * server says "fixed". Merging instead of replacing would leave every corrected
 * mistake underlined until the file was closed, which is the one bug in this
 * area that people notice immediately and never forgive.
 */

import { setDiagnostics, type Diagnostic as LintDiagnostic } from '@codemirror/lint';
import type { EditorView } from '@codemirror/view';

import type { CodeDiagnostic } from '@uleditor/plugin-sdk';

/**
 * A position from a server, as an offset into the document.
 *
 * Lines and columns arrive one-based and the columns are counted in UTF-16 code
 * units, which is exactly what an index into a JavaScript string is — so there
 * is no conversion to do, only clamping. And clamping is not paranoia: a server
 * answers about the text it was last told about, the person has kept typing,
 * and a position past the end of a shorter document would throw where an
 * underline in roughly the right place is what was wanted.
 */
function offsetOf(view: EditorView, line: number, column: number): number {
  const document = view.state.doc;
  const which = Math.min(Math.max(line, 1), document.lines);
  const at = document.line(which);
  return Math.min(at.from + Math.max(column - 1, 0), at.to);
}

/** Our severities are the protocol's; CodeMirror knows three of the four. */
function severityOf(diagnostic: CodeDiagnostic): LintDiagnostic['severity'] {
  switch (diagnostic.severity) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    default:
      /* A hint and an informational note both draw as `info`: CodeMirror has no
         fourth level, and inventing one would mean styling a thing nobody has
         asked to see differently. */
      return 'info';
  }
}

/**
 * Puts a server's diagnostics on the document, replacing whatever was there.
 *
 * The whole set every time, which is what `setDiagnostics` is for — and what
 * the protocol means.
 */
export function showDiagnostics(view: EditorView, diagnostics: CodeDiagnostic[]): void {
  const mapped: LintDiagnostic[] = diagnostics.map((diagnostic) => {
    const from = offsetOf(view, diagnostic.line, diagnostic.column);
    const to = offsetOf(view, diagnostic.endLine, diagnostic.endColumn);

    return {
      from,
      /* A zero-width range draws nothing at all, and a server pointing at a
         single position — a missing semicolon, an unclosed brace — is the
         commonest case there is. One character of underline is the least that
         can be seen. */
      to: to > from ? to : Math.min(from + 1, view.state.doc.length),
      severity: severityOf(diagnostic),
      message: diagnostic.code
        ? `${diagnostic.message}  [${diagnostic.code}]`
        : diagnostic.message,
      source: diagnostic.source ?? undefined,
    };
  });

  view.dispatch(setDiagnostics(view.state, mapped));
}

/** How the status bar says what a server has found. */
export function summarise(diagnostics: CodeDiagnostic[]): string | null {
  if (diagnostics.length === 0) return null;

  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length;

  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} ✕`);
  if (warnings > 0) parts.push(`${warnings} ⚠`);
  /* Notes and hints are counted but not spelled out: a person who wants to see
     them has the gutter, and a status bar that said "3 ✕ 2 ⚠ 47 ℹ" would be
     reporting the noise louder than the news. */
  if (parts.length === 0) return null;
  return parts.join('  ');
}
