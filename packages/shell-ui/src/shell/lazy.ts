/**
 * Lazy editor registration.
 *
 * The registry has to know WHICH formats an editor covers before any document is
 * opened — otherwise it cannot decide who opens what. But the editor's code is
 * not needed until the first open: pdf.js alone is 1.3 MB, which every user would
 * pay for at startup even if they never opened a PDF.
 *
 * So the metadata is registered immediately, while the module is fetched only in
 * `createInstance`.
 */

import type { DocumentHandle, EditorHost, EditorInstance, EditorProvider } from '@uleditor/plugin-sdk';

type ProviderMeta = Omit<EditorProvider, 'createInstance'>;

/** A module with one editor offers it as `default`; a package with several (Office) uses named exports. */
type LoadedProvider = EditorProvider | { default: EditorProvider };

export function lazyProvider(
  meta: ProviderMeta,
  load: () => Promise<LoadedProvider>,
): EditorProvider {
  let pending: Promise<EditorProvider> | null = null;

  return {
    ...meta,
    async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
      // One fetch per editor, even when several documents open at once.
      pending ??= load().then((module) => ('default' in module ? module.default : module));
      const provider = await pending;
      return provider.createInstance(host, doc);
    },
  };
}
