/**
 * @uleditor/plugin-sdk — the public contract between the shell and the editors.
 *
 * An editor that depends on this package alone runs unchanged on desktop, web
 * and mobile. Everything platform-specific hides behind `EditorHost`.
 */

export * from './events.js';
export * from './format.js';
export * from './fs.js';
export * from './clipboard.js';
export * from './host.js';
export * from './reading.js';
export * from './editor.js';

/** The contract version. Editors may check it when registering. */
export const SDK_VERSION = '0.1.0';
