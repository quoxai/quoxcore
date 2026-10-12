import { createContext, useContext, useEffect, useState } from 'react';

const STORAGE_KEY = 'quoxplan.editMode';
const EditModeContext = createContext(null);

/**
 * Global read/edit toggle. This is a view preference (like the Timeline's
 * zoom level), not data — allowed in localStorage per the house rule. Never
 * stores anything mutation-shaped; the server remains the sole source of
 * truth for every stream field.
 */
function loadInitial() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function EditModeProvider({ children }) {
  const [editMode, setEditMode] = useState(loadInitial);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, editMode ? '1' : '0');
    } catch {
      // localStorage unavailable (private mode etc.) — the toggle just won't persist.
    }
  }, [editMode]);

  function toggleEditMode() {
    setEditMode((v) => !v);
  }

  return (
    <EditModeContext.Provider value={{ editMode, setEditMode, toggleEditMode }}>
      {children}
    </EditModeContext.Provider>
  );
}

export function useEditMode() {
  const ctx = useContext(EditModeContext);
  if (!ctx) throw new Error('useEditMode must be used inside an EditModeProvider');
  return ctx;
}
