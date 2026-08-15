/**
 * Lijena registracija editora.
 *
 * Registar mora znati KOJE formate editor pokriva prije nego se ijedan
 * dokument otvori — inače ne može odlučiti tko što otvara. Ali kod editora
 * ne treba do prvog otvaranja: pdf.js je sam 1,3 MB, što bi svaki korisnik
 * plaćao pri pokretanju i kad nikad ne otvori PDF.
 *
 * Zato se metapodaci registriraju odmah, a modul se dohvaća tek u
 * `createInstance`.
 */

import type { DocumentHandle, EditorHost, EditorInstance, EditorProvider } from '@uleditor/plugin-sdk';

type ProviderMeta = Omit<EditorProvider, 'createInstance'>;

export function lazyProvider(
  meta: ProviderMeta,
  load: () => Promise<{ default: EditorProvider }>,
): EditorProvider {
  let pending: Promise<EditorProvider> | null = null;

  return {
    ...meta,
    async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
      // Jedan dohvat po editoru, čak i kad se otvori više dokumenata odjednom.
      pending ??= load().then((module) => module.default);
      const provider = await pending;
      return provider.createInstance(host, doc);
    },
  };
}
