/**
 * Priprema slike prije prepoznavanja.
 *
 * Tesseract je građen za skenirane dokumente na ~300 DPI. Fotografija s
 * mobitela, screenshot ili sitan natpis mu dolaze kao nešto sasvim drugo, i
 * rezultat pada mnogo više nego što se očekuje. Tri stvari vraćaju najviše, a
 * ne traže ništa osim canvasa:
 *
 * 1. **Povećanje.** Ispod ~20 px visine slova motor gubi oblik. Povećanje na
 *    razumnu veličinu je jedina pretprocesna radnja koja gotovo nikad ne šteti.
 * 2. **Sivi tonovi po percepciji svjetline.** Prosjek kanala izgubi kontrast
 *    kod obojenog teksta; luma ga zadrži.
 * 3. **Rastezanje kontrasta po percentilima.** Fotografirani papir rijetko ima
 *    čistu bijelu i crnu; bez rastezanja motor traži rub koji ne postoji.
 *
 * Binarizacija se namjerno **ne** radi: Tesseract iznutra radi Otsua, i to
 * bolje nego što bismo mi naslijepo. Dvostruka binarizacija guta tanke poteze.
 */

/** Ispod ove visine slova motor gubi oblik znaka. */
const TARGET_MIN_SIDE = 1400;
/** Iznad ovoga prepoznavanje traje dulje nego što dobitak vrijedi. */
const MAX_SIDE = 4200;
/** Percentili na koje se rasteže kontrast — otporni na pojedinačne piksele. */
const LOW_PERCENTILE = 0.02;
const HIGH_PERCENTILE = 0.98;

export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
  /** Faktor povećanja; 1 znači da slika nije dirana po veličini. */
  scale: number;
}

/**
 * Vraća sliku spremnu za OCR. Ako priprema ne uspije (npr. format koji canvas
 * ne dekodira), pozivatelj dobiva `null` i šalje izvornik — bolje slabiji
 * rezultat nego nikakav.
 */
export async function prepareForOcr(bytes: Uint8Array, mime: string): Promise<PreparedImage | null> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const source = new Blob([copy], { type: mime });

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    return null;
  }

  try {
    const scale = scaleFor(bitmap.width, bitmap.height);
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    // Glatko skaliranje: pikselizirano povećanje motoru daje stepenaste rubove
    // koje čita kao šum.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);

    const image = ctx.getImageData(0, 0, width, height);
    toGrayscale(image.data);
    stretchContrast(image.data);
    ctx.putImageData(image, 0, 0);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? { blob, width, height, scale } : null;
  } finally {
    bitmap.close();
  }
}

function scaleFor(width: number, height: number): number {
  const smaller = Math.min(width, height);
  const larger = Math.max(width, height);

  let scale = smaller < TARGET_MIN_SIDE ? TARGET_MIN_SIDE / smaller : 1;
  if (larger * scale > MAX_SIDE) scale = MAX_SIDE / larger;

  // Smanjivanje bi izgubilo podatke; ako je slika već velika, ostaje kakva jest.
  return Math.max(1, scale);
}

/** Luma po Rec. 709 — ista težina koju oko daje kanalima. */
function toGrayscale(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const value = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
  }
}

/**
 * Rasteže raspon svjetline na puni 0–255, ali po percentilima: pojedinačni
 * bijeli odsjaj ili tamna mrlja inače definiraju cijeli raspon i rastezanje
 * ne napravi ništa.
 */
function stretchContrast(data: Uint8ClampedArray): void {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) histogram[data[i]!]! += 1;

  const total = data.length / 4;
  const lowTarget = total * LOW_PERCENTILE;
  const highTarget = total * HIGH_PERCENTILE;

  let seen = 0;
  let low = 0;
  let high = 255;
  for (let value = 0; value < 256; value++) {
    seen += histogram[value]!;
    if (seen >= lowTarget) {
      low = value;
      break;
    }
  }
  seen = 0;
  for (let value = 0; value < 256; value++) {
    seen += histogram[value]!;
    if (seen >= highTarget) {
      high = value;
      break;
    }
  }

  // Ravna slika (skoro jednobojna) nema što rastegnuti.
  if (high - low < 16) return;

  const factor = 255 / (high - low);
  const table = new Uint8ClampedArray(256);
  for (let value = 0; value < 256; value++) {
    table[value] = (value - low) * factor;
  }

  for (let i = 0; i < data.length; i += 4) {
    const value = table[data[i]!]!;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
  }
}
