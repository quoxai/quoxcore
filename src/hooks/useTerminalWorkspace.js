/**
 * useTerminalWorkspace - Multi-workspace terminal state management
 *
 * Manages tabbed workspaces, each with its own layout + panes.
 * Layout presets, per-pane state, focus tracking, and localStorage persistence.
 *
 * Usage:
 *   const { layout, panes, workspaces, setLayout, addWorkspace, ... } = useTerminalWorkspace();
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { TERMINAL_LIMITS } from '../config/terminalConfig';
import { decodeWorkspaceShare } from '../utils/terminalShare';
import { queueSync } from '../services/serverSyncQueue';

const STORAGE_KEY = 'quox-terminal-workspaces';
const OLD_STORAGE_KEY = 'quox-terminal-workspace';
const MAX_PANES = TERMINAL_LIMITS.MAX_PANES;
const MAX_WORKSPACES = TERMINAL_LIMITS.MAX_WORKSPACES;

/** Layout presets and their pane counts */
const LAYOUTS = {
  'single':    1,
  'split-h':   2,
  'split-v':   2,
  'main-side': 3,
  'side-main': 3,
  'top-split': 3,
  'split-top': 3,
  'quad':      4,
};

/** Get pane count for a layout preset */
function getLayoutPaneCount(layout) {
  return LAYOUTS[layout] || 1;
}

/** Create a default pane */
function createDefaultPane(index, overrides = {}) {
  return {
    id: `pane-${index}`,
    mode: 'local',
    hostId: '',
    connected: false,
    sessionId: null,
    ...overrides,
  };
}

/** Build initial panes array for a layout */
function buildPanesForLayout(layout, existingPanes = [], clearSessionIds = false) {
  const count = getLayoutPaneCount(layout);
  const panes = [];
  for (let i = 0; i < count; i++) {
    if (existingPanes[i]) {
      const pane = { ...existingPanes[i], connected: false };
      if (clearSessionIds) pane.sessionId = null;
      panes.push(pane);
    } else {
      panes.push(createDefaultPane(i));
    }
  }
  return panes;
}

/** Create a default workspace */
function createDefaultWorkspace(index, overrides = {}) {
  return {
    id: `ws-${index}`,
    name: `Workspace ${index + 1}`,
    layout: 'single',
    panes: [createDefaultPane(0)],
    focusedPaneId: 'pane-0',
    ...overrides,
  };
}

/** Count connected sessions that would be lost when downgrading layout */
function getSessionsToLose(currentPanes, newLayout) {
  const newCount = getLayoutPaneCount(newLayout);
  if (newCount >= currentPanes.length) return 0;
  const removedPanes = currentPanes.slice(newCount);
  return removedPanes.filter(p => p.connected).length;
}

/** Generate next workspace ID */
let wsCounter = 0;
function nextWorkspaceId() {
  return `ws-${Date.now()}-${wsCounter++}`;
}

/** Load multi-workspace state from localStorage */
function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.workspaces) && data.workspaces.length > 0) {
        // Strip stale sessionIds — sessions are ephemeral and don't survive collector restarts
        for (const ws of data.workspaces) {
          if (ws.panes) {
            for (const p of ws.panes) { delete p.sessionId; }
          }
        }
        return data;
      }
    }
  } catch { /* ignore */ }

  // Migrate from old single-workspace format
  try {
    const oldRaw = localStorage.getItem(OLD_STORAGE_KEY);
    if (oldRaw) {
      const old = JSON.parse(oldRaw);
      if (old && LAYOUTS[old.layout]) {
        const migrated = {
          activeWorkspaceId: 'ws-0',
          workspaces: [{
            id: 'ws-0',
            name: 'Workspace 1',
            layout: old.layout,
            panes: old.panes || [{ id: 'pane-0', mode: 'local', hostId: '' }],
            focusedPaneId: 'pane-0',
          }],
        };
        localStorage.removeItem(OLD_STORAGE_KEY);
        return migrated;
      }
    }
  } catch { /* ignore */ }

  return null;
}

/** Save multi-workspace state to localStorage AND queue server sync */
function saveToStorage(state) {
  const data = {
    activeWorkspaceId: state.activeWorkspaceId,
    workspaces: state.workspaces.map(ws => ({
      id: ws.id,
      name: ws.name,
      layout: ws.layout,
      panes: ws.panes.map(p => ({ id: p.id, mode: p.mode, hostId: p.hostId })),
      focusedPaneId: ws.focusedPaneId,
    })),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch { /* quota exceeded, ignore */ }
  // Queue server sync for cross-device persistence
  queueSync('terminalWorkspaces', data);
}

export default function useTerminalWorkspace(initialSearchParams) {
  const [state, setState] = useState(() => {
    // Share URL takes priority — decode ?ws= param into a fresh workspace
    const wsParam = initialSearchParams?.get?.('ws');
    if (wsParam) {
      const shared = decodeWorkspaceShare(wsParam);
      if (shared) {
        const sharedPanes = shared.panes.map((p, i) => createDefaultPane(i, {
          mode: p.mode,
          hostId: p.hostId,
        }));
        const ws = createDefaultWorkspace(0, {
          name: shared.name,
          layout: shared.layout,
          panes: sharedPanes,
        });
        // Clean the ws param from URL without navigation
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete('ws');
          window.history.replaceState(null, '', url.toString());
        } catch { /* SSR or test env */ }
        return { activeWorkspaceId: ws.id, workspaces: [ws] };
      }
    }

    const stored = loadFromStorage();
    const urlMode = initialSearchParams?.get?.('mode');
    const urlHost = initialSearchParams?.get?.('host');
    const urlCmd = initialSearchParams?.get?.('cmd');

    if (stored) {
      // Rebuild panes with connection state + session IDs cleared (page load = fresh start)
      const workspaces = stored.workspaces.map(ws => ({
        ...ws,
        panes: buildPanesForLayout(ws.layout, ws.panes, true),
      }));
      // URL params override pane-0 of the active workspace
      const activeWs = workspaces.find(ws => ws.id === stored.activeWorkspaceId) || workspaces[0];
      if (urlMode && activeWs.panes[0]) {
        activeWs.panes[0].mode = urlMode;
        if (urlMode === 'ssh' && urlHost) activeWs.panes[0].hostId = urlHost;
        else if (urlMode === 'local') activeWs.panes[0].hostId = '';
        if (urlCmd) activeWs.panes[0].initialCommand = urlCmd;
      }
      return {
        activeWorkspaceId: activeWs.id,
        workspaces,
      };
    }

    // Default: single workspace
    const pane0Overrides = {};
    if (urlMode) {
      pane0Overrides.mode = urlMode;
      if (urlMode === 'ssh' && urlHost) pane0Overrides.hostId = urlHost;
    }
    if (urlCmd) pane0Overrides.initialCommand = urlCmd;

    return {
      activeWorkspaceId: 'ws-0',
      workspaces: [createDefaultWorkspace(0, {
        panes: [createDefaultPane(0, pane0Overrides)],
      })],
    };
  });

  // Debounced localStorage persistence
  const saveTimerRef = useRef(null);
  useEffect(() => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => saveToStorage(state), 500);
    return () => clearTimeout(saveTimerRef.current);
  }, [state]);

  // Helper: get active workspace
  const getActiveWs = useCallback((s) => {
    return s.workspaces.find(ws => ws.id === s.activeWorkspaceId) || s.workspaces[0];
  }, []);

  // Helper: update active workspace in state
  const updateActiveWs = useCallback((updater) => {
    setState(prev => ({
      ...prev,
      workspaces: prev.workspaces.map(ws =>
        ws.id === prev.activeWorkspaceId ? updater(ws) : ws
      ),
    }));
  }, []);

  // Helper: update a specific workspace by ID
  const updateWorkspace = useCallback((wsId, updater) => {
    setState(prev => ({
      ...prev,
      workspaces: prev.workspaces.map(ws =>
        ws.id === wsId ? updater(ws) : ws
      ),
    }));
  }, []);

  // --- Workspace-level actions (existing API, operate on active workspace) ---

  const setLayout = useCallback((newLayout) => {
    if (!LAYOUTS[newLayout]) return;
    updateActiveWs(ws => {
      const panes = buildPanesForLayout(newLayout, ws.panes);
      const focusedPaneId = panes.find(p => p.id === ws.focusedPaneId)
        ? ws.focusedPaneId
        : 'pane-0';
      return { ...ws, layout: newLayout, panes, focusedPaneId };
    });
  }, [updateActiveWs]);

  const updatePane = useCallback((paneId, updates, workspaceId = null) => {
    const updater = ws => ({
      ...ws,
      panes: ws.panes.map(p => {
        if (p.id !== paneId) return p;
        const updated = { ...p, ...updates };
        if (updates.mode === 'local') updated.hostId = '';
        // Clear sessionId when mode or host changes (forces new session)
        if (updates.mode !== undefined || updates.hostId !== undefined) {
          updated.sessionId = null;
        }
        return updated;
      }),
    });
    if (workspaceId) {
      updateWorkspace(workspaceId, updater);
    } else {
      updateActiveWs(updater);
    }
  }, [updateActiveWs, updateWorkspace]);

  const setPaneConnected = useCallback((paneId, connected, workspaceId = null) => {
    const updater = ws => ({
      ...ws,
      panes: ws.panes.map(p =>
        p.id === paneId ? { ...p, connected } : p
      ),
    });
    if (workspaceId) {
      updateWorkspace(workspaceId, updater);
    } else {
      updateActiveWs(updater);
    }
  }, [updateActiveWs, updateWorkspace]);

  const setPaneSessionId = useCallback((paneId, sessionId, workspaceId = null) => {
    const updater = ws => ({
      ...ws,
      panes: ws.panes.map(p =>
        p.id === paneId ? { ...p, sessionId } : p
      ),
    });
    if (workspaceId) {
      updateWorkspace(workspaceId, updater);
    } else {
      updateActiveWs(updater);
    }
  }, [updateActiveWs, updateWorkspace]);

  const setFocusedPane = useCallback((paneId) => {
    updateActiveWs(ws => ({ ...ws, focusedPaneId: paneId }));
  }, [updateActiveWs]);

  const resetWorkspace = useCallback(() => {
    updateActiveWs(() => ({
      id: state.activeWorkspaceId,
      name: 'Workspace 1',
      layout: 'single',
      panes: [createDefaultPane(0)],
      focusedPaneId: 'pane-0',
    }));
  }, [updateActiveWs, state.activeWorkspaceId]);

  // --- Tab-level actions (new) ---

  const addWorkspace = useCallback(() => {
    setState(prev => {
      if (prev.workspaces.length >= MAX_WORKSPACES) return prev;
      const newWs = createDefaultWorkspace(0, { id: nextWorkspaceId() });
      newWs.name = `Workspace ${prev.workspaces.length + 1}`;
      return {
        activeWorkspaceId: newWs.id,
        workspaces: [...prev.workspaces, newWs],
      };
    });
  }, []);

  const removeWorkspace = useCallback((wsId) => {
    setState(prev => {
      if (prev.workspaces.length <= 1) return prev; // can't remove last
      const filtered = prev.workspaces.filter(ws => ws.id !== wsId);
      let activeId = prev.activeWorkspaceId;
      if (activeId === wsId) {
        // Switch to adjacent tab
        const removedIdx = prev.workspaces.findIndex(ws => ws.id === wsId);
        activeId = filtered[Math.min(removedIdx, filtered.length - 1)].id;
      }
      return { activeWorkspaceId: activeId, workspaces: filtered };
    });
  }, []);

  const renameWorkspace = useCallback((wsId, name) => {
    setState(prev => ({
      ...prev,
      workspaces: prev.workspaces.map(ws =>
        ws.id === wsId ? { ...ws, name: name.trim() || ws.name } : ws
      ),
    }));
  }, []);

  const setActiveWorkspace = useCallback((wsId) => {
    setState(prev => {
      if (!prev.workspaces.find(ws => ws.id === wsId)) return prev;
      return { ...prev, activeWorkspaceId: wsId };
    });
  }, []);

  const duplicateWorkspace = useCallback((wsId) => {
    setState(prev => {
      if (prev.workspaces.length >= MAX_WORKSPACES) return prev;
      const source = prev.workspaces.find(ws => ws.id === wsId);
      if (!source) return prev;
      const newWs = {
        ...source,
        id: nextWorkspaceId(),
        name: `${source.name} (copy)`,
        panes: source.panes.map(p => ({ ...p, connected: false, sessionId: null })),
      };
      return {
        activeWorkspaceId: newWs.id,
        workspaces: [...prev.workspaces, newWs],
      };
    });
  }, []);

  // --- Derived state (from active workspace) ---
  const activeWs = getActiveWs(state);
  const layout = activeWs.layout;
  const panes = activeWs.panes;
  const focusedPaneId = activeWs.focusedPaneId;
  const activePaneCount = panes.length;
  const sessionCount = panes.filter(p => p.connected).length;
  const canAddPane = activePaneCount < MAX_PANES;
  const workspaceCount = state.workspaces.length;
  const workspaceWarning = workspaceCount >= TERMINAL_LIMITS.WORKSPACE_WARN_THRESHOLD
    ? `${workspaceCount}/${MAX_WORKSPACES} workspaces used`
    : null;

  return {
    // Active workspace state (backwards compatible)
    layout,
    panes,
    focusedPaneId,
    activePaneCount,
    sessionCount,
    canAddPane,

    // Active workspace actions (backwards compatible)
    setLayout,
    updatePane,
    setPaneConnected,
    setPaneSessionId,
    setFocusedPane,
    resetWorkspace,

    // Multi-workspace state
    workspaces: state.workspaces,
    activeWorkspaceId: state.activeWorkspaceId,
    workspaceCount,
    workspaceWarning,

    // Multi-workspace actions
    addWorkspace,
    removeWorkspace,
    renameWorkspace,
    setActiveWorkspace,
    duplicateWorkspace,
  };
}

// Exports for testing
export {
  LAYOUTS, getLayoutPaneCount, buildPanesForLayout, createDefaultPane,
  MAX_PANES, MAX_WORKSPACES, createDefaultWorkspace, getSessionsToLose,
};
