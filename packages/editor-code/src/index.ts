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
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';

import {
  Emitter,
  plainPayload,
  type ClipboardPayload,
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
import { ulTheme } from './theme.js';

const CODE_EXTENSIONS = [
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'jsonc', 'rs', 'py', 'pyi', 'html', 'htm', 'css', 'scss', 'less',
  'toml', 'yaml', 'yml', 'xml', 'svg', 'sh', 'bash', 'zsh', 'ps1', 'sql',
  'go', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'rb', 'php',
  'swift', 'lua', 'vue', 'svelte',
  'txt', 'log', 'csv', 'tsv', 'ini', 'cfg', 'conf', 'env',
];

class CodeEditor implements EditorInstance {
  #view: EditorView | null = null;
  #extensions: Extension[];
  #initial: string;
  #savedText: string;
  #dirty = false;

  #dirtyEmitter = new Emitter<boolean>();
  #statusEmitter = new Emitter<string>();
  readonly onDirtyChange = this.#dirtyEmitter.event;
  readonly onStatusChange = this.#statusEmitter.event;

  constructor(
    private readonly host: EditorHost,
    private readonly doc: DocumentHandle,
    text: string,
    language: Extension | null,
  ) {
    this.#initial = text;
    this.#savedText = text;
    this.#extensions = language ? [language] : [];
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
        autocompletion(),
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
        EditorView.updateListener.of((update) => {
          if (update.docChanged) this.#recomputeDirty();
          if (update.docChanged || update.selectionSet) this.#emitStatus();
        }),
        ...this.#extensions,
      ],
    });

    this.#view = new EditorView({ state, parent: container });
    this.#emitStatus();
  }

  unmount(): void {
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
    this.#statusEmitter.fire(`${t('Line {line}, column {column}', { line: line.number, column })}${suffix}`);
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
    // Gornja granica: lista rezultata iznad ~500 pogodaka ionako nije upotrebljiva.
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
    // Tablica zalijepljena u kod ima smisla kao tab-razdvojeni tekst.
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

// Dijeli se s editor-markdown, da oba tekstualna editora izgledaju isto.
export { ulTheme } from './theme.js';
export { loadLanguage, hasLanguage } from './languages.js';

