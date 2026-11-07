/**
 * Paper to text: the picture, its corners, recognising, the result, saving.
 *
 *     picture → corners → recognising → result → saving → saved
 *                  ↑______ failed ______|          ↑__ not saved __|
 *
 * The picture comes from the system's camera app or the gallery (ADR 0009, O4);
 * the first corners are the whole picture, since finding a paper's edges comes
 * later. The person drags them in, Rust straightens what they enclose
 * (`ImageOps.perspective`, K4), `packages/ocr` reads it, and the text is held
 * here until it is saved: it is not a file yet.
 *
 * **Only the picture's size is kept.** The pixels stay with the adapter, which
 * lets them go once they have been read (ADR 0009: a picture is not kept past
 * its processing). The text is `privatno`, and a photographed paper may hold
 * other people's data, so nothing here logs it.
 *
 * **A result is not dropped by the way.** Taking another picture from the
 * result is refused; `discard` is the one event that gives a result up, and an
 * interface asks before it sends it.
 */

export interface Point {
  x: number;
  y: number;
}

/** Top left, top right, bottom right, bottom left, in the picture's pixels. */
export type Corners = readonly [Point, Point, Point, Point];

export interface PictureSize {
  width: number;
  height: number;
}

export type CornerIndex = 0 | 1 | 2 | 3;

/**
 * The least a crop may enclose, as a share of the picture. Below it the four
 * corners have all but met, and straightening would stretch a few pixels over a
 * page.
 */
export const MIN_AREA_FRACTION = 0.01;

export type Scan =
  | { step: 'picture' }
  /** `failed`: the last recognition did not come back; the corners are as they were. */
  | { step: 'corners'; size: PictureSize; corners: Corners; failed: boolean }
  | { step: 'recognising'; size: PictureSize; corners: Corners }
  /** `saveFailed`: the last save did not happen; the text is still here. */
  | { step: 'result'; size: PictureSize; corners: Corners; text: string; saveFailed: boolean }
  | { step: 'saving'; size: PictureSize; corners: Corners; text: string }
  | { step: 'saved'; text: string };

export type ScanEvent =
  | { type: 'picture'; size: PictureSize }
  | { type: 'move'; index: CornerIndex; to: Point }
  | { type: 'recognise' }
  | { type: 'recognised'; text: string }
  | { type: 'failed' }
  /** The result corrected, through the same edit session an editor speaks. */
  | { type: 'revise'; text: string }
  | { type: 'save' }
  | { type: 'saved'; ok: boolean }
  /** Another picture, from anywhere but a result. */
  | { type: 'retake' }
  /** The result given up, after the interface has asked. */
  | { type: 'discard' };

export const NO_SCAN: Scan = { step: 'picture' };

export function isPictureSize(size: PictureSize): boolean {
  return [size.width, size.height].every((side) => Number.isInteger(side) && side > 0);
}

/** The first corners: the whole picture. */
export function wholePicture(size: PictureSize): Corners {
  const { width, height } = size;
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

function clampPoint(point: Point, size: PictureSize): Point | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return { x: Math.min(size.width, Math.max(0, point.x)), y: Math.min(size.height, Math.max(0, point.y)) };
}

/** Twice the area the corners enclose, positive when they go round clockwise on the screen. */
function doubledArea(corners: Corners): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i as CornerIndex];
    const b = corners[((i + 1) % 4) as CornerIndex];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}

/**
 * Whether the corners make a crop that can be straightened: inside the picture,
 * in their order, convex, and not too small.
 *
 * Convex and in order is one test: every turn from one side to the next goes
 * the same way, clockwise on the screen. A corner dragged past its neighbour
 * makes a bow tie, and one dragged inward past the diagonal makes a dent; a
 * perspective transform maps neither onto a page.
 */
export function cornersValid(corners: Corners, size: PictureSize): boolean {
  if (!isPictureSize(size)) return false;
  for (const point of corners) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    if (point.x < 0 || point.y < 0 || point.x > size.width || point.y > size.height) return false;
  }
  for (let i = 0; i < 4; i++) {
    const a = corners[i as CornerIndex];
    const b = corners[((i + 1) % 4) as CornerIndex];
    const c = corners[((i + 2) % 4) as CornerIndex];
    const turn = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (!(turn > 0)) return false;
  }
  return doubledArea(corners) / 2 >= MIN_AREA_FRACTION * size.width * size.height;
}

/**
 * A corner dragged: kept inside the picture, and refused where it would break
 * the crop. Refused means the corner stays where it last was valid, so a finger
 * that drags too far sees the corner stop rather than jump.
 */
export function moveCorner(corners: Corners, index: CornerIndex, to: Point, size: PictureSize): Corners {
  if (![0, 1, 2, 3].includes(index)) return corners;
  const point = clampPoint(to, size);
  if (!point) return corners;
  const moved = corners.map((corner, i) => (i === index ? point : corner)) as unknown as Corners;
  return cornersValid(moved, size) ? moved : corners;
}

/** A result that would be lost: text recognised and not yet saved. */
export function scanUnsaved(scan: Scan): boolean {
  return (scan.step === 'result' && scan.text.trim() !== '') || scan.step === 'saving';
}

/** One step of the scan. An event that does not apply where it is changes nothing. */
export function scanStep(scan: Scan, event: ScanEvent): Scan {
  switch (event.type) {
    case 'picture': {
      if (scan.step !== 'picture' && scan.step !== 'saved') return scan;
      if (!isPictureSize(event.size)) return scan;
      /* The size and nothing else: whatever else came with it stays out of the state. */
      const size = { width: event.size.width, height: event.size.height };
      return { step: 'corners', size, corners: wholePicture(size), failed: false };
    }

    case 'move':
      if (scan.step !== 'corners') return scan;
      return { ...scan, corners: moveCorner(scan.corners, event.index, event.to, scan.size), failed: false };

    case 'recognise':
      if (scan.step !== 'corners' || !cornersValid(scan.corners, scan.size)) return scan;
      return { step: 'recognising', size: scan.size, corners: scan.corners };

    case 'recognised':
      if (scan.step !== 'recognising') return scan;
      return { step: 'result', size: scan.size, corners: scan.corners, text: event.text, saveFailed: false };

    case 'failed':
      if (scan.step !== 'recognising') return scan;
      return { step: 'corners', size: scan.size, corners: scan.corners, failed: true };

    case 'revise':
      if (scan.step !== 'result') return scan;
      return { ...scan, text: event.text, saveFailed: false };

    case 'save':
      if (scan.step !== 'result' || scan.text.trim() === '') return scan;
      return { step: 'saving', size: scan.size, corners: scan.corners, text: scan.text };

    case 'saved':
      if (scan.step !== 'saving') return scan;
      return event.ok
        ? { step: 'saved', text: scan.text }
        : { step: 'result', size: scan.size, corners: scan.corners, text: scan.text, saveFailed: true };

    case 'retake':
      return scan.step === 'result' || scan.step === 'saving' ? scan : NO_SCAN;

    case 'discard':
      return scan.step === 'result' ? NO_SCAN : scan;
  }
}
