/**
 * The questions the shell asks, for an interface to draw.
 *
 * Saving with ADR 0004's questions, closing with unsaved work, a file changed
 * outside: the shell asks them all through `shell.notify`, and none of the
 * concepts drew them (ADR 0009, "What the matrix added", 4). So the interface
 * does not ask them either; it draws what `shell.notify` holds, and a tap on an
 * answer runs that answer, exactly as a toast's button does on the desktop.
 *
 * **A question is a record that waits for an answer**: one with actions. Not
 * `sticky`, which only `fidelityWarning` sets: `confirmDiscard` and
 * `askOverwrite` are `show` with actions, and stay up just the same until they
 * are answered.
 *
 * **Every question is a layer** (`watchQuestions`), so Back reaches it. Its
 * actions go into the layer with the mark `NotificationAction.cancel` carries,
 * and nothing else: Back runs the action marked as the cancel, and a question
 * with none marked stays.
 */

import { useEffect, useMemo, useState } from 'react';
import type { LayerAction } from '@uleditor/mobile-core';

import type { Shell, ToastRecord } from '../../host/index.js';
import { record as recordCrash } from '../../shell/crash.js';
import { closeLayer, openLayer } from './history.js';

export function isQuestion(record: ToastRecord): boolean {
  return record.actions.length > 0;
}

export function questionLayerId(record: ToastRecord): string {
  return `question:${record.id}`;
}

/** Runs one of a question's answers, as a tap on it does. */
export function answer(record: ToastRecord, index: number): void {
  const action = record.actions[index];
  if (!action) return;
  /* An answer whose own failure went unheard would be the worst place in the
     program to swallow one; the desktop's toast reports it the same way. */
  void Promise.resolve(action.run()).catch((error: unknown) => {
    recordCrash(error, { where: `the action on a ${record.level} question` });
  });
}

function layerActions(record: ToastRecord): LayerAction[] {
  return record.actions.map((action, index) =>
    action.cancel === true ? { id: String(index), cancel: true } : { id: String(index) },
  );
}

/**
 * Opens a layer for every question `shell.notify` holds and closes it when the
 * question is gone, however it was answered. Started once, by the mobile shell.
 */
export function watchQuestions(shell: Shell): () => void {
  const open = new Set<string>();

  const follow = (records: readonly ToastRecord[]) => {
    const now = new Set<string>();
    for (const record of records) {
      if (!isQuestion(record)) continue;
      const id = questionLayerId(record);
      now.add(id);
      if (open.has(id)) continue;
      open.add(id);
      openLayer(
        { id, actions: layerActions(record) },
        { onCancel: (action) => answer(record, Number(action.id)) },
      );
    }
    for (const id of [...open]) {
      if (now.has(id)) continue;
      open.delete(id);
      closeLayer(id);
    }
  };

  follow(shell.notify.toasts);
  const subscription = shell.notify.onDidChange(follow);

  return () => {
    subscription.dispose();
    for (const id of open) closeLayer(id);
    open.clear();
  };
}

/**
 * What `shell.notify` holds, split as an interface draws it: the questions,
 * which wait for an answer, and the notices, which only tell.
 */
export function useQuestions(shell: Shell): { questions: ToastRecord[]; notices: ToastRecord[] } {
  const [records, setRecords] = useState<ToastRecord[]>(() => shell.notify.toasts);

  useEffect(() => {
    setRecords(shell.notify.toasts);
    const subscription = shell.notify.onDidChange(setRecords);
    return () => subscription.dispose();
  }, [shell]);

  return useMemo(
    () => ({
      questions: records.filter(isQuestion),
      notices: records.filter((record) => !isQuestion(record)),
    }),
    [records],
  );
}
