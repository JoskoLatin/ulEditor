/**
 * The code and plain text editor — CodeMirror 6.
 *
 * CodeMirror was chosen over Monaco because mobile is a declared target, and
 * Monaco effectively does not work on touch devices. See
 * docs/ANALYSIS-AND-PLAN.md.
 */

import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import {
  bracketMatching,
  codeFolding,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from '@codemirror/language';
import { lintGutter } from '@codemirror/lint';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';

import {
  Emitter,
  plainPayload,
  type ClipboardPayload,
  type CodeCompletion,
  type CodeHover,
  type CodeLocation,
  type DocumentHandle,
  type EditorHost,
  type EditorInstance,
  type EditorProvider,
  type FindQuery,
  type FindResult,
  type SaveResult,
  type SaveTarget,
} from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import { loadLanguage } from './languages.js';
import { showDiagnostics, summarise } from './diagnostics.js';
import { goToDefinition, intelligence, type CodeIntel } from './intel.js';
import { ulTheme } from './theme.js';

const CODE_EXTENSIONS = [
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'jsonc', 'rs', 'py', 'pyi', 'html', 'htm', 'css', 'scss', 'less',
  'toml', 'yaml', 'yml', 'xml', 'svg', 'sh', 'bash', 'zsh', 'ps1', 'sql',
  'go', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'rb', 'php',
  'swift', 'lua', 'vue', 'svelte',
  'txt', 'log', 'csv', 'tsv', 'ini', 'cfg', 'conf', 'env',
];

class CodeEditor implements EditorInstance, CodeIntel {
  #view: EditorView | null = null;
  #extensions: Extension[];
  #initial: string;
  #savedText: string;
  #dirty = false;

  #dirtyEmitter = new Emitter<boolean>();
  #statusEmitter = new Emitter<string>();
  readonly onDirtyChange = this.#dirtyEmitter.event;
  readonly onStatusChange = this.#statusEmitter.event;

  /* ── the language server, where there is one ─────────────────────────
   *
   * All of this is idle on a machine with no server installed, which is the
   * ordinary case rather than a failure: `open` answers whether anything is
   * listening, and if nothing is, nothing else here ever runs.
   */
  /** The language as the detector named it — `rust`, `typescript`. */
  #languageId: string | null;
  #served = false;
  #version = 1;
  #diagnosticsSub: { dispose: () => void } | null = null;
  #changeTimer: ReturnType<typeof setTimeout> | null = null;
  #lastSummary: string | null = null;

  constructor(
    private readonly host: EditorHost,
    private readonly doc: DocumentHandle,
    text: string,
    language: Extension | null,
  ) {
    this.#initial = text;
    this.#savedText = text;
    this.#extensions = language ? [language] : [];
    this.#languageId = doc.detection.language ?? null;
  }

  mount(container: HTMLElement): void {
    const state = EditorState.create({
      doc: this.#initial,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        codeFolding(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        indentUnit.of('  '),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        EditorView.lineWrapping,
        ulTheme,
        /* The marks in the margin. Empty until a server says otherwise, and on
           a machine without one it stays empty and costs nothing. */
        lintGutter(),
        /*
         * The tooltip, the completion list and `F12`, all of which ask this
         * instance and get nothing until a server has taken the document.
         *
         * Mounted unconditionally, which is the point: whether anything is
         * listening is only known one round trip after the editor is on the
         * screen, and an editor that reconfigured itself when the answer came
         * back would be rebuilding the state under somebody who has already
         * started typing. Idle extensions cost nothing; a state swap costs the
         * undo history.
         */
        ...intelligence(this),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            this.#recomputeDirty();
            this.#tellTheServer();
          }
          if (update.docChanged || update.selectionSet) this.#emitStatus();
        }),
        ...this.#extensions,
      ],
    });

    this.#view = new EditorView({ state, parent: container });
    this.#emitStatus();
    void this.#startServer();
  }

  /* ── the language server ───────────────────────────────────────────── */

  /**
   * Offers the document to a server, and listens if one took it.
   *
   * Nothing is reported when nothing is listening. A person who has not
   * installed rust-analyzer has not asked for it, and an editor that announced
   * "no language server found" every time a file was opened would be telling
   * them off for a choice they made.
   */
  async #startServer(): Promise<void> {
    const language = this.#languageId;
    if (!language) return;

    try {
      this.#served = await this.host.language.open(this.doc.uri, language, this.#text());
    } catch {
      /* A server that would not start has already said why on its own output;
         the editor's part is to keep colouring the code. */
      this.#served = false;
    }
    if (!this.#served) return;

    this.#diagnosticsSub = this.host.language.onDiagnostics((published) => {
      if (!this.#isThisDocument(published.uri)) return;

      /* An answer about text that has since changed is not an answer about this
         text. Servers that name a version get held to it; a compiler run names
         none, because it read the file from disk, and those are shown — they
         are the ones worth waiting for. */
      if (
        published.version !== undefined &&
        published.version !== null &&
        published.version < this.#version
      ) {
        return;
      }

      const view = this.#view;
      if (!view) return;

      showDiagnostics(view, published.diagnostics);
      this.#lastSummary = summarise(published.diagnostics);
      this.#emitStatus();
    });
  }

  /* ── what the tooltip, the list and `F12` ask ─────────────────────── */

  served(): boolean {
    return this.#served && this.#languageId !== null;
  }

  async hover(line: number, column: number): Promise<CodeHover | null> {
    if (!this.#languageId) return null;
    return this.host.language.hover(this.doc.uri, this.#languageId, line, column);
  }

  async definition(line: number, column: number): Promise<CodeLocation[]> {
    if (!this.#languageId) return [];
    return this.host.language.definition(this.doc.uri, this.#languageId, line, column);
  }

  async completions(line: number, column: number): Promise<CodeCompletion[]> {
    if (!this.#languageId) return [];
    return this.host.language.completions(this.doc.uri, this.#languageId, line, column);
  }

  /**
   * A definition somewhere else — handed to the shell, which owns tabs.
   *
   * The editor knows nothing about how a file is opened, and it stays that way:
   * this is the same seam OCR uses to put text in the panel below. A command
   * id and a payload, and the editor does not learn what a tab is.
   */
  jump(location: CodeLocation): void {
    void this.host.commands.execute('editor.goToLocation', location);
  }

  report(message: string): void {
    this.host.notify.show('info', message);
  }

  readonly nothingFound = t('No definition found.');

  /**
   * The same thing `F12` does, for the menu and the palette.
   *
   * A shortcut is not a place: somebody who has never used one has no way to
   * find out that this exists, and the menu is where they would look.
   */
  goToDefinition(): void {
    if (this.#view) void goToDefinition(this.#view, this);
  }

  /**
   * Puts the cursor somewhere and shows it — what a jump arrives at.
   *
   * Scrolled to the middle rather than to the top edge: a definition on the
   * first visible line has its context above it off the screen, and the
   * context is half of why anybody went there.
   */
  revealPosition(line: number, column: number): void {
    const view = this.#view;
    if (!view) return;

    const which = Math.min(Math.max(line, 1), view.state.doc.lines);
    const at = view.state.doc.line(which);
    const offset = Math.min(at.from + Math.max(column - 1, 0), at.to);

    view.dispatch({
      selection: { anchor: offset },
      effects: EditorView.scrollIntoView(offset, { y: 'center' }),
    });
    view.focus();
  }

  /**
   * Whether a publication is about this document.
   *
   * Compared case-insensitively with the separators normalised: a server
   * answers about `c:/dev/x.rs` for a file this editor calls `C:\dev\x.rs`,
   * and the Rust side has already turned the URL into a path — what is left is
   * the drive letter, which Windows does not care about and a string comparison
   * does.
   */
  #isThisDocument(uri: string): boolean {
    const normalise = (text: string) => text.toLowerCase().replace(/\\/g, '/');
    return normalise(uri) === normalise(this.doc.uri);
  }

  /**
   * Tells the server what the document says now, once the typing stops.
   *
   * Two hundred milliseconds, and the debounce is the whole point: a
   * notification per keystroke is a re-analysis per keystroke, and the answers
   * would be about text three characters old by the time they arrived. The
   * version number goes up regardless, because a server tracks it and a gap is
   * fine while going backwards is not.
   */
  #tellTheServer(): void {
    if (!this.#served || !this.#languageId) return;

    if (this.#changeTimer !== null) clearTimeout(this.#changeTimer);
    this.#changeTimer = setTimeout(() => {
      this.#changeTimer = null;
      const language = this.#languageId;
      if (!language) return;
      void this.host.language
        .change(this.doc.uri, language, ++this.#version, this.#text())
        .catch(() => {
          /* The server has gone. The underlines stop updating, which is the
             honest consequence, and the next save will find out for certain. */
        });
    }, 200);
  }

  unmount(): void {
    if (this.#changeTimer !== null) clearTimeout(this.#changeTimer);
    this.#changeTimer = null;
    this.#diagnosticsSub?.dispose();
    this.#diagnosticsSub = null;

    /* The server is told the document is closed, so it can stop analysing it
       and forget its diagnostics. Not awaited: the tab is going now, and a
       notification down a pipe needs nobody to wait for it. */
    if (this.#served && this.#languageId) {
      void this.host.language.close(this.doc.uri, this.#languageId).catch(() => {});
    }
    this.#served = false;

    this.#view?.destroy();
    this.#view = null;
  }

  #text(): string {
    return this.#view?.state.doc.toString() ?? this.#initial;
  }

  #recomputeDirty(): void {
    // A comparison against the saved content, not a count of edits — undo back
    // to the original state must clear the dirty flag.
    const dirty = this.#text() !== this.#savedText;
    if (dirty === this.#dirty) return;
    this.#dirty = dirty;
    this.#dirtyEmitter.fire(dirty);
  }

  #emitStatus(): void {
    const view = this.#view;
    if (!view) return;
    const { state } = view;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const column = head - line.from + 1;
    const selected = state.selection.ranges.reduce((sum, r) => sum + (r.to - r.from), 0);
    const suffix = selected > 0 ? `  ·  ${t('{n} selected', { n: selected })}` : '';
    /* What the server found, after the position rather than instead of it: the
       cursor is why anybody looks at this line, and a count of errors is what
       they look for second. Absent entirely when there is nothing to say, which
       includes every machine without a server installed. */
    const found = this.#lastSummary ? `  ·  ${this.#lastSummary}` : '';
    this.#statusEmitter.fire(
      `${t('Line {line}, column {column}', { line: line.number, column })}${suffix}${found}`,
    );
  }

  isDirty(): boolean {
    return this.#dirty;
  }

  async save(target?: SaveTarget): Promise<SaveResult> {
    const uri = target?.uri ?? this.doc.uri;
    const text = this.#text();
    await this.host.fs.writeText(uri, text);
    this.#savedText = text;
    this.#recomputeDirty();

    /*
     * And the server is told, because for some languages this is the moment the
     * real diagnostics arrive: rust-analyzer runs `cargo check` on a save and
     * publishes what the compiler says — the type errors and borrow errors its
     * own parser never reports. An editor that never mentioned a save would
     * show syntax errors and nothing else, which looks exactly like a compiler
     * with nothing to complain about.
     *
     * Sent after the write and not awaited: the file is already on disk, which
     * is what the server will read.
     */
    if (this.#served && this.#languageId) {
      void this.host.language.save(uri, this.#languageId).catch(() => {});
    }

    // Plain text has nothing to lose — the round trip is always complete.
    return { uri, lostFidelity: [] };
  }

  undo(): void {
    if (this.#view) undo(this.#view);
  }

  redo(): void {
    if (this.#view) redo(this.#view);
  }

  canUndo(): boolean {
    return this.#dirty;
  }

  canRedo(): boolean {
    return true;
  }

  async find(query: FindQuery): Promise<FindResult[]> {
    const view = this.#view;
    if (!view || !query.query) return [];

    const text = view.state.doc.toString();
    const needle = query.caseSensitive ? query.query : query.query.toLowerCase();
    const haystack = query.caseSensitive ? text : text.toLowerCase();

    const results: FindResult[] = [];
    let from = 0;
    // An upper bound: a result list beyond ~500 hits is unusable anyway.
    while (results.length < 500) {
      const index = haystack.indexOf(needle, from);
      if (index === -1) break;
      const to = index + query.query.length;
      const line = view.state.doc.lineAt(index);
      results.push({
        label: t('Line {n}', { n: line.number }),
        preview: line.text.trim().slice(0, 120),
        reveal: () => {
          view.dispatch({
            selection: { anchor: index, head: to },
            effects: EditorView.scrollIntoView(index, { y: 'center' }),
          });
          view.focus();
        },
      });
      from = to;
    }
    return results;
  }

  async copySelection(): Promise<ClipboardPayload | null> {
    const view = this.#view;
    if (!view) return null;
    const { from, to } = view.state.selection.main;
    if (from === to) return null;
    return plainPayload(view.state.sliceDoc(from, to), {
      editorId: 'org.uleditor.code',
      uri: this.doc.uri,
    });
  }

  async paste(payload: ClipboardPayload): Promise<boolean> {
    const view = this.#view;
    if (!view) return false;
    // A spreadsheet pasted into code makes sense as tab-separated text.
    const text = payload['text/plain'];
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
    return true;
  }

  async plainText(): Promise<string> {
    return this.#text();
  }

  focus(): void {
    this.#view?.focus();
  }
}

export const codeEditorProvider: EditorProvider = {
  id: 'org.uleditor.code',
  displayName: 'Code editor',
  matches: {
    // Alongside extensions it accepts format identifiers too, so a file with no
    // extension that was detected as text still ends up here.
    extensions: [...CODE_EXTENSIONS, 'code', 'text'],
  },
  capabilities: ['view', 'edit', 'search'],
  priority: 20,

  async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    const text = await doc.text();
    const language = await loadLanguage(doc.detection.language);
    return new CodeEditor(host, doc, text, language);
  },
};

export default codeEditorProvider;

// Shared with editor-markdown, so both text editors look the same.
export { ulTheme } from './theme.js';
export { loadLanguage, hasLanguage } from './languages.js';

