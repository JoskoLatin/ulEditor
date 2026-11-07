/**
 * The edit field, without a look: `useEditSession`.
 *
 * The pattern is `edit-session.ts` in `mobile-core` (idle, editing,
 * previewing, committing, done), and the field is the interface's: Arak's
 * *crta*, Palac's *dlan*, Četiri boje's field above the keyboard. Between the
 * two this keeps the one session there is, and carries the editor's answers in
 * and out: a preview asked for the text as it stands, a commit handed to the
 * editor and its answer handed back.
 *
 * **One session for the whole shell**, in a store rather than in a component. A
 * phone shows one field at a time, and whether something typed is still
 * unwritten is asked from outside the field too: changing the interface is
 * refused while it is (`canSwitch`, ADR 0009).
 *
 * The editor's side is `touch.ts` (K4): `onEditTarget` opens a session,
 * `previewTarget` and `applyTarget` answer it. Until it exists the writer is
 * handed in, so nothing here names an editor.
 */

import { create } from 'zustand';
import {
  IDLE,
  editPending,
  editStep,
  type EditEvent,
  type EditPreview,
  type EditScope,
  type EditSession,
  type EditTarget,
} from '@uleditor/mobile-core';

/** What an editor answers a session with: `previewTarget` and `applyTarget` of `touch.ts` (K4). */
export interface TargetWriter {
  preview?(id: string, scope: EditScope, text: string): EditPreview | Promise<EditPreview>;
  apply(id: string, scope: EditScope, text: string): Promise<boolean>;
}

const useSession = create<{ session: EditSession }>(() => ({ session: IDLE }));

function dispatch(event: EditEvent): EditSession {
  const session = editStep(useSession.getState().session, event);
  useSession.setState({ session });
  return session;
}

/** Whether a text typed into the field is still unwritten; asked from outside it. */
export function editSessionPending(): boolean {
  return editPending(useSession.getState().session);
}

async function requestPreview(writer: TargetWriter): Promise<void> {
  const session = useSession.getState().session;
  if (!writer.preview || (session.state !== 'editing' && session.state !== 'previewing')) return;
  const { target, scope, text } = session;
  try {
    const preview = await writer.preview(target.id, scope, text);
    /* `mobile-core` drops an answer for a text that has changed since. */
    dispatch({ type: 'preview', text, preview });
  } catch {
    /* No preview is a field without the line under it, not a failure to report. */
  }
}

async function commit(writer: TargetWriter): Promise<void> {
  const session = dispatch({ type: 'commit' });
  if (session.state !== 'committing') return;
  let ok = false;
  try {
    ok = await writer.apply(session.target.id, session.scope, session.text);
  } catch {
    ok = false;
  }
  /* Refused, the text stays in the field (`refused`), and the person decides. */
  dispatch({ type: 'applied', ok });
}

export function useEditSession() {
  const session = useSession((state) => state.session);
  return {
    session,
    pending: editPending(session),
    open: (target: EditTarget | null) => void dispatch({ type: 'open', target }),
    type: (text: string) => void dispatch({ type: 'type', text }),
    scope: (scope: EditScope) => void dispatch({ type: 'scope', scope }),
    cancel: () => void dispatch({ type: 'cancel' }),
    preview: (writer: TargetWriter) => requestPreview(writer),
    /** From `submit` or a button, never from a key (ADR 0003, step 4). */
    commit: (writer: TargetWriter) => commit(writer),
  };
}
