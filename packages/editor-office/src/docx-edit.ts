/**
 * Izmjena teksta u Word dokumentu — kirurški, po jednom runu.
 *
 * **Zašto run, a ne odlomak.** U OOXML-u je `w:r` komad teksta s jednim
 * formatiranjem. Odlomak ih zna imati desetak: podebljano ime, obična
 * rečenica, kurzivna napomena. Da se prepisuje odlomak, program bi morao
 * pogađati koje formatiranje ide na koje novo slovo — a to je upravo ono tiho
 * gubljenje tuđeg formatiranja koje projekt zabranjuje. Run se prepisuje bez
 * ijedne odluke: formatiranje mu ostaje, mijenja se samo tekst.
 *
 * **Zašto se XML ne serijalizira nanovo.** `XMLSerializer` bi prošao kroz
 * cijeli dokument i usput promijenio navodnike, prostore imena, redoslijed
 * atributa i prazan prostor. Razlika bi bila neusporediva s onim što je
 * korisnik tražio. Zato se radi zamjena **po rasponu bajtova**: sve osim
 * prepisanog teksta ostaje slovo za slovo isto.
 *
 * Ovdje nema DOM-a ni zipa, pa se isto vrti u pregledniku i u provjerama.
 */

import { strToU8, zipSync } from 'fflate';

import type { Archive } from './ooxml.js';

/* ── prolazak kroz oznake ────────────────────────────────────────────── */

interface Tag {
  /** Ime s prefiksom, kako stoji u datoteci: `w:r`, `w:t`. */
  name: string;
  start: number;
  end: number;
  closing: boolean;
  selfClosing: boolean;
}

/**
 * Redom vraća sve XML oznake s njihovim rasponima.
 *
 * Navodnici se poštuju jer vrijednost atributa smije sadržavati `>`, a
 * komentari i CDATA se preskaču u cijelosti — inače bi `<` unutar njih
 * izgledao kao početak oznake.
 */
function* scanTags(xml: string): Generator<Tag> {
  let i = 0;

  while (i < xml.length) {
    const open = xml.indexOf('<', i);
    if (open === -1) return;

    if (xml.startsWith('<!--', open)) {
      const close = xml.indexOf('-->', open);
      i = close === -1 ? xml.length : close + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', open)) {
      const close = xml.indexOf(']]>', open);
      i = close === -1 ? xml.length : close + 3;
      continue;
    }
    if (xml.startsWith('<?', open) || xml.startsWith('<!', open)) {
      const close = xml.indexOf('>', open);
      i = close === -1 ? xml.length : close + 1;
      continue;
    }

    let at = open + 1;
    let quote = '';
    while (at < xml.length) {
      const ch = xml[at]!;
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      at++;
    }
    if (at >= xml.length) return;

    const body = xml.slice(open + 1, at);
    const closing = body.startsWith('/');
    const selfClosing = body.endsWith('/');
    const name = body
      .replace(/^\//, '')
      .replace(/\/$/, '')
      .trim()
      .split(/[\s/]/, 1)[0]!;

    yield { name, start: open, end: at + 1, closing, selfClosing };
    i = at + 1;
  }
}

function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/* ── runovi ──────────────────────────────────────────────────────────── */

export interface RunSpan {
  /** Redni broj u dokumentu; isti redoslijed kao obilazak DOM stabla. */
  index: number;
  start: number;
  end: number;
  /** Raspon jedinog `w:t` elementa i njegova sadržaja. */
  text: { start: number; end: number; contentStart: number; contentEnd: number } | null;
  /** Zašto se ovaj run ne da prepisati; `null` kad se da. */
  refusal: string | null;
}

/**
 * Sadržaj koji run čini neprepisivim.
 *
 * Prijelom retka i tabulator nose položaj, a crtež, polje ili ugniježđeni run
 * nose vlastiti sadržaj — zamjena samog teksta bi ih pomaknula ili izgubila.
 * Takav run se i dalje čita, samo se ne nudi na izmjenu.
 */
const BLOCKING = new Set(['br', 'tab', 'drawing', 'pict', 'object', 'fldChar', 'instrText', 'ruby']);

/** Nalazi sve `w:r` elemente u dokumentu, redom. */
export function findRuns(xml: string): RunSpan[] {
  const runs: RunSpan[] = [];
  /** Otvoreni runovi; unutarnji je zadnji. Crteži znaju sadržavati runove. */
  const open: { span: RunSpan; texts: RunSpan['text'][]; blocked: Set<string> }[] = [];
  let pendingText: { start: number; contentStart: number } | null = null;

  for (const tag of scanTags(xml)) {
    const local = localName(tag.name);

    if (local === 'r' && !tag.closing) {
      const span: RunSpan = { index: runs.length, start: tag.start, end: tag.end, text: null, refusal: null };
      runs.push(span);
      if (!tag.selfClosing) open.push({ span, texts: [], blocked: new Set() });
      else span.refusal = 'run je prazan';
      continue;
    }

    const current = open[open.length - 1];

    if (local === 'r' && tag.closing) {
      const finished = open.pop();
      if (!finished) continue;

      finished.span.end = tag.end;
      if (finished.blocked.size > 0) {
        finished.span.refusal = `sadrži ${[...finished.blocked].join(', ')}`;
      } else if (finished.texts.length === 0) {
        finished.span.refusal = 'run nema teksta';
      } else if (finished.texts.length > 1) {
        // Word zna razbiti riječ na više `w:t` nakon provjere pravopisa.
        finished.span.refusal = 'tekst je razbijen na više dijelova';
      } else {
        finished.span.text = finished.texts[0] ?? null;
      }

      // Run unutar runa čini vanjski neprepisivim, jer nosi tuđi sadržaj.
      open[open.length - 1]?.blocked.add('ugniježđeni run');
      continue;
    }

    if (!current) continue;

    if (local === 't') {
      if (tag.closing) {
        if (pendingText) {
          current.texts.push({
            start: pendingText.start,
            end: tag.end,
            contentStart: pendingText.contentStart,
            contentEnd: tag.start,
          });
          pendingText = null;
        }
        continue;
      }
      if (tag.selfClosing) {
        // `<w:t/>` je prazan tekst; sadržaj se ubacuje između oznaka.
        current.texts.push({
          start: tag.start,
          end: tag.end,
          contentStart: tag.end,
          contentEnd: tag.end,
        });
        continue;
      }
      pendingText = { start: tag.start, contentStart: tag.end };
      continue;
    }

    if (!tag.closing && BLOCKING.has(local)) current.blocked.add(local);
  }

  return runs;
}

/* ── tekst ───────────────────────────────────────────────────────────── */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function unescapeXml(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) return String.fromCodePoint(Number(body.slice(1)));
    return ENTITIES[body] ?? whole;
  });
}

export function escapeXml(text: string): string {
  return text.replace(/[&<>]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));
}

export function runText(xml: string, run: RunSpan): string {
  if (!run.text) return '';
  return unescapeXml(xml.slice(run.text.contentStart, run.text.contentEnd));
}

/* ── zapis ───────────────────────────────────────────────────────────── */

export interface RunEdit {
  index: number;
  text: string;
}

/**
 * Upisuje nove tekstove u dokument, mijenjajući samo njihove raspone.
 *
 * Ide od kraja prema početku da se odmaci ne pomaknu ispod nogu. Novi element
 * uvijek dobiva `xml:space="preserve"`: bez toga Word odbacuje vodeći i
 * završni razmak, pa bi „ime ” tiho postalo „ime”.
 */
export function applyRunEdits(xml: string, runs: RunSpan[], edits: RunEdit[]): string {
  const byIndex = new Map(runs.map((run) => [run.index, run]));

  const ordered = [...edits]
    .map((edit) => ({ edit, run: byIndex.get(edit.index) }))
    .filter((pair): pair is { edit: RunEdit; run: RunSpan } => !!pair.run?.text && !pair.run.refusal)
    .sort((a, b) => b.run.text!.start - a.run.text!.start);

  let out = xml;
  for (const { edit, run } of ordered) {
    const span = run.text!;
    out =
      out.slice(0, span.start) +
      `<w:t xml:space="preserve">${escapeXml(edit.text)}</w:t>` +
      out.slice(span.end);
  }
  return out;
}

/**
 * Sastavlja novi `.docx` s izmijenjenim tekstom.
 *
 * Svi ostali dijelovi arhive prolaze **nedirnuti**: stilovi, numeriranje,
 * slike, zaglavlja, metapodaci. Mijenja se točno jedan dio, i unutar njega
 * točno oni rasponi koje je korisnik prepisao.
 */
export function writeDocx(archive: Archive, runs: RunSpan[], xml: string, edits: RunEdit[]): Uint8Array {
  const next: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(archive)) next[path] = data;
  next['word/document.xml'] = strToU8(applyRunEdits(xml, runs, edits));
  return zipSync(next);
}
