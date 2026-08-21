/**
 * Text recognition from an image (OCR).
 *
 * Tesseract through WebAssembly, inside a web worker — recognition takes
 * seconds and must not freeze the window.
 *
 * Three decisions the user can see:
 *
 * 1. **The language is chosen.** Without the Croatian model `č`, `ć`, `ž`, `š`
 *    and `đ` come out as `c`, `z`, `s` — which is exactly what has to be
 *    corrected by hand afterwards.
 * 2. **Everything is served from the application itself** (`/ocr/`), not from a
 *    CDN. By default Tesseract pulls its worker, wasm and models off the
 *    internet, which breaks two things this project has on purpose: the desktop
 *    CSP allows `'self'` only, and the editor has to work offline. Loosening the
 *    CSP for one feature means every user pays for it, forever.
 *    The assets are prepared by `tools/ocr-assets.mjs`.
 * 3. **The engine loads lazily.** Tesseract is several megabytes of wasm and
 *    must not weigh down startup for someone who never uses OCR.
 */

import type { Worker } from 'tesseract.js';

import { prepareForOcr } from './preprocess.js';

/** Languages we ship a model for. More are easy to add — these are the two in use. */
export const OCR_LANGUAGES = [
  { id: 'hrv', label: 'Croatian' },
  { id: 'eng', label: 'English' },
] as const;

export type OcrLanguage = (typeof OCR_LANGUAGES)[number]['id'];

export interface OcrProgress {
  /** 0..1 */
  fraction: number;
  /** The phase the engine is in right now, e.g. `recognizing text`. */
  stage: string;
}

export interface OcrResult {
  text: string;
  /** Average recognition confidence, 0..100. */
  confidence: number;
  /** Whether the image was upscaled and enhanced before recognition. */
  prepared: boolean;
}

/**
 * Where the worker, the wasm core and the language models are served from.
 *
 * An absolute path from the root: the same origin as the application, so
 * `connect-src 'self'` from the CSP holds without exception.
 */
const ASSETS = '/ocr';

let worker: Worker | null = null;
let workerLanguage: OcrLanguage | null = null;

/**
 * The worker is kept between calls: bringing the wasm core up takes longer than
 * recognising a short excerpt, so every click would pay for it again.
 */
async function ensureWorker(
  language: OcrLanguage,
  onProgress: (progress: OcrProgress) => void,
): Promise<Worker> {
  if (worker && workerLanguage === language) return worker;

  await disposeOcr();

  const { createWorker } = await import('tesseract.js');

  // `oem: 1` is LSTM; that is why only the LSTM cores are copied into the app.
  worker = await createWorker(language, 1, {
    workerPath: `${ASSETS}/worker.min.js`,
    corePath: ASSETS,
    langPath: ASSETS,
    // The model already ships with the app; a cache would merely duplicate it.
    cacheMethod: 'none',
    logger: (message: { status?: string; progress?: number }) =>
      onProgress({
        fraction: typeof message.progress === 'number' ? message.progress : 0,
        stage: message.status ?? '',
      }),
  });
  /*
   * With no resolution given, Tesseract assumes 70 DPI and logs a warning. The
   * preparation step already brings the image to scan proportions, so we say so
   * — guessing otherwise skews its estimate of the letter size.
   */
  await worker.setParameters({ user_defined_dpi: '300' });

  workerLanguage = language;
  return worker;
}

export async function disposeOcr(): Promise<void> {
  const current = worker;
  worker = null;
  workerLanguage = null;
  if (current) await current.terminate();
}

/**
 * Recognises text in an image. `bytes` are the raw file bytes — Tesseract decodes
 * the usual formats itself, so no canvas round trip is needed.
 */
export async function recogniseImage(
  bytes: Uint8Array,
  mime: string,
  language: OcrLanguage,
  onProgress: (progress: OcrProgress) => void,
): Promise<OcrResult> {
  const engine = await ensureWorker(language, onProgress);

  /*
   * Preparing the image before recognition. If that fails (a format canvas
   * cannot decode), the original is sent — a weaker result beats none.
   */
  const prepared = await prepareForOcr(bytes, mime);
  let input: Blob;
  if (prepared) {
    input = prepared.blob;
  } else {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    input = new Blob([copy], { type: mime });
  }

  const { data } = await engine.recognize(input);
  return {
    text: normalise(data.text ?? ''),
    confidence: Math.round(data.confidence ?? 0),
    prepared: prepared !== null,
  };
}

/**
 * Tesseract returns line by line with excess whitespace and words hyphenated at
 * the end of a line. This is the minimal clean-up that does not change the
 * content: a hyphenated word is rejoined, and three or more blank lines become
 * one paragraph break.
 */
function normalise(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/-\n(\p{Ll})/gu, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
