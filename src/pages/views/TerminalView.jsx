/**
 * TerminalView - Premium Web Terminal Plugin (Phase 3b: Tabbed Workspaces)
 *
 * Multi-pane terminal workspace with layout presets (single, split-h, split-v, quad).
 * Multiple named workspace tabs, each with its own layout + panes.
 * Confirmation dialogs for layout downgrade and tab close when sessions active.
 *
 * Supports URL params for direct linking (applied to pane-0):
 *   /terminal?mode=ssh&host=docker01
 *
 * Premium plugin: requires 'web-terminal' license (tier_b).
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed';
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice';
import { listHosts } from '../../services/bastionClient';
import useTerminalWorkspace, { getSessionsToLose } from '../../hooks/useTerminalWorkspace';
import TerminalPane from '../../components/terminal/TerminalPane';
import TerminalChat from '../../components/terminal/TerminalChat';
import Modal from '../../components/ui/Modal';
import { KeyboardShortcuts } from '../../components/help/KeyboardShortcuts';
import { loadMode } from '../../config/terminalModes';
import { composeErrorQuery } from '../../utils/terminalErrorDetector';
import { updateTerminalFocus } from '../../services/terminalMemoryBridge';
import { matchShortcut, TERMINAL_SHORTCUTS } from '../../config/terminalConfig';
import useNetworkStatus from '../../hooks/useNetworkStatus';
import OfflineBanner from '../../components/terminal/OfflineBanner';
import ShareToast from '../../components/terminal/ShareToast';
import { buildShareUrl } from '../../utils/terminalShare';
import { createSnapshot } from '../../services/snapshotClient';
import { createObserveUrl } from '../../services/observerClient';
import { fetchRecoverableSessions, matchSessionsToPanes } from '../../services/sessionRecoveryClient';
import SessionRecoveryBanner from '../../components/terminal/SessionRecoveryBanner';
import './terminal-view.css';

const PLUGIN_NAME = 'web-terminal';

/**
 * Layout icon SVGs for the layout picker
 */
function SingleIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="1" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
    );
}

function SplitHIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="1" width="5" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <rect x="8" y="1" width="5" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
    );
}

function SplitVIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="1" width="12" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <rect x="1" y="8" width="12" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
    );
}

function MainSideIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="1" width="7" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <rect x="10" y="1" width="3" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <rect x="10" y="8" width="3" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
        </svg>
    );
}

function SideMainIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="1" width="3" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <rect x="1" y="8" width="3" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <rect x="6" y="1" width="7" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
    );
}

function TopSplitIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="1" width="12" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <rect x="1" y="10" width="5" height="3" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <rect x="8" y="10" width="5" height="3" rx="1" stroke="currentColor" strokeWidth="1.2" />
        </svg>
    );
}

function SplitTopIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="1" width="5" height="3" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <rect x="8" y="1" width="5" height="3" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <rect x="1" y="6" width="12" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
    );
}

function QuadIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="1" width="5" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <rect x="8" y="1" width="5" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <rect x="1" y="8" width="5" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <rect x="8" y="8" width="5" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
    );
}

const LAYOUT_OPTIONS = [
    { id: 'single',    label: 'Single',           Icon: SingleIcon },
    { id: 'split-h',   label: 'Split Horizontal',  Icon: SplitHIcon },
    { id: 'split-v',   label: 'Split Vertical',    Icon: SplitVIcon },
    { id: 'main-side', label: 'Main + Side',       Icon: MainSideIcon },
    { id: 'side-main', label: 'Side + Main',       Icon: SideMainIcon },
    { id: 'top-split', label: 'Top + Split',       Icon: TopSplitIcon },
    { id: 'split-top', label: 'Split + Bottom',    Icon: SplitTopIcon },
    { id: 'quad',      label: 'Quad',              Icon: QuadIcon },
];

export default function TerminalView() {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();

    const {
        layout,
        panes,
        focusedPaneId,
        setLayout,
        updatePane,
        setPaneConnected,
        setPaneSessionId,
        setFocusedPane,
        sessionCount,
        activePaneCount,
        // Multi-workspace
        workspaces,
        activeWorkspaceId,
        workspaceWarning,
        addWorkspace,
        removeWorkspace,
        renameWorkspace,
        setActiveWorkspace,
        duplicateWorkspace,
    } = useTerminalWorkspace(searchParams);

    const [hosts, setHosts] = useState([]);
    const [hostsLoading, setHostsLoading] = useState(false);
    const [chatOpen, setChatOpen] = useState(false);
    const chatSendRef = useRef(null);
    const pendingErrorRef = useRef(null);

    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [shareToastVisible, setShareToastVisible] = useState(false);
    const [shareToastMessage, setShareToastMessage] = useState('Share link copied to clipboard');
    const [snapshotLoading, setSnapshotLoading] = useState(false);
    const [observeLoading, setObserveLoading] = useState(false);

    // --- Navigation guard: prevent accidental session loss ---
    const totalActiveSessions = workspaces.reduce(
        (sum, ws) => sum + ws.panes.filter(p => p.connected).length, 0
    );
    const hasActiveSessions = totalActiveSessions > 0;
    const [leaveTarget, setLeaveTarget] = useState(null);

    // Intercept clicks on sidebar/nav links when sessions are active.
    // Uses document-level capture listener — does NOT patch pushState or any browser API.
    useEffect(() => {
        if (!hasActiveSessions) return;
        const handler = (e) => {
            const anchor = e.target.closest?.('a[href]');
            if (!anchor) return;
            const href = anchor.getAttribute('href');
            if (!href || href.startsWith('#') || href.includes('/terminal')) return;
            // Only intercept internal links (same origin, relative paths)
            if (href.startsWith('http') && !href.startsWith(window.location.origin)) return;
            e.preventDefault();
            e.stopPropagation();
            setLeaveTarget(href);
        };
        document.addEventListener('click', handler, true);
        return () => document.removeEventListener('click', handler, true);
    }, [hasActiveSessions]);

    const handleLeaveStay = useCallback(() => setLeaveTarget(null), []);
    const handleLeaveConfirm = useCallback(() => {
        const href = leaveTarget;
        setLeaveTarget(null);
        if (href) navigate(href);
    }, [leaveTarget, navigate]);

    // Browser close / refresh guard
    useEffect(() => {
        if (!hasActiveSessions) return;
        const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, [hasActiveSessions]);

    // Observer mode: ?observe=<sessionId> makes this a read-only observer view
    const observeSessionId = searchParams.get('observe') || null;

    // Vim keybindings — per-workspace toggle, persisted in localStorage
    const VIM_STORAGE_PREFIX = 'quox-terminal-vim-';
    const [vimEnabled, setVimEnabled] = useState(() => {
        try {
            return localStorage.getItem(`${VIM_STORAGE_PREFIX}${activeWorkspaceId}`) === 'true';
        } catch { return false; }
    });

    // Map of paneId → ref for terminal clear (Ctrl+Shift+L)
    const clearRefsMap = useRef({});
    // Map of paneId → ref for reconnect trigger (auto-resume on network restore)
    const reconnectRefsMap = useRef({});

    // Network offline detection + auto-resume
    const { isOnline, wasOffline } = useNetworkStatus();

    useEffect(() => {
        if (!wasOffline) return;
        // Network just came back — trigger reconnect on all disconnected panes across all workspaces
        for (const ws of workspaces) {
            for (const pane of ws.panes) {
                if (!pane.connected) {
                    const key = `${ws.id}-${pane.id}`;
                    const reconnectFn = reconnectRefsMap.current[key];
                    if (reconnectFn?.current) reconnectFn.current();
                }
            }
        }
    }, [wasOffline, workspaces]);

    // Prune orphaned refs when workspaces change (e.g., workspace deleted)
    useEffect(() => {
        const validKeys = new Set();
        for (const ws of workspaces) {
            for (const pane of ws.panes) {
                validKeys.add(`${ws.id}-${pane.id}`);
            }
        }
        for (const key of Object.keys(clearRefsMap.current)) {
            if (!validKeys.has(key)) delete clearRefsMap.current[key];
        }
        for (const key of Object.keys(reconnectRefsMap.current)) {
            if (!validKeys.has(key)) delete reconnectRefsMap.current[key];
        }
    }, [workspaces]);

    // --- Session recovery: discover detached sessions via REST on mount ---
    const [recoveryMatches, setRecoveryMatches] = useState([]);
    const [recoveringPaneId, setRecoveringPaneId] = useState(null);

    // Fetch recoverable sessions once on mount
    useEffect(() => {
        let cancelled = false;
        fetchRecoverableSessions().then(sessions => {
            if (cancelled || sessions.length === 0) return;
            const matches = matchSessionsToPanes(sessions, workspaces);
            if (matches.length > 0) setRecoveryMatches(matches);
        });
        return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // Only on mount

    // After setPaneSessionId propagates, trigger reconnection via ref
    useEffect(() => {
        if (!recoveringPaneId) return;
        const pane = panes.find(p => p.id === recoveringPaneId);
        if (pane?.sessionId) {
            const key = `${activeWorkspaceId}-${recoveringPaneId}`;
            const reconnectFn = reconnectRefsMap.current[key];
            if (reconnectFn?.current) reconnectFn.current();
            setRecoveringPaneId(null);
            // Remove this match from the recovery list
            setRecoveryMatches(prev => prev.filter(m => m.paneId !== recoveringPaneId));
        }
    }, [recoveringPaneId, panes, activeWorkspaceId]);

    const handleRecoverSession = useCallback((paneId, sessionId) => {
        setPaneSessionId(paneId, sessionId);
        setRecoveringPaneId(paneId);
    }, [setPaneSessionId]);

    // Read current terminal mode (for error detection filtering)
    const terminalMode = loadMode(activeWorkspaceId);

    // Ref for closeTab to avoid circular dependency (handleCloseTab defined later)
    const closeTabRef = useRef(null);

    // Shared shortcut dispatcher — used by both xterm handler and window listener
    const dispatchShortcut = useCallback((action) => {
        switch (action) {
            case 'focusPane0':
            case 'focusPane1':
            case 'focusPane2':
            case 'focusPane3': {
                const idx = parseInt(action.slice(-1), 10);
                if (panes[idx]) setFocusedPane(panes[idx].id);
                break;
            }
            case 'toggleChat':
                setChatOpen(prev => !prev);
                break;
            case 'clearTerminal': {
                const clearKey = `${activeWorkspaceId}-${focusedPaneId}`;
                const clearFn = clearRefsMap.current[clearKey];
                if (clearFn?.current) clearFn.current();
                break;
            }
            case 'newWorkspace':
                addWorkspace();
                break;
            case 'closeWorkspace':
                if (workspaces.length > 1 && closeTabRef.current) closeTabRef.current(activeWorkspaceId);
                break;
            case 'showShortcuts':
                setShortcutsOpen(prev => !prev);
                break;
            case 'toggleVim':
                setVimEnabled(prev => {
                    const next = !prev;
                    try { localStorage.setItem(`${VIM_STORAGE_PREFIX}${activeWorkspaceId}`, next); } catch {}
                    return next;
                });
                break;
            default:
                return false;
        }
        return true;
    }, [panes, setFocusedPane, addWorkspace, workspaces.length, activeWorkspaceId, focusedPaneId]);

    // xterm custom key handler — return false to intercept, true to pass through
    const handleTerminalKey = useCallback((event) => {
        // Only intercept Ctrl combos
        if (!event.ctrlKey && !event.metaKey) return true;
        const action = matchShortcut(event);
        if (action) {
            event.preventDefault();
            event.stopPropagation();
            dispatchShortcut(action);
            return false; // consumed — don't send to xterm
        }
        return true; // pass through to xterm (Ctrl+C, Ctrl+D, etc.)
    }, [dispatchShortcut]);

    // Window-level listener for when xterm is NOT focused (tab bar, chat, etc.)
    useEffect(() => {
        const handleWindowKey = (event) => {
            // Skip when typing in inputs/textareas
            const tag = event.target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (!event.ctrlKey && !event.metaKey) return;
            const action = matchShortcut(event);
            if (action) {
                event.preventDefault();
                dispatchShortcut(action);
            }
        };
        window.addEventListener('keydown', handleWindowKey);
        return () => window.removeEventListener('keydown', handleWindowKey);
    }, [dispatchShortcut]);

    // Error notification → chat flow
    const handleErrorAction = useCallback((action, error) => {
        pendingErrorRef.current = error;
        setChatOpen(true);
        setTimeout(() => {
            chatSendRef.current?.(composeErrorQuery(action, error));
        }, 0);
    }, []);

    // Workspace tab switch with memory focus tracking + vim state sync
    const handleWorkspaceSwitch = useCallback((wsId) => {
        setActiveWorkspace(wsId);
        // Load vim enabled state for new workspace
        try {
            setVimEnabled(localStorage.getItem(`${VIM_STORAGE_PREFIX}${wsId}`) === 'true');
        } catch { setVimEnabled(false); }
        const ws = workspaces.find(w => w.id === wsId);
        if (ws) {
            const focusedPane = ws.panes?.find(p => p.id === ws.focusedPaneId);
            updateTerminalFocus(ws.name, focusedPane?.hostId || null);
        }
    }, [setActiveWorkspace, workspaces]);

    // Share workspace — copy URL to clipboard
    const handleShareWorkspace = useCallback(() => {
        const activeWs = workspaces.find(w => w.id === activeWorkspaceId);
        if (!activeWs) return;
        const url = buildShareUrl(activeWs);
        navigator.clipboard.writeText(url).then(() => {
            setShareToastMessage('Setup link copied to clipboard');
            setShareToastVisible(true);
        }).catch(() => {
            // Fallback: select-copy for older browsers
            const ta = document.createElement('textarea');
            ta.value = url;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            setShareToastMessage('Setup link copied to clipboard');
            setShareToastVisible(true);
        });
    }, [workspaces, activeWorkspaceId]);

    // Share snapshot — capture terminal output + layout, get share URL
    const handleShareSnapshot = useCallback(async () => {
        const activeWs = workspaces.find(w => w.id === activeWorkspaceId);
        if (!activeWs) return;
        setSnapshotLoading(true);
        try {
            const result = await createSnapshot({
                name: activeWs.name,
                layout: activeWs.layout,
                panes: activeWs.panes,
            });
            const url = `${window.location.origin}/terminal/share/${result.shareId}`;
            await navigator.clipboard.writeText(url).catch(() => {});
            setShareToastMessage('Snapshot link copied to clipboard');
            setShareToastVisible(true);
        } catch (err) {
            console.error('[TerminalView] Snapshot share failed:', err);
            setShareToastMessage('Snapshot failed — ' + (err.message || 'try again'));
            setShareToastVisible(true);
        } finally {
            setSnapshotLoading(false);
        }
    }, [workspaces, activeWorkspaceId]);

    // Share observer link — create observe URL for focused pane's session
    const handleShareObserve = useCallback(async () => {
        const focusedPane = panes.find(p => p.id === focusedPaneId);
        if (!focusedPane?.sessionId) return;
        setObserveLoading(true);
        try {
            const result = await createObserveUrl(focusedPane.sessionId);
            const url = `${window.location.origin}${result.observeUrl}`;
            await navigator.clipboard.writeText(url).catch(() => {});
            setShareToastMessage('Observer link copied to clipboard');
            setShareToastVisible(true);
        } catch (err) {
            console.error('[TerminalView] Observer link failed:', err);
            setShareToastMessage('Observer link failed — ' + (err.message || 'try again'));
            setShareToastVisible(true);
        } finally {
            setObserveLoading(false);
        }
    }, [panes, focusedPaneId]);

    // Confirmation dialog state
    const [confirmModal, setConfirmModal] = useState(null);
    // Inline tab rename state
    const [renamingTabId, setRenamingTabId] = useState(null);
    const [renameValue, setRenameValue] = useState('');
    const renameInputRef = useRef(null);

    const diag = usePluginLicenseDiagnosis(PLUGIN_NAME);
    const licensed = diag.licensed;

    // Load hosts from bastion (once, shared across all panes)
    const hasAnySshPane = workspaces.some(ws => ws.panes.some(p => p.mode === 'ssh'));
    useEffect(() => {
        if (!hasAnySshPane) return;
        setHostsLoading(true);
        listHosts()
            .then(result => {
                const hostList = Array.isArray(result) ? result : (result?.hosts || []);
                setHosts(hostList);
            })
            .catch(err => {
                console.error('[TerminalView] Failed to load hosts:', err);
                setHosts([]);
            })
            .finally(() => setHostsLoading(false));
    }, [hasAnySshPane]);

    const handleModeChange = useCallback((wsId, paneId, mode) => {
        updatePane(paneId, { mode }, wsId);
    }, [updatePane]);

    const handleHostChange = useCallback((wsId, paneId, hostId) => {
        updatePane(paneId, { hostId }, wsId);
    }, [updatePane]);

    const handleConnect = useCallback((wsId, paneId) => {
        setPaneConnected(paneId, true, wsId);
    }, [setPaneConnected]);

    const handleDisconnect = useCallback((wsId, paneId) => {
        setPaneConnected(paneId, false, wsId);
    }, [setPaneConnected]);

    const handleSessionId = useCallback((wsId, paneId, sessionId) => {
        setPaneSessionId(paneId, sessionId, wsId);
    }, [setPaneSessionId]);

    const handleClose = useCallback(() => {
        setLayout('single');
    }, [setLayout]);

    // Layout change with confirmation when sessions would be lost
    const handleLayoutChange = useCallback((newLayout) => {
        const sessionsToLose = getSessionsToLose(panes, newLayout);
        if (sessionsToLose > 0) {
            setConfirmModal({
                type: 'layout',
                title: 'Change Layout',
                message: `This will close ${sessionsToLose} connected session${sessionsToLose > 1 ? 's' : ''}. Continue?`,
                onConfirm: () => {
                    setLayout(newLayout);
                    setConfirmModal(null);
                },
            });
        } else {
            setLayout(newLayout);
        }
    }, [panes, setLayout]);

    // Close workspace tab — always confirm (too easy to lose work)
    const handleCloseTab = useCallback((wsId) => {
        const ws = workspaces.find(w => w.id === wsId);
        if (!ws) return;
        const connectedCount = ws.panes.filter(p => p.connected).length;
        const detail = connectedCount > 0
            ? `This will disconnect ${connectedCount} active session${connectedCount > 1 ? 's' : ''}.`
            : 'This workspace will be removed.';
        setConfirmModal({
            type: 'close-tab',
            title: `Close "${ws.name}"?`,
            message: detail,
            onConfirm: () => {
                removeWorkspace(wsId);
                setConfirmModal(null);
            },
        });
    }, [workspaces, removeWorkspace]);
    closeTabRef.current = handleCloseTab;

    // Inline rename: double-click to start
    const handleTabDoubleClick = useCallback((wsId, currentName) => {
        setRenamingTabId(wsId);
        setRenameValue(currentName);
    }, []);

    // Focus input when rename starts
    useEffect(() => {
        if (renamingTabId && renameInputRef.current) {
            renameInputRef.current.focus();
            renameInputRef.current.select();
        }
    }, [renamingTabId]);

    const commitRename = useCallback(() => {
        if (renamingTabId) {
            renameWorkspace(renamingTabId, renameValue);
            setRenamingTabId(null);
        }
    }, [renamingTabId, renameValue, renameWorkspace]);

    const handleRenameKeyDown = useCallback((e) => {
        if (e.key === 'Enter') {
            commitRename();
        } else if (e.key === 'Escape') {
            setRenamingTabId(null);
        }
    }, [commitRename]);

    if (!licensed) {
        return <PluginLicenseNotice diag={diag} displayName="Web Terminal" accentColor="#22c55e" />;
    }

    // Observer mode — render a single read-only pane
    if (observeSessionId) {
        return (
            <div className="terminal-view">
                <div className="terminal-view__header">
                    <div className="terminal-view__title">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                        </svg>
                        Terminal Observer
                        <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginLeft: '8px' }}>
                            READ-ONLY
                        </span>
                    </div>
                </div>
                <div className="terminal-view__main">
                    <div className="terminal-view__body" data-layout="single">
                        <TerminalPane
                            paneId="observer-0"
                            mode="local"
                            hostId=""
                            sessionId={null}
                            hosts={[]}
                            hostsLoading={false}
                            isFocused={true}
                            showCloseBtn={false}
                            terminalMode={terminalMode}
                            onModeChange={() => {}}
                            onHostChange={() => {}}
                            onConnect={() => {}}
                            onDisconnect={() => {}}
                            onSessionId={() => {}}
                            onFocus={() => {}}
                            onClose={() => {}}
                            vimEnabled={false}
                            isObserver={true}
                            observeSessionId={observeSessionId}
                        />
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="terminal-view">
            <div className="terminal-view__header">
                <div className="terminal-view__title">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="4 17 10 11 4 5" />
                        <line x1="12" y1="19" x2="20" y2="19" />
                    </svg>
                    Web Terminal
                </div>

                <div className="terminal-view__toolbar">
                    <div className="terminal-view__layout-picker">
                        {LAYOUT_OPTIONS.map(({ id, label, Icon }) => (
                            <button
                                key={id}
                                className={`terminal-view__layout-btn ${layout === id ? 'terminal-view__layout-btn--active' : ''}`}
                                onClick={() => handleLayoutChange(id)}
                                title={label}
                            >
                                <Icon />
                            </button>
                        ))}
                    </div>

                    <span className={`terminal-view__sessions ${sessionCount > 0 ? 'terminal-view__sessions--active' : ''}`}>
                        {sessionCount}/{activePaneCount}
                    </span>

                    <button
                        className={`terminal-view__layout-btn ${chatOpen ? 'terminal-view__layout-btn--active' : ''}`}
                        onClick={() => setChatOpen(prev => !prev)}
                        title={chatOpen ? 'Close AI Chat' : 'Open AI Chat'}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                    </button>
                </div>

                <div className="terminal-view__status">
                    <span className={`terminal-view__dot ${sessionCount > 0 ? 'terminal-view__dot--connected' : ''}`} />
                    {sessionCount > 0 ? `${sessionCount} Connected` : 'Disconnected'}
                </div>
            </div>

            {/* Workspace tab bar */}
            <div className="terminal-view__tab-bar">
                {workspaces.map(ws => (
                    <div
                        key={ws.id}
                        className={`terminal-view__tab ${ws.id === activeWorkspaceId ? 'terminal-view__tab--active' : ''}`}
                        onClick={() => handleWorkspaceSwitch(ws.id)}
                        onDoubleClick={() => handleTabDoubleClick(ws.id, ws.name)}
                        title={`${ws.name} — ${ws.layout}`}
                    >
                        {renamingTabId === ws.id ? (
                            <input
                                ref={renameInputRef}
                                className="terminal-view__tab-rename"
                                type="text"
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onBlur={commitRename}
                                onKeyDown={handleRenameKeyDown}
                                onClick={(e) => e.stopPropagation()}
                                maxLength={24}
                            />
                        ) : (
                            <span className="terminal-view__tab-name">{ws.name}</span>
                        )}
                        {ws.panes.some(p => p.connected) && (
                            <span className="terminal-view__tab-dot" />
                        )}
                        {workspaces.length > 1 && (
                            <button
                                className="terminal-view__tab-close"
                                onClick={(e) => { e.stopPropagation(); handleCloseTab(ws.id); }}
                                title="Close workspace"
                            >
                                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                                    <line x1="2" y1="2" x2="8" y2="8" />
                                    <line x1="8" y1="2" x2="2" y2="8" />
                                </svg>
                            </button>
                        )}
                    </div>
                ))}
                <button
                    className="terminal-view__tab-add"
                    onClick={addWorkspace}
                    title="New workspace"
                >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <line x1="6" y1="1" x2="6" y2="11" />
                        <line x1="1" y1="6" x2="11" y2="6" />
                    </svg>
                </button>
                <button
                    className="terminal-view__tab-add"
                    onClick={handleShareWorkspace}
                    title="Share workspace setup"
                >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="18" cy="5" r="3" />
                        <circle cx="6" cy="12" r="3" />
                        <circle cx="18" cy="19" r="3" />
                        <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                        <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                    </svg>
                </button>
                {sessionCount > 0 && (
                    <button
                        className="terminal-view__tab-add"
                        onClick={handleShareSnapshot}
                        disabled={snapshotLoading}
                        title="Share snapshot (layout + terminal output)"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                            <circle cx="12" cy="13" r="4" />
                        </svg>
                    </button>
                )}
                {sessionCount > 0 && (
                    <button
                        className="terminal-view__tab-add"
                        onClick={handleShareObserve}
                        disabled={observeLoading}
                        title="Share live observer link (read-only)"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                        </svg>
                    </button>
                )}
                {workspaceWarning && (
                    <span className="terminal-view__workspace-warning">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                        {workspaceWarning}
                    </span>
                )}
            </div>

            <OfflineBanner isOffline={!isOnline} />
            <SessionRecoveryBanner
                matches={recoveryMatches}
                onReconnect={handleRecoverSession}
            />

            <div className="terminal-view__main">
                {workspaces.map(ws => {
                    const isActive = ws.id === activeWorkspaceId;
                    return (
                        <div
                            key={ws.id}
                            className="terminal-view__body"
                            data-layout={ws.layout}
                            style={isActive ? undefined : { display: 'none' }}
                        >
                            {ws.panes.map(pane => {
                                const refKey = `${ws.id}-${pane.id}`;
                                if (!clearRefsMap.current[refKey]) {
                                    clearRefsMap.current[refKey] = { current: null };
                                }
                                if (!reconnectRefsMap.current[refKey]) {
                                    reconnectRefsMap.current[refKey] = { current: null };
                                }
                                return (
                                    <TerminalPane
                                        key={refKey}
                                        paneId={pane.id}
                                        mode={pane.mode}
                                        hostId={pane.hostId}
                                        sessionId={pane.sessionId}
                                        initialCommand={pane.initialCommand}
                                        hosts={hosts}
                                        hostsLoading={hostsLoading}
                                        isFocused={isActive && ws.focusedPaneId === pane.id}
                                        showCloseBtn={ws.panes.length > 1}
                                        terminalMode={terminalMode}
                                        onModeChange={(paneId, mode) => handleModeChange(ws.id, paneId, mode)}
                                        onHostChange={(paneId, hostId) => handleHostChange(ws.id, paneId, hostId)}
                                        onConnect={(paneId) => handleConnect(ws.id, paneId)}
                                        onDisconnect={(paneId) => handleDisconnect(ws.id, paneId)}
                                        onSessionId={(paneId, sid) => handleSessionId(ws.id, paneId, sid)}
                                        onFocus={isActive ? setFocusedPane : undefined}
                                        onClose={handleClose}
                                        onErrorAction={isActive ? handleErrorAction : undefined}
                                        vimEnabled={isActive ? vimEnabled : false}
                                        customKeyHandler={isActive ? handleTerminalKey : undefined}
                                        clearRef={clearRefsMap.current[refKey]}
                                        reconnectRef={reconnectRefsMap.current[refKey]}
                                        visible={isActive}
                                    />
                                );
                            })}
                        </div>
                    );
                })}
                {chatOpen && (
                    <TerminalChat
                        workspaceId={activeWorkspaceId}
                        paneId={focusedPaneId}
                        isOpen={chatOpen}
                        onClose={() => setChatOpen(false)}
                        sessionId={panes.find(p => p.id === focusedPaneId)?.sessionId || null}
                        chatSendRef={chatSendRef}
                        pendingErrorRef={pendingErrorRef}
                    />
                )}
            </div>

            {/* Keyboard shortcuts overlay — append vim navigation keys when enabled */}
            <KeyboardShortcuts
                isOpen={shortcutsOpen}
                onClose={() => setShortcutsOpen(false)}
                shortcuts={vimEnabled ? [
                    ...TERMINAL_SHORTCUTS,
                    {
                        category: 'Vim Navigation (NORMAL mode)',
                        items: [
                            { keys: ['Esc'], description: 'Enter NORMAL mode' },
                            { keys: ['i'], description: 'Enter INSERT mode (type in shell)' },
                            { keys: ['j'], description: 'Scroll down one line' },
                            { keys: ['k'], description: 'Scroll up one line' },
                            { keys: ['Ctrl', 'd'], description: 'Scroll half page down' },
                            { keys: ['Ctrl', 'u'], description: 'Scroll half page up' },
                            { keys: ['G'], description: 'Jump to bottom' },
                            { keys: ['g', 'g'], description: 'Jump to top' },
                        ],
                    },
                ] : TERMINAL_SHORTCUTS}
            />

            <ShareToast visible={shareToastVisible} message={shareToastMessage} onDone={() => setShareToastVisible(false)} />

            {/* Navigation guard — leave confirmation */}
            {leaveTarget && (
                <Modal isOpen={true} onClose={handleLeaveStay} severity="warning" size="sm">
                    <Modal.Header
                        title="Leave terminal?"
                        icon={
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                                <line x1="12" y1="9" x2="12" y2="13" />
                                <line x1="12" y1="17" x2="12.01" y2="17" />
                            </svg>
                        }
                    />
                    <Modal.Body>
                        <p style={{ margin: 0, color: 'rgba(255,255,255,0.7)', fontSize: '14px' }}>
                            You have {totalActiveSessions} active session{totalActiveSessions !== 1 ? 's' : ''}.
                            They'll persist for 30 minutes and auto-reconnect when you return.
                        </p>
                    </Modal.Body>
                    <Modal.Footer>
                        <button
                            onClick={handleLeaveStay}
                            style={{
                                padding: '8px 16px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                                borderRadius: '6px', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontSize: '13px',
                            }}
                        >
                            Stay
                        </button>
                        <button
                            onClick={handleLeaveConfirm}
                            style={{
                                padding: '8px 16px', background: 'rgba(255, 176, 48, 0.2)', border: '1px solid rgba(255, 176, 48, 0.4)',
                                borderRadius: '6px', color: '#ffb030', cursor: 'pointer', fontSize: '13px', fontWeight: 600,
                            }}
                        >
                            Leave
                        </button>
                    </Modal.Footer>
                </Modal>
            )}

            {/* Confirmation modal */}
            {confirmModal && (
                <Modal isOpen={true} onClose={() => setConfirmModal(null)} severity="warning" size="sm">
                    <Modal.Header
                        title={confirmModal.title}
                        icon={
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                                <line x1="12" y1="9" x2="12" y2="13" />
                                <line x1="12" y1="17" x2="12.01" y2="17" />
                            </svg>
                        }
                    />
                    <Modal.Body>
                        <p style={{ margin: 0, color: 'rgba(255,255,255,0.7)', fontSize: '14px' }}>
                            {confirmModal.message}
                        </p>
                    </Modal.Body>
                    <Modal.Footer>
                        <button
                            onClick={() => setConfirmModal(null)}
                            style={{
                                padding: '8px 16px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                                borderRadius: '6px', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontSize: '13px',
                            }}
                        >
                            Cancel
                        </button>
                        <button
                            onClick={confirmModal.onConfirm}
                            style={{
                                padding: '8px 16px', background: 'rgba(255, 176, 48, 0.2)', border: '1px solid rgba(255, 176, 48, 0.4)',
                                borderRadius: '6px', color: '#ffb030', cursor: 'pointer', fontSize: '13px', fontWeight: 600,
                            }}
                        >
                            Continue
                        </button>
                    </Modal.Footer>
                </Modal>
            )}
        </div>
    );
}

// Export for testing (keep backwards compatibility with existing tests)
function buildShellWsUrl(protocol, host, mode, hostId, sessionId) {
    const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
    if (sessionId) {
        return `${wsProto}//${host}/collector/terminal/shell/ws?session=${encodeURIComponent(sessionId)}`;
    }
    const params = new URLSearchParams({ mode });
    if (mode === 'ssh' && hostId) params.set('host', hostId);
    return `${wsProto}//${host}/collector/terminal/shell/ws?${params.toString()}`;
}

function groupHostsByGroup(hosts) {
    const groups = {};
    for (const host of hosts) {
        const group = host.group || 'ungrouped';
        if (!groups[group]) groups[group] = [];
        groups[group].push(host);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
}

export { buildShellWsUrl, groupHostsByGroup };
