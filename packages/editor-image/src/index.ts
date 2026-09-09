/**
 * The image viewer, and the editor it turns into where there is a Rust core
 * under it.
 *
 * **Nothing is written until a save.** Turning, mirroring, cropping and resizing
 * are a *plan*, drawn on screen by the browser at no cost — the same shape as
 * page operations in the PDF editor. The pixels are touched exactly once, in
 * `crates/ul-image`, by the save itself: a photograph out of a phone is forty
 * megapixels, and decoding that in the webview to preview a rotation would be
 * a hundred and sixty megabytes for a picture CSS can turn for nothing.
 *
 * So the tools are drawn only where the transforms exist. `host.images` answers
 * that, and in a browser it answers no — the picture still opens, zooms and goes
 * through OCR, and what cannot be done is not offered.
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
  type ImageEncoding,
  type ImageInfo,
  type ImageOps,
  type SaveResult,
  type SaveTarget,
} from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import { OCR_LANGUAGES, disposeOcr, recogniseImage, type OcrLanguage } from './ocr.js';
import { icon } from './icons.js';

const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.67, 1, 1.5, 2, 3, 4, 8, 16];
const MARGIN = 48;

/** The formats that can be written back, in the order the select offers them. */
const ENCODINGS: { id: ImageEncoding; label: string }[] = [
  { id: 'png', label: 'PNG' },
  { id: 'jpeg', label: 'JPEG' },
  { id: 'webp', label: 'WebP' },
  { id: 'bmp', label: 'BMP' },
  { id: 'tiff', label: 'TIFF' },
];

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

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

/** The extensions each writable format is allowed to be called by. */
const NAMES: Record<ImageEncoding, string[]> = {
  png: ['png'],
  jpeg: ['jpg', 'jpeg'],
  webp: ['webp'],
  bmp: ['bmp'],
  tiff: ['tif', 'tiff'],
};

/**
 * Where a save goes when the format was changed.
 *
 * JPEG bytes in a file called `.png` is a file that lies about itself, and every
 * program downstream believes the name first. So a change of format writes a new
 * file beside the original — which is the rule an old `.xls` already follows
 * here, and the shell already knows how to move the tab to it.
 */
function targetFor(uri: string, encoding: ImageEncoding | null): string {
  if (!encoding) return uri;
  const current = uri.slice(uri.lastIndexOf('.') + 1).toLowerCase();
  if (NAMES[encoding].includes(current)) return uri;
  const dot = uri.lastIndexOf('.');
  const stem = dot > uri.lastIndexOf('/') && dot > uri.lastIndexOf('\\') ? uri.slice(0, dot) : uri;
  return `${stem}.${NAMES[encoding][0]}`;
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

  /* ── the plan ──────────────────────────────────────────────────────────
   *
   * Everything here is pending until a save. `rotate` is clockwise degrees; the
   * crop is a rectangle in the pixels of the picture **as shown**, turn and
   * mirrors included, which is the whole reason `ul-image` turns before it
   * crops — a rectangle dragged over the screen then means what it looks like.
   */
  #rotate = 0;
  #flipH = false;
  #flipV = false;
  #crop: Rect | null = null;
  /** The width to end on; the height follows, so nothing is ever stretched. */
  #resizeWidth: number | null = null;
  /** The format to write. `null` keeps the one the file already had. */
  #encoding: ImageEncoding | null = null;
  #quality = 90;
  #info: ImageInfo | null = null;

  #cropping = false;
  #dragFrom: { x: number; y: number } | null = null;
  #overlay: HTMLElement | null = null;
  #editingTools: HTMLElement[] = [];
  #lastDirty = false;
  /** What the format select was set to on opening — the baseline for "dirty". */
  #encodingAtOpen: ImageEncoding | null = null;

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

    // A copy into a fresh buffer — Blob does not accept a view onto shared memory.
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

    /* What the file is, from the side that will have to write it. The browser
       has already told us the size; this adds the two things it cannot know —
       whether the format can be written at all, and whether the picture is
       stored sideways with a tag saying which way is up. */
    if (this.host.images.available()) {
      try {
        this.#info = await this.host.images.info(this.doc.uri);
        if (this.#info && !this.#info.editable) {
          /* A GIF or an `.avif` can be shown and not written. Editing is still
             offered — what it will produce instead is chosen here and said in
             the bar, and it does not count as a change the person made. */
          this.#encoding = 'png';
          this.#encodingAtOpen = 'png';
        }
      } catch {
        // An unreadable picture is already reported by the viewer above; this
        // only decides which tools to draw.
        this.#info = null;
      }
    }

    this.#buildOverlay();

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
    label.className = 'zoom';
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

    /* The file size is information, not a tool — on a narrow screen the status
       bar carries it, so it leaves the vertical toolbar. */
    const info = document.createElement('span');
    info.className = 'readout';
    info.textContent = humanBytes(this.doc.stat.size);

    /* Text recognition: the language, then the button. The language sits beside
       the button because it is chosen before each run rather than in settings —
       the same image often holds both languages. */
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

    /* The tools that write a file are drawn only where there is something to
       write it with. In a browser `host.images` says no, and the bar keeps the
       zoom, the OCR and the readout — rather than offering four buttons that
       would each end in the same apology. */
    const editing = this.host.images.available() ? this.#buildEditingTools(button, sep) : [];

    bar.append(
      zoomOut,
      label,
      zoomIn,
      sep(),
      fit,
      actual,
      ...editing,
      spacer,
      language,
      ocr,
      sep(),
      info,
    );

    this.#syncButtons = () => {
      fit.dataset.active = String(this.#fit);
      ocr.disabled = this.#ocrBusy;
      if (this.#zoomLabel) this.#zoomLabel.textContent = `${Math.round(this.#scale * 100)}%`;
      this.#syncEditingTools();
    };
    return bar;
  }

  /* ── the editing tools ────────────────────────── */

  #syncEditingTools: () => void = () => {};

  #buildEditingTools(
    button: (label: string, title: string, onClick: () => void) => HTMLButtonElement,
    sep: () => HTMLElement,
  ): HTMLElement[] {
    /* Drawn, not typed. `↺ ↻ ⇄ ⇅ ⬚` are typographic characters doing the work
       of pictures, and the font decides what they look like — the PDF bar was
       cleared of exactly that habit, and this one does not restart it. The
       class is what a check finds them by, since a title is translated. */
    const iconButton = (name: string, label: string, title: string, onClick: () => void) => {
      const element = button('', title, onClick);
      element.classList.add(`ul-img-${label}`);
      element.append(icon(name));
      return element;
    };

    const rotateLeft = iconButton('rotateLeft', 'rotate-left', t('Rotate left'), () =>
      this.rotateBy(-90),
    );
    const rotateRight = iconButton('rotateRight', 'rotate-right', t('Rotate right'), () =>
      this.rotateBy(90),
    );

    const flipH = iconButton('flipH', 'flip-h', t('Mirror left to right'), () => {
      this.#flipH = !this.#flipH;
      this.#planChanged();
    });
    const flipV = iconButton('flipV', 'flip-v', t('Mirror top to bottom'), () => {
      this.#flipV = !this.#flipV;
      this.#planChanged();
    });

    const crop = iconButton('crop', 'crop', t('Crop — drag a rectangle over the picture'), () => {
      this.#cropping = !this.#cropping;
      this.#dragFrom = null;
      this.#planChanged();
    });

    /* One number, not two. A width and a height that disagree with the picture
       stretch it, and a stretched photograph is never what was wanted — the way
       to change the proportions is the crop beside it. */
    const width = document.createElement('input');
    width.type = 'number';
    width.min = '1';
    width.className = 'ul-img-number ul-img-width';
    width.title = t('Width in pixels; the height follows');
    width.addEventListener('change', () => {
      const value = Number.parseInt(width.value, 10);
      this.#resizeWidth = Number.isFinite(value) && value > 0 ? value : null;
      if (this.#resizeWidth === null) width.value = '';
      this.#planChanged();
    });

    const format = document.createElement('select');
    format.className = 'ul-img-select ul-img-format';
    format.title = t('Format to save as');

    const keep = document.createElement('option');
    keep.value = '';
    keep.textContent = t('Keep');
    format.appendChild(keep);
    for (const entry of ENCODINGS) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.label;
      format.appendChild(option);
    }
    format.addEventListener('change', () => {
      this.#encoding = (format.value || null) as ImageEncoding | null;
      this.#planChanged();
    });

    /* Quality belongs to JPEG and to nothing else here, so it appears with it
       rather than sitting greyed out beside every other format. */
    const quality = document.createElement('input');
    quality.type = 'number';
    quality.min = '1';
    quality.max = '100';
    quality.value = String(this.#quality);
    quality.className = 'ul-img-number ul-img-quality';
    quality.title = t('JPEG quality');
    quality.addEventListener('change', () => {
      const value = Number.parseInt(quality.value, 10);
      this.#quality = Number.isFinite(value) ? Math.min(100, Math.max(1, value)) : 90;
      quality.value = String(this.#quality);
      this.#planChanged();
    });

    const reset = button(t('Reset'), t('Undo every pending change'), () => this.resetPlan());
    reset.classList.add('ul-img-reset');

    this.#syncEditingTools = () => {
      const planned = this.#plannedSize();
      const turned = this.#turnedSize();

      /* A crop that no longer fits inside the picture — the turn changed the
         sides under it — is dropped rather than saved as something else. */
      if (
        this.#crop &&
        (this.#crop.x + this.#crop.width > turned.width ||
          this.#crop.y + this.#crop.height > turned.height)
      ) {
        this.#crop = null;
      }

      crop.dataset.active = String(this.#cropping || this.#crop !== null);
      rotateLeft.dataset.active = String(this.#rotate % 360 !== 0);
      rotateRight.dataset.active = String(this.#rotate % 360 !== 0);
      flipH.dataset.active = String(this.#flipH);
      flipV.dataset.active = String(this.#flipV);

      // The placeholder is the width a save would write now, so the box shows
      // the number it would replace rather than sitting empty.
      width.placeholder = String(planned.width);
      if (this.#resizeWidth === null && width.value !== '') width.value = '';

      format.value = this.#encoding ?? '';
      // Keeping the format is not an option when the format cannot be written.
      keep.disabled = this.#info !== null && !this.#info.editable;
      keep.textContent = keep.disabled ? t('Keep — not possible') : t('Keep');

      quality.hidden = this.#effectiveEncoding() !== 'jpeg';
      reset.disabled = !this.isDirty();
    };

    this.#editingTools = [rotateLeft, rotateRight, flipH, flipV, crop, width, format, quality, reset];
    return [sep(), ...this.#editingTools];
  }

  /* ── the plan ───────────────────────────────── */

  /** The size of the picture as shown: a quarter turn swaps the sides. */
  #turnedSize(): { width: number; height: number } {
    const { width, height } = this.#natural;
    return this.#rotate % 180 === 0 ? { width, height } : { width: height, height: width };
  }

  /** What a save would write: the turn, then the crop, then the resize. */
  #plannedSize(): { width: number; height: number } {
    const turned = this.#turnedSize();
    const cropped = this.#crop ?? turned;
    if (this.#resizeWidth === null || cropped.width === 0) {
      return { width: cropped.width, height: cropped.height };
    }
    return {
      width: this.#resizeWidth,
      height: Math.max(1, Math.round((cropped.height * this.#resizeWidth) / cropped.width)),
    };
  }

  /** The format a save would write: the chosen one, or the one it had. */
  #effectiveEncoding(): ImageEncoding | null {
    return this.#encoding ?? this.#info?.encoding ?? null;
  }

  #plan(): ImageOps {
    const planned = this.#plannedSize();
    const cropped = this.#crop ?? this.#turnedSize();
    return {
      rotate: ((this.#rotate % 360) + 360) % 360,
      flipHorizontal: this.#flipH,
      flipVertical: this.#flipV,
      crop: this.#crop ?? undefined,
      resize:
        this.#resizeWidth !== null && planned.width !== cropped.width
          ? { width: planned.width, height: planned.height }
          : undefined,
      encoding: this.#effectiveEncoding() ?? undefined,
      quality: this.#effectiveEncoding() === 'jpeg' ? this.#quality : undefined,
    };
  }

  rotateBy(degrees: number): void {
    this.#rotate = (((this.#rotate + degrees) % 360) + 360) % 360;
    /* The crop was a rectangle in the picture as it was shown, and the picture
       has just turned under it. Keeping it would move the cut somewhere nobody
       chose — so it goes, and it goes visibly, because the rectangle leaves the
       screen at the same moment. */
    this.#crop = null;
    this.#planChanged();
  }

  resetPlan(): void {
    this.#rotate = 0;
    this.#flipH = false;
    this.#flipV = false;
    this.#crop = null;
    this.#resizeWidth = null;
    this.#encoding = this.#encodingAtOpen;
    this.#cropping = false;
    this.#planChanged();
  }

  #planChanged(): void {
    this.#applyZoom();
    this.#paintOverlay();
    this.#recomputeDirty();
  }

  #recomputeDirty(): void {
    const dirty = this.isDirty();
    if (dirty === this.#lastDirty) return;
    this.#lastDirty = dirty;
    this.#dirtyEmitter.fire(dirty);
  }

  /* ── the crop, dragged over the picture ────────────────── */

  #buildOverlay(): void {
    const frame = this.#frame;
    if (!frame || !this.host.images.available()) return;

    const overlay = document.createElement('div');
    overlay.className = 'ul-img-selection';
    overlay.hidden = true;
    frame.appendChild(overlay);
    this.#overlay = overlay;

    frame.addEventListener('pointerdown', this.#onPointerDown);
    frame.addEventListener('pointermove', this.#onPointerMove);
    frame.addEventListener('pointerup', this.#onPointerUp);
    frame.addEventListener('pointercancel', this.#onPointerUp);
  }

  /** Where a pointer is, in the pixels of the picture as shown. */
  #pointAt(event: PointerEvent): { x: number; y: number } {
    const frame = this.#frame;
    const shown = this.#turnedSize();
    if (!frame) return { x: 0, y: 0 };

    const box = frame.getBoundingClientRect();
    const clamp = (value: number, limit: number) => Math.min(limit, Math.max(0, Math.round(value)));
    return {
      x: clamp(((event.clientX - box.left) / Math.max(1, box.width)) * shown.width, shown.width),
      y: clamp(((event.clientY - box.top) / Math.max(1, box.height)) * shown.height, shown.height),
    };
  }

  #onPointerDown = (event: PointerEvent): void => {
    if (!this.#cropping || event.button !== 0) return;
    event.preventDefault();
    this.#frame?.setPointerCapture(event.pointerId);
    this.#dragFrom = this.#pointAt(event);
    this.#crop = null;
    this.#paintOverlay();
  };

  #onPointerMove = (event: PointerEvent): void => {
    if (!this.#dragFrom) return;
    const to = this.#pointAt(event);
    this.#crop = {
      x: Math.min(this.#dragFrom.x, to.x),
      y: Math.min(this.#dragFrom.y, to.y),
      width: Math.abs(to.x - this.#dragFrom.x),
      height: Math.abs(to.y - this.#dragFrom.y),
    };
    this.#paintOverlay();
    this.#statusEmitter.fire(this.#statusText());
  };

  #onPointerUp = (event: PointerEvent): void => {
    if (!this.#dragFrom) return;
    this.#dragFrom = null;
    if (this.#frame?.hasPointerCapture(event.pointerId)) {
      this.#frame.releasePointerCapture(event.pointerId);
    }
    /* A tap rather than a drag: two pixels of picture is nobody's crop, and
       keeping it would leave a rectangle too small to see or to undo. */
    if (this.#crop && (this.#crop.width < 2 || this.#crop.height < 2)) this.#crop = null;
    this.#planChanged();
  };

  #paintOverlay(): void {
    const overlay = this.#overlay;
    if (!overlay) return;

    const crop = this.#crop;
    if (!crop || crop.width === 0 || crop.height === 0) {
      overlay.hidden = true;
      return;
    }

    const shown = this.#turnedSize();
    overlay.hidden = false;
    overlay.style.left = `${(crop.x / shown.width) * 100}%`;
    overlay.style.top = `${(crop.y / shown.height) * 100}%`;
    overlay.style.width = `${(crop.width / shown.width) * 100}%`;
    overlay.style.height = `${(crop.height / shown.height) * 100}%`;
  }

  #syncButtons: () => void = () => {};

  /* ── text recognition ──────────────────────────────────────────────── */

  /**
   * Reads the text off the image and hands it to the shell, which opens it in
   * the panel below.
   *
   * The editor knows nothing about that panel — it announces itself through a
   * command. That is the same seam any other plugin would use to publish a
   * result that is not a file on disk.
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
        t('Text recognition failed: {reason}', {
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      this.#ocrBusy = false;
      this.#syncButtons();
      // Restores the usual status (dimensions, zoom, size).
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

    const shown = this.#turnedSize();

    if (this.#fit) {
      // An image smaller than the window is not enlarged — otherwise a small icon fills the screen.
      this.#scale = Math.min(
        1,
        (this.#stage.clientWidth - MARGIN) / shown.width,
        (this.#stage.clientHeight - MARGIN) / shown.height,
      );
    }

    const w = Math.max(1, Math.round(width * this.#scale));
    const h = Math.max(1, Math.round(height * this.#scale));
    this.#img.style.width = `${w}px`;
    this.#img.style.height = `${h}px`;

    /* The frame is the picture as shown, so a quarter turn swaps its sides: the
       picture inside it keeps its own, and is turned about its centre. */
    this.#frame.style.width = `${Math.max(1, Math.round(shown.width * this.#scale))}px`;
    this.#frame.style.height = `${Math.max(1, Math.round(shown.height * this.#scale))}px`;

    /* Read right to left, as CSS applies them: turned first, mirrored second.
       That is the order `ul-image` uses, and the other order is a different
       picture — one nobody would notice until the file was written. */
    const mirror = `scale(${this.#flipH ? -1 : 1}, ${this.#flipV ? -1 : 1})`;
    this.#img.style.transform = `translate(-50%, -50%) ${mirror} rotate(${this.#rotate}deg)`;

    // Interpolation only when scaling down; enlarged must show the pixels.
    this.#frame.dataset.smooth = String(this.#scale <= 1);
    this.#frame.dataset.cropping = String(this.#cropping);

    this.#syncButtons();
    this.#paintOverlay();
    this.#statusEmitter.fire(this.#statusText());
  }

  /**
   * The line under the window: what the picture is, and — when a plan is
   * pending — what a save would write instead. The second half is the whole
   * point of a plan, since nothing on disk has changed yet.
   */
  #statusText(): string {
    const shown = this.#turnedSize();
    const parts = [
      `${shown.width} × ${shown.height} px`,
      `${Math.round(this.#scale * 100)}%`,
      humanBytes(this.doc.stat.size),
    ];

    if (this.isDirty()) {
      const planned = this.#plannedSize();
      const encoding = this.#effectiveEncoding();
      parts.push(
        t('will be saved as {width} × {height} {format}', {
          width: planned.width,
          height: planned.height,
          format: (encoding ?? '').toUpperCase(),
        }),
      );
      /* Not a shortfall of this program but of the format: a JPEG is compressed
         again every time it is written, so the second rotation of a photograph
         costs something even though nothing else was touched. Said here, where
         it can still be avoided by choosing another format. */
      if (encoding === 'jpeg') parts.push(t('recompressed'));
    } else if (this.#info?.reoriented) {
      /* The file is stored sideways with a tag saying which way is up. Every
         viewer obeys the tag, and a save bakes it in — so it is said before
         somebody wonders why the numbers moved. */
      parts.push(t('stored sideways; a save writes it upright'));
    }

    return parts.join('  ·  ');
  }

  unmount(): void {
    // The wasm core holds a worker; without this it stays alive after the image closes.
    void disposeOcr();
    this.#resize?.disconnect();
    this.#stage?.removeEventListener('wheel', this.#onWheel);
    if (this.#objectUrl) URL.revokeObjectURL(this.#objectUrl);
    this.#objectUrl = null;
    this.#root?.remove();
    this.#root = null;
  }

  isDirty(): boolean {
    return (
      this.#rotate % 360 !== 0 ||
      this.#flipH ||
      this.#flipV ||
      this.#crop !== null ||
      this.#resizeWidth !== null ||
      this.#encoding !== this.#encodingAtOpen
    );
  }

  /**
   * The one moment the pixels are touched.
   *
   * The plan goes to Rust, which reads the file, applies it and writes the
   * result — nothing decoded here, nothing sent across but five numbers and two
   * flags. Afterwards the file on disk is re-read rather than reconstructed,
   * because what the window shows has to be what was written, including
   * whatever the encoder did on the way.
   */
  async save(target?: SaveTarget): Promise<SaveResult> {
    const images = this.host.images;
    if (!images.available()) {
      throw new Error(t('Image editing needs the desktop application.'));
    }

    /* A "save as" was given a name by the person, and that name wins. A plain
       save follows the format: unchanged, it writes the same file. */
    const uri = target?.uri ?? targetFor(this.doc.uri, this.#effectiveEncoding());
    const written = await images.write(this.doc.uri, uri, this.#plan());

    this.#rotate = 0;
    this.#flipH = false;
    this.#flipV = false;
    this.#crop = null;
    this.#resizeWidth = null;
    this.#cropping = false;
    this.#encoding = null;
    this.#encodingAtOpen = null;

    await this.#reload(uri);
    this.#recomputeDirty();

    /*
     * `lostFidelity` is deliberately empty even when the encoding was lossy.
     * The shell reports it *after* the write, with a Cancel beside it — and a
     * Cancel that cannot unwrite the file is worse than no dialog at all. What
     * a JPEG costs is knowable before anything happens and is the person's own
     * choice of format, so it is said in the bar while the plan is still a
     * plan, next to the size the file will have.
     */
    return { uri, lostFidelity: [] };
  }

  /** Puts the written file back on the screen. */
  async #reload(uri: string): Promise<void> {
    const img = this.#img;
    if (!img) return;

    const bytes = await this.host.fs.readBytes(uri);
    const blob = new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: mimeFor(uri) });
    const url = URL.createObjectURL(blob);

    const loaded = new Promise<boolean>((resolve) => {
      img.addEventListener('load', () => resolve(true), { once: true });
      img.addEventListener('error', () => resolve(false), { once: true });
    });
    img.src = url;
    if (await loaded) {
      this.#natural = { width: img.naturalWidth, height: img.naturalHeight };
    }

    if (this.#objectUrl) URL.revokeObjectURL(this.#objectUrl);
    this.#objectUrl = url;

    try {
      this.#info = await this.host.images.info(uri);
    } catch {
      this.#info = null;
    }
    this.#applyZoom();
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
  displayName: 'Image editor',
  matches: {
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'image'],
    mimeTypes: Object.values(MIME),
  },
  capabilities: ['view', 'edit', 'export'],
  priority: 30,

  async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    return new ImageEditor(host, doc, await doc.bytes());
  },
};

export default imageEditorProvider;
