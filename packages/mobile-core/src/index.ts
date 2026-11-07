/**
 * @uleditor/mobile-core — the rules of the mobile shell, without the shell.
 *
 * What all three interfaces (Arak, Palac, Četiri boje) do the same way, held
 * once and checked in Node: Back and the stack of layers, the keyboard's inset,
 * the pile of open documents, where each document was left, the phone's
 * settings, correcting one target, a scan, a note's name and the folding of
 * Croatian letters for a search (ADR 0009, `packages/mobile-core`).
 *
 * Pure TypeScript: no React, no DOM (the `lib` of its `tsconfig.json` has none),
 * no Tauri, no dependency. The adapters to `history`, `visualViewport` and the
 * settings live in `shell-ui/src/mobile/common`.
 */

export * from './store.js';
export * from './layers.js';
export * from './keyboard.js';
export * from './documents.js';
export * from './memory.js';
export * from './prefs.js';
export * from './edit-session.js';
export * from './scan.js';
export * from './notes.js';
export * from './fold.js';
