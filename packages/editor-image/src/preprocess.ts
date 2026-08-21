/**
 * Preparing an image before recognition.
 *
 * Tesseract is built for scanned documents at ~300 DPI. A phone photo, a
 * screenshot or a small caption arrive as something else entirely, and the
 * result degrades far more than one expects. Three things return the most while
 * requiring nothing but a canvas:
 *
 * 1. **Upscaling.** Below ~20 px of letter height the engine loses the shape.
 *    Scaling up to a sensible size is the one preprocessing step that almost
 *    never hurts.
 * 2. **Greyscale by perceived brightness.** Averaging the channels loses
 *    contrast on coloured text; luma preserves it.
 * 3. **Contrast stretching by percentiles.** Photographed paper rarely holds a
 *    clean white and black; without stretching, the engine looks for an edge
 *    that does not exist.
 *
 * Binarisation is deliberately **not** performed: Tesseract runs Otsu
 * internally, and does it better than we would blindly. Double binarisation
 * swallows thin strokes.
 */

/** Below this letter height the engine loses the shape of a character. */
const TARGET_MIN_SIDE = 1400;
/** Above this, recognition takes longer than the gain is worth. */
const MAX_SIDE = 4200;
/** The percentiles contrast is stretched to — resistant to individual pixels. */
const LOW_PERCENTILE = 0.02;
const HIGH_PERCENTILE = 0.98;

export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
  /** The upscaling factor; 1 means the image size was left alone. */
  scale: number;
}

/**
 * Returns an image ready for OCR. If preparation fails (e.g. a format canvas
 * cannot decode), the caller gets `null` and sends the original — a weaker
 * result beats none.
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

    // Smooth scaling: a pixelated upscale gives the engine stepped edges it
    // reads as noise.
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

  // Downscaling would lose data; if the image is already large, it stays as it is.
  return Math.max(1, scale);
}

/** Luma per Rec. 709 — the same weighting the eye gives the channels. */
function toGrayscale(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const value = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
  }
}

/**
 * Stretches the brightness range to the full 0–255, but by percentiles: a single
 * white glare or dark smudge would otherwise define the whole range and the
 * stretch would achieve nothing.
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

  // A flat image (near single-colour) has nothing to stretch.
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
