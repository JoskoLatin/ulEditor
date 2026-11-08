/**
 * The open documents in the order they were last used: `useOpenDocuments`.
 *
 * The rule is `documents.ts` in `mobile-core`: the one brought to the front
 * goes on top, a closed one drops out. This follows the workspace, whose tabs
 * are the open documents and whose `active` is the one in front, and keeps the
 * order every interface draws its pile in (Arak's *hrpa*, Palac's dots, Četiri
 * boje's "još 2 otvorena"). A tab already open when the watch starts, restored
 * by the session, goes below the ones used since, in the workspace's order.
 *
 * One order for the whole shell, in a store, started once by `MobileApp`.
 */

import { create } from 'zustand';
import { NO_DOCUMENTS, DEFAULT_MODE, bringToFront, closeDocument, type OpenDocuments } from '@uleditor/mobile-core';

import { selectActiveTabId, useWorkspace, type TabState } from '../../state/workspace.js';

const useOrder = create<{ docs: OpenDocuments }>(() => ({ docs: NO_DOCUMENTS }));

function follow(): void {
  const state = useWorkspace.getState();
  const front = selectActiveTabId(state);
  let docs = useOrder.getState().docs;
  const open = new Set(state.tabs.map((tab) => tab.id));
  for (const doc of docs) if (!open.has(doc.id)) docs = closeDocument(docs, doc.id);
  const known = new Set(docs.map((doc) => doc.id));
  const restored = state.tabs.filter((tab) => !known.has(tab.id));
  if (restored.length > 0) {
    docs = [...docs, ...restored.map((tab) => ({ id: tab.id, mode: DEFAULT_MODE, usedAt: 0, savedAt: null }))];
  }
  if (front && docs[0]?.id !== front) docs = bringToFront(docs, front, Date.now());
  if (docs !== useOrder.getState().docs) useOrder.setState({ docs });
}

/** Keeps the order in step with the workspace; returns what stops it. */
export function watchOpenDocuments(): () => void {
  follow();
  return useWorkspace.subscribe(follow);
}

/** The open tabs, the one used last first. */
export function useOpenDocuments(): TabState[] {
  const docs = useOrder((s) => s.docs);
  const tabs = useWorkspace((s) => s.tabs);
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  return docs.map((doc) => byId.get(doc.id)).filter((tab): tab is TabState => tab !== undefined);
}
