/**
 * What an EPS or PostScript file says about itself, read without running it.
 *
 * PostScript is a program, and nothing in a browser or on a phone runs one
 * (ADR 0007). Two things can be shown all the same:
 *
 * - **The preview a DOS EPS carries.** Illustrator and CorelDRAW save an EPS
 *   with a TIFF of itself beside the PostScript, for programs that cannot run
 *   it. `ul-image` cuts it out and decodes it (`images.preview`); this only
 *   tells whether there is a container to ask about.
 * - **Its own comments.** The Document Structuring Conventions put the title,
 *   the program that wrote it, the date and the drawing's bounds in `%%` lines
 *   at the top — the same facts LibreOffice's placeholder shows.
 *
 * Pure, with no DOM, so that it is checked in Node (`tools/verify-eps.mjs`).
 * Every number in a DOS EPS header is the file's word, so each is checked
 * before it is used, and what is shown is printable ASCII only, cut short: a
 * comment line is somebody else's text in this page.
 */

/** The first four bytes of a DOS EPS file. */
const DOS_EPS = [0xc5, 0xd0, 0xd3, 0xc6];

/** How far into the PostScript the comments are looked for. */
const HEAD = 4096;

/** The most of any one comment that is shown. */
const LONGEST = 200;

export function isDosEps(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && DOS_EPS.every((value, i) => bytes[i] === value);
}

/**
 * The PostScript of a file: in a DOS EPS the section its header names, where
 * that lies wholly inside the file; otherwise the file itself.
 */
export function postscriptOf(bytes: Uint8Array): Uint8Array {
  if (!isDosEps(bytes)) return bytes;
  if (bytes.length < 12) return new Uint8Array(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = view.getUint32(4, true);
  const length = view.getUint32(8, true);
  if (start > bytes.length || length > bytes.length - start) return new Uint8Array(0);
  return bytes.subarray(start, start + length);
}

/** Whether the bytes are PostScript a person could read the comments of. */
export function isPostscript(bytes: Uint8Array): boolean {
  const head = postscriptOf(bytes);
  return head.length >= 2 && head[0] === 0x25 && head[1] === 0x21; // %!
}

export interface DscFields {
  title?: string;
  creator?: string;
  creationDate?: string;
  boundingBox?: string;
}

const KEYS: Record<string, keyof DscFields> = {
  Title: 'title',
  Creator: 'creator',
  CreationDate: 'creationDate',
  BoundingBox: 'boundingBox',
};

/**
 * The four comments, from the first 4 KiB of the PostScript: the first of
 * each, printable ASCII only, without the parentheses PostScript strings are
 * written in, at most 200 characters. `(atend)` — "given at the end" — is not
 * a value, and is left out rather than looked for.
 */
export function dscFields(bytes: Uint8Array): DscFields {
  const head = postscriptOf(bytes).subarray(0, HEAD);
  let text = '';
  for (const byte of head) text += String.fromCharCode(byte);

  const fields: DscFields = {};
  for (const line of text.split(/\r\n|\r|\n/)) {
    const match = /^%%(Title|Creator|CreationDate|BoundingBox):(.*)$/.exec(line);
    const key = match && KEYS[match[1] ?? ''];
    if (!key || fields[key] !== undefined) continue;
    let value = (match[2] ?? '').replace(/[^\x20-\x7e]/g, '').trim();
    if (value.startsWith('(') && value.endsWith(')')) value = value.slice(1, -1).trim();
    if (!value || value === 'atend') continue;
    fields[key] = value.length > LONGEST ? `${value.slice(0, LONGEST)}…` : value;
  }
  return fields;
}
