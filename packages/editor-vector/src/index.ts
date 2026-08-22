/**
 * The vector graphics viewer.
 *
 * Viewing only, which is the honest scope: editing vectors means a whole
 * application — paths, nodes, boolean operations, a colour model — and that is
 * not what this program is. Opening the file, seeing it at any size, and reading
 * the markup behind it is what people actually want from an editor that is not
 * Illustrator.
 *
 * **The picture is drawn in an `<img>`, and that is the entire security story.**
 * An SVG loaded as an image cannot run script, cannot fetch anything from the
 * network and cannot reach the page around it — the browser enforces that, so
 * there is nothing here to get wrong. The obvious alternative, dropping the
 * markup into the DOM, would need sanitising against scripts, and even sanitised
 * it leaks: a `<style>` element inside an SVG is not scoped to the SVG, so a
 * rule like `path { fill: red }` in a stranger's file would repaint the icons in
 * the toolbars.
 *
 * What we do not open, and why:
 *
 * - **`.ai`** files usually open already and never reach this editor. Since
 *   Illustrator 9 the default save writes a complete PDF inside the file, and
 *   detection reads the `%PDF` signature before it looks at the name, so an
 *   Illustrator file goes to the PDF viewer on its own. Only one saved with PDF
 *   compatibility switched off arrives here, and that is PostScript.
 * - **`.eps`, `.ps`** are PostScript: a programming language, not a drawing.
 *   Rendering them means an interpreter — Ghostscript, or LibreOffice.
 * - **`.cdr`** is CorelDRAW's own format, and the only thing that reads it is
 *   libcdr, inside LibreOffice.
 *
 * All three therefore wait for `ul-convert` in phase 2, which brings LibreOffice
 * headless for its own reasons. Until then they say so, rather than opening
 * blank.
 */

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
} from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';
import { gunzipSync } from 'fflate';

const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.67, 1, 1.5, 2, 3, 4, 8, 16, 32];
const MARGIN = 48;

/** Formats that are drawn, as opposed to the ones that only get an explanation. */
const DRAWABLE = new Set(['svg', 'svgz']);

/** What a file needs before LibreOffice arrives, keyed by extension. */
const NEEDS_CONVERSION: Record<string, string> = {
  ai: 'This Illustrator file was saved without PDF compatibility, so it is PostScript inside. Reading it needs the LibreOffice conversion that arrives in phase 2.',
  eps: 'EPS and PostScript are a programming language rather than a drawing, so showing one means running an interpreter. That arrives with the LibreOffice conversion in phase 2.',
  ps: 'EPS and PostScript are a programming language rather than a drawing, so showing one means running an interpreter. That arrives with the LibreOffice conversion in phase 2.',
  cdr: 'CorelDRAW files are read by libcdr, which comes with the LibreOffice conversion in phase 2. Nothing outside it can open the format.',
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function humanBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} kB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** `.svgz` is gzipped SVG and nothing else — the same markup, one layer down. */
function unpack(bytes: Uint8Array, extension: string): Uint8Array {
  const gzipped = extension === 'svgz' || (bytes[0] === 0x1f && bytes[1] === 0x8b);
  return gzipped ? gunzipSync(bytes) : bytes;
}

class VectorViewer implements EditorInstance {
  #root: HTMLElement | null = null;
  #stage: HTMLElement | null = null;
  #frame: HTMLElement | null = null;
  #img: HTMLImageElement | null = null;
  #source: HTMLElement | null = null;
  #zoomLabel: HTMLElement | null = null;
  #objectUrl: string | null = null;
  #resize: ResizeObserver | null = null;

  #scale = 1;
  #fit = true;
  #showSource = false;
  #natural = { width: 0, height: 0 };
  #markup = '';

  #statusEmitter = new Emitter<string>();
  #dirtyEmitter = new Emitter<boolean>();
  readonly onStatusChange = this.#statusEmitter.event;
  readonly onDirtyChange = this.#dirtyEmitter.event;

  constructor(
    private readonly doc: DocumentHandle,
    private readonly bytes: Uint8Array,
  ) {}

  async mount(container: HTMLElement): Promise<void> {
    const extension = extensionOf(this.doc.name);
    const root = document.createElement('div');
    root.className = 'ul-vec';
    this.#root = root;
    container.appendChild(root);

    if (!DRAWABLE.has(extension)) {
      root.appendChild(this.#explain(extension));
      this.#statusEmitter.fire(t('Not supported yet'));
      return;
    }

    const stage = document.createElement('div');
    stage.className = 'ul-vec-stage';

    const frame = document.createElement('div');
    frame.className = 'ul-vec-frame';

    const img = document.createElement('img');
    img.alt = this.doc.name;

    const source = document.createElement('pre');
    source.className = 'ul-vec-source';
    source.hidden = true;

    frame.appendChild(img);
    stage.append(frame, source);
    root.append(this.#buildToolbar(), stage);

    this.#stage = stage;
    this.#frame = frame;
    this.#img = img;
    this.#source = source;

    let markup: Uint8Array;
    try {
      markup = unpack(this.bytes, extension);
    } catch {
      this.#fail(stage, t('{name} is not a valid compressed SVG.', { name: this.doc.name }));
      return;
    }

    this.#markup = new TextDecoder().decode(markup);
    source.textContent = this.#markup;

    // A copy into a fresh buffer — Blob does not accept a view onto shared memory.
    const blob = new Blob([new Uint8Array(markup).buffer as ArrayBuffer], {
      type: 'image/svg+xml',
    });
    this.#objectUrl = URL.createObjectURL(blob);

    const loaded = new Promise<boolean>((resolve) => {
      img.addEventListener('load', () => resolve(true), { once: true });
      img.addEventListener('error', () => resolve(false), { once: true });
    });
    img.src = this.#objectUrl;

    if (!(await loaded)) {
      this.#fail(stage, t('{name} could not be drawn — the SVG is damaged.', { name: this.doc.name }));
      return;
    }

    /*
     * An SVG without width and height on the root, or with only a viewBox, has
     * no intrinsic size — the browser reports 0 or its own default of 300×150.
     * The drawing is still valid; it simply has no opinion about how big it is,
     * so we give it one and say so in the status bar.
     */
    this.#natural = { width: img.naturalWidth || 0, height: img.naturalHeight || 0 };
    const sized = this.#natural.width > 0 && this.#natural.height > 0;
    if (!sized) this.#natural = { width: 512, height: 512 };

    this.#resize = new ResizeObserver(() => {
      if (this.#fit) this.#applyZoom();
    });
    this.#resize.observe(stage);
    stage.addEventListener('wheel', this.#onWheel, { passive: false });

    this.#applyZoom();
    this.#statusEmitter.fire(
      sized
        ? t('{width} × {height}', { width: this.#natural.width, height: this.#natural.height })
        : t('Scalable — the drawing states no size of its own'),
    );
  }

  #explain(extension: string): HTMLElement {
    const box = document.createElement('div');
    box.className = 'ul-vec-error';
    const title = document.createElement('strong');
    title.textContent = t('{name} cannot be shown yet', { name: this.doc.name });
    const body = document.createElement('p');
    body.textContent = t(
      NEEDS_CONVERSION[extension] ?? 'No viewer is registered for this vector format yet.',
    );
    box.append(title, body);
    return box;
  }

  #fail(stage: HTMLElement, message: string): void {
    stage.replaceChildren();
    const error = document.createElement('div');
    error.className = 'ul-vec-error';
    error.textContent = message;
    stage.appendChild(error);
    this.#statusEmitter.fire(t('Could not be drawn'));
  }

  #buildToolbar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'ul-vec-toolbar';

    const button = (label: string, title: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.className = 'ul-vec-btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', onClick);
      return b;
    };

    const zoomOut = button('−', t('Zoom out (Ctrl + wheel)'), () => this.zoomBy(-1));
    const zoomIn = button('+', t('Zoom in (Ctrl + wheel)'), () => this.zoomBy(1));

    const label = document.createElement('span');
    label.className = 'zoom';
    this.#zoomLabel = label;

    const fit = button(t('Fit'), t('Fit to window'), () => this.setFit(true));
    const actual = button('1:1', t('Actual size'), () => {
      this.#fit = false;
      this.#scale = 1;
      this.#applyZoom();
    });

    /*
     * An SVG is a text file, and often the reason for opening one is to see what
     * is inside it. Showing the markup here rather than sending the file to the
     * code editor keeps both views one button apart — the picture and what draws
     * it, without reopening anything.
     */
    const source = button(t('Source'), t('Show the markup behind the drawing'), () => {
      this.#showSource = !this.#showSource;
      this.#syncViews();
    });

    const sep = document.createElement('span');
    sep.className = 'sep';
    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    const info = document.createElement('span');
    info.className = 'readout';
    info.textContent = humanBytes(this.doc.stat.size);

    bar.append(zoomOut, label, zoomIn, sep, fit, actual, source, spacer, info);

    this.#syncButtons = () => {
      fit.dataset.active = String(this.#fit && !this.#showSource);
      source.dataset.active = String(this.#showSource);
      zoomOut.disabled = this.#showSource;
      zoomIn.disabled = this.#showSource;
      fit.disabled = this.#showSource;
      actual.disabled = this.#showSource;
      if (this.#zoomLabel) this.#zoomLabel.textContent = `${Math.round(this.#scale * 100)}%`;
    };
    this.#syncButtons();
    return bar;
  }

  #syncButtons: () => void = () => {};

  #syncViews(): void {
    if (this.#frame) this.#frame.hidden = this.#showSource;
    if (this.#source) this.#source.hidden = !this.#showSource;
    this.#syncButtons();
  }

  setFit(fit: boolean): void {
    this.#fit = fit;
    this.#applyZoom();
  }

  zoomBy(direction: number): void {
    this.#fit = false;
    const index = ZOOM_STEPS.findIndex((step) => step >= this.#scale - 0.001);
    const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction))];
    this.#scale = next ?? this.#scale;
    this.#applyZoom();
  }

  #onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    this.zoomBy(event.deltaY < 0 ? 1 : -1);
  };

  #applyZoom(): void {
    const stage = this.#stage;
    const frame = this.#frame;
    if (!stage || !frame) return;

    if (this.#fit) {
      const available = {
        width: Math.max(1, stage.clientWidth - MARGIN),
        height: Math.max(1, stage.clientHeight - MARGIN),
      };
      /*
       * Never above 1 when fitting. A vector would happily fill a wall, but a
       * 16-pixel icon blown up to the width of the window is not what "fit"
       * means to anybody — it is what a mistake looks like.
       */
      this.#scale = Math.min(
        1,
        available.width / this.#natural.width,
        available.height / this.#natural.height,
      );
    }

    frame.style.width = `${Math.round(this.#natural.width * this.#scale)}px`;
    frame.style.height = `${Math.round(this.#natural.height * this.#scale)}px`;
    this.#syncButtons();
  }

  unmount(): void {
    this.#resize?.disconnect();
    this.#resize = null;
    this.#stage?.removeEventListener('wheel', this.#onWheel);
    if (this.#objectUrl) URL.revokeObjectURL(this.#objectUrl);
    this.#objectUrl = null;
    this.#root?.remove();
    this.#root = null;
  }

  isDirty(): boolean {
    return false;
  }

  async save(): Promise<SaveResult> {
    throw new Error(t('Vector graphics open read-only — ulEditor does not edit them.'));
  }

  undo(): void {}
  redo(): void {}
  canUndo(): boolean {
    return false;
  }
  canRedo(): boolean {
    return false;
  }

  /**
   * Searching the markup, which is the only text an SVG has. Hits are reported
   * without a `reveal` that scrolls the picture: the match is in the source, and
   * pretending to point at a place in the drawing would be a lie about what was
   * found.
   */
  async find({ query, caseSensitive }: FindQuery): Promise<FindResult[]> {
    if (!query || !this.#markup) return [];
    const haystack = caseSensitive ? this.#markup : this.#markup.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();

    const results: FindResult[] = [];
    let from = 0;
    while (results.length < 200) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      const lineStart = this.#markup.lastIndexOf('\n', at) + 1;
      const lineEnd = this.#markup.indexOf('\n', at);
      results.push({
        label: t('Line {n}', { n: this.#markup.slice(0, at).split('\n').length }),
        preview: this.#markup.slice(lineStart, lineEnd === -1 ? at + 80 : lineEnd).trim().slice(0, 120),
        reveal: () => {
          this.#showSource = true;
          this.#syncViews();
        },
      });
      from = at + needle.length;
    }
    return results;
  }

  /*
   * The markup, as text. `ClipboardPayload` has no vector slot and inventing one
   * here would be a private extension nothing else reads — the SVG source is
   * what every drawing program accepts on paste anyway.
   */
  async copySelection(): Promise<ClipboardPayload | null> {
    return plainPayload(this.#markup || this.doc.name, {
      editorId: 'org.uleditor.vector',
      uri: this.doc.uri,
    });
  }

  async paste(): Promise<boolean> {
    return false;
  }

  async plainText(): Promise<string | null> {
    return this.#markup || null;
  }

  focus(): void {
    this.#stage?.focus();
  }
}

export const vectorEditorProvider: EditorProvider = {
  id: 'org.uleditor.vector',
  displayName: 'Vector graphics viewer',
  matches: {
    extensions: ['svg', 'svgz', 'ai', 'eps', 'ps', 'cdr', 'vector'],
    mimeTypes: ['image/svg+xml', 'application/postscript'],
  },
  capabilities: ['view', 'search'],
  priority: 30,

  async createInstance(_host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    return new VectorViewer(doc, await doc.bytes());
  },
};

export default vectorEditorProvider;
