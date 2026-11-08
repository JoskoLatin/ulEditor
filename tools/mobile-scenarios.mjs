/**
 * The mobile shell's scenarios as data: the steps and what has to hold after
 * them, once for every interface (ADR 0009, testing level C).
 *
 * A step is one of:
 *
 * - `{ library: [ids], blocked? }` — the library, as Rust's look at the device
 *   would give it; in a browser stood in for by `ul-check-library`;
 * - `{ do: action, name? | text? | answer? }` — something the person does, which
 *   each interface's driver (`tools/mobile-drivers/<ui>.mjs`) turns into taps;
 * - `{ expect: {…} }` — a part of the driver's `state()` that has to match;
 * - `{ keyboard: 'up' | 'down' }` — the system's keyboard, stood in for in a
 *   browser by a smaller `visualViewport`;
 * - `{ check: name }` — a measure the harness takes: `fieldAboveKeyboard`,
 *   `questionAboveKeyboard`, `hitInView`;
 * - `{ shot: name }` — a screenshot, at 448 px in both schemes.
 *
 * The state is the interface's, said in words every interface has: `place` is
 * `wall` (the library), `document`, `tools` (the layer with the tools and the
 * other open documents) or `find`; `left` is true once Back has left the app.
 * The actions are the same words: `openFromLibrary`, `openTools`, `openFind`,
 * `type`, `nextHit`, `previousHit`, `closeFind`, `bringToFront`, `putAway`,
 * `toWall`, `dismissHint`, `typeInDocument`, `answer`, `back`.
 *
 * K6a covers reading: Use 1 of the ADR, several documents, Back, a question and
 * the library without permission. Correcting, the note and the camera come
 * with K4, K5 and K6.
 */

import { MD_SOURCE, makeDocx, makeMultiPagePdf, makePdf, makeXlsx } from './fixtures.mjs';

/** The moment the checks run at: a Thursday, so today, this week and earlier months all have something. */
export const NOW = '2026-11-05T10:00:00+01:00';

/** The documents on the "device", from the repository's own fixtures; never anyone's real files. */
export const FIXTURES = {
  pdf: { name: 'Six pages.pdf', folder: 'Download', modified: '2026-11-05T08:30:00+01:00', bytes: () => makeMultiPagePdf(6) },
  md: { name: 'Notes.md', folder: 'Documents', modified: '2026-11-05T07:15:00+01:00', bytes: () => MD_SOURCE },
  docx: { name: 'Letter.docx', folder: 'Documents', modified: '2026-11-03T16:00:00+01:00', bytes: () => makeDocx() },
  xlsx: { name: 'Budget.xlsx', folder: 'Documents', modified: '2026-10-12T09:00:00+02:00', bytes: () => makeXlsx() },
  old: { name: 'Report.pdf', folder: 'Download', modified: '2025-06-20T12:00:00+02:00', bytes: () => makePdf('Report') },
  /* A camera's photograph, as a phone holds hundreds of: one pixel of PNG. */
  photo: {
    name: 'IMG_20261104_181502.png',
    folder: 'DCIM/Camera',
    modified: '2026-11-04T18:15:02+01:00',
    bytes: () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  },
};

const ALL = ['pdf', 'md', 'docx', 'xlsx', 'old', 'photo'];

export const SCENARIOS = [
  {
    id: 'read-pdf',
    title: 'open a PDF from the wall and read it',
    steps: [
      { library: ALL },
      {
        expect: {
          place: 'wall',
          groups: [
            { id: 'today', title: 'Danas', names: ['Six pages.pdf', 'Notes.md'] },
            { id: 'week', title: 'Ovaj tjedan', names: ['Letter.docx'] },
            { id: '2026-10', title: 'Listopad', names: ['Budget.xlsx'] },
            { id: '2025-06', title: 'Lipanj 2025.', names: ['Report.pdf'] },
          ],
          pictures: { count: 1, shown: false },
        },
      },
      { shot: 'zid' },
      /* Pictures wait behind their button, and come out on a tap, by date as the documents do. */
      { do: 'togglePictures' },
      {
        expect: {
          pictures: { count: 1, shown: true },
          groups: [
            { id: 'today' },
            { id: 'week' },
            { id: '2026-10' },
            { id: '2025-06' },
            { id: 'pictures-week', title: 'Ovaj tjedan', names: ['IMG_20261104_181502.png'] },
          ],
        },
      },
      { do: 'togglePictures' },
      { expect: { pictures: { count: 1, shown: false } } },
      { do: 'openFromLibrary', name: 'Six pages.pdf' },
      { expect: { place: 'document', front: 'Six pages.pdf', shown: true, hint: 'pdf', layers: 1, entries: 1 } },
      { shot: 'list-ceduljica' },
      { do: 'dismissHint' },
      { expect: { place: 'document', hint: null } },
      { do: 'back' },
      { expect: { place: 'wall', open: ['Six pages.pdf'], layers: 0, entries: 0 } },
      { do: 'openFromLibrary', name: 'Six pages.pdf' },
      { expect: { place: 'document', front: 'Six pages.pdf', hint: null } },
      { do: 'back' },
      { do: 'back' },
      { expect: { left: true } },
    ],
  },
  {
    id: 'find',
    title: 'find a word: the strip above the keyboard, the count, next and previous',
    steps: [
      { library: ALL },
      { do: 'openFromLibrary', name: 'Six pages.pdf' },
      { do: 'dismissHint' },
      { do: 'openTools' },
      { expect: { place: 'tools', front: 'Six pages.pdf', state: 'readonly', pile: [] } },
      { shot: 'stol' },
      { do: 'openFind' },
      { expect: { place: 'find', layers: 2, entries: 2, focus: 'find-field' } },
      { keyboard: 'up' },
      { do: 'type', text: 'page' },
      { expect: { find: { current: 1, total: 6, text: '1 od 6' } } },
      { check: 'fieldAboveKeyboard' },
      { check: 'hitInView' },
      { do: 'nextHit' },
      { do: 'nextHit' },
      { expect: { find: { current: 3, total: 6, text: '3 od 6' }, focus: 'find-field' } },
      { check: 'hitInView' },
      { shot: 'crta' },
      { do: 'previousHit' },
      { expect: { find: { current: 2, total: 6 } } },
      { do: 'previousHit' },
      { do: 'previousHit' },
      { expect: { find: { current: 6, total: 6 } } },
      { do: 'back' },
      { expect: { place: 'document', find: null, layers: 1, entries: 1 } },
      { keyboard: 'down' },
      { do: 'openFind' },
      { do: 'type', text: 'nowhere' },
      { expect: { find: { current: 0, total: 0, text: 'nema pogodaka' } } },
      { do: 'closeFind' },
      { expect: { place: 'document', layers: 1, entries: 1 } },
    ],
  },
  {
    id: 'office',
    title: 'a .docx and an .xlsx open, read-only as today, each with its first hint',
    steps: [
      { library: ALL },
      { do: 'openFromLibrary', name: 'Letter.docx' },
      { expect: { place: 'document', front: 'Letter.docx', shown: true, hint: 'text' } },
      { do: 'openTools' },
      { expect: { place: 'tools', state: 'readonly', hint: null } },
      { do: 'back' },
      { do: 'back' },
      { expect: { place: 'wall', open: ['Letter.docx'] } },
      { do: 'openFromLibrary', name: 'Budget.xlsx' },
      { expect: { place: 'document', front: 'Budget.xlsx', shown: true, hint: 'sheet' } },
      { do: 'dismissHint' },
      { do: 'back' },
      { expect: { place: 'wall', open: ['Budget.xlsx', 'Letter.docx'] } },
    ],
  },
  {
    id: 'pile',
    title: 'three documents on the pile: switch, put one away, back to the wall',
    steps: [
      { library: ALL },
      { do: 'openFromLibrary', name: 'Six pages.pdf' },
      { do: 'back' },
      { do: 'openFromLibrary', name: 'Letter.docx' },
      { do: 'back' },
      { do: 'openFromLibrary', name: 'Budget.xlsx' },
      { do: 'openTools' },
      { expect: { place: 'tools', front: 'Budget.xlsx', pile: ['Letter.docx', 'Six pages.pdf'] } },
      { shot: 'hrpa' },
      { do: 'bringToFront', name: 'Six pages.pdf' },
      { expect: { place: 'document', front: 'Six pages.pdf', layers: 1, entries: 1 } },
      { do: 'openTools' },
      { expect: { pile: ['Budget.xlsx', 'Letter.docx'] } },
      { do: 'putAway' },
      { expect: { place: 'document', front: 'Budget.xlsx', open: ['Budget.xlsx', 'Letter.docx'], layers: 1, entries: 1 } },
      { do: 'openTools' },
      { do: 'toWall' },
      { expect: { place: 'wall', open: ['Budget.xlsx', 'Letter.docx'], layers: 0, entries: 0 } },
    ],
  },
  {
    id: 'back',
    title: 'Back through every layer down to the wall, and then out',
    steps: [
      { library: ALL },
      { do: 'openFromLibrary', name: 'Six pages.pdf' },
      { do: 'openTools' },
      { expect: { place: 'tools', layers: 2, entries: 2 } },
      { do: 'back' },
      { expect: { place: 'document', layers: 1, entries: 1 } },
      { do: 'openFind' },
      { expect: { place: 'find', layers: 2, entries: 2 } },
      { do: 'back' },
      { expect: { place: 'document', layers: 1, entries: 1 } },
      { do: 'back' },
      { expect: { place: 'wall', layers: 0, entries: 0, open: ['Six pages.pdf'] } },
      { do: 'back' },
      { expect: { left: true } },
    ],
  },
  {
    id: 'question',
    title: 'unsaved work put away: the question above the keyboard, Back as its Cancel',
    steps: [
      { library: ALL },
      { do: 'openFromLibrary', name: 'Notes.md' },
      { do: 'dismissHint' },
      { do: 'typeInDocument', text: 'x' },
      { keyboard: 'up' },
      { do: 'openTools' },
      { expect: { place: 'tools', state: 'dirty' } },
      { do: 'putAway' },
      { expect: { question: { actions: [{ cancel: true }, { cancel: false }, { cancel: false }] }, layers: 3, entries: 3 } },
      { check: 'questionAboveKeyboard' },
      { shot: 'pitanje' },
      { do: 'back' },
      { expect: { question: null, notice: null, place: 'tools', front: 'Notes.md', state: 'dirty', layers: 2, entries: 2 } },
      { keyboard: 'down' },
      { do: 'putAway' },
      { do: 'answer', answer: 1 },
      { expect: { question: null, notice: null, place: 'wall', open: [], layers: 0, entries: 0 } },
    ],
  },
  {
    id: 'permission',
    title: 'Android hides the documents: an honest sheet, no button into Android',
    steps: [
      { library: [], blocked: true },
      { expect: { place: 'wall', permission: { controls: ['library-rescan'] }, groups: [] } },
      { shot: 'dozvola' },
    ],
  },
];
