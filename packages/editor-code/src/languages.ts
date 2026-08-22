/**
 * Languages are loaded lazily. Without this every language package lands in the
 * initial bundle — with two dozen languages that is a few hundred kilobytes the
 * user pays for on every start, most of them for a file they will never open.
 *
 * The set has to cover everything `detect` can name. It did not: `.sh`, `.yaml`,
 * `.toml`, `.go`, `.rb`, `.swift` and `.lua` were recognised and then opened as
 * grey text, because a language with no loader here falls through silently.
 * `tools/verify-languages.mjs` compares the two lists now.
 *
 * Two kinds of loader. The dedicated `lang-*` packages carry a real Lezer
 * grammar and give structure — folding, indentation, autocomplete. The legacy
 * modes are the CodeMirror 5 tokenisers, which only colour; that is the whole
 * of what exists for shell, YAML and the rest, and colouring is the point.
 */

import type { Extension } from '@codemirror/state';

type Loader = () => Promise<Extension>;

/** A CodeMirror 5 tokeniser, wrapped for CodeMirror 6. */
async function legacy(name: string, load: () => Promise<Record<string, unknown>>): Promise<Extension> {
  const { StreamLanguage } = await import('@codemirror/language');
  const mode = (await load())[name];
  return StreamLanguage.define(mode as Parameters<typeof StreamLanguage.define>[0]);
}

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

  shell: () => legacy('shell', () => import('@codemirror/legacy-modes/mode/shell')),
  powershell: () => legacy('powerShell', () => import('@codemirror/legacy-modes/mode/powershell')),
  yaml: () => legacy('yaml', () => import('@codemirror/legacy-modes/mode/yaml')),
  toml: () => legacy('toml', () => import('@codemirror/legacy-modes/mode/toml')),
  go: () => legacy('go', () => import('@codemirror/legacy-modes/mode/go')),
  ruby: () => legacy('ruby', () => import('@codemirror/legacy-modes/mode/ruby')),
  swift: () => legacy('swift', () => import('@codemirror/legacy-modes/mode/swift')),
  lua: () => legacy('lua', () => import('@codemirror/legacy-modes/mode/lua')),
  dockerfile: () => legacy('dockerFile', () => import('@codemirror/legacy-modes/mode/dockerfile')),
  properties: () => legacy('properties', () => import('@codemirror/legacy-modes/mode/properties')),
  diff: () => legacy('diff', () => import('@codemirror/legacy-modes/mode/diff')),

  /* Ours — nothing anywhere has a mode for batch. See batch.ts. */
  batch: async () => (await import('./batch.js')).batch,
};

/** Every language this editor can colour, for the check that compares the list
 *  with what `detect` is able to name. */
export const LANGUAGE_IDS: string[] = Object.keys(LOADERS).sort();

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
