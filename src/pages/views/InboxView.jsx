/**
 * InboxView - Human-in-the-Loop Inbox
 *
 * Main inbox showing approval requests, tasks, questions, and incidents.
 * Part of Phase C: HITL implementation.
 */

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useOutletContext, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useStepUp } from '../../hooks/useStepUp.jsx';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useInboxWithRealtime, useMultiOrgInboxStream } from '../../hooks/useInboxStream';
import { PageSection, PageGrid } from '../../components/layout';
// Modal removed — actions are inline on item rows now
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import { CoreCommsBanner } from '../../components/inbox';
import InboxFolderSidebar from '../../components/inbox/InboxFolderSidebar';
import InboxChatSidebar from '../../components/inbox/InboxChatSidebar';
import UndoToast from '../../components/inbox/UndoToast';
import SnoozeMenu from '../../components/inbox/SnoozeMenu';
import ShortcutHelpOverlay from '../../components/inbox/ShortcutHelpOverlay';
import { INBOX_FOLDERS, applyFolderFilter, computeFolderCounts, FOLDER_SERVER_FILTER, HISTORY_FOLDERS, HISTORY_CHIPS, getDecision } from '../../components/inbox/inboxFolders';

import { listApprovals, approveRequest, denyRequest } from '../../services/quoxflowClient';
import { denyNeedsReason } from '../../services/inboxReject';
import '../../components/inbox/inbox-layout.css';
import '../../components/inbox/inbox-glass.css';
import './views.css';
import LLMAuthBanner from '../../components/ui/LLMAuthBanner'

// Sort options
const SORT_OPTIONS = [
    { value: 'created_at_desc', label: 'Newest' },
    { value: 'created_at_asc', label: 'Oldest' },
    { value: 'priority_desc', label: 'Priority' },
    // QMH-5/3 — numeric priority score from priorityScorer (HITL checkpoints).
    { value: 'priority_score_desc', label: 'Priority Score' },
    { value: 'due_at_asc', label: 'Due Date' }
];

const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };

// SVG Icons for inbox
const InboxIcons = {
    inbox: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>,
    flow: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>,
    refresh: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>,
    star: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
    starFilled: <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
    archive: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>,
    clock: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
    trash: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,
    eye: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
    mailOpen: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6Z"/><path d="m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10"/></svg>,
    layers: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>,
    check: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
    checkCircle: <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>,
    shieldOk: <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>,
    x: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
    xCircle: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>,
    helpCircle: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
    send: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>,
    shield: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
    alertTriangle: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
    target: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>,
    zap: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
    info: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>,
    edit: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
};

// Item kind configs
const ITEM_KINDS = {
    approval: { label: 'Approval', color: 'blue', icon: InboxIcons.check },
    question: { label: 'Question', color: 'purple', icon: InboxIcons.helpCircle },
    task: { label: 'Task', color: 'green', icon: InboxIcons.target },
    incident: { label: 'Incident', color: 'red', icon: InboxIcons.zap },
    info: { label: 'Info', color: 'slate', icon: InboxIcons.info },
    override_required: { label: 'Override', color: 'amber', icon: InboxIcons.alertTriangle }
};

// Priority configs (matches schema: low, normal, high, urgent)
const PRIORITIES = {
    urgent: { label: 'Urgent', color: 'red' },
    high: { label: 'High', color: 'amber' },
    normal: { label: 'Normal', color: 'blue' },
    low: { label: 'Low', color: 'slate' }
};

// Status configs
const STATUSES = {
    open: { label: 'Open', color: 'blue' },
    in_progress: { label: 'In Progress', color: 'amber' },
    waiting: { label: 'Waiting', color: 'purple' },
    resolved: { label: 'Resolved', color: 'green' },
    cancelled: { label: 'Cancelled', color: 'slate' },
    expired: { label: 'Expired', color: 'red' }
};

function StatsStrip({ stats, activeStatus, onFilterStatus }) {
    const items = [
        { key: 'open', label: 'Open', value: stats.open, color: 'var(--ui-blue, #3b82f6)' },
        { key: 'in_progress', label: 'In Progress', value: stats.in_progress, color: 'var(--ui-amber, #f59e0b)' },
        { key: 'waiting', label: 'Waiting', value: stats.waiting || 0, color: 'var(--ui-purple, #a855f7)' },
        { key: null, label: 'Total', value: stats.total, color: 'rgba(255,255,255,0.7)' },
    ];
    return (
        <div className="inbox-stats-strip">
            {items.map(item => (
                <button
                    key={item.key ?? 'total'}
                    className={`inbox-stats-strip__item ${activeStatus === item.key ? 'inbox-stats-strip__item--active' : ''}`}
                    onClick={() => onFilterStatus(activeStatus === item.key ? null : item.key)}
                >
                    <span className="inbox-stats-strip__dot" style={{ backgroundColor: item.color }} />
                    <span className="inbox-stats-strip__value">{item.value}</span>
                    <span className="inbox-stats-strip__label">{item.label}</span>
                </button>
            ))}
        </div>
    );
}

function getItemSource(item) {
    // Prefer agent/workflow name over generic "System"
    if (item.payload?.agent_name) return item.payload.agent_name;
    if (item.payload?.source_agent) return item.payload.source_agent;
    if (item.created_by_name && item.created_by_name !== 'system') return item.created_by_name;
    if (item.workflow_name) return item.workflow_name;
    // Map known source patterns to friendly names
    if (item.payload?.source === 'service_monitor') return 'WARDEN';
    if (item.payload?.source === 'human_task') return 'QuoxFlow';
    if (item.payload?.source === 'proxmox_alert') return 'DAEDALUS';
    if (item.payload?.source === 'vault_alert') return 'CIPHER';
    if (item.created_by_name) return item.created_by_name;
    return 'CommanderQ';
}

function stripMarkdown(text) {
    if (!text) return '';
    return text
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')  // strip images
        .replace(/#{1,6}\s+/g, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/^[-*+]\s+/gm, '')
        .replace(/^\d+\.\s+/gm, '')
        .replace(/\n{2,}/g, ' ')
        .replace(/\n/g, ' ')
        .trim();
}

function InboxItemCard({ item, onClick, onToggleFlag, orgName }) {
    const kindConfig = ITEM_KINDS[item.kind] || ITEM_KINDS.info;
    const priorityConfig = PRIORITIES[item.priority] || PRIORITIES.normal;
    const statusConfig = STATUSES[item.status] || STATUSES.open;
    const fromLabel = getItemSource(item);
    const decision = getDecision(item);
    const isUnread = !item.is_read;

    const formatTime = (timestamp) => {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;
        const mins = Math.floor(diff / 60000);
        const hours = Math.floor(mins / 60);
        const days = Math.floor(hours / 24);

        const relative = days > 0 ? `${days}d ago` : hours > 0 ? `${hours}h ago` : mins > 0 ? `${mins}m ago` : 'just now';
        const absolute = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' + date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        return `${absolute} (${relative})`;
    };

    const getDueStatus = () => {
        if (!item.due_at) return null;
        const due = new Date(item.due_at);
        const now = new Date();
        const diff = due - now;
        const hours = Math.floor(diff / (1000 * 60 * 60));

        if (diff < 0) return { label: 'Overdue', color: 'red' };
        if (hours < 1) return { label: '<1h', color: 'red' };
        if (hours < 4) return { label: `${hours}h`, color: 'amber' };
        return { label: `${hours}h`, color: 'green' };
    };

    const dueStatus = getDueStatus();

    return (
        <div className={`inbox-item-card inbox-item-card--${statusConfig.color}${isUnread ? ' inbox-item-card--unread' : ''}`} onClick={onClick}>
            {isUnread && <span className="inbox-item-card__unread-dot" />}
            <div className="inbox-item-card__content">
                {/* Title row: icon + title + all badges inline */}
                <div className="inbox-item-card__header">
                    <div className="inbox-item-card__icon" style={{ color: `var(--ui-${kindConfig.color}, #a855f7)` }}>
                        {kindConfig.icon}
                    </div>
                    <span className="inbox-item-card__title">{item.title}</span>
                    <div className="inbox-item-card__badges">
                        {orgName && <span className="inbox-item-org-badge">{orgName}</span>}
                        {item.payload?.source === 'human_task' && (
                            <span className="inbox-item-card__workflow-paused-badge">
                                <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                                Workflow paused
                            </span>
                        )}
                        <Badge variant={priorityConfig.color} size="sm">
                            {/* QMH-5/3 — show numeric priority score when available
                                (HITL checkpoints carry it from priorityScorer). */}
                            {priorityConfig.label}
                            {typeof item.priority_score === 'number' && ` ${item.priority_score}`}
                        </Badge>
                        <Badge variant={kindConfig.color} size="sm">{kindConfig.label}</Badge>
                        {decision
                            ? <Badge variant={decision.color} size="sm" data-testid="decision-pill">{decision.label}</Badge>
                            : <Badge variant={statusConfig.color} size="sm">{statusConfig.label}</Badge>}
                        {dueStatus && (
                            <Badge variant={dueStatus.color} size="sm">Due: {dueStatus.label}</Badge>
                        )}
                        <button
                            className={`inbox-item-card__flag-btn${item.is_flagged ? ' inbox-item-card__flag-btn--active' : ''}`}
                            onClick={(e) => { e.stopPropagation(); onToggleFlag?.(item.id, !item.is_flagged); }}
                            title={item.is_flagged ? 'Unflag' : 'Flag'}
                            aria-label={item.is_flagged ? 'Unflag item' : 'Flag item'}
                        >
                            {item.is_flagged ? InboxIcons.starFilled : InboxIcons.star}
                        </button>
                    </div>
                </div>
                {/* Body uses full width */}
                {item.body_md && (
                    <div className="inbox-item-card__body">
                        {(() => { const plain = item.payload?.approval_context?.summary_line || stripMarkdown(item.body_md); return plain.substring(0, 200) + (plain.length > 200 ? '...' : ''); })()}
                    </div>
                )}
                <div className="inbox-item-card__meta">
                    <span>From: <strong>{fromLabel}</strong></span>
                    <span>{formatTime(item.created_at)}</span>
                    {decision && (
                        <span data-testid="decision-meta">
                            {decision.label}{decision.who ? ` by ${decision.who}` : ''}{decision.when ? `, ${formatTime(decision.when)}` : ''}
                        </span>
                    )}
                    {item.run_id && <span>Run: {item.run_id.substring(0, 8)}</span>}
                </div>
            </div>
        </div>
    );
}

// ItemDetailModal removed — actions are now inline on each item row.
// Detail view lives at /inbox/:id (InboxItemDetailView).

function InboxView() {
    const { setPageActions } = useOutletContext() || {};
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const { authFetch, user } = useAuth();
    const { stepUpFetch, stepUpModal } = useStepUp(authFetch); // QUOXON-STEPUP
    const { currentOrg, orgs, myScopes } = useWorkspace();
    const initialScopeId = searchParams.get('scope') || null;
    const initialFolder = searchParams.get('folder') || 'inbox';
    const [activeFolder, setActiveFolder] = useState(initialFolder);
    const [orgFilter, setOrgFilter] = useState('all'); // 'all' | org.id
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [filter, setFilter] = useState({ status: null, kind: null, priority: null, scope_id: initialScopeId });
    const [error, setError] = useState(null);
    const [qfApprovals, setQfApprovals] = useState([]);
    const [qfLoading, setQfLoading] = useState(false);
    // QMH-5/3 — pending HITL checkpoints from /api/checkpoints/pending
    // (QMH-3 part 2 wired listPendingCheckpoints to surface task_priority).
    const [pendingCheckpoints, setPendingCheckpoints] = useState([]);

    // Right sidebar (TRIAGE-Q agent chat)
    const [chatSidebarOpen, setChatSidebarOpen] = useState(true);
    const [selectedChatAgent, setSelectedChatAgent] = useState('triage-q');

    // Search & filter state (controlled input + debounced filter)
    const [searchInput, setSearchInput] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [assigneeFilter, setAssigneeFilter] = useState('all'); // 'all' | 'mine' | 'unassigned'
    const [sortBy, setSortBy] = useState('created_at_desc');
    const searchDebounceRef = useRef(null);
    useEffect(() => () => clearTimeout(searchDebounceRef.current), []);

    // Bulk selection state
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [bulkLoading, setBulkLoading] = useState(false);
    const lastSelectedIndexRef = useRef(-1);

    // Undo toast state
    const [undoToast, setUndoToast] = useState(null); // { message, itemIds, action }

    // In-flight inline respond guard: prevents rapid double-clicks from firing
    // duplicate POSTs and surfacing "already resolved" 400s as fake failures.
    // Ref is the source of truth (synchronous); state mirrors it for re-render.
    // Tracked as itemId -> outcome so only the button matching the in-flight
    // outcome shows a spinner; its sibling button on the same card is merely
    // disabled (not loading), and other cards are unaffected.
    const pendingInflightRef = useRef(new Map());
    const [pendingInlineOutcomes, setPendingInlineOutcomes] = useState(() => new Map());

    // Snooze menu state
    const [snoozeTarget, setSnoozeTarget] = useState(null); // itemId for snooze menu

    // Keyboard shortcut help overlay
    const [showShortcutHelp, setShowShortcutHelp] = useState(false);

    // Keyboard navigation state
    const [focusIndex, setFocusIndex] = useState(-1);
    const listRef = useRef(null);
    const scrollSentinelRef = useRef(null);

    // Multi-org support: when "All" org filter is active and user has multiple orgs
    const allOrgIds = useMemo(() => (orgs || []).map(o => o.id), [orgs]);
    const useMultiOrg = orgFilter === 'all' && allOrgIds.length > 1;

    // Single-org hook (default or when specific org selected). The active
    // folder's server filter drives the fetch so the list is complete per folder.
    const singleOrgId = orgFilter === 'all' ? currentOrg?.id : orgFilter;
    // INBOX-LIVE: QF approvals + HITL checkpoints are separate lists the SSE
    // stream does not carry. Refresh them (debounced 2s) on item_created /
    // stats_updated, and immediately after any stream reopen/poll. The refs are
    // assigned below, after refreshQfApprovals/refreshCheckpoints exist.
    const extrasRefreshRef = useRef(() => {});
    const extrasDebounceRef = useRef(null);
    const handleStreamEvent = useCallback((type) => {
        if (type !== 'item_created' && type !== 'stats_updated') return;
        if (extrasDebounceRef.current) clearTimeout(extrasDebounceRef.current);
        extrasDebounceRef.current = setTimeout(() => {
            extrasDebounceRef.current = null;
            extrasRefreshRef.current();
        }, 2000);
    }, []);
    const handleStreamReconnect = useCallback(() => extrasRefreshRef.current(), []);
    useEffect(() => () => {
        if (extrasDebounceRef.current) clearTimeout(extrasDebounceRef.current);
    }, []);

    // INBOX-HISTORY: history folders (Approvals / All / Done) get a status chip
    // row; the chip narrows the server query (status/decision) so pagination and
    // totals stay correct within the chosen slice.
    const [historyChip, setHistoryChip] = useState('all');
    const isHistoryFolder = HISTORY_FOLDERS.includes(activeFolder);
    const activeChip = HISTORY_CHIPS.find(c => c.id === historyChip) || HISTORY_CHIPS[0];
    const serverFilter = useMemo(() => {
        const base = FOLDER_SERVER_FILTER[activeFolder] || {};
        if (!isHistoryFolder || activeChip.id === 'all') return base;
        return { ...base, ...activeChip.filter };
    }, [activeFolder, isHistoryFolder, activeChip]);

    const singleOrg = useInboxWithRealtime(useMultiOrg ? null : singleOrgId, {
        serverFilter,
        onEvent: handleStreamEvent,
        onReconnect: handleStreamReconnect,
    });

    // Multi-org hook (when "All" selected with multiple orgs)
    const multiOrg = useMultiOrgInboxStream(useMultiOrg ? allOrgIds : [], {
        serverFilter,
        onEvent: handleStreamEvent,
        onReconnect: handleStreamReconnect,
    });

    // Unified data source
    const rawItems = useMultiOrg ? multiOrg.items : singleOrg.items;
    const rawStats = useMultiOrg ? {} : singleOrg.stats;
    const loading = useMultiOrg ? multiOrg.loading : singleOrg.loading;
    const connected = useMultiOrg ? true : singleOrg.connected;
    const refresh = useMultiOrg ? multiOrg.refresh : singleOrg.refresh;
    const loadMore = !useMultiOrg ? singleOrg.loadMore : null;
    const loadingMore = !useMultiOrg ? singleOrg.loadingMore : false;
    const paginationInfo = !useMultiOrg ? singleOrg.pagination : null;

    useEffect(() => {
        setPageActions?.(
            <Button variant="secondary" onClick={refresh} disabled={loading} icon={InboxIcons.refresh}>
                Refresh
            </Button>
        );
        return () => setPageActions?.(null);
    }, [setPageActions, loading]);

    // Infinite scroll: auto-load next page when sentinel enters viewport
    useEffect(() => {
        const sentinel = scrollSentinelRef.current;
        if (!sentinel || !loadMore) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && !loadingMore) {
                    loadMore();
                }
            },
            { rootMargin: '200px' } // trigger 200px before sentinel is visible
        );

        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [loadMore, loadingMore]);

    // Normalize QF approvals into the same shape as platform items
    const normalizedQfItems = useMemo(() => {
        return qfApprovals.map(a => ({
            id: `qf-${a.id}`,
            _qfId: a.id,
            title: a.reason || a.intent || 'Approval Required',
            kind: 'approval',
            priority: 'normal',
            status: 'open',
            body_md: a.workflowId ? `Workflow: ${a.workflowId}${a.nodeId ? ` / Node: ${a.nodeId}` : ''}` : null,
            workflow_name: a.workflowId || null,
            run_id: a.executionId || null,
            created_at: a.requestedAt || null,
            // Per-user state defaults (QF items don't have DB-backed state)
            is_read: 1,
            is_flagged: 0,
            archived_at: null,
            snoozed_until: null,
            assignees: [],
        }));
    }, [qfApprovals]);

    // QMH-5/3 — normalize pending HITL checkpoints. task_priority is the
    // 0..100 score written by priorityScorer at decomposition time. Maps to
    // the qualitative priority buckets used by the existing inbox UI:
    //   80+ urgent, 60+ high, 40+ normal, <40 low.
    const normalizedCheckpointItems = useMemo(() => {
        return pendingCheckpoints.map(c => {
            const score = typeof c.taskPriority === 'number' ? c.taskPriority : null;
            const priority = score === null ? 'normal'
                : score >= 80 ? 'urgent'
                : score >= 60 ? 'high'
                : score >= 40 ? 'normal'
                : 'low';
            return {
                id: `cp-${c.id}`,
                _checkpointId: c.id,
                _objectiveId: c.objectiveId,
                _taskId: c.taskId,
                title: c.title || c.taskTitle || c.objectiveTitle || 'Checkpoint',
                kind: 'approval',
                priority,
                priority_score: score,
                status: c.status === 'pending' ? 'open' : c.status,
                body_md: c.description || (c.taskTitle ? `Task: ${c.taskTitle}` : null),
                created_at: c.createdAt || null,
                is_read: 0,
                is_flagged: 0,
                archived_at: null,
                snoozed_until: null,
                assignees: [],
            };
        });
    }, [pendingCheckpoints]);

    // Merge all items (unfiltered, for folder count computation)
    const allItems = useMemo(() => {
        return [...(rawItems || []), ...normalizedQfItems, ...normalizedCheckpointItems];
    }, [rawItems, normalizedQfItems, normalizedCheckpointItems]);

    // Compute folder badge counts from loaded items, then override the main +
    // type folders with SERVER-sourced counts (rawStats) so they stay accurate
    // even though the list is now fetched per-folder (loaded items alone would
    // undercount siblings). Math.max keeps the larger of client/server so
    // client-only sources (QuoxFlow approvals, HITL checkpoints) never shrink a
    // count below what is actually shown.
    const folderCounts = useMemo(() => {
        const counts = computeFolderCounts(allItems, user?.id);
        const bk = rawStats?.by_kind || {};
        const withServer = (folderId, serverVal) => {
            if (typeof serverVal === 'number') counts[folderId] = Math.max(counts[folderId] || 0, serverVal);
        };
        if (typeof rawStats?.total_active === 'number') counts.inbox = Math.max(counts.inbox || 0, rawStats.total_active);
        withServer('alerts', bk.incident);
        withServer('approvals', rawStats?.pending_approvals ?? bk.approval);
        withServer('questions', bk.question);
        withServer('tasks', bk.task);
        withServer('results', bk.info);
        return counts;
    }, [allItems, user?.id, rawStats]);

    // Apply folder filter, then search/sort
    const items = useMemo(() => {
        const currentFolder = INBOX_FOLDERS.find(f => f.id === activeFolder) || INBOX_FOLDERS[0];
        let filtered = applyFolderFilter(allItems, currentFolder, user?.id);

        // INBOX-HISTORY chip (client mirror of the server slice, keeps live updates honest)
        if (isHistoryFolder && activeChip.id !== 'all') {
            const cf = activeChip.filter;
            const sts = cf.status.split(',');
            filtered = filtered.filter(i => sts.includes(i.status) && (!cf.decision || getDecision(i)?.label.toLowerCase() === cf.decision));
        }

        // Additional inline filters (scope, status override, priority)
        if (filter.status) {
            filtered = filtered.filter(i => i.status === filter.status);
        }
        if (filter.scope_id) {
            filtered = filtered.filter(i => i.scope_id === filter.scope_id);
        }

        // Assignee filter
        if (assigneeFilter === 'mine') {
            filtered = filtered.filter(i =>
                i.assignees?.some(a => a.assignee_id === user?.id)
            );
        } else if (assigneeFilter === 'unassigned') {
            filtered = filtered.filter(i => !i.assignees || i.assignees.length === 0);
        }

        // Search filter
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            filtered = filtered.filter(i =>
                (i.title && i.title.toLowerCase().includes(q)) ||
                (i.body_md && i.body_md.toLowerCase().includes(q)) ||
                (i.workflow_name && i.workflow_name.toLowerCase().includes(q))
            );
        }

        // Sort based on selected option
        filtered.sort((a, b) => {
            switch (sortBy) {
                case 'created_at_asc':
                    return new Date(a.created_at || 0) - new Date(b.created_at || 0);
                case 'priority_desc': {
                    const pa = PRIORITY_ORDER[a.priority] ?? 2;
                    const pb = PRIORITY_ORDER[b.priority] ?? 2;
                    return pa !== pb ? pa - pb : new Date(b.created_at || 0) - new Date(a.created_at || 0);
                }
                // QMH-5/3 — numeric priority_score (0..100) from priorityScorer.
                // When present (HITL checkpoints), it ranks above the qualitative
                // bucket. Items without a score fall back to the bucket order so
                // the sort still produces a sensible total order.
                case 'priority_score_desc': {
                    const sa = typeof a.priority_score === 'number' ? a.priority_score : null;
                    const sb = typeof b.priority_score === 'number' ? b.priority_score : null;
                    if (sa !== null || sb !== null) {
                        if (sa === null) return 1;       // items without a score sink
                        if (sb === null) return -1;
                        if (sa !== sb) return sb - sa;   // higher score first
                    }
                    const pa = PRIORITY_ORDER[a.priority] ?? 2;
                    const pb = PRIORITY_ORDER[b.priority] ?? 2;
                    return pa !== pb ? pa - pb : new Date(b.created_at || 0) - new Date(a.created_at || 0);
                }
                case 'due_at_asc': {
                    const da = a.due_at ? new Date(a.due_at) : new Date('9999-12-31');
                    const db = b.due_at ? new Date(b.due_at) : new Date('9999-12-31');
                    return da - db;
                }
                case 'created_at_desc':
                default:
                    if (isHistoryFolder) {
                        // history: newest decision first (responded/resolved time, else created)
                        const t = (i) => new Date(getDecision(i)?.when || i.created_at || 0);
                        return t(b) - t(a);
                    }
                    return new Date(b.created_at || 0) - new Date(a.created_at || 0);
            }
        });

        return filtered;
    }, [allItems, activeFolder, isHistoryFolder, activeChip, filter, assigneeFilter, searchQuery, user?.id, sortBy]);

    // Clamp focusIndex when the item list shrinks (search, filter, sort changes)
    useEffect(() => {
        const maxIndex = items.length - 1;
        setFocusIndex(prev => (prev > maxIndex ? Math.max(maxIndex, -1) : prev));
    }, [items.length]);

    // Compute stats from raw stats or fallback to counting items
    const stats = useMemo(() => {
        if (rawStats?.by_status) {
            return {
                open: rawStats.by_status.open || 0,
                in_progress: rawStats.by_status.in_progress || 0,
                waiting: rawStats.by_status.waiting || 0,
                total: rawStats.total || 0
            };
        }
        // Fallback: compute from items
        const allItems = rawItems || [];
        return {
            open: allItems.filter(i => i.status === 'open').length,
            in_progress: allItems.filter(i => i.status === 'in_progress').length,
            waiting: allItems.filter(i => i.status === 'waiting').length,
            total: allItems.length
        };
    }, [rawStats, rawItems]);

    // Fetch QuoxFlow approvals on mount (merged into main list)
    const refreshQfApprovals = useCallback(() => {
        setQfLoading(true);
        listApprovals({ status: 'pending' })
            .then(res => setQfApprovals(res?.data || []))
            .catch(() => setQfApprovals([]))
            .finally(() => setQfLoading(false));
    }, []);

    useEffect(() => {
        refreshQfApprovals();
    }, [refreshQfApprovals]);

    // QMH-5/3 — fetch pending HITL checkpoints and refresh on the same
    // cadence as QF approvals. Uses /tasks proxy → /api/checkpoints/pending.
    const refreshCheckpoints = useCallback(() => {
        if (!authFetch) return;
        authFetch('/tasks/api/checkpoints/pending')
            .then(res => res?.ok ? res.json() : { checkpoints: [] })
            .then(body => setPendingCheckpoints(Array.isArray(body?.checkpoints) ? body.checkpoints : []))
            .catch(() => setPendingCheckpoints([]));
    }, [authFetch]);

    useEffect(() => {
        refreshCheckpoints();
    }, [refreshCheckpoints]);

    extrasRefreshRef.current = () => {
        refreshQfApprovals();
        refreshCheckpoints();
    };

    // QuoxFlow approve/deny for QF-backed approval items. Reuses the same
    // pendingInflightRef / pendingInlineOutcomes map as handleInlineRespond
    // so the existing button loading/disabled wiring lights up for free.
    // The map is keyed by item.id because that's what the buttons read;
    // the QuoxFlow API itself needs the separate _qfId, passed in as approvalId.
    const handleQfAction = useCallback(async (approvalId, action, itemId, reason = '') => {
        const outcome = action === 'approve' ? 'approved' : 'denied';

        // Guard against rapid double-clicks: only one in-flight action per item.
        if (pendingInflightRef.current.has(itemId)) return;
        pendingInflightRef.current.set(itemId, outcome);
        setPendingInlineOutcomes(new Map(pendingInflightRef.current));

        const clearPending = () => {
            pendingInflightRef.current.delete(itemId);
            setPendingInlineOutcomes(new Map(pendingInflightRef.current));
        };

        // approveRequest/denyRequest in quoxflowClient.js don't accept a
        // signal, so race the call against a 12s timer instead of aborting it.
        // The timer rejects with an AbortError-named error so the catch
        // block below can tell a timeout from a genuine failure.
        let timeoutId;
        const timeout = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                const err = new Error('QF action timed out');
                err.name = 'AbortError';
                reject(err);
            }, 12000);
        });

        try {
            const call = action === 'approve'
                ? approveRequest(approvalId, 'admin', reason)
                : denyRequest(approvalId, 'admin', reason);
            await Promise.race([call, timeout]);
            refreshQfApprovals();
        } catch (err) {
            const isTimeout = err?.name === 'AbortError';
            console.error('QF action failed:', err);
            setUndoToast({
                message: isTimeout ? 'Request timed out, please retry' : `Failed to ${action} approval`,
                itemIds: []
            });
        } finally {
            clearTimeout(timeoutId);
            clearPending();
        }
    }, [refreshQfApprovals]);

    // QMH-5/3 — checkpoint approve/deny. Checkpoint inbox items are `cp-`
    // prefixed projections built in normalizedCheckpointItems above; their
    // real identity in the tasks service is _objectiveId + _checkpointId,
    // not a platform inbox item id, so they must never go through the
    // platform `/api/orgs/:orgId/inbox/:itemId/respond` route (that 404s,
    // fleet #419). They resolve through the tasks proxy instead.
    const handleCheckpointAction = useCallback(async (objectiveId, checkpointId, action, itemId, reason = '') => {
        const outcome = action === 'approve' ? 'approved' : 'denied';

        // Guard against rapid double-clicks: only one in-flight action per item.
        if (pendingInflightRef.current.has(itemId)) return;
        pendingInflightRef.current.set(itemId, outcome);
        setPendingInlineOutcomes(new Map(pendingInflightRef.current));

        const clearPending = () => {
            pendingInflightRef.current.delete(itemId);
            setPendingInlineOutcomes(new Map(pendingInflightRef.current));
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);

        try {
            const path = `/tasks/api/objectives/${objectiveId}/checkpoints/${checkpointId}/${action === 'approve' ? 'approve' : 'reject'}`;
            const res = await (action === 'approve' ? stepUpFetch : authFetch)(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notes: reason || '' }),
                signal: controller.signal
            });
            if (!res?.ok) throw new Error(`HTTP ${res?.status}`);
            refreshCheckpoints();
            refresh();
        } catch (err) {
            const isTimeout = err?.name === 'AbortError';
            const verb = outcome === 'approved' ? 'approve' : 'deny';
            console.error('Checkpoint action failed:', err);
            setUndoToast({
                message: isTimeout ? 'Request timed out, please retry' : `Failed to ${verb} item`,
                itemIds: []
            });
        } finally {
            clearTimeout(timeoutId);
            clearPending();
        }
    }, [authFetch, stepUpFetch, refreshCheckpoints, refresh]);

    // ── Reject-with-reason ────────────────────────────────────────────────
    // A deny/request-changes should capture a reason (the server stores +
    // witnesses `comment`; the UI previously always sent ''). promptRejectReason
    // opens the modal and resolves with the entered text, or null if cancelled.
    const [rejectModal, setRejectModal] = useState(null); // null | { pending: true }
    const [rejectText, setRejectText] = useState('');
    const rejectResolveRef = useRef(null);

    const promptRejectReason = useCallback(() => new Promise((resolve) => {
        rejectResolveRef.current = resolve;
        setRejectText('');
        setRejectModal({ pending: true });
    }), []);

    const closeRejectModal = useCallback((value) => {
        const resolve = rejectResolveRef.current;
        rejectResolveRef.current = null;
        setRejectModal(null);
        if (resolve) resolve(value);
    }, []);

    // Resolve org_id for an item (supports multi-org mode)
    const resolveOrgId = useCallback((itemId) => {
        const item = (rawItems || []).find(i => i.id === itemId);
        return item?.org_id || currentOrg?.id;
    }, [rawItems, currentOrg?.id]);

    // Flag toggle handler
    const handleToggleFlag = useCallback(async (itemId, flagged) => {
        try {
            const orgId = resolveOrgId(itemId);
            const res = await authFetch(`/api/orgs/${orgId}/inbox/${itemId}/flag`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_flagged: flagged })
            });
            if (!res?.ok) throw new Error(`HTTP ${res?.status}`);
            refresh();
        } catch (err) {
            console.error('Flag toggle failed:', err);
            setUndoToast({ message: 'Failed to update flag', itemIds: [] });
            refresh();
        }
    }, [authFetch, resolveOrgId, refresh]);

    // Mark as read handler (fire-and-forget, no UI feedback needed)
    const handleMarkRead = useCallback(async (itemId) => {
        try {
            const orgId = resolveOrgId(itemId);
            const res = await authFetch(`/api/orgs/${orgId}/inbox/${itemId}/read`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_read: true })
            });
            if (!res?.ok) console.warn('Mark read returned:', res?.status);
        } catch (err) {
            console.error('Mark read failed:', err);
        }
    }, [authFetch, resolveOrgId]);

    // Snooze handler
    const handleSnooze = useCallback(async (itemId, snoozedUntil) => {
        try {
            const orgId = resolveOrgId(itemId);
            const res = await authFetch(`/api/orgs/${orgId}/inbox/${itemId}/snooze`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ snoozed_until: snoozedUntil })
            });
            if (!res?.ok) throw new Error(`HTTP ${res?.status}`);
            setSnoozeTarget(null);
            refresh();
        } catch (err) {
            console.error('Snooze failed:', err);
            setUndoToast({ message: 'Failed to snooze item', itemIds: [] });
        }
    }, [authFetch, resolveOrgId, refresh]);

    // Keyboard navigation — refs to avoid stale closures in useEffect
    const keyHandlersRef = useRef({});
    const selectedIdsRef = useRef(selectedIds);
    selectedIdsRef.current = selectedIds;

    useEffect(() => {
        const handleKeyDown = (e) => {
            // Don't capture when typing in inputs/textareas
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
            // No modal to dismiss — Escape just clears focus/selection

            const h = keyHandlersRef.current;
            const paginatedItems = items;
            const focusedItem = focusIndex >= 0 && focusIndex < paginatedItems.length ? paginatedItems[focusIndex] : null;

            switch (e.key) {
                case 'j': // Next item
                    e.preventDefault();
                    setFocusIndex(prev => Math.min(prev + 1, paginatedItems.length - 1));
                    break;
                case 'k': // Previous item
                    e.preventDefault();
                    setFocusIndex(prev => Math.max(prev - 1, 0));
                    break;
                case 'Enter': // Open focused item
                    if (focusedItem) {
                        e.preventDefault();
                        h.handleItemClick(focusedItem);
                    }
                    break;
                case 'Escape':
                    setFocusIndex(-1);
                    setSelectedIds(new Set());
                    setSnoozeTarget(null);
                    break;
                case 's': // Star/unstar (platform items only)
                    if (focusedItem && !String(focusedItem.id).startsWith('qf-')) {
                        e.preventDefault();
                        h.handleToggleFlag(focusedItem.id, !focusedItem.is_flagged);
                    }
                    break;
                case 'e': // Archive (platform items only)
                    if (focusedItem && !String(focusedItem.id).startsWith('qf-')) {
                        e.preventDefault();
                        h.handleArchive(focusedItem.id, !focusedItem.archived_at);
                    }
                    break;
                case 'h': // Snooze (platform items only)
                    if (focusedItem && !String(focusedItem.id).startsWith('qf-')) {
                        e.preventDefault();
                        setSnoozeTarget(focusedItem.id);
                    }
                    break;
                case 'x': // Select/deselect
                    if (focusedItem) {
                        e.preventDefault();
                        h.toggleSelectItem(focusedItem.id, focusIndex, false);
                    }
                    break;
                case '#': // Delete focused item (or selected items if any)
                    if (focusedItem) {
                        e.preventDefault();
                        if (selectedIdsRef.current.size === 0) {
                            // Nothing selected — delete just the focused item directly
                            h.handleBulkAction('delete', [focusedItem.id]);
                        } else {
                            h.handleBulkAction('delete');
                        }
                    }
                    break;
                case 'a': // Approve
                    if (focusedItem && focusedItem.kind === 'approval' && ['open', 'in_progress'].includes(focusedItem.status)) {
                        e.preventDefault();
                        h.resolveItem(focusedItem, 'approved');
                    }
                    break;
                case 'd': // Deny
                    if (focusedItem && focusedItem.kind === 'approval' && ['open', 'in_progress'].includes(focusedItem.status)) {
                        e.preventDefault();
                        h.resolveItem(focusedItem, 'denied');
                    }
                    break;
                case '?': // Help
                    e.preventDefault();
                    setShowShortcutHelp(true);
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [items, focusIndex]);

    // Bulk actions
    const toggleSelectItem = useCallback((itemId, index, shiftKey) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (shiftKey && lastSelectedIndexRef.current >= 0) {
                // Shift+click range select
                const paginatedItems = items;
                const start = Math.min(lastSelectedIndexRef.current, index);
                const end = Math.max(lastSelectedIndexRef.current, index);
                for (let i = start; i <= end; i++) {
                    if (paginatedItems[i]) {
                        next.add(paginatedItems[i].id);
                    }
                }
            } else if (next.has(itemId)) {
                next.delete(itemId);
            } else {
                next.add(itemId);
            }
            return next;
        });
        lastSelectedIndexRef.current = index;
    }, [items]);

    const toggleSelectAll = useCallback(() => {
        const paginatedItems = items;
        const allSelected = paginatedItems.length > 0 && paginatedItems.every(i => selectedIds.has(i.id));
        if (allSelected) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(paginatedItems.map(i => i.id)));
        }
    }, [items, selectedIds]);

    const handleBulkAction = useCallback(async (action, explicitIds = null) => {
        const sourceIds = explicitIds || Array.from(selectedIds);
        if (sourceIds.length === 0) return;
        setBulkLoading(true);
        // Filter out QF items (qf-* IDs don't exist in backend)
        const itemIds = sourceIds.filter(id => !String(id).startsWith('qf-'));
        if (itemIds.length === 0) {
            setBulkLoading(false);
            return;
        }
        try {
            // Group items by org for multi-org support
            const byOrg = {};
            for (const id of itemIds) {
                const orgId = resolveOrgId(id);
                if (!byOrg[orgId]) byOrg[orgId] = [];
                byOrg[orgId].push(id);
            }

            const results = await Promise.all(
                Object.entries(byOrg).map(async ([orgId, ids]) => {
                    const res = await (action === 'approve' ? stepUpFetch : authFetch)(`/api/orgs/${orgId}/inbox/bulk`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ item_ids: ids, action })
                    }, { subject: { line1: `approve ${ids.length} item${ids.length === 1 ? '' : 's'}` } });
                    if (!res?.ok) throw new Error(`HTTP ${res?.status}`);
                    return res.json();
                })
            );

            setError(null);
            setSelectedIds(new Set());

            // Show undo toast for destructive actions
            if (action === 'delete') {
                setUndoToast({ message: `${itemIds.length} item${itemIds.length > 1 ? 's' : ''} deleted`, itemIds, action });
            } else if (action === 'archive') {
                setUndoToast({ message: `${itemIds.length} item${itemIds.length > 1 ? 's' : ''} archived`, itemIds, action: 'unarchive' });
            }

            // Warn on partial failures
            const totalFailed = results.reduce((sum, r) => sum + (r.failed || 0), 0);
            if (totalFailed > 0) {
                console.warn(`Bulk ${action}: some items failed (${totalFailed} failures)`);
            }

            refresh();
        } catch (err) {
            console.error('Bulk action failed:', err);
            setError('Bulk action failed. Please try again.');
        } finally {
            setBulkLoading(false);
        }
    }, [selectedIds, authFetch, stepUpFetch, resolveOrgId, refresh]);

    const handleUndoBulk = useCallback(async () => {
        if (!undoToast) return;
        try {
            if (undoToast.action === 'unarchive') {
                // Group by org for multi-org support
                const byOrg = {};
                for (const id of undoToast.itemIds) {
                    const orgId = resolveOrgId(id);
                    if (!byOrg[orgId]) byOrg[orgId] = [];
                    byOrg[orgId].push(id);
                }
                await Promise.all(
                    Object.entries(byOrg).map(async ([orgId, ids]) => {
                        const res = await authFetch(`/api/orgs/${orgId}/inbox/bulk`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ item_ids: ids, action: 'unarchive' })
                        });
                        if (!res?.ok) throw new Error(`Undo unarchive failed: HTTP ${res?.status}`);
                    })
                );
            } else {
                // Restore deleted items
                const results = await Promise.all(undoToast.itemIds.map(id => {
                    const orgId = resolveOrgId(id);
                    return authFetch(`/api/orgs/${orgId}/inbox/${id}/restore`, { method: 'POST' });
                }));
                const failCount = results.filter(r => !r?.ok).length;
                if (failCount > 0) throw new Error(`${failCount} restore(s) failed`);
            }
            refresh();
        } catch (err) {
            console.error('Undo failed:', err);
            setUndoToast({ message: 'Undo failed — please refresh', itemIds: [] });
            return;
        }
        setUndoToast(null);
    }, [undoToast, authFetch, resolveOrgId, refresh]);

    // Archive handler for single items
    const handleArchive = useCallback(async (itemId, archived) => {
        try {
            const orgId = resolveOrgId(itemId);
            const res = await authFetch(`/api/orgs/${orgId}/inbox/${itemId}/archive`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ archived })
            });
            if (!res?.ok) throw new Error(`HTTP ${res?.status}`);
            if (archived) {
                setUndoToast({ message: '1 item archived', itemIds: [itemId], action: 'unarchive' });
            }
            refresh();
        } catch (err) {
            console.error('Archive failed:', err);
            setUndoToast({ message: 'Failed to archive item', itemIds: [] });
        }
    }, [authFetch, resolveOrgId, refresh]);

    // Inline respond (for Platform tab items)
    const handleInlineRespond = useCallback(async (itemId, outcome, reason = '') => {
        // Guard against rapid double-clicks: only one in-flight respond per item.
        // Check/mutate the ref synchronously — useState updater functions run
        // during reconciliation, not at call-time, so they can't be used for
        // a same-tick guard.
        if (pendingInflightRef.current.has(itemId)) return;
        pendingInflightRef.current.set(itemId, outcome);
        setPendingInlineOutcomes(new Map(pendingInflightRef.current));

        const clearPending = () => {
            pendingInflightRef.current.delete(itemId);
            setPendingInlineOutcomes(new Map(pendingInflightRef.current));
        };

        // Guarantee the spinner always releases: abort the request after 12s
        // so a hung/dropped response can't leave the button stuck forever.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);

        try {
            const orgId = resolveOrgId(itemId);
            console.log('[InboxView] inline respond →', { itemId, orgId, outcome });
            const res = await (outcome === 'approved' ? stepUpFetch : authFetch)(`/api/orgs/${orgId}/inbox/${itemId}/respond`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: outcome, comment: reason || '' }),
                signal: controller.signal
            }, { subject: { line1: 'approve this item' } });
            if (!res?.ok) {
                // Idempotent: treat "already resolved" as success silently.
                if (res?.status === 400) {
                    const body = await res.json().catch(() => ({}));
                    if (body?.error === 'Item is not open for response') {
                        refresh();
                        return;
                    }
                }
                throw new Error(`HTTP ${res?.status}`);
            }
            // A stale approval is refused server-side and the card flips to expired:
            // say so, never let the click read as approved.
            const out = await res.json().catch(() => ({}));
            if (out?.item?.status === 'expired') setUndoToast({ message: out.message || 'This approval had expired, so nothing ran.', itemIds: [] });
            refresh();
        } catch (err) {
            const isTimeout = err?.name === 'AbortError';
            const verb = outcome === 'approved' ? 'approve' : outcome === 'denied' ? 'deny' : outcome;
            console.error('Inline respond failed:', err);
            setUndoToast({
                message: isTimeout ? 'Request timed out, please retry' : `Failed to ${verb} item`,
                itemIds: []
            });
        } finally {
            clearTimeout(timeoutId);
            clearPending();
        }
    }, [authFetch, stepUpFetch, resolveOrgId, refresh]);

    // Single entry point for approve/deny from any trigger (buttons, keyboard).
    // Approve is one-click; deny/request-changes prompts for a reason first.
    // Declared after handleInlineRespond: its dependency array references that
    // const, so defining resolveItem earlier hits a temporal dead zone at render
    // ("Cannot access before initialization"). Keep it below its dependencies.
    const resolveItem = useCallback(async (item, outcome) => {
        let reason = '';
        if (denyNeedsReason(outcome)) {
            reason = await promptRejectReason();
            if (reason === null) return; // cancelled
        }
        const action = outcome === 'approved' ? 'approve' : 'deny';
        if (item._qfId) handleQfAction(item._qfId, action, item.id, reason);
        else if (item._checkpointId) handleCheckpointAction(item._objectiveId, item._checkpointId, action, item.id, reason);
        else handleInlineRespond(item.id, outcome, reason);
    }, [promptRejectReason, handleQfAction, handleCheckpointAction, handleInlineRespond]);

    const handleItemClick = (item) => {
        // Mark as read on click (platform items only)
        if (!item.is_read && !String(item.id).startsWith('qf-')) {
            handleMarkRead(item.id);
        }
        // Navigate to detail page (QF items use their qf- prefixed ID).
        // Pass the item's org_id via state so the detail view can scope its
        // fetch correctly when the workspace currentOrg differs (multi-org list).
        navigate(`/inbox/${item.id}`, {
            state: { orgId: item.org_id }
        });
    };

    // Assign keyboard handler refs now that all handlers are defined
    keyHandlersRef.current = { handleToggleFlag, handleArchive, handleItemClick, toggleSelectItem, handleBulkAction, handleInlineRespond, resolveItem };

    const filterByStatus = (status) => {
        setFilter(prev => ({ ...prev, status: prev.status === status ? null : status }));
    };

    const handleFolderChange = useCallback((folderId) => {
        setActiveFolder(folderId);
        setHistoryChip('all');
        setSidebarOpen(false);
        setError(null);
        setFocusIndex(-1);
        setSelectedIds(new Set());
        // Sync to URL
        const url = new URL(window.location);
        if (folderId === 'inbox') {
            url.searchParams.delete('folder');
        } else {
            url.searchParams.set('folder', folderId);
        }
        window.history.replaceState({}, '', url);
    }, []);

    if (!currentOrg) {
        return (
            <div className="inbox-view view-page">
                <div className="inbox-view__empty">
                    <p>Please select an organization from the sidebar to view your inbox.</p>
                </div>
            </div>
        );
    }

    const currentFolderDef = INBOX_FOLDERS.find(f => f.id === activeFolder);

    return (
        <div className="inbox-view view-page inbox-view--row">
            <style>{`
                .app-shell__content:has(.inbox-view) {
                    padding: 0;
                    overflow: hidden;
                }
                .app-shell__content:has(.inbox-view) .breadcrumbs {
                    display: none;
                }
                .inbox-view--row {
                    display: flex;
                    flex-direction: row;
                    gap: 16px;
                    flex: 1;
                    min-height: 0;
                    /* NO padding — .app-shell already provides 16px outer padding */
                }
                .inbox-view__main-col {
                    flex: 1;
                    min-width: 0;
                    display: flex;
                    flex-direction: column;
                }
                .inbox-view__chat-col {
                    width: 360px;
                    flex-shrink: 0;
                    display: flex;
                    flex-direction: column;
                    position: relative;
                    isolation: isolate;
                    min-height: 0;
                    /* Full glass panel — same recipe as .bastion-sidebar */
                    background: var(--m-bg-base, rgba(255,255,255,0.08));
                    border: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
                    border-radius: var(--qx-radius, 20px);
                    box-shadow:
                        inset 0 1px 0 rgba(255,255,255,0.18),
                        inset 0 -1px 0 rgba(0,0,0,0.45);
                    overflow: hidden;
                }
                .inbox-view__chat-col::before {
                    content: '';
                    position: absolute;
                    inset: 0;
                    z-index: -1;
                    border-radius: inherit;
                    pointer-events: none;
                    background: var(--qx-edges);
                    backdrop-filter: var(--qx-blur);
                    -webkit-backdrop-filter: var(--qx-blur);
                }
                .inbox-view__chat-close {
                    position: absolute;
                    top: 12px;
                    right: 12px;
                    z-index: 20;
                    width: 26px;
                    height: 26px;
                    border-radius: 8px;
                    background: rgba(255, 255, 255, 0.07);
                    border: 1px solid rgba(255,255,255,0.22);
                    color: #fff;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 11px;
                    box-shadow:
                        inset 0 1px 0 rgba(255,255,255,0.22),
                        0 2px 8px rgba(0,0,0,0.35);
                    transition: background 0.15s, border-color 0.15s;
                }
                .inbox-view__chat-close:hover {
                    background: rgba(32, 36, 52, 0.94);
                    border-color: rgba(255,255,255,0.35);
                }
            `}</style>
            {/* Main content column */}
            <div className="inbox-view__main-col">
            <LLMAuthBanner />

            <div className="inbox-layout">
                {/* Mobile sidebar backdrop */}
                {sidebarOpen && <div className="inbox-folder-sidebar__backdrop" onClick={() => setSidebarOpen(false)} />}

                <InboxFolderSidebar
                    activeFolder={activeFolder}
                    onFolderChange={handleFolderChange}
                    folderCounts={folderCounts}
                    isOpen={sidebarOpen}
                />

                {/* Mobile sidebar toggle */}
                <button className="inbox-folder-sidebar__toggle" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Toggle folder sidebar">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
                    </svg>
                </button>

                <div className="inbox-layout__content">
                    {/* Org filter pills (multi-org) */}
                    {orgs && orgs.length > 1 && (
                        <div className="inbox-org-filter-strip">
                            <button
                                className={`inbox-org-filter-strip__pill ${orgFilter === 'all' ? 'inbox-org-filter-strip__pill--active' : ''}`}
                                onClick={() => setOrgFilter('all')}
                            >
                                All Orgs
                            </button>
                            {orgs.map(org => (
                                <button
                                    key={org.id}
                                    className={`inbox-org-filter-strip__pill ${orgFilter === org.id ? 'inbox-org-filter-strip__pill--active' : ''}`}
                                    onClick={() => setOrgFilter(orgFilter === org.id ? 'all' : org.id)}
                                >
                                    {org.logo_url && <img src={org.logo_url} alt="" className="inbox-org-filter-strip__logo" />}
                                    {org.name}
                                </button>
                            ))}
                        </div>
                    )}

                    {/* Org context header */}
                    {currentOrg && orgFilter !== 'all' && (
                        <div className="inbox-view__org-header">
                            {currentOrg.logo_url ? (
                                <img src={currentOrg.logo_url} alt="" className="inbox-view__org-logo" />
                            ) : (
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9h1"/><path d="M9 13h1"/><path d="M9 17h1"/>
                                </svg>
                            )}
                            <span className="inbox-view__org-name">{currentOrg.name}</span>
                            {stats && <span className="inbox-view__org-count">{stats.open || 0} open</span>}
                        </div>
                    )}

                    {/* Single-row toolbar: search + assignee tabs + sort + scope */}
                    {isHistoryFolder && (
                        <div className="inbox-view__history-chips" role="group" aria-label="Filter by outcome" data-testid="history-chips">
                            {HISTORY_CHIPS.map(c => (
                                <button
                                    key={c.id}
                                    type="button"
                                    className={`glass-btn${historyChip === c.id ? ' glass-btn--active' : ''}`}
                                    aria-pressed={historyChip === c.id}
                                    onClick={() => setHistoryChip(c.id)}
                                >{c.label}</button>
                            ))}
                        </div>
                    )}
                    <div className="inbox-view__toolbar">
                        <div className="inbox-view__search">
                            <input
                                type="text"
                                className="inbox-view__search-input"
                                aria-label="Search inbox items"
                                placeholder="Search inbox items..."
                                value={searchInput}
                                onChange={(e) => {
                                    const value = e.target.value;
                                    setSearchInput(value);
                                    clearTimeout(searchDebounceRef.current);
                                    searchDebounceRef.current = setTimeout(() => setSearchQuery(value), 250);
                                }}
                            />
                            <svg className="inbox-view__search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="11" cy="11" r="8"/>
                                <path d="m21 21-4.35-4.35"/>
                            </svg>
                        </div>
                        <div className="inbox-view__assignee-tabs">
                            {[
                                { key: 'all', label: 'All' },
                                { key: 'mine', label: 'Mine' },
                                { key: 'unassigned', label: 'Unassigned' }
                            ].map(tab => (
                                <button
                                    key={tab.key}
                                    className={`inbox-view__assignee-tab ${assigneeFilter === tab.key ? 'inbox-view__assignee-tab--active' : ''}`}
                                    onClick={() => setAssigneeFilter(tab.key)}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </div>
                        <div className="inbox-view__sort-group">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="16" y2="12"/><line x1="4" y1="18" x2="12" y2="18"/>
                            </svg>
                            <select
                                value={sortBy}
                                onChange={(e) => setSortBy(e.target.value)}
                                aria-label="Sort inbox items"
                            >
                                {SORT_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </select>
                        </div>
                        {/* Scope — folded into same row */}
                        {myScopes && myScopes.length > 0 && (
                            <div className="inbox-view__sort-group">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/>
                                </svg>
                                <select
                                    value={filter.scope_id || ''}
                                    onChange={(e) => setFilter(prev => ({ ...prev, scope_id: e.target.value || null }))}
                                    aria-label="Scope filter"
                                >
                                    <option value="">All Scopes</option>
                                    {myScopes.map(scope => {
                                        const prefix = scope.scope_type === 'division' ? 'Div' : scope.scope_type === 'department' ? 'Dept' : scope.scope_type === 'team' ? 'Team' : 'Org';
                                        const name = scope.name_cache || scope.id?.slice(-6) || 'Unnamed';
                                        return (
                                            <option key={scope.id} value={scope.id}>
                                                {prefix}: {name}
                                            </option>
                                        );
                                    })}
                                </select>
                            </div>
                        )}
                    </div>

                    {/* CoreComms Plugin Promotion */}
                    <CoreCommsBanner />

                    {/* Stats Strip — no wrapper card, unstyled inline row */}
                    <StatsStrip stats={stats} activeStatus={filter.status} onFilterStatus={filterByStatus} />

                    {/* Error State */}
                    {error && (
                        <div className="inbox-view__error">
                            <p>{error}</p>
                            <Button variant="secondary" onClick={() => { setError(null); refresh(); }} icon={InboxIcons.refresh}>Retry</Button>
                        </div>
                    )}

                    {/* Loading State */}
                    {loading && (
                        <div className="inbox-view__loading">
                            <p>Loading inbox...</p>
                        </div>
                    )}

                    {/* Items List */}
                    {!loading && (
                        <div className="inbox-view__section">
                            {items.length === 0 ? (
                                activeFolder === 'inbox' && !searchQuery ? (
                                    <div className="inbox-zero">
                                        <div className="inbox-zero__icon">{InboxIcons.shieldOk}</div>
                                        <h3 className="inbox-zero__title">Inbox Zero</h3>
                                        <p className="inbox-zero__subtitle">You're all caught up</p>
                                    </div>
                                ) : (
                                    <div className="inbox-view__empty">
                                        <div className="inbox-view__empty-icon">{InboxIcons.checkCircle}</div>
                                        <p>No items in {currentFolderDef?.label || 'this folder'}</p>
                                        <p className="inbox-view__empty-subtitle">
                                            {searchQuery ? `No results for "${searchQuery}"` : 'Nothing here right now.'}
                                        </p>
                                        {searchQuery && (
                                            <Button variant="ghost" size="sm" onClick={() => { setSearchInput(''); setSearchQuery(''); }}>Clear search</Button>
                                        )}
                                    </div>
                                )
                            ) : (
                                <div className="inbox-view__list" ref={listRef}>
                                    {/* Persistent list header with select-all and bulk actions */}
                                    <div className={`inbox-list-header${selectedIds.size > 0 ? ' inbox-list-header--has-selection' : ''}`}>
                                        <label className="inbox-list-header__select-all" title="Select all">
                                            <input
                                                type="checkbox"
                                                checked={items.length > 0 && items.every(i => selectedIds.has(i.id))}
                                                ref={el => { if (el) { const paged = items; el.indeterminate = selectedIds.size > 0 && !paged.every(i => selectedIds.has(i.id)); } }}
                                                onChange={toggleSelectAll}
                                            />
                                            <span className="inbox-list-header__select-label">
                                                {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select all'}
                                            </span>
                                        </label>

                                        {selectedIds.size > 0 ? (
                                            <div className="inbox-list-header__actions">
                                                <Button variant="ghost" size="sm" onClick={() => handleBulkAction('mark_read')} loading={bulkLoading} icon={InboxIcons.mailOpen}>
                                                    Read
                                                </Button>
                                                <Button variant="ghost" size="sm" onClick={() => handleBulkAction('flag')} loading={bulkLoading} icon={InboxIcons.star}>
                                                    Flag
                                                </Button>
                                                <Button variant="ghost" size="sm" onClick={() => handleBulkAction('archive')} loading={bulkLoading} icon={InboxIcons.archive}>
                                                    Archive
                                                </Button>
                                                {(() => {
                                                    const selectedItems = items.filter(i => selectedIds.has(i.id));
                                                    const allApprovals = selectedItems.length > 0 && selectedItems.every(i => i.kind === 'approval' && ['open', 'in_progress'].includes(i.status));
                                                    if (!allApprovals) return null;
                                                    return (
                                                        <>
                                                            <div className="inbox-list-header__divider" />
                                                            <Button variant="primary" size="sm" onClick={() => handleBulkAction('approve')} loading={bulkLoading} icon={InboxIcons.check}>
                                                                Approve All
                                                            </Button>
                                                            <Button variant="outline-red" size="sm" onClick={() => handleBulkAction('deny')} loading={bulkLoading} icon={InboxIcons.xCircle}>
                                                                Deny All
                                                            </Button>
                                                        </>
                                                    );
                                                })()}
                                                <div className="inbox-list-header__divider" />
                                                <Button variant="ghost" size="sm" onClick={() => handleBulkAction('delete')} loading={bulkLoading} icon={InboxIcons.trash}>
                                                    Delete
                                                </Button>
                                                <div style={{ flex: 1 }} />
                                                <Button variant="ghost" size="sm" onClick={() => { setSelectedIds(new Set()); lastSelectedIndexRef.current = -1; }} icon={InboxIcons.x}>
                                                    Clear
                                                </Button>
                                            </div>
                                        ) : (
                                            <span className="inbox-list-header__count">
                                                {items.length} item{items.length !== 1 ? 's' : ''}
                                                {paginationInfo?.total > items.length ? ` of ${paginationInfo.total}` : ''}
                                            </span>
                                        )}
                                    </div>

                                    {items.map((item, index) => {
                                        const isActionable = ['open', 'in_progress', 'iterating'].includes(item.status);
                                        // The outcome currently in flight for THIS card (or undefined if none).
                                        // Only the button whose outcome matches shows a spinner; a sibling
                                        // button on the same card is disabled (not loading) while it waits.
                                        const pendingOutcome = pendingInlineOutcomes.get(item.id);
                                        const isRespondPending = pendingOutcome !== undefined;
                                        return (
                                        <div key={item.id} className="inbox-item-row">
                                            <div className="inbox-item-row__checkbox">
                                                <input
                                                    type="checkbox"
                                                    checked={selectedIds.has(item.id)}
                                                    onChange={(e) => toggleSelectItem(item.id, index, e.nativeEvent.shiftKey)}
                                                    onClick={(e) => e.stopPropagation()}
                                                />
                                            </div>
                                            <div className={`inbox-item-row__card ${focusIndex === index ? 'inbox-item-row__card--focused' : ''}`}>
                                                <InboxItemCard
                                                    item={item}
                                                    onClick={() => handleItemClick(item)}
                                                    onToggleFlag={handleToggleFlag}
                                                    orgName={orgFilter === 'all' && orgs?.length > 1 ? orgs.find(o => o.id === item.org_id)?.name : null}
                                                />
                                            </div>
                                            {/* Inline action buttons — always visible for actionable items */}
                                            {isActionable && (
                                                <div className="inbox-item-row__actions">
                                                    {item.payload?.custom_actions?.length > 0 && !item._qfId ? (
                                                        item.payload.custom_actions.slice(0, 2).map((ca) => (
                                                            <Button
                                                                key={ca.action}
                                                                variant={ca.style === 'danger' ? 'outline-red' : ca.style === 'primary' ? 'primary' : 'secondary'}
                                                                size="sm"
                                                                loading={pendingOutcome === ca.action}
                                                                disabled={isRespondPending && pendingOutcome !== ca.action}
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleInlineRespond(item.id, ca.action);
                                                                }}
                                                            >
                                                                {ca.label}
                                                            </Button>
                                                        ))
                                                    ) : item.kind === 'approval' ? (
                                                        <>
                                                            <Button
                                                                variant="primary"
                                                                size="sm"
                                                                icon={InboxIcons.check}
                                                                loading={pendingOutcome === 'approved'}
                                                                disabled={isRespondPending && pendingOutcome !== 'approved'}
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    resolveItem(item, 'approved');
                                                                }}
                                                            >
                                                                Approve
                                                            </Button>
                                                            <Button
                                                                variant="outline-red"
                                                                size="sm"
                                                                icon={InboxIcons.xCircle}
                                                                loading={pendingOutcome === 'denied'}
                                                                disabled={isRespondPending && pendingOutcome !== 'denied'}
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    resolveItem(item, 'denied');
                                                                }}
                                                            >
                                                                Deny
                                                            </Button>
                                                        </>
                                                    ) : item.kind === 'task' ? (
                                                        <Button
                                                            variant="primary"
                                                            size="sm"
                                                            icon={InboxIcons.check}
                                                            loading={isRespondPending}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleInlineRespond(item.id, 'completed');
                                                            }}
                                                        >
                                                            Complete
                                                        </Button>
                                                    ) : item.kind === 'incident' ? (
                                                        <Button
                                                            variant="primary"
                                                            size="sm"
                                                            icon={InboxIcons.shield}
                                                            loading={isRespondPending}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleInlineRespond(item.id, 'resolved');
                                                            }}
                                                        >
                                                            Resolve
                                                        </Button>
                                                    ) : item.kind === 'question' ? (
                                                        <Button
                                                            variant="secondary"
                                                            size="sm"
                                                            icon={InboxIcons.send}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleItemClick(item);
                                                            }}
                                                        >
                                                            Answer
                                                        </Button>
                                                    ) : item.kind === 'override_required' ? (
                                                        <>
                                                            <Button
                                                                variant="danger"
                                                                size="sm"
                                                                icon={InboxIcons.alertTriangle}
                                                                loading={pendingOutcome === 'override_granted'}
                                                                disabled={isRespondPending && pendingOutcome !== 'override_granted'}
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleInlineRespond(item.id, 'override_granted');
                                                                }}
                                                            >
                                                                Override
                                                            </Button>
                                                            <Button
                                                                variant="outline-red"
                                                                size="sm"
                                                                icon={InboxIcons.xCircle}
                                                                loading={pendingOutcome === 'rejected'}
                                                                disabled={isRespondPending && pendingOutcome !== 'rejected'}
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleInlineRespond(item.id, 'rejected');
                                                                }}
                                                            >
                                                                Reject
                                                            </Button>
                                                        </>
                                                    ) : null}
                                                </div>
                                            )}
                                        </div>
                                        );
                                    })}
                                    {/* Infinite scroll sentinel — triggers loadMore when visible */}
                                    {paginationInfo?.has_more && loadMore && (
                                        <div ref={scrollSentinelRef} className="inbox-view__scroll-sentinel">
                                            {loadingMore && (
                                                <span className="inbox-view__loading-indicator">Loading older items...</span>
                                            )}
                                            {!loadingMore && (
                                                <button type="button" className="glass-btn" data-testid="load-more" onClick={() => loadMore()}>
                                                    Load more ({items.length} of {paginationInfo?.total})
                                                </button>
                                            )}
                                        </div>
                                    )}
                                    {/* End of list indicator */}
                                    {!paginationInfo?.has_more && items.length > 0 && (
                                        <div className="inbox-view__end-of-list">
                                            All {paginationInfo?.total || items.length} items loaded
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Keyboard shortcut hint */}
                            <div className="inbox-view__kbd-hints">
                                <kbd className="inbox-view__kbd">j</kbd>/<kbd className="inbox-view__kbd">k</kbd> navigate
                                {' '}<kbd className="inbox-view__kbd">x</kbd> select
                                {' '}<kbd className="inbox-view__kbd">s</kbd> star
                                {' '}<kbd className="inbox-view__kbd">a</kbd> approve
                                {' '}<kbd className="inbox-view__kbd">d</kbd> deny
                                {' '}<kbd className="inbox-view__kbd">e</kbd> archive
                                {' '}<kbd className="inbox-view__kbd">?</kbd> help
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* End main content column */}
            </div>

            {/* Sidebar toggle (when closed) */}
            {!chatSidebarOpen && (
                <button
                    onClick={() => setChatSidebarOpen(true)}
                    title="Open TRIAGE-Q chat"
                    style={{
                        position: 'absolute', right: 12, top: 12, zIndex: 20,
                        width: 32, height: 32, borderRadius: 8,
                        background: 'rgba(139, 92, 246, 0.12)',
                        border: '1px solid rgba(139, 92, 246, 0.25)',
                        color: 'rgba(255, 255, 255, 0.8)',
                        cursor: 'pointer', display: 'flex', alignItems: 'center',
                        justifyContent: 'center', fontSize: 14,
                    }}
                >
                    &#x25C0;
                </button>
            )}

            {/* TRIAGE-Q agent chat sidebar — its own glass panel */}
            {chatSidebarOpen && (
                <aside className="inbox-view__chat-col">
                    <button
                        className="inbox-view__chat-close"
                        onClick={() => setChatSidebarOpen(false)}
                        title="Close chat"
                    >
                        &#x25B6;
                    </button>
                    <InboxChatSidebar
                        items={items}
                        stats={stats}
                        selectedAgent={selectedChatAgent}
                        onAgentChange={setSelectedChatAgent}
                    />
                </aside>
            )}

            {/* Snooze Menu (positioned near focused item or centered) */}
            {snoozeTarget && (
                <>
                    <div style={{ position: 'fixed', inset: 0, zIndex: 149 }} onClick={() => setSnoozeTarget(null)} />
                    <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 150 }}>
                        <SnoozeMenu
                            onSnooze={(snoozedUntil) => handleSnooze(snoozeTarget, snoozedUntil)}
                            onClose={() => setSnoozeTarget(null)}
                        />
                    </div>
                </>
            )}

            {/* Shortcut Help Overlay */}
            <ShortcutHelpOverlay
                isOpen={showShortcutHelp}
                onClose={() => setShowShortcutHelp(false)}
            />

            {/* Undo Toast */}
            {undoToast && (
                <UndoToast
                    message={undoToast.message}
                    onUndo={handleUndoBulk}
                    onDismiss={() => setUndoToast(null)}
                />
            )}

            {/* Reject-with-reason modal — deny/request-changes capture a reason
                that flows to /respond (stored + VOLT-witnessed as the comment). */}
            {stepUpModal}
            {rejectModal && (
                <div
                    className="inbox-reject-overlay"
                    onMouseDown={() => closeRejectModal(null)}
                    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
                >
                    <div
                        className="inbox-reject-modal glass-panel"
                        onMouseDown={(e) => e.stopPropagation()}
                        style={{ width: 'min(480px, 92vw)', padding: '18px 20px', borderRadius: 16, display: 'flex', flexDirection: 'column', gap: 12 }}
                    >
                        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary, #fff)' }}>Reason for rejecting</div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.7))' }}>
                            This is recorded on the item and witnessed in the evidence trail. Optional, but recommended.
                        </div>
                        <textarea
                            autoFocus
                            className="qx-input"
                            value={rejectText}
                            onChange={(e) => setRejectText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Escape') { e.preventDefault(); closeRejectModal(null); }
                                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); closeRejectModal(rejectText.trim()); }
                            }}
                            placeholder="Why is this being rejected? (Cmd/Ctrl+Enter to confirm)"
                            rows={4}
                            style={{ width: '100%', resize: 'vertical', minHeight: 80, fontSize: 13, padding: '8px 10px', borderRadius: 8 }}
                        />
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                            <Button variant="outline" size="sm" onClick={() => closeRejectModal(null)}>Cancel</Button>
                            <Button variant="outline-red" size="sm" icon={InboxIcons.xCircle} onClick={() => closeRejectModal(rejectText.trim())}>Reject</Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default InboxView;
