import { useCallback, useEffect, useState } from 'react';

/**
 * Boolean view preference persisted to localStorage. Same allowed pattern as
 * EditModeContext / the Timeline zoom preset: this is UI chrome state (is a
 * panel open, is the sidebar collapsed), never data, so localStorage is fine
 * per the house zero-tolerance-persistence rule (that rule targets data, not
 * view prefs). Returns a [value, setValue] pair, setValue accepts a plain
 * value or an updater function like useState.
 */
export function usePersistedBool(key, defaultValue = false) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? defaultValue : stored === '1';
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, value ? '1' : '0');
    } catch {
      // localStorage unavailable (private mode etc.) — the preference just won't persist.
    }
  }, [key, value]);

  return [value, setValue];
}

/**
 * Numeric view preference persisted to localStorage (e.g. the Timeline
 * zoom's px-per-day). Same allowed pattern as usePersistedBool above — UI
 * chrome state, not data. Returns a [value, setValue] pair.
 */
export function usePersistedNumber(key, defaultValue = 0) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      const parsed = stored === null ? NaN : Number(stored);
      return Number.isFinite(parsed) ? parsed : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      // localStorage unavailable (private mode etc.) — the preference just won't persist.
    }
  }, [key, value]);

  return [value, setValue];
}

/**
 * String (or null) view preference persisted to localStorage, keyed
 * DYNAMICALLY — unlike usePersistedBool/usePersistedNumber above (whose key
 * is fixed for a component's lifetime), this hook's `key` is allowed to
 * change across renders (QUOXPLAN-P5: the active scope selection is
 * persisted per-roadmap as `quoxplan.scope.<roadmapId>`, and the roadmap
 * changes while the same provider stays mounted).
 *
 * Unlike usePersistedNumber/usePersistedBool, persistence is write-through
 * (the returned setter writes to localStorage synchronously) rather than a
 * `useEffect` keyed on `[key, value]` — that combination would re-persist
 * the PREVIOUS roadmap's value under the NEW key for one commit whenever
 * `key` changes, since the effect and the value update from the
 * key-change-triggered reload land in the same render pass. Write-through
 * avoids that race entirely: reads happen on key change, writes only happen
 * when the caller actually calls the setter.
 *
 * A stored/represented value of `null` or `''` clears the key rather than
 * writing an empty string, so "no selection" doesn't leave stale entries.
 */
function readPersistedString(key, defaultValue) {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? defaultValue : stored;
  } catch {
    return defaultValue;
  }
}

export function usePersistedString(key, defaultValue = null) {
  const [value, setValue] = useState(() => readPersistedString(key, defaultValue));

  useEffect(() => {
    setValue(readPersistedString(key, defaultValue));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const setPersisted = useCallback(
    (next) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? next(prev) : next;
        try {
          if (resolved === null || resolved === undefined || resolved === '') {
            localStorage.removeItem(key);
          } else {
            localStorage.setItem(key, resolved);
          }
        } catch {
          // localStorage unavailable (private mode etc.) — the preference just won't persist.
        }
        return resolved;
      });
    },
    [key]
  );

  return [value, setPersisted];
}
