/**
 * Correcting one target: a word, or a cell.
 *
 * The three concepts share one pattern under three skins (ADR 0009, "Why"): a
 * tap on a word or a cell opens a field outside the document with the target's
 * text, a label ("D4 Plin, studeni") and what will follow ("Ukupno 263,24 →
 * 259,99"), then a commit. Where the field stands is the interface's; this is
 * the pattern, once:
 *
 *     idle → editing ⇄ previewing → committing → done → (the next target | idle)
 *
 * **What is typed is not lost by accident.** A text that differs from the
 * target's is given up only by `cancel`: a second tap that names another target,
 * a change of scope, an editor that refuses the commit, all leave it in the
 * field. A text equal to the target's has nothing to lose, and gives way.
 *
 * **The commit is the person's.** It comes from `submit` or a button, never from
 * a key: the keyboard sends keyCode 229 for everything while it composes
 * (ADR 0003, step 4). And a commit that would write the text the target already
 * has writes nothing.
 *
 * The editor answers through `touch.ts` (K4): `onEditTarget` gives the target,
 * `previewTarget` the preview, `applyTarget` the commit's outcome. Its types are
 * the sketch in ADR 0009, held here until `plugin-sdk/src/touch.ts` exists. The
 * text in them comes from the document and is untrusted; showing it inert and
 * capping it is the host's (K4), and nothing here displays anything.
 */

export type EditScope = 'word' | 'sentence' | 'paragraph' | 'cell';

/** What a tap named: a word in a run, or a cell. */
export interface EditTarget {
  /** The editor's own handle; opaque to the host. */
  id: string;
  kind: 'text' | 'cell';
  /** Only the scopes this editor writes back faithfully, narrowest first. */
  scopes: ReadonlyArray<{ scope: EditScope; text: string }>;
  /** "D4 Plin, studeni": plain text, capped by the host. */
  label?: string;
  inputMode: 'text' | 'decimal';
  hasPrevious: boolean;
  hasNext: boolean;
}

/** What else a commit would change: a total, an average. */
export interface EditPreview {
  changes: ReadonlyArray<{ label: string; before: string; after: string }>;
}

interface Field {
  target: EditTarget;
  scope: EditScope;
  /** The scope's text as the editor gave it. */
  original: string;
  /** What is in the field now. */
  text: string;
}

export type EditSession =
  | { state: 'idle' }
  /** `refused`: the editor did not take the last commit; the text is still here. */
  | ({ state: 'editing'; refused: boolean } & Field)
  /** The preview is for exactly this text; typing drops it. */
  | ({ state: 'previewing'; preview: EditPreview } & Field)
  | ({ state: 'committing' } & Field)
  /** `applied`: the editor wrote it; `false` when there was nothing to write. */
  | ({ state: 'done'; applied: boolean } & Field);

export type EditEvent =
  /** `onEditTarget`: a tap named a target, or `null`, nothing. */
  | { type: 'open'; target: EditTarget | null }
  | { type: 'type'; text: string }
  | { type: 'scope'; scope: EditScope }
  /** `previewTarget`'s answer, for the text it was asked about. */
  | { type: 'preview'; text: string; preview: EditPreview }
  | { type: 'commit' }
  /** `applyTarget`'s answer. */
  | { type: 'applied'; ok: boolean }
  | { type: 'cancel' };

export const IDLE: EditSession = { state: 'idle' };

/** Something typed that a reload or another target would lose. */
export function editPending(session: EditSession): boolean {
  switch (session.state) {
    case 'editing':
    case 'previewing':
      return session.text !== session.original;
    case 'committing':
      return true;
    default:
      return false;
  }
}

/**
 * Whether the arrows to the neighbouring word or cell can be offered: only when
 * the editor has one, and only with nothing typed that moving would lose.
 */
export function canStep(session: EditSession, to: 'previous' | 'next'): boolean {
  if (session.state === 'idle' || session.state === 'committing' || editPending(session)) return false;
  return to === 'previous' ? session.target.hasPrevious : session.target.hasNext;
}

function field(target: EditTarget): Field | null {
  /* No scope means the editor writes nothing of this target back faithfully:
     there is nothing to correct, so no field opens. */
  const first = target.scopes[0];
  return first ? { target, scope: first.scope, original: first.text, text: first.text } : null;
}

function fieldOf(session: Exclude<EditSession, { state: 'idle' }>): Field {
  return { target: session.target, scope: session.scope, original: session.original, text: session.text };
}

/** One step of the session. An event that does not apply where it is changes nothing. */
export function editStep(session: EditSession, event: EditEvent): EditSession {
  switch (event.type) {
    case 'open': {
      if (session.state === 'committing' || editPending(session)) return session;
      const next = event.target ? field(event.target) : null;
      return next ? { state: 'editing', refused: false, ...next } : IDLE;
    }

    case 'type':
      if (session.state !== 'editing' && session.state !== 'previewing') return session;
      if (event.text === session.text) return session;
      return { state: 'editing', refused: false, ...fieldOf(session), text: event.text };

    case 'scope': {
      if (session.state !== 'editing' && session.state !== 'previewing') return session;
      if (editPending(session) || event.scope === session.scope) return session;
      const offered = session.target.scopes.find((one) => one.scope === event.scope);
      if (!offered) return session;
      return {
        state: 'editing',
        refused: false,
        target: session.target,
        scope: offered.scope,
        original: offered.text,
        text: offered.text,
      };
    }

    case 'preview':
      /* An answer for a text that has since changed is about another text. */
      if (session.state !== 'editing' && session.state !== 'previewing') return session;
      if (event.text !== session.text) return session;
      return { state: 'previewing', preview: event.preview, ...fieldOf(session) };

    case 'commit':
      if (session.state !== 'editing' && session.state !== 'previewing') return session;
      if (session.text === session.original) return { state: 'done', applied: false, ...fieldOf(session) };
      return { state: 'committing', ...fieldOf(session) };

    case 'applied':
      if (session.state !== 'committing') return session;
      return event.ok
        ? { state: 'done', applied: true, ...fieldOf(session) }
        : { state: 'editing', refused: true, ...fieldOf(session) };

    case 'cancel':
      /* A write already handed to the editor is not taken back halfway. */
      return session.state === 'committing' ? session : IDLE;
  }
}
