/**
 * Languages are loaded lazily. Without this every language package lands in the
 * initial bundle — with fifteen languages that is a few hundred kilobytes the
 * user pays for on every start.
 */

import type { Extension } from '@codemirror/state';

type Loader = () => Promise<Extension>;

const LOADERS: Record<string, Loader> = {
  typescript: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true }),
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  json: async () => (await import('@codemirror/lang-json')).json(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  python: async () => (await import('@codemirror/lang-python')).python(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  php: async () => (await import('@codemirror/lang-php')).php(),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
};

export function hasLanguage(language: string | undefined): boolean {
  return !!language && language in LOADERS;
}

export async function loadLanguage(language: string | undefined): Promise<Extension | null> {
  if (!language) return null;
  const loader = LOADERS[language];
  if (!loader) return null;
  try {
    return await loader();
  } catch (err) {
    console.warn(`[uleditor] language "${language}" failed to load`, err);
    return null;
  }
}
