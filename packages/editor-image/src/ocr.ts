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
 * 2. **Jezični model se preuzima pri prvoj upotrebi** i ostaje u predmemoriji
 *    preglednika. Prvi put treba mreža; poslije radi bez nje. To se kaže
 *    unaprijed, ne kroz tihu grešku.
 * 3. **Motor se učitava lijeno.** Tesseract je nekoliko megabajta wasm-a i ne
 *    smije opteretiti pokretanje programa nekome tko OCR nikad ne koristi.
 */

import type { Worker } from 'tesseract.js';

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
}

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
  worker = await createWorker(language, 1, {
    logger: (message: { status?: string; progress?: number }) =>
      onProgress({
        fraction: typeof message.progress === 'number' ? message.progress : 0,
        stage: message.status ?? '',
      }),
  });
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

  // Svjež buffer: Blob ne prihvaća pogled na dijeljeni spremnik.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const blob = new Blob([copy], { type: mime });

  const { data } = await engine.recognize(blob);
  return {
    text: normalise(data.text ?? ''),
    confidence: Math.round(data.confidence ?? 0),
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
