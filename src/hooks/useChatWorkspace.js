/**
 * useChatWorkspace - Multi-tab chat state management
 *
 * Manages tabbed chat conversations, each with its own assistant, session,
 * and conversation history. Mirrors the useTerminalWorkspace pattern.
 *
 * Tab metadata is stored in this hook's state and persisted to localStorage.
 * Conversation messages are stored separately per tab (managed by ChatTab component)
 * to avoid bloating the hook state with large message arrays.
 *
 * Each browser tab gets a unique window ID to prevent cross-tab state corruption
 * when multiple browser tabs run the dashboard simultaneously.
 *
 * Usage:
 *   const { tabs, activeTabId, activeTab, addTab, removeTab, ... } = useChatWorkspace();
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { CHAT_LIMITS, CHAT_STORAGE_KEY, CHAT_TAB_MESSAGES_PREFIX } from '../config/chatConfig';
import { queueSync } from '../services/serverSyncQueue';

const MAX_TABS = CHAT_LIMITS.MAX_TABS;

/**
 * Unique ID for this browser tab/window instance.
 * Prevents two browser tabs from overwriting each other's workspace state.
 * Stored on sessionStorage (per-tab) so it survives React hot reloads
 * but not new browser tabs.
 */
function getBrowserTabId() {
    const SESSION_KEY = 'quox-browser-tab-id';
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
        id = `btab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
}

const BROWSER_TAB_ID = getBrowserTabId();

/** Storage key scoped to this browser tab */
function scopedStorageKey() {
    return `${CHAT_STORAGE_KEY}:${BROWSER_TAB_ID}`;
}

/** Counter for unique IDs within a session */
let tabCounter = 0;

/** Generate a unique tab ID */
function nextTabId() {
    return `chat-${Date.now()}-${tabCounter++}`;
}

/** Create a default tab */
function createDefaultTab(assistantId = 'quox', overrides = {}) {
    return {
        id: nextTabId(),
        name: null, // null = auto-name from assistant; string = user-renamed
        assistantId,
        sessionId: null,
        correlationId: null,
        lastExecution: null,
        createdAt: new Date().toISOString(),
        lastMessageAt: null,
        ...overrides,
    };
}

/**
 * Prune phantom tabs left behind by AOCL-DISPATCH-B12's accidental
 * Continue-effect tab-creation loop.
 *
 * AOCL-DISPATCH-B17: B14 also checked stored messages, but B12's loop
 * pre-populated `quox-chat-tab-${id}-messages` for every tab it created,
 * so phantoms had messages and survived the prune — the user's state
 * stayed at 16/16 forever. Real chat or Continue tabs always pick up
 * either `lastMessageAt`, `correlationId`, or `sessionId` from the
 * normal flow; a phantom has none of those. The Continue effect now
 * sets `lastMessageAt` immediately after pre-populating, so live
 * Continues survive too.
 *
 * Always keeps the active tab.
 */
function pruneOrphanTabs(data) {
    if (!data || !Array.isArray(data.tabs) || data.tabs.length <= 1) return data;
    const activeId = data.activeTabId;
    const messagesKeyFor = (id) => `${CHAT_TAB_MESSAGES_PREFIX}${id}-messages`;
    const isPhantom = (t) => {
        if (t.id === activeId) return false;     // never prune active
        if (t.lastMessageAt) return false;       // ever-touched tab
        if (t.correlationId) return false;       // bound to a real conv
        if (t.sessionId) return false;           // had a chat session
        return true;
    };
    const kept = data.tabs.filter(t => !isPhantom(t));
    if (kept.length === data.tabs.length) return data; // nothing pruned
    if (kept.length === 0 && data.tabs.length > 0) {
        // Something went wrong — keep at least the active tab
        const fallback = data.tabs.find(t => t.id === activeId) || data.tabs[0];
        return { ...data, tabs: [fallback], activeTabId: fallback.id };
    }
    const dropped = data.tabs.length - kept.length;
    if (dropped > 0) {
        console.warn(`[ChatWorkspace] Pruned ${dropped} phantom tab(s) (B12 loop residue)`);
        for (const t of data.tabs) {
            if (!kept.find(k => k.id === t.id)) {
                try { localStorage.removeItem(messagesKeyFor(t.id)); } catch { /* */ }
                try { localStorage.removeItem(`${CHAT_TAB_MESSAGES_PREFIX}${t.id}-reactions`); } catch { /* */ }
            }
        }
    }
    return {
        ...data,
        tabs: kept,
        activeTabId: kept.find(t => t.id === activeId) ? activeId : kept[0]?.id,
    };
}

/**
 * Load workspace state from localStorage.
 * Tries the scoped key first (this browser tab's own state),
 * then falls back to the legacy shared key for migration.
 */
function loadFromStorage() {
    // Try scoped key first (per-browser-tab)
    try {
        const raw = localStorage.getItem(scopedStorageKey());
        if (raw) {
            const data = JSON.parse(raw);
            if (data && Array.isArray(data.tabs) && data.tabs.length > 0) {
                return pruneOrphanTabs(data);
            }
        }
    } catch { /* ignore corrupt data */ }

    // Fall back to legacy shared key (migration from pre-fix version)
    try {
        const raw = localStorage.getItem(CHAT_STORAGE_KEY);
        if (raw) {
            const data = JSON.parse(raw);
            if (data && Array.isArray(data.tabs) && data.tabs.length > 0) {
                return pruneOrphanTabs(data);
            }
        }
    } catch { /* ignore corrupt data */ }
    return null;
}

/** Save workspace state to localStorage AND queue server sync (metadata only, not messages) */
function saveToStorage(state) {
    const data = {
        browserTabId: BROWSER_TAB_ID,
        activeTabId: state.activeTabId,
        tabs: state.tabs.map(t => ({
            id: t.id,
            name: t.name,
            assistantId: t.assistantId,
            sessionId: t.sessionId,
            correlationId: t.correlationId,
            lastExecution: t.lastExecution || null,
            createdAt: t.createdAt,
            lastMessageAt: t.lastMessageAt,
        })),
    };
    try {
        // Write to scoped key (per-browser-tab, no cross-tab conflicts)
        localStorage.setItem(scopedStorageKey(), JSON.stringify(data));
        // Also write to shared key for server sync (last-writer-wins is fine for sync)
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(data));
    } catch { /* quota exceeded, ignore */ }
    // Queue server sync for cross-device persistence
    queueSync('chatWorkspace', data);
}

/** Clean up localStorage messages for a removed tab */
function cleanupTabMessages(tabId) {
    try {
        localStorage.removeItem(`${CHAT_TAB_MESSAGES_PREFIX}${tabId}-messages`);
        localStorage.removeItem(`${CHAT_TAB_MESSAGES_PREFIX}${tabId}-reactions`);
    } catch { /* ignore */ }
}

/** Check if a tab has any stored messages */
export function tabHasMessages(tabId) {
    try {
        const raw = localStorage.getItem(`${CHAT_TAB_MESSAGES_PREFIX}${tabId}-messages`);
        if (raw) {
            const msgs = JSON.parse(raw);
            return Array.isArray(msgs) && msgs.length > 0;
        }
    } catch { /* ignore */ }
    return false;
}

export default function useChatWorkspace() {
    const [state, setState] = useState(() => {
        const stored = loadFromStorage();
        if (stored) {
            return {
                activeTabId: stored.activeTabId,
                tabs: stored.tabs,
            };
        }

        // Default: single tab with default assistant
        const defaultAssistant = localStorage.getItem('quox-assistant') || 'quox';
        const defaultTab = createDefaultTab(defaultAssistant, { id: 'chat-default' });
        return {
            activeTabId: defaultTab.id,
            tabs: [defaultTab],
        };
    });

    // Debounced localStorage persistence
    const saveTimerRef = useRef(null);
    useEffect(() => {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => saveToStorage(state), 500);
        return () => clearTimeout(saveTimerRef.current);
    }, [state]);

    // --- Tab actions ---

    /** Add a new tab, optionally with a specific assistant. Returns the new tab ID. */
    const addTab = useCallback((assistantId = 'quox') => {
        let newTabId = null;
        setState(prev => {
            if (prev.tabs.length >= MAX_TABS) return prev;
            const newTab = createDefaultTab(assistantId);
            newTabId = newTab.id;
            return {
                activeTabId: newTab.id,
                tabs: [...prev.tabs, newTab],
            };
        });
        return newTabId;
    }, []);

    /**
     * Add a new tab, evicting the oldest non-active tab if at capacity.
     * Atomic — eviction + add happen in a single setState so the chain
     * can't half-complete. Always returns a valid tab ID (the only way
     * it can fail is if MAX_TABS < 1).
     *
     * Used by the Continue Conversation flow, where the user explicitly
     * asked for a new tab — silently failing on tab-limit was the
     * symptom users hit twice (B11→B14). Even if state is somehow
     * corrupted with > MAX_TABS tabs, this trims down to make room.
     */
    const addTabEvictingOldest = useCallback((assistantId = 'quox') => {
        const newTab = createDefaultTab(assistantId);
        const evictedIds = new Set();
        setState(prev => {
            let workingTabs = prev.tabs;
            const activeId = prev.activeTabId;

            // Evict oldest non-active tabs until we have room for one more.
            while (workingTabs.length >= MAX_TABS) {
                const sorted = [...workingTabs]
                    .filter(t => t.id !== activeId)
                    .sort((a, b) => {
                        const ta = a.lastMessageAt || a.createdAt || '';
                        const tb = b.lastMessageAt || b.createdAt || '';
                        return ta.localeCompare(tb);
                    });
                if (sorted.length === 0) break; // only active tab left
                const evictId = sorted[0].id;
                evictedIds.add(evictId);
                workingTabs = workingTabs.filter(t => t.id !== evictId);
            }

            return {
                activeTabId: newTab.id,
                tabs: [...workingTabs, newTab],
            };
        });
        for (const id of evictedIds) cleanupTabMessages(id);
        return newTab.id;
    }, []);

    /** Remove a tab by ID. Cleans up its stored messages. */
    const removeTab = useCallback((tabId) => {
        setState(prev => {
            if (prev.tabs.length <= 1) {
                // Can't remove last tab — reset it instead
                const defaultTab = createDefaultTab('quox');
                cleanupTabMessages(tabId);
                return {
                    activeTabId: defaultTab.id,
                    tabs: [defaultTab],
                };
            }
            const filtered = prev.tabs.filter(t => t.id !== tabId);
            let activeId = prev.activeTabId;
            if (activeId === tabId) {
                // Switch to adjacent tab
                const removedIdx = prev.tabs.findIndex(t => t.id === tabId);
                activeId = filtered[Math.min(removedIdx, filtered.length - 1)].id;
            }
            cleanupTabMessages(tabId);
            return { activeTabId: activeId, tabs: filtered };
        });
    }, []);

    /** Switch to a tab */
    const setActiveTab = useCallback((tabId) => {
        setState(prev => {
            if (!prev.tabs.find(t => t.id === tabId)) return prev;
            return { ...prev, activeTabId: tabId };
        });
    }, []);

    /** Rename a tab */
    const renameTab = useCallback((tabId, name) => {
        setState(prev => ({
            ...prev,
            tabs: prev.tabs.map(t =>
                t.id === tabId ? { ...t, name: name?.trim() || null } : t
            ),
        }));
    }, []);

    /** Update tab metadata (sessionId, correlationId, lastMessageAt, etc.) */
    const updateTab = useCallback((tabId, updates) => {
        setState(prev => ({
            ...prev,
            tabs: prev.tabs.map(t =>
                t.id === tabId ? { ...t, ...updates } : t
            ),
        }));
    }, []);

    /**
     * Open a new tab for a specific assistant.
     * Always creates a fresh tab — never silently reuses an existing one,
     * as that makes the user think their tab disappeared.
     * At capacity: focuses the most recent tab with this assistant.
     * Returns the tab ID.
     */
    const openOrFocusAssistant = useCallback((assistantId) => {
        let resultTabId = null;
        setState(prev => {
            // At capacity — focus the most recent tab with this assistant, or first tab
            if (prev.tabs.length >= MAX_TABS) {
                const withAssistant = prev.tabs.filter(t => t.assistantId === assistantId);
                const target = withAssistant.length > 0
                    ? withAssistant[withAssistant.length - 1]
                    : prev.tabs[prev.tabs.length - 1];
                resultTabId = target.id;
                return { ...prev, activeTabId: resultTabId };
            }

            // Always create a new tab
            const newTab = createDefaultTab(assistantId);
            resultTabId = newTab.id;
            return {
                activeTabId: newTab.id,
                tabs: [...prev.tabs, newTab],
            };
        });
        return resultTabId;
    }, []);

    // --- Derived state ---
    const activeTab = state.tabs.find(t => t.id === state.activeTabId) || state.tabs[0];
    const tabCount = state.tabs.length;
    const canAddTab = tabCount < MAX_TABS;
    const tabWarning = tabCount >= CHAT_LIMITS.TAB_WARN_THRESHOLD
        ? `${tabCount}/${MAX_TABS} chat tabs open`
        : null;

    return {
        // State
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        activeTab,
        tabCount,
        canAddTab,
        tabWarning,

        // Actions
        addTab,
        addTabEvictingOldest,
        removeTab,
        setActiveTab,
        renameTab,
        updateTab,
        openOrFocusAssistant,
    };
}

// Exports for testing
export { createDefaultTab, loadFromStorage, saveToStorage, cleanupTabMessages, MAX_TABS };
