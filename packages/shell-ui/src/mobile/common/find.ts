/**
 * A search in the document in front: `useFind`.
 *
 * The same contract the desktop's find bar drives, `EditorInstance.find()`, so
 * it behaves the same over every format that has one. Where the field stands
 * and how the hits are counted out is the interface's; this keeps the query,
 * the hits and which one is current.
 *
 * What the desktop's bar learned holds here too: a search is started a moment
 * after the last keystroke, not on every one, because a PDF reads the text of
 * every page; an answer that arrives after a newer search started is thrown
 * away; and the hits of one document are gone the moment another comes to the
 * front, since their `reveal()` would jump into a document no longer shown.
 *
 * Not in it yet: `foldDiacritics` on the query, so that "jamcevina" finds
 * "Jamčevina". It is a new member of `FindQuery`, and comes with the editors'
 * side in K4.
 */

import { useEffect, useRef, useState } from 'react';
import type { FindResult } from '@uleditor/plugin-sdk';

import { activeInstance, selectActiveTabId, useWorkspace } from '../../state/workspace.js';

/** The same pause as the desktop's find bar. */
const DEBOUNCE_MS = 160;

export function useFind() {
  const activeTabId = useWorkspace(selectActiveTabId);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FindResult[]>([]);
  const [current, setCurrent] = useState(0);
  const [searching, setSearching] = useState(false);
  const runId = useRef(0);

  useEffect(() => {
    const id = ++runId.current;
    setResults([]);
    setCurrent(0);
    if (!query) {
      setSearching(false);
      return;
    }
    const timer = setTimeout(() => {
      const instance = activeInstance();
      if (!instance) return;
      setSearching(true);
      instance
        .find({ query })
        .then((found) => {
          if (id === runId.current) setResults(found);
        })
        .catch(() => {
          if (id === runId.current) setResults([]);
        })
        .finally(() => {
          if (id === runId.current) setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, activeTabId]);

  const go = (index: number) => {
    const result = results[index];
    if (!result) return;
    setCurrent(index);
    result.reveal();
  };

  const step = (direction: 1 | -1) => {
    if (results.length === 0) return;
    go((current + direction + results.length) % results.length);
  };

  return {
    query,
    setQuery,
    results,
    current,
    searching,
    next: () => step(1),
    previous: () => step(-1),
    go,
  };
}
