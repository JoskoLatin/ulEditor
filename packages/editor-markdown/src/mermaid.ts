/**
 * Diagrams in Markdown — a ```mermaid fence drawn instead of printed.
 *
 * Three facts shape this file:
 *
 * 1. **Mermaid is megabytes**, and almost no Markdown holds a diagram. So it is
 *    imported the first time a fence is actually on the page, never when the
 *    editor mounts — the rule the language modes and the 3D viewer already
 *    follow.
 * 2. **The preview is rebuilt on every keystroke.** Drawing takes long enough to
 *    see, so a drawn diagram is kept, keyed by its own source *and* the theme it
 *    was drawn in — the colours are baked into the SVG. Typing in the paragraph
 *    below redraws nothing.
 * 3. **A diagram with a mistake in it has to say so.** Mermaid throws on a
 *    syntax error, and a preview that swallows that leaves a blank where the
 *    picture should be — which looks exactly like a diagram that drew nothing.
 *    The message goes on the page instead, with the source beneath it, in the
 *    space the picture would have taken.
 */

import DOMPurify from 'dompurify';
import { t } from '@uleditor/i18n';

/** Only what is used here, so the dynamic import needs no types of its own. */
type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
};

type Drawn = { ok: true; svg: string } | { ok: false; detail: string };

/** Where a fence lands after markdown-it: `<pre><code class="language-mermaid">`. */
const FENCE = 'pre > code.language-mermaid';

const cache = new Map<string, Drawn>();

let api: MermaidApi | null = null;
let initialisedFor: string | null = null;
let counter = 0;

/** Whether the page holds a diagram at all — asked before mermaid is fetched. */
export function hasDiagram(root: HTMLElement): boolean {
  return root.querySelector(FENCE) !== null;
}

async function mermaidFor(theme: 'light' | 'dark'): Promise<MermaidApi> {
  api ??= ((await import('mermaid')).default as unknown) as MermaidApi;
  if (initialisedFor !== theme) {
    api.initialize({
      startOnLoad: false,
      // Mermaid sanitises its own output at this level and refuses the `click`
      // directive, which can otherwise call a function in the page. Ours below
      // is not the only guard, and this is the cheaper one.
      securityLevel: 'strict',
      // Without this, a diagram that fails to parse is replaced by mermaid's own
      // error picture — drawn into the page, in English, over the top of what we
      // are about to say ourselves.
      suppressErrorRendering: true,
      theme: theme === 'dark' ? 'dark' : 'default',
      // A label in a `foreignObject` is HTML inside the picture, and it survives
      // neither the sanitiser below nor the reading flow, which paginates by
      // measuring what it can see. `<text>` survives both.
      //
      // The top-level flag is the one that decides it. With only the per-diagram
      // ones set, the flowchart renderer still wrote its node labels as HTML —
      // and since the sanitiser then took the `foreignObject` away, every box
      // came out empty while the edge labels, which had obeyed, stayed. A
      // diagram of blank boxes is worse than none: it looks like a drawing
      // that simply has nothing written on it.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      class: { htmlLabels: false },
      fontFamily: 'inherit',
    });
    initialisedFor = theme;
  }
  return api;
}

/**
 * Mermaid's stylesheet is a `<style>` element inside the `<svg>`, so stripping
 * that tag — as the Markdown pass does, where a document's own CSS has no
 * business restyling the application — would leave a colourless tangle of
 * lines. Here it is mermaid's own CSS and nothing else, and the sanitiser still
 * takes every script, every event handler and every foreign protocol with it.
 */
function clean(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
  });
}

function detailOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** The message and the source, in the place the picture would have taken. */
function failure(source: string, detail: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'ul-md-diagram-error';

  const title = document.createElement('p');
  title.className = 'title';
  title.textContent = t('This diagram could not be drawn.');

  const why = document.createElement('p');
  why.className = 'why';
  why.textContent = detail;

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = source;
  pre.appendChild(code);

  box.append(title, why, pre);
  return box;
}

function picture(svg: string): HTMLElement {
  const figure = document.createElement('div');
  figure.className = 'ul-md-diagram';
  // Sanitised in `clean`, which is the only route into this function.
  figure.innerHTML = svg;
  return figure;
}

function replace(code: Element, node: HTMLElement): void {
  const pre = code.parentElement;
  (pre ?? code).replaceWith(node);
}

/**
 * Draws every fence in the given roots. The preview and the reading layer hold
 * the same rendered Markdown, so both are passed at once and a diagram drawn
 * for one is taken out of the cache by the other.
 */
export async function drawDiagrams(roots: HTMLElement[], theme: 'light' | 'dark'): Promise<void> {
  const fences = roots.flatMap((root) => [...root.querySelectorAll(FENCE)]);
  if (fences.length === 0) return;

  let mermaid: MermaidApi;
  try {
    mermaid = await mermaidFor(theme);
  } catch (err) {
    // The chunk did not load. Every fence says so rather than one of them.
    const detail = detailOf(err);
    for (const code of fences) replace(code, failure(code.textContent ?? '', detail));
    return;
  }

  for (const code of fences) {
    const source = code.textContent ?? '';
    if (!source.trim()) continue;

    const key = `${theme}\n${source}`;
    let result = cache.get(key);

    if (result === undefined) {
      const id = `ul-mermaid-${++counter}`;
      try {
        result = { ok: true, svg: clean((await mermaid.render(id, source)).svg) };
      } catch (err) {
        result = { ok: false, detail: detailOf(err) };
      }
      // Mermaid measures text by putting a temporary element in the body, and a
      // render that threw halfway does not always take it back out.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
      cache.set(key, result);
    }

    replace(code, result.ok ? picture(result.svg) : failure(source, result.detail));
  }
}
