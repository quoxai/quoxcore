/**
 * promptsLocalStorageDrain — STUDY-REV-2 / P7.E.2
 *
 * Pure helper that reads the old localStorage prompt keys, returns a
 * migration payload for POST /api/prompts/migrate, and (after successful
 * migration) removes the keys from localStorage.
 *
 * Keys drained:
 *   quox-custom-prompts  — published custom prompts (from promptDraftService)
 *   quox-prompt-drafts   — in-progress drafts (from promptDraftService)
 *   quox-prompt-history  — version history map (from promptHistoryService)
 *
 * Usage in PromptsLibraryView:
 *   import { hasLocalStorageData, readDrain, clearLocalStorageKeys } from '../lib/promptsLocalStorageDrain'
 *
 *   if (hasLocalStorageData()) {
 *     const payload = readDrain();
 *     await migratePromptsFromLocalStorage({ authFetch, ...payload });
 *     clearLocalStorageKeys();
 *   }
 *
 * Idempotent: safe to call repeatedly.
 * No imports from the old services — this helper is self-contained.
 */

export const CUSTOM_KEY = 'quox-custom-prompts';
export const DRAFTS_KEY = 'quox-prompt-drafts';
export const HISTORY_KEY = 'quox-prompt-history';

/**
 * Safely parse a localStorage value. Returns `fallback` on any error.
 */
function safeParse(raw, fallback) {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

/**
 * Returns true if any of the three drain keys exist and contain data.
 * Use this to decide whether to trigger a migration on mount.
 *
 * @returns {boolean}
 */
export function hasLocalStorageData() {
    return [CUSTOM_KEY, DRAFTS_KEY, HISTORY_KEY].some((key) => {
        const val = localStorage.getItem(key);
        if (!val) return false;
        const parsed = safeParse(val, null);
        if (Array.isArray(parsed)) return parsed.length > 0;
        if (parsed && typeof parsed === 'object') return Object.keys(parsed).length > 0;
        return false;
    });
}

/**
 * Read the three localStorage keys and return a migration payload.
 * Malformed JSON is silently treated as empty.
 *
 * @returns {{ customs: Array, drafts: Array, history: Object }}
 */
export function readDrain() {
    const customs = safeParse(localStorage.getItem(CUSTOM_KEY), []);
    const drafts = safeParse(localStorage.getItem(DRAFTS_KEY), []);
    const history = safeParse(localStorage.getItem(HISTORY_KEY), {});

    return {
        customs: Array.isArray(customs) ? customs : [],
        drafts: Array.isArray(drafts) ? drafts : [],
        history: history && typeof history === 'object' && !Array.isArray(history) ? history : {},
    };
}

/**
 * Remove the three drain keys from localStorage.
 * Call this AFTER a successful server migration.
 */
export function clearLocalStorageKeys() {
    localStorage.removeItem(CUSTOM_KEY);
    localStorage.removeItem(DRAFTS_KEY);
    localStorage.removeItem(HISTORY_KEY);
}
