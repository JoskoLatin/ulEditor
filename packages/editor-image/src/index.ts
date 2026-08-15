/**
 * Preglednik slika.
 *
 * Za sada samo pregled — kadriranje, rotacija i konverzija dolaze preko
 * `image-rs` u Rust jezgri, da isti kod radi na sve tri platforme i da se
 * veliki JPEG-ovi ne dekodiraju u JS heapu.
 */

import {
  Emitter,
  plainPayload,
  type ClipboardPayload,
  type DocumentHandle,
  type EditorHost,
  type EditorInstance,
  type EditorProvider,
  type FindResult,
  type SaveResult,
} from '@uleditor/plugin-sdk';

const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.67, 1, 1.5, 2, 3, 4, 8, 16];
const MARGIN = 48;

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

function mimeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

function humanBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} kB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

class ImageEditor implements EditorInstance {
  #root: HTMLElement | null = null;
  #frame: HTMLElement | null = null;
  #img: HTMLImageElement | null = null;
  #stage: HTMLElement | null = null;
  #zoomLabel: HTMLElement | null = null;
  #objectUrl: string | null = null;
  #resize: ResizeObserver | null = null;

  #scale = 1;
  #fit = true;
  #natural = { width: 0, height: 0 };

  #statusEmitter = new Emitter<string>();
  #dirtyEmitter = new Emitter<boolean>();
  readonly onStatusChange = this.#statusEmitter.event;
  readonly onDirtyChange = this.#dirtyEmitter.event;

  constructor(
    private readonly doc: DocumentHandle,
    private readonly bytes: Uint8Array,
  ) {}

  async mount(container: HTMLElement): Promise<void> {
    const root = document.createElement('div');
    root.className = 'ul-img';

    const stage = document.createElement('div');
    stage.className = 'ul-img-stage';

    const frame = document.createElement('div');
    frame.className = 'ul-img-frame';

    const img = document.createElement('img');
    img.alt = this.doc.name;

    // Kopija u svjež buffer — Blob ne prihvaća pogled na dijeljeni spremnik.
    const blob = new Blob([new Uint8Array(this.bytes).buffer as ArrayBuffer], {
      type: mimeFor(this.doc.name),
    });
    this.#objectUrl = URL.createObjectURL(blob);

    frame.appendChild(img);
    stage.appendChild(frame);
    root.append(this.#buildToolbar(), stage);
    container.appendChild(root);

    this.#root = root;
    this.#stage = stage;
    this.#frame = frame;
    this.#img = img;

    const loaded = new Promise<boolean>((resolve) => {
      img.addEventListener('load', () => resolve(true), { once: true });
      img.addEventListener('error', () => resolve(false), { once: true });
    });
    img.src = this.#objectUrl;

    if (!(await loaded)) {
      stage.replaceChildren();
      const error = document.createElement('div');
      error.className = 'ul-img-error';
      error.textContent = `Slika ${this.doc.name} se ne može prikazati.\nFormat možda nije podržan u ovom pregledniku.`;
      error.style.whiteSpace = 'pre-line';
      stage.appendChild(error);
      this.#statusEmitter.fire('Neuspješno učitavanje');
      return;
    }

    this.#natural = { width: img.naturalWidth, height: img.naturalHeight };

    this.#resize = new ResizeObserver(() => {
      if (this.#fit) this.#applyZoom();
    });
    this.#resize.observe(stage);

    stage.addEventListener('wheel', this.#onWheel, { passive: false });
    this.#applyZoom();
  }

  #buildToolbar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'ul-img-toolbar';

    const button = (label: string, title: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.className = 'ul-img-btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', onClick);
      return b;
    };

    const zoomOut = button('−', 'Smanji (Ctrl + kotačić)', () => this.zoomBy(-1));
    const zoomIn = button('+', 'Povećaj (Ctrl + kotačić)', () => this.zoomBy(1));

    const label = document.createElement('span');
    label.style.minWidth = '48px';
    label.style.textAlign = 'center';
    this.#zoomLabel = label;

    const fit = button('Prilagodi', 'Prilagodi prozoru', () => this.setFit(true));
    const actual = button('1:1', 'Stvarna veličina', () => {
      this.#fit = false;
      this.#scale = 1;
      this.#applyZoom();
    });

    const sep = document.createElement('span');
    sep.className = 'sep';
    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    const info = document.createElement('span');
    info.textContent = humanBytes(this.doc.stat.size);

    bar.append(zoomOut, label, zoomIn, sep, fit, actual, spacer, info);

    this.#syncButtons = () => {
      fit.dataset.active = String(this.#fit);
      if (this.#zoomLabel) this.#zoomLabel.textContent = `${Math.round(this.#scale * 100)}%`;
    };
    return bar;
  }

  #syncButtons: () => void = () => {};

  setFit(fit: boolean): void {
    this.#fit = fit;
    this.#applyZoom();
  }

  zoomBy(direction: number): void {
    const index = ZOOM_STEPS.findIndex((s) => s >= this.#scale - 0.001);
    const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction));
    this.#fit = false;
    this.#scale = ZOOM_STEPS[next] ?? 1;
    this.#applyZoom();
  }

  #onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    this.zoomBy(event.deltaY < 0 ? 1 : -1);
  };

  #applyZoom(): void {
    const { width, height } = this.#natural;
    if (!this.#img || !this.#frame || !this.#stage || width === 0) return;

    if (this.#fit) {
      // Slika manja od prozora ne uvećava se — inače mala ikona ispuni ekran.
      this.#scale = Math.min(
        1,
        (this.#stage.clientWidth - MARGIN) / width,
        (this.#stage.clientHeight - MARGIN) / height,
      );
    }

    const w = Math.max(1, Math.round(width * this.#scale));
    const h = Math.max(1, Math.round(height * this.#scale));
    this.#img.style.width = `${w}px`;
    this.#img.style.height = `${h}px`;
    // Interpolacija samo pri smanjenju; uvećano mora pokazati piksele.
    this.#frame.dataset.smooth = String(this.#scale <= 1);

    this.#syncButtons();
    this.#statusEmitter.fire(
      `${width} × ${height} px  ·  ${Math.round(this.#scale * 100)}%  ·  ${humanBytes(this.doc.stat.size)}`,
    );
  }

  unmount(): void {
    this.#resize?.disconnect();
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
    throw new Error('Uređivanje slika (kadriranje, rotacija) stiže preko image-rs u fazi 1.');
  }

  undo(): void {}
  redo(): void {}
  canUndo(): boolean {
    return false;
  }
  canRedo(): boolean {
    return false;
  }

  async find(): Promise<FindResult[]> {
    return [];
  }

  async copySelection(): Promise<ClipboardPayload | null> {
    return {
      ...plainPayload(this.doc.name, { editorId: 'org.uleditor.image', uri: this.doc.uri }),
      'image/png': this.bytes,
    };
  }

  async paste(): Promise<boolean> {
    return false;
  }

  focus(): void {
    this.#stage?.focus();
  }
}

export const imageEditorProvider: EditorProvider = {
  id: 'org.uleditor.image',
  displayName: 'Preglednik slika',
  matches: {
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'image'],
    mimeTypes: Object.values(MIME),
  },
  capabilities: ['view'],
  priority: 30,

  async createInstance(_host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    return new ImageEditor(doc, await doc.bytes());
  },
};

export default imageEditorProvider;
