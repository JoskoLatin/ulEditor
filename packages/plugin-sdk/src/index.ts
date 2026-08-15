/**
 * @uleditor/plugin-sdk — javni ugovor između shella i editora.
 *
 * Editor koji ovisi samo o ovom paketu radi neizmijenjen na desktopu,
 * webu i mobitelu. Sve što je platformski specifično krije se iza
 * `EditorHost`.
 */

export * from './events.js';
export * from './format.js';
export * from './fs.js';
export * from './clipboard.js';
export * from './host.js';
export * from './editor.js';

/** Verzija ugovora. Editori je smiju provjeriti pri registraciji. */
export const SDK_VERSION = '0.1.0';
