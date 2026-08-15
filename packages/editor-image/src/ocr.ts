/**
 * Prepoznavanje teksta na slici (OCR).
 *
 * Tesseract preko WebAssemblyja, u web workeru — prepoznavanje traje sekunde
 * i ne smije zamrznuti prozor.
 *
 * Tri odluke koje se vide korisniku:
 *
 * 1. **Jezik se bira.** Bez hrvatskog modela `č`, `ć`, `ž`, `š` i `đ` završe
 *    kao `c`, `z`, `s` — a to je upravo ono što se poslije mora ručno
 *    ispravljati.
 * 2. **Sve se poslužuje iz same aplikacije** (`/ocr/`), ne s CDN-a. Zadani
 *    Tesseract vuče worker, wasm i modele s interneta, što pada na dvije
 *    stvari koje ovaj projekt namjerno ima: CSP desktop verzije dopušta samo
 *    `'self'`, a editor mora raditi bez mreže. Labaviti CSP zbog jedne
 *    značajke znači da to plaćaju svi korisnici, zauvijek.
 *    Resurse priprema `tools/ocr-assets.mjs`.
 * 3. **Motor se učitava lijeno.** Tesseract je nekoliko megabajta wasm-a i ne
 *    smije opteretiti pokretanje programa nekome tko OCR nikad ne koristi.
 */

import type { Worker } from 'tesseract.js';

import { prepareForOcr } from './preprocess.js';

/** Jezici za koje nudimo model. Više ih je lako dodati — ovo su ona dva koja Josko treba. */
export const OCR_LANGUAGES = [
  { id: 'hrv', label: 'Croatian' },
  { id: 'eng', label: 'English' },
] as const;

export type OcrLanguage = (typeof OCR_LANGUAGES)[number]['id'];

export interface OcrProgress {
  /** 0..1 */
  fraction: number;
  /** Faza koju motor upravo radi, npr. `recognizing text`. */
  stage: string;
}

export interface OcrResult {
  text: string;
  /** Prosječna pouzdanost prepoznavanja, 0..100. */
  confidence: number;
  /** Je li slika prije prepoznavanja povećana i pojačana. */
  prepared: boolean;
}

/**
 * Mjesto s kojeg se poslužuju worker, wasm jezgra i jezični modeli.
 *
 * Apsolutna putanja od korijena: isti izvor kao aplikacija, pa `connect-src
 * 'self'` iz CSP-a vrijedi bez iznimke.
 */
const ASSETS = '/ocr';

let worker: Worker | null = null;
let workerLanguage: OcrLanguage | null = null;

/**
 * Worker se drži između poziva: podizanje wasm jezgre traje dulje nego samo
 * prepoznavanje kratkog isječka, pa bi ga svaki klik plaćao iznova.
 */
async function ensureWorker(
  language: OcrLanguage,
  onProgress: (progress: OcrProgress) => void,
): Promise<Worker> {
  if (worker && workerLanguage === language) return worker;

  await disposeOcr();

  const { createWorker } = await import('tesseract.js');

  // `oem: 1` je LSTM; zato se u aplikaciju kopiraju samo LSTM jezgre.
  worker = await createWorker(language, 1, {
    workerPath: `${ASSETS}/worker.min.js`,
    corePath: ASSETS,
    langPath: ASSETS,
    // Model je već uz aplikaciju; predmemorija bi ga samo udvostručila.
    cacheMethod: 'none',
    logger: (message: { status?: string; progress?: number }) =>
      onProgress({
        fraction: typeof message.progress === 'number' ? message.progress : 0,
        stage: message.status ?? '',
      }),
  });
  /*
   * Bez podatka o razlučivosti Tesseract pretpostavi 70 DPI i prijavi
   * upozorenje. Priprema sliku već dovede na razmjere skena, pa mu se to i
   * kaže — pogađanje inače pomakne procjenu veličine slova.
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
 * Prepoznaje tekst na slici. `bytes` su izvorni bajtovi datoteke — Tesseract
 * sam dekodira uobičajene formate, pa ne treba prolaz kroz canvas.
 */
export async function recogniseImage(
  bytes: Uint8Array,
  mime: string,
  language: OcrLanguage,
  onProgress: (progress: OcrProgress) => void,
): Promise<OcrResult> {
  const engine = await ensureWorker(language, onProgress);

  /*
   * Priprema slike prije prepoznavanja. Ako ne uspije (format koji canvas ne
   * dekodira), šalje se izvornik — slabiji rezultat je bolji od nikakvog.
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
 * Tesseract vraća redak po redak s viškom praznina i rastavljenim riječima na
 * kraju retka. Ovo je minimalno čišćenje koje ne mijenja sadržaj: rastavljena
 * riječ se spaja, a tri i više praznih redaka postaju jedan odlomak.
 */
function normalise(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/-\n(\p{Ll})/gu, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
