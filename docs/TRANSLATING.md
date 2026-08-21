# Translating ulEditor

Every language is welcome, and a partial one is welcome too. You do not need to
finish before you contribute: an untranslated string falls back to English, so a
catalogue that is a third done works correctly for a third of the interface and
is honest about the rest. Send it, and someone else can carry it on.

You need no knowledge of TypeScript. A catalogue is a list of English sentences
with a blank beside each one.

## Start a language

Install once — Node 20 or newer, and [pnpm](https://pnpm.io):

```bash
git clone https://github.com/JoskoLatin/ulEditor
cd ulEditor
pnpm install
```

Then generate a catalogue for your language, using its
[ISO 639-1 code](https://en.wikipedia.org/wiki/List_of_ISO_639_language_codes)
(`es`, `de`, `fr`, `pl`, `pt-BR`…):

```bash
node tools/i18n-template.mjs es
```

That writes `packages/i18n/src/es.ts` — every string in the program, in the same
order and under the same headings as the English:

```ts
export const es: Catalog = {
  /* ── frame ─────────────────────────────────────────────────────────── */
  'Open folder': '',
  'Open files': '',
  Folder: '',
```

Fill in the blanks. The text on the left is the key **and** the English original;
leave it exactly as it is and write only between the quotes on the right:

```ts
  'Open folder': 'Abrir carpeta',
```

Leave anything you are unsure of empty. Empty means "not yet translated", and
the program shows the English.

## Register it

Four lines in `packages/i18n/src/index.ts`:

```ts
import { es } from './es.js';                                    // 1

export type Locale = 'en' | 'hr' | 'es';                         // 2

export const LOCALES: LocaleDescriptor[] = [
  { id: 'en', label: 'English', native: 'English' },
  { id: 'hr', label: 'Croatian', native: 'Hrvatski' },
  { id: 'es', label: 'Spanish', native: 'Español' },             // 3
];

export const CATALOGS: Record<Locale, Catalog> = { en: {}, hr, es };  // 4
```

`label` is the language name in English, for the list in settings; `native` is
its name in itself — that is what a speaker of the language recognises.

That is all of it. Everything else — the settings list, restoring the language at
startup, the check below — reads `LOCALES`.

## Check it

```bash
node tools/verify-i18n.mjs
```

It reports how much is done, lists what is left, and fails on the things that
are actually broken. Then see it running:

```bash
pnpm dev          # http://localhost:5273 — pick the language in Ctrl+,
```

## The rules, all four of them

**Braces are placeholders.** `{n}`, `{name}`, `{total}` are replaced with real
values at run time. Every one on the left must appear on the right, spelled
identically. They may move within the sentence — word order is yours:

```ts
  'Page {n} of {total}': 'Página {n} de {total}',        // ✓
  'Page {n} of {total}': 'Página {num} de {total}',      // ✗ the reader sees "{num}"
  'Page {n} of {total}': 'Página de {total}',            // ✗ the number vanishes
```

`verify-i18n.mjs` fails on this, because no type system catches it and the
result reaches the user as literal braces.

**Keyboard shortcuts stay as they are.** `Ctrl+S` is what the key on the
keyboard says. Translate the words around it:

```ts
  'Save (Ctrl+S)': 'Guardar (Ctrl+S)',
```

**Ellipsis and case are part of the string.** A trailing `…` means "this opens a
dialog" and is a convention users read without noticing. `'Open folder'` and
`'Open folder…'` are separate entries on purpose.

**Translate the meaning, not the words.** These are buttons and messages a
person reads while working, not documentation. If your language says something
in three words that English says in six, use three.

## Keeping up

When the program gains new strings, add them without touching your work:

```bash
node tools/i18n-template.mjs es --update
```

Existing translations are kept, new strings arrive empty, and strings that no
longer exist are dropped. It says how many of each.

## Sending it

A pull request with your catalogue and the four lines in `index.ts`. Say in the
description roughly how complete it is — `verify-i18n.mjs` prints the number.

The project is Apache-2.0, and your contribution comes in under the same
licence.

## Why it looks like this

The key is the English source text rather than an identifier like
`shell.tab.close.tooltip`. gettext works the same way, and the reasons are:

- An untranslated string falls back to **readable English** instead of to a code
  name. This is what makes a partial translation usable rather than embarrassing.
- The English catalogue is empty, so it cannot fall out of step with itself.
- You can read the file and know what you are translating, without hunting for
  where a key is used.

The cost is that editing the English text severs the link to every translation.
So the English changes only when the meaning changes — and then the translations
needed rechecking anyway.
