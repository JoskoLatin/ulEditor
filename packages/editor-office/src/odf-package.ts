/**
 * Putting an OpenDocument package back together.
 *
 * This is the one rule a text document and a spreadsheet share exactly, which is
 * why it lives here rather than in either editor: **`mimetype` goes back first
 * and uncompressed.** It is not a formality. That entry, stored rather than
 * deflated and written before anything else, is what lets a program say what the
 * file is from its opening bytes without unpacking it — which is how this
 * program's own detection recognises one. A rebuilt archive that deflates it, or
 * writes it second, is a file every other office suite opens and ours does not.
 *
 * Everything else passes through as the bytes it arrived as. Only `content.xml`
 * is replaced, and inside it only the ranges the person rewrote — see
 * [`ods-edit.ts`](./ods-edit.ts) for the cells and [`odt-edit.ts`](./odt-edit.ts)
 * for the text.
 */

import { strToU8, zipSync } from 'fflate';

import type { Archive } from './ooxml.js';

export function writeOdf(archive: Archive, contentXml: string): Uint8Array {
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};

  const mimetype = archive['mimetype'];
  if (mimetype) files['mimetype'] = [mimetype, { level: 0 }];

  for (const [path, data] of Object.entries(archive)) {
    if (path === 'mimetype') continue;
    files[path] = data;
  }
  files['content.xml'] = strToU8(contentXml);

  return zipSync(files as Parameters<typeof zipSync>[0]);
}
