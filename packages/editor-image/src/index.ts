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
import { t } from '@uleditor/i18n';

import { OCR_LANGUAGES, disposeOcr, recogniseImage, type OcrLanguage } from './ocr.js';

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

  #ocrButton: HTMLButtonElement | null = null;
  #ocrLanguage: OcrLanguage;
  #ocrBusy = false;

  #statusEmitter = new Emitter<string>();
  #dirtyEmitter = new Emitter<boolean>();
  readonly onStatusChange = this.#statusEmitter.event;
  readonly onDirtyChange = this.#dirtyEmitter.event;

  constructor(
    private readonly host: EditorHost,
    private readonly doc: DocumentHandle,
    private readonly bytes: Uint8Array,
  ) {
    this.#ocrLanguage = host.settings.get<OcrLanguage>('ocr.language', 'hrv');
  }

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
      error.textContent = t('{name} cannot be displayed. This browser may not support the format.', {
        name: this.doc.name,
      });
      error.style.whiteSpace = 'pre-line';
      stage.appendChild(error);
      this.#statusEmitter.fire(t('Could not load the image'));
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

    const zoomOut = button('−', t('Zoom out (Ctrl + wheel)'), () => this.zoomBy(-1));
    const zoomIn = button('+', t('Zoom in (Ctrl + wheel)'), () => this.zoomBy(1));

    const label = document.createElement('span');
    label.style.minWidth = '48px';
    label.style.textAlign = 'center';
    this.#zoomLabel = label;

    const fit = button(t('Fit'), t('Fit to window'), () => this.setFit(true));
    const actual = button('1:1', t('Actual size'), () => {
      this.#fit = false;
      this.#scale = 1;
      this.#applyZoom();
    });

    const sep = () => {
      const element = document.createElement('span');
      element.className = 'sep';
      return element;
    };
    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    const info = document.createElement('span');
    info.textContent = humanBytes(this.doc.stat.size);

    /* Prepoznavanje teksta: jezik pa gumb. Jezik stoji uz gumb jer se bira
       prije pokretanja, a ne u postavkama — ista slika zna imati oba jezika. */
    const language = document.createElement('select');
    language.className = 'ul-img-select';
    language.title = t('Recognition language');
    for (const entry of OCR_LANGUAGES) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = t(entry.label);
      option.selected = entry.id === this.#ocrLanguage;
      language.appendChild(option);
    }
    language.addEventListener('change', () => {
      this.#ocrLanguage = language.value as OcrLanguage;
      this.host.settings.set('ocr.language', this.#ocrLanguage);
    });

    const ocr = button('OCR', t('Recognises text in the image and opens it in an editor below'), () =>
      void this.readText(),
    );
    ocr.classList.add('ul-img-ocr');
    this.#ocrButton = ocr;

    bar.append(zoomOut, label, zoomIn, sep(), fit, actual, spacer, language, ocr, sep(), info);

    this.#syncButtons = () => {
      fit.dataset.active = String(this.#fit);
      ocr.disabled = this.#ocrBusy;
      if (this.#zoomLabel) this.#zoomLabel.textContent = `${Math.round(this.#scale * 100)}%`;
    };
    return bar;
  }

  #syncButtons: () => void = () => {};

  /* ── prepoznavanje teksta ──────────────────────────────────────────── */

  /**
   * Pročita tekst sa slike i preda ga shellu, koji ga otvara u ploči ispod.
   *
   * Editor ne zna ništa o toj ploči — javlja se naredbom. To je isti seam
   * kojim bi svaki drugi plugin objavio rezultat koji nije datoteka na disku.
   */
  async readText(): Promise<void> {
    if (this.#ocrBusy) return;

    this.#ocrBusy = true;
    this.#syncButtons();
    this.#statusEmitter.fire(t('Reading text…'));

    try {
      const result = await recogniseImage(
        this.bytes,
        mimeFor(this.doc.name),
        this.#ocrLanguage,
        (progress) => {
          if (progress.stage === 'recognizing text') {
            this.#statusEmitter.fire(
              t('Reading text… {percent}%', { percent: Math.round(progress.fraction * 100) }),
            );
          }
        },
      );

      if (!result.text) {
        this.host.notify.show('warning', t('No text found in the image.'));
        return;
      }

      await this.host.commands.execute('scratch.openText', {
        name: t('Text from {name}', { name: this.doc.name.replace(/\.[^.]+$/, '') }),
        text: result.text,
      });

      this.host.notify.show(
        'info',
        t('Recognised {n} characters — confidence {confidence}%.', {
          n: result.text.length,
          confidence: result.confidence,
        }),
      );
    } catch (err) {
      this.host.notify.show(
        'error',
        `${t('Text recognition failed: {reason}', {
          reason: err instanceof Error ? err.message : String(err),
        })} ${t('OCR needs to download the language data on first use, which requires an internet connection.')}`,
      );
    } finally {
      this.#ocrBusy = false;
      this.#syncButtons();
      // Vraća uobičajeni status (dimenzije, zoom, veličina).
      this.#applyZoom();
    }
  }

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
    // Wasm jezgra drži worker; bez ovoga ostaje živ i nakon zatvaranja slike.
    void disposeOcr();
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
    throw new Error(t('Image editing (crop, rotate) arrives via image-rs in phase 1.'));
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
  displayName: 'Image viewer',
  matches: {
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'image'],
    mimeTypes: Object.values(MIME),
  },
  capabilities: ['view'],
  priority: 30,

  async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    return new ImageEditor(host, doc, await doc.bytes());
  },
};

export default imageEditorProvider;
