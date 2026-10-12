/**
 * NotesQ autosave state machine (pure, no React, no I/O).
 *
 * Statuses: saved | unsaved | saving | conflict | error
 *
 * Rules the UI relies on:
 *  - An edit made while a save is in flight is never lost: `dirty` stays set,
 *    and SAVE_OK drops back to `unsaved` (not `saved`) so another save fires.
 *  - After a conflict, autosave is OFF until the user resolves it
 *    (`shouldAutosave` is false); the unsent draft is never discarded here.
 *  - `baseHash` is the content_hash the next PUT must send.
 */
export const INITIAL_SAVE_STATE = Object.freeze({
  status: 'saved',
  baseHash: null,
  dirty: false,
  conflictHash: null,
  error: null,
});

export function saveReducer(state, action) {
  switch (action.type) {
    case 'LOAD':
      return { ...INITIAL_SAVE_STATE, baseHash: action.hash ?? null };
    case 'EDIT':
      if (state.status === 'conflict') return { ...state, dirty: true };
      if (state.status === 'saving') return { ...state, dirty: true };
      return { ...state, status: 'unsaved', dirty: true, error: null };
    case 'SAVE_START':
      if (state.status === 'conflict') return state;
      return { ...state, status: 'saving', dirty: false };
    case 'SAVE_OK':
      return {
        ...state,
        baseHash: action.hash ?? state.baseHash,
        status: state.dirty ? 'unsaved' : 'saved',
        error: null,
      };
    case 'SAVE_CONFLICT':
      return { ...state, status: 'conflict', dirty: true, conflictHash: action.currentHash ?? null };
    case 'SAVE_ERROR':
      // Keep the draft dirty so a retry (next edit or manual) sends it.
      return { ...state, status: 'error', dirty: true, error: action.message || 'Save failed' };
    case 'KEEP_MINE':
      // Overwrite: adopt the server's current hash, then autosave resumes.
      return { ...state, status: 'unsaved', dirty: true, baseHash: action.hash ?? state.conflictHash, conflictHash: null };
    case 'RETRY':
      return state.status === 'error' ? { ...state, status: 'unsaved' } : state;
    default:
      return state;
  }
}

export function shouldAutosave(state) {
  return state.status === 'unsaved' && state.dirty;
}

export const STATUS_LABEL = {
  saved: 'Saved',
  saving: 'Saving',
  unsaved: 'Unsaved',
  conflict: 'Conflict',
  error: 'Save failed',
};

export const AUTOSAVE_DELAY_MS = 1500;
