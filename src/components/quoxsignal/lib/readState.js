import { useCallback, useEffect, useState } from 'react';

/**
 * Read/unread is UI triage state, not data the server models (the item API
 * has no such field) — same allowed localStorage exemption as quoxplan's
 * usePersistedBool view prefs (this is chrome state, not something an
 * enterprise customer expects to survive a browser clear or follow them to
 * another device). Marking an item read on open is the email-inbox pattern
 * the keyboard triage UX brief asks for.
 *
 * Ported verbatim from quox-signal/web/src/lib/readState.js.
 */
const KEY = 'quoxsignal.read-ids';

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function persist(set) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {
    // localStorage unavailable - read state just won't persist across reloads.
  }
}

export function useReadState() {
  const [readIds, setReadIds] = useState(load);

  useEffect(() => {
    persist(readIds);
  }, [readIds]);

  const markRead = useCallback((id) => {
    setReadIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  const isRead = useCallback((id) => readIds.has(id), [readIds]);

  return { isRead, markRead };
}
