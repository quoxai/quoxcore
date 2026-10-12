/**
 * localStorage draft buffer for unsent NotesQ edits. CACHE ONLY: the server is
 * the source of truth, the buffer exists so a failed/conflicted save never
 * loses typed text. Cleared on successful save. Storage is injectable for tests.
 */
const PREFIX = 'quox.notesq.draft.';

function store(s) {
  if (s) return s;
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

export function saveDraft(noteId, draft, s) {
  const st = store(s);
  if (!st || !noteId) return false;
  try {
    st.setItem(PREFIX + noteId, JSON.stringify({ ...draft, savedAt: Date.now() }));
    return true;
  } catch { return false; }
}

export function loadDraft(noteId, s) {
  const st = store(s);
  if (!st || !noteId) return null;
  try {
    const raw = st.getItem(PREFIX + noteId);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && typeof d.markdown === 'string' ? d : null;
  } catch { return null; }
}

export function clearDraft(noteId, s) {
  const st = store(s);
  if (!st || !noteId) return;
  try { st.removeItem(PREFIX + noteId); } catch { /* cache only */ }
}
