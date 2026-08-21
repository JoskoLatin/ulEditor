# Translating ulEditor

Every language is welcome, and a partial one is welcome too. You do not need to
finish before you contribute: an untranslated string falls back to English, so a
catalogue that is a third done works correctly for a third of the interface and
is honest about the rest. Send it, and someone else can carry it on.

You need no knowledge of programming. A catalogue is one JSON file: English on
the left, your language on the right.

```json
{
  "Open folder": "Abrir carpeta",
  "Save": "Guardar",
  "Page {n} of {total}": "Página {n} de {total}"
}
```

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

That writes `packages/i18n/locales/es.json` — every string in the program, in
the order it appears in the interface, with a blank beside each:

```json
{
  "Open folder": "",
  "Open files": "",
  "Folder": "",
```

Fill in the blanks. The text on the left is both the key and the English
original: leave it exactly as it is and write only between the quotes on the
right. Leave anything you are unsure of empty — empty means "not yet
translated", and the program shows the English.

The blank lines between blocks group the strings by where they appear: the frame,
search, the PDF toolbar, and so on. They are ordinary JSON whitespace, so you
may keep them, and nothing breaks if a tool removes them.

## Register it

Three lines in `packages/i18n/src/index.ts`:

```ts
import es from '../locales/es.json' with { type: 'json' };       // 1

export type Locale = 'en' | 'hr' | 'es';                         // 2

export const LOCALES: LocaleDescriptor[] = [
  { id: 'en', label: 'English', native: 'English' },
  { id: 'hr', label: 'Croatian', native: 'Hrvatski' },
  { id: 'es', label: 'Spanish', native: 'Español' },             // 3
];

export const CATALOGS: Record<Locale, Catalog> = { en: {}, hr, es };
```

`label` is the language name in English, for the list in settings; `native` is
its name in itself — that is what a speaker of the language recognises.

That is all of it. Everything else — the settings list, restoring the language
at startup, the check below — reads `LOCALES`.

## Check it

```bash
node tools/verify-i18n.mjs
```

It reports how much is done, lists what is left, and fails only on what is
actually broken: a mistyped comma, a duplicated line, a placeholder that moved.
Being unfinished is not a failure.

Then see it running:

```bash
pnpm dev          # http://localhost:5273 — pick the language in Ctrl+,
```

## The rules, all four of them

**Braces are placeholders.** `{n}`, `{name}`, `{total}` are replaced with real
values at run time. Every one on the left must appear on the right, spelled
identically. They may move within the sentence — word order is yours:

```json
  "Page {n} of {total}": "Página {n} de {total}",
  "Page {n} of {total}": "Página {num} de {total}",
  "Page {n} of {total}": "Página de {total}",
```

The first is right. The second reaches the reader as a literal `{num}`; in the
third the number vanishes. `verify-i18n.mjs` fails on both, because no type
system catches this and the damage is only visible at run time.

**Keyboard shortcuts stay as they are.** `Ctrl+S` is what the key on the
keyboard says. Translate the words around it:

```json
  "Save (Ctrl+S)": "Guardar (Ctrl+S)"
```

**Ellipsis and case are part of the string.** A trailing `…` means "this opens a
dialog" and is a convention users read without noticing. `"Open folder"` and
`"Open folder…"` are separate entries on purpose.

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

## Using a translation tool

The catalogues are flat JSON with the English as the key, which
[Weblate](https://weblate.org), [Crowdin](https://crowdin.com), Lokalise and
Poedit all read directly — point one at `packages/i18n/locales/` and pick the
plain "JSON file" format, not the nested or i18next variant. The keys are whole
English sentences and contain full stops, which a nested format would try to
read as separators.

## Sending it

A pull request with your catalogue and the three lines in `index.ts`. Say in the
description roughly how complete it is — `verify-i18n.mjs` prints the number.

The project is Apache-2.0, and your contribution comes in under the same
licence.

## Why it looks like this

The key is the English source text rather than an identifier like
`shell.tab.close.tooltip`. gettext works the same way, and the reasons are:

- An untranslated string falls back to **readable English** instead of to a code
  name. This is what makes a partial translation usable rather than embarrassing.
- The English catalogue is empty, so it cannot fall out of step with itself.
- You can read the file and know what you are translating, without hunting
  through the source for where a key is used.

The cost is that editing the English text severs the link to every translation.
So the English changes only when the meaning changes — and then the translations
needed rechecking anyway.
