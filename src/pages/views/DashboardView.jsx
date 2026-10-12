/**
 * DashboardView - Platform Command Centre (Redesigned)
 *
 * Layout:
 * [SystemHealthBanner]                                  full width (collapses when operational)
 * [QuickStats: 4 KPI tiles]                             full width strip
 * [AttentionNeeded] [LiveObjectives] [RecentActivity]   3-col grid (hero row)
 * [Services(compact)] [Automation] [Fleet]              3-col grid
 * [VOLT]              [WARD]                            2-col governance
 *
 * Design: Linear-inspired density, glassmorphic cards, breathing dots,
 * monospace data, gradient borders, real data only — no mocks.
 */

import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ServiceDetailModal } from '../../components/core/monitoring';
import { recordHealthCheck, getServiceUptime, getAverageResponseTime } from '../../services/serviceHistory';
import { evaluateAlerts } from '../../services/alertService';
import { bridgeAlertsToInbox, bridgeResolutionsToInbox } from '../../services/serviceAlertBridge';
import { useAuth } from '../../contexts/AuthContext';
import { useHealth } from '../../contexts/HealthContext';
import { useUISettings } from '../../services/uiSettings';
import { ALL_DASH_TABS, computeVisibleTabs } from '../../config/dashboardTabs';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useWorkflows } from '../../hooks/useWorkflows';
import { getDashboardStats } from '../../services/aeeAnalytics';
import { getAllAgents } from '../../config/agentRegistry';
import { getAllPluginManifests } from '../../config/plugins/index';
import { getHostSummary, getHosts } from '../../config/hosts';
import { getLibraryStats } from '../../services/workflowLibrary';
import { useBackupStatus } from '../../hooks/useBackupStatus';
import { useUpdateStatus } from '../../hooks/useUpdateStatus';
import { getLocalVersion } from '../../services/maintenance/updateService';
import { listObjectives } from '../../services/objectivesClient';
import { isPluginLicensed, fetchEntitlements } from '../../services/licenseValidator';
import VoltSummaryCard from '../../components/volt/VoltSummaryCard';
import WardSummaryCard from '../../components/ward/WardSummaryCard';
import AgentsSummaryCard from '../../components/dashboard/AgentsSummaryCard';
import CostSummaryCard from '../../components/dashboard/CostSummaryCard';
import CognitiveSummaryCard from '../../components/dashboard/CognitiveSummaryCard';
import ComplianceSummaryCard from '../../components/dashboard/ComplianceSummaryCard';
import MemorySummaryCard from '../../components/dashboard/MemorySummaryCard';
import TabErrorBoundary from '../../components/dashboard/TabErrorBoundary';
import useGovernancePulse from '../../hooks/useGovernancePulse';
import DashboardChatSidebar from '../../components/dashboard/DashboardChatSidebar';
import { listExecutions } from '../../services/quoxflowClient';
import QuoxShapeRadial from '../../components/dashboard/hud/QuoxShapeRadial';
import MiniBrain from '../../components/dashboard/hud/MiniBrain';
import HudPrimaryStat from '../../components/dashboard/hud/HudPrimaryStat';
import CycleTabsControl from '../../components/dashboard/hud/CycleTabsControl';
import useAoclLayerStats from '../../hooks/useAoclLayerStats';
import AgentFleetPanel from '../../components/core/monitoring/AgentFleetPanel';
import GPUFleetPanel from '../../components/core/monitoring/GPUFleetPanel';
import MeetYourResidentCard from '../../components/dashboard/MeetYourResidentCard';
import './views.css';

// Brain tab embeds the REAL Qortex surface (owner ask: the actual brain, not a
// summary mashup). Lazy — it internally lazy-loads the R3F BrainOrgan3D and is
// plugin-gated (renders its own PluginLicenseNotice when unlicensed).
// Keep the import thunks so we can BOTH lazy-render and idle-preload them; the
// module cache dedups, so warming on idle makes the first tab switch instant
// instead of a cold chunk fetch (owner: heavy tabs slow to load).
const importQuoxbrain = () => import('./QuoxbrainView');
const importCognitiveTopology = () => import('./CognitiveTopologyView');
const QuoxbrainView = lazy(importQuoxbrain);
const CognitiveTopologyView = lazy(importCognitiveTopology);

// ─── Helpers ────────────────────────────────────────────────
const MONO = "'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace";

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function pct(a, b) {
    if (!b || b === 0) return 0;
    return Math.round((a / b) * 100);
}

const KIND_ICONS = {
    approval: '◈',
    question: '?',
    task: '▸',
    incident: '⚠',
    info: 'ℹ',
    override_required: '⛔',
};

const KIND_COLORS = {
    approval: '#a78bfa',
    question: '#38bdf8',
    task: '#34d399',
    incident: '#f87171',
    info: '#94a3b8',
    override_required: '#ef4444',
};

const PRIORITY_COLORS = {
    urgent: '#ef4444',
    high: '#f59e0b',
    normal: 'rgba(255,255,255,0.4)',
    low: 'rgba(255,255,255,0.2)',
};

const STATUS_LABELS = {
    pending: 'Queued',
    decomposing: 'Planning',
    decomposed: 'Planned',
    running: 'Running',
    paused: 'Paused',
    completed: 'Done',
    completed_with_errors: 'Partial',
    failed: 'Failed',
    cancelled: 'Cancelled',
};

const STATUS_COLORS = {
    pending: '#94a3b8',
    decomposing: '#38bdf8',
    decomposed: '#38bdf8',
    running: '#30ff90',
    paused: '#fbbf24',
    completed: '#30ff90',
    completed_with_errors: '#f59e0b',
    failed: '#f87171',
    cancelled: '#6b7280',
};

// ─── LAYER 0: System Health Banner ──────────────────────────
function SystemHealthBanner({ healthData, loading }) {
    const summary = healthData?.summary || { healthy: 0, total: 0, criticalHealthy: 0, criticalTotal: 0 };
    // Drive the banner from the SAME HealthContext-derived values the footer
    // (SystemHealthBadge + DEFCON) uses, not the raw summary. The raw summary
    // counts any not-fully-healthy service (responding but missing a required
    // endpoint) as "down" and skips the debounce + the "3+ down = probably
    // this browser can't reach the box" collapse, so it shouted "3 Critical
    // Services Down" while the footer stayed green. downCount counts only
    // non-responding (debounced) services; overallStatus === 'unreachable'
    // means the whole platform looks unreachable (self-connection), not N
    // real outages.
    const { overallStatus, downCount = 0, degradedCount = 0 } = useHealth();
    const unreachable = overallStatus === 'unreachable';

    const statusClass = loading ? 'loading'
        : unreachable ? 'degraded'
        : downCount > 0 ? 'critical'
        : degradedCount > 0 ? 'degraded'
        : 'operational';
    const statusText = loading ? 'Checking systems...'
        : unreachable ? 'Platform unreachable'
        : downCount > 0 ? `${downCount} Service${downCount > 1 ? 's' : ''} Down`
        : degradedCount > 0 ? `${degradedCount} Service${degradedCount > 1 ? 's' : ''} Degraded`
        : 'All Systems Operational';

    return (
        <div className={`system-health-banner system-health-banner--${statusClass}`}>
            <div className="system-health-banner__indicator">
                <div className="system-health-banner__pulse" />
            </div>
            <div className="system-health-banner__content">
                <span className="system-health-banner__status">{statusText}</span>
                <span className="system-health-banner__detail">
                    {summary.healthy}/{summary.total} services healthy
                    {summary.criticalTotal > 0 && ` · ${summary.criticalHealthy}/${summary.criticalTotal} critical`}
                </span>
            </div>
            {healthData?.timestamp && (
                <div className="system-health-banner__timestamp">
                    <span>{new Date(healthData.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                </div>
            )}
        </div>
    );
}

// ─── LAYER 1: Quick Stats Strip ─────────────────────────────
function QuickStatsStrip({ healthData, analyticsData, workflows, analyticsLoading, serverStats }) {
    const uptime = useMemo(() => {
        if (!healthData?.summary) return null;
        const { healthy, total } = healthData.summary;
        return total > 0 ? Math.round((healthy / total) * 100) : 0;
    }, [healthData]);

    const deployedCount = workflows.deployed?.length || 0;
    // Prefer server-sourced 24h stats (survive a fresh browser); fall back to
    // the client analytics cache only when the server summary isn't loaded.
    const successRate = serverStats?.success_rate ?? analyticsData?.overview?.success_rate;
    const conversations24h = serverStats?.total_conversations ?? analyticsData?.overview?.total_conversations;

    const tiles = [
        {
            label: 'Platform Uptime',
            value: uptime != null ? `${uptime}%` : '—',
            color: uptime === 100 ? '#30ff90' : uptime >= 80 ? '#fbbf24' : '#f87171',
            icon: '◉',
        },
        {
            label: 'Workflows Active',
            value: deployedCount,
            color: '#38bdf8',
            icon: '⟳',
        },
        {
            label: 'Success Rate 24h',
            value: successRate != null ? `${Math.round(successRate)}%` : (analyticsLoading ? '...' : '—'),
            color: successRate >= 90 ? '#30ff90' : successRate >= 70 ? '#fbbf24' : successRate != null ? '#f87171' : 'rgba(255,255,255,0.4)',
            icon: '✓',
        },
        {
            label: 'Conversations 24h',
            value: conversations24h ?? (analyticsLoading ? '...' : '0'),
            color: '#a78bfa',
            icon: '◇',
        },
    ];

    return (
        <div className="quick-stats-strip">
            {tiles.map(tile => (
                <div key={tile.label} className="quick-stat-tile">
                    <span className="quick-stat-tile__icon" style={{ color: tile.color }}>{tile.icon}</span>
                    <span className="quick-stat-tile__value" style={{ color: tile.color }}>{tile.value}</span>
                    <span className="quick-stat-tile__label">{tile.label}</span>
                </div>
            ))}
        </div>
    );
}

// ─── Hero stat strip (Overview tab) ─────────────────────────
// One large primary metric (Success Rate 24h) with smaller KPIs alongside, so
// the Overview reads at a glance. Reuses the same computed values as
// QuickStatsStrip; server-sourced stats preferred so they survive a fresh
// browser (see [[inbox-sse-http2]] discipline: server is source of truth).
function HeroStatStrip({ healthData, analyticsData, workflows, analyticsLoading, serverStats }) {
    const uptime = useMemo(() => {
        if (!healthData?.summary) return null;
        const { healthy, total } = healthData.summary;
        return total > 0 ? Math.round((healthy / total) * 100) : 0;
    }, [healthData]);

    const deployedCount = workflows.deployed?.length || 0;
    const successRate = serverStats?.success_rate ?? analyticsData?.overview?.success_rate;
    const conversations24h = serverStats?.total_conversations ?? analyticsData?.overview?.total_conversations;

    const heroColor = successRate >= 90 ? '#30ff90' : successRate >= 70 ? '#fbbf24' : successRate != null ? '#f87171' : 'rgba(255,255,255,0.5)';
    const heroValue = successRate != null ? `${Math.round(successRate)}%` : (analyticsLoading ? '…' : '—');

    const tiles = [
        { label: 'Platform Uptime', value: uptime != null ? `${uptime}%` : '—', color: uptime === 100 ? '#30ff90' : uptime >= 80 ? '#fbbf24' : '#f87171' },
        { label: 'Workflows Active', value: deployedCount, color: '#38bdf8' },
        { label: 'Conversations 24h', value: conversations24h ?? (analyticsLoading ? '…' : '0'), color: '#a78bfa' },
    ];

    return (
        <div className="dash-hero">
            <div className="dash-hero__primary" style={{ '--hero-color': heroColor }}>
                <span className="dash-hero__label">Success Rate</span>
                <span className="dash-hero__value">{heroValue}</span>
                <span className="dash-hero__sub">last 24 hours</span>
            </div>
            <div className="dash-hero__tiles">
                {tiles.map(t => (
                    <div key={t.label} className="dash-hero__tile">
                        <span className="dash-hero__tile-value" style={{ color: t.color }}>{t.value}</span>
                        <span className="dash-hero__tile-label">{t.label}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ─── LAYER 2A: Attention Needed ─────────────────────────────
function AttentionNeededCard({ authFetch, orgId }) {
    const [items, setItems] = useState(null);
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!orgId || !authFetch) { setLoading(false); return; }
        let cancelled = false;

        const fetchInbox = async () => {
            try {
                // Fetch top 4 items with previews
                const res = await authFetch(`/api/orgs/${orgId}/inbox?limit=4&status=open,in_progress,waiting`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (!cancelled) {
                    setItems(data.items || []);
                    setStats(data.pagination || {});
                }
            } catch (err) {
                console.warn('[AttentionNeeded] Fetch failed:', err);
                if (!cancelled) setItems([]);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        fetchInbox();
        const interval = setInterval(fetchInbox, 60000);
        return () => { cancelled = true; clearInterval(interval); };
    }, [authFetch, orgId]);

    const totalActive = stats?.total || 0;
    const urgentItems = items?.filter(i => i.priority === 'urgent' || i.priority === 'high') || [];

    return (
        <div className="dash-card dash-card--attention">
            <div className="dash-card__header">
                <div className="dash-card__title">
                    <span className="dash-card__icon" style={{ color: urgentItems.length > 0 ? '#ef4444' : '#f59e0b' }}>◈</span>
                    <span>Attention</span>
                    {urgentItems.length > 0 && (
                        <span className="dash-card__count dash-card__count--urgent">{urgentItems.length}</span>
                    )}
                </div>
                <Link to="/inbox" className="dash-card__action">Inbox →</Link>
            </div>
            <div className="dash-card__body">
                {loading ? (
                    <div className="dash-card__skeleton">
                        <div className="skeleton-line" /><div className="skeleton-line" /><div className="skeleton-line" />
                    </div>
                ) : !items || items.length === 0 ? (
                    <div className="dash-card__empty">
                        <span className="dash-card__empty-icon">✓</span>
                        <span>All clear — no actions pending</span>
                    </div>
                ) : (
                    <>
                        <div className="attention-items">
                            {items.slice(0, 3).map(item => (
                                <Link key={item.id} to={`/inbox`} className="attention-item">
                                    <span
                                        className="attention-item__kind"
                                        style={{ color: KIND_COLORS[item.kind] || '#94a3b8' }}
                                        title={item.kind}
                                    >
                                        {KIND_ICONS[item.kind] || '•'}
                                    </span>
                                    <div className="attention-item__content">
                                        <span className="attention-item__title">{item.title || 'Untitled item'}</span>
                                        <span className="attention-item__meta">
                                            {item.kind} · {timeAgo(item.created_at)}
                                            {item.created_by_name && ` · ${item.created_by_name}`}
                                        </span>
                                    </div>
                                    <span
                                        className="attention-item__priority"
                                        style={{ background: PRIORITY_COLORS[item.priority] || PRIORITY_COLORS.normal }}
                                    />
                                </Link>
                            ))}
                        </div>
                        {totalActive > 3 && (
                            <div className="attention-overflow">
                                +{totalActive - 3} more items
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

// ─── LAYER 2B: Live Objectives ──────────────────────────────
function LiveObjectivesCard({ authFetch }) {
    const [objectives, setObjectives] = useState(null);
    const [flows, setFlows] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!authFetch) { setLoading(false); return; }
        let cancelled = false;

        const fetchAll = async () => {
            // Objectives (loops + DAG) and running QuoxFlow executions — the card
            // is "what's running", so it now shows flows alongside objectives.
            const [objRes, execRes] = await Promise.all([
                listObjectives(authFetch, { limit: 10 }).then(d => d.objectives || []).catch(() => []),
                listExecutions({ status: 'running', limit: 5 })
                    .then(r => r?.executions || r?.data || (Array.isArray(r) ? r : [])).catch(() => []),
            ]);
            if (cancelled) return;
            setObjectives(objRes);
            setFlows(execRes);
            setLoading(false);
        };

        fetchAll();
        const interval = setInterval(fetchAll, 30000);
        return () => { cancelled = true; clearInterval(interval); };
    }, [authFetch]);

    // Separate active (running/decomposing/paused) from recent completed
    const active = objectives?.filter(o => ['running', 'decomposing', 'decomposed', 'paused', 'pending'].includes(o.status)) || [];
    const recentDone = objectives?.filter(o => ['completed', 'completed_with_errors', 'failed'].includes(o.status)).slice(0, 2) || [];
    const display = [...active.slice(0, 4), ...recentDone].slice(0, 5);

    return (
        <div className="dash-card dash-card--objectives">
            <div className="dash-card__header">
                <div className="dash-card__title">
                    <span className="dash-card__icon" style={{ color: '#30ff90' }}>▶</span>
                    <span>Objectives &amp; Flows</span>
                    {(active.length + flows.length) > 0 && (
                        <span className="dash-card__count dash-card__count--live">{active.length + flows.length}</span>
                    )}
                </div>
                <Link to="/mission-control" className="dash-card__action">Mission Control →</Link>
            </div>
            <div className="dash-card__body">
                {loading ? (
                    <div className="dash-card__skeleton">
                        <div className="skeleton-line" /><div className="skeleton-line" /><div className="skeleton-line" />
                    </div>
                ) : (display.length === 0 && flows.length === 0) ? (
                    <div className="dash-card__empty">
                        <span className="dash-card__empty-icon">◎</span>
                        <span>Nothing running</span>
                    </div>
                ) : (
                    <div className="objectives-list">
                        {flows.slice(0, 3).map(f => {
                            const id = f.id || f.execution_id || f.executionId;
                            const name = f.workflowName || f.workflow_name || f.name || f.workflowId || f.workflow_id || 'Workflow';
                            return (
                                <div key={`flow-${id}`} className="objective-row objective-row--active">
                                    <div className="objective-row__header">
                                        <span className="objective-row__status-dot" style={{ background: '#3b82f6' }} />
                                        <span className="objective-row__title">{name}</span>
                                        <span className="objective-row__status" style={{ color: '#3b82f6' }}>FLOW</span>
                                    </div>
                                    {(f.startedAt || f.started_at) && (
                                        <span className="objective-row__elapsed">{timeAgo(f.startedAt || f.started_at)}</span>
                                    )}
                                </div>
                            );
                        })}
                        {display.map(obj => {
                            const progress = pct(obj.tasks_completed, obj.task_count);
                            const isActive = ['running', 'decomposing', 'decomposed', 'paused', 'pending'].includes(obj.status);
                            const statusColor = STATUS_COLORS[obj.status] || '#94a3b8';

                            return (
                                <div key={obj.id} className={`objective-row ${isActive ? 'objective-row--active' : ''}`}>
                                    <div className="objective-row__header">
                                        <span className="objective-row__status-dot" style={{ background: statusColor }} />
                                        <span className="objective-row__title">{obj.title}</span>
                                        <span className="objective-row__status" style={{ color: statusColor }}>
                                            {STATUS_LABELS[obj.status] || obj.status}
                                        </span>
                                    </div>
                                    {obj.task_count > 0 && (
                                        <div className="objective-row__progress-wrap">
                                            <div className="objective-row__progress-bar">
                                                <div
                                                    className="objective-row__progress-fill"
                                                    style={{
                                                        width: `${progress}%`,
                                                        background: statusColor,
                                                    }}
                                                />
                                            </div>
                                            <span className="objective-row__progress-text">
                                                {obj.tasks_completed}/{obj.task_count}
                                            </span>
                                        </div>
                                    )}
                                    {isActive && obj.started_at && (
                                        <span className="objective-row__elapsed">{timeAgo(obj.started_at)}</span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── LAYER 2C: Recent Activity Timeline ─────────────────────
function RecentActivityCard({ analyticsData, analyticsLoading, objectives, serverStats }) {
    // Build a unified timeline from real AEE events + objective events.
    const events = useMemo(() => {
        const timeline = [];
        const humaniseIntent = (intent) => {
            if (!intent) return 'Event';
            const s = String(intent).replace(/^quox\./, '').replace(/^aocl\./, '').replace(/[._]/g, ' ').trim();
            return s.charAt(0).toUpperCase() + s.slice(1);
        };

        // Add objective events
        if (objectives) {
            objectives.slice(0, 6).forEach(obj => {
                if (obj.completed_at) {
                    timeline.push({
                        id: `obj-done-${obj.id}`,
                        icon: obj.status === 'failed' ? '✕' : obj.status === 'completed_with_errors' ? '⚠' : '✓',
                        color: STATUS_COLORS[obj.status] || '#30ff90',
                        text: `Objective "${obj.title}" ${STATUS_LABELS[obj.status]?.toLowerCase() || obj.status}`,
                        time: new Date(obj.completed_at),
                    });
                } else if (obj.started_at && ['running', 'decomposing'].includes(obj.status)) {
                    timeline.push({
                        id: `obj-run-${obj.id}`,
                        icon: '▶',
                        color: '#30ff90',
                        text: `"${obj.title}" started`,
                        time: new Date(obj.started_at),
                    });
                } else if (obj.created_at) {
                    timeline.push({
                        id: `obj-new-${obj.id}`,
                        icon: '+',
                        color: '#38bdf8',
                        text: `Objective "${obj.title}" created`,
                        time: new Date(obj.created_at),
                    });
                }
            });
        }

        // Real AEE events (server-source): each carries its own timestamp, so
        // this is a genuine event feed rather than aggregate counts stamped "now".
        if (serverStats?.recent_events?.length) {
            for (const e of serverStats.recent_events.slice(0, 8)) {
                const isErr = e.type === 'error';
                timeline.push({
                    id: `aee-${e.corr}-${e.ts}`,
                    icon: isErr ? '✕' : '◇',
                    color: isErr ? '#f87171' : '#a78bfa',
                    text: humaniseIntent(e.intent),
                    time: new Date(e.ts),
                });
            }
        } else if (analyticsData?.conversations) {
            // Fallback (server summary not loaded): the old aggregate snapshot.
            const convCount = analyticsData.conversations.total_conversations || 0;
            if (convCount > 0) {
                timeline.push({
                    id: 'conv-summary',
                    icon: '◇',
                    color: '#a78bfa',
                    text: `${convCount} conversation${convCount !== 1 ? 's' : ''} in the last 24h`,
                    time: new Date(),
                });
            }
            if (analyticsData?.health?.has_anomalies) {
                timeline.push({
                    id: 'anomalies',
                    icon: '⚠',
                    color: '#f87171',
                    text: `${analyticsData.health.anomaly_count} anomal${analyticsData.health.anomaly_count === 1 ? 'y' : 'ies'} detected`,
                    time: new Date(),
                });
            }
        }

        // Sort by time descending
        timeline.sort((a, b) => b.time - a.time);
        return timeline.slice(0, 8);
    }, [objectives, analyticsData, serverStats]);

    return (
        <div className="dash-card dash-card--activity">
            <div className="dash-card__header">
                <div className="dash-card__title">
                    <span className="dash-card__icon" style={{ color: '#a78bfa' }}>◈</span>
                    <span>Recent Activity</span>
                </div>
                <Link to="/activity" className="dash-card__action">View All →</Link>
            </div>
            <div className="dash-card__body">
                {analyticsLoading && (!events || events.length === 0) ? (
                    <div className="dash-card__skeleton">
                        <div className="skeleton-line" /><div className="skeleton-line" /><div className="skeleton-line" />
                    </div>
                ) : events.length === 0 ? (
                    <div className="dash-card__empty">
                        <span className="dash-card__empty-icon">○</span>
                        <span>No recent activity</span>
                    </div>
                ) : (
                    <div className="activity-timeline">
                        {events.map((evt, i) => (
                            <div key={evt.id} className="activity-event">
                                <div className="activity-event__line">
                                    <span className="activity-event__dot" style={{ background: evt.color, boxShadow: `0 0 6px ${evt.color}40` }} />
                                    {i < events.length - 1 && <span className="activity-event__connector" />}
                                </div>
                                <div className="activity-event__content">
                                    <span className="activity-event__icon" style={{ color: evt.color }}>{evt.icon}</span>
                                    <span className="activity-event__text">{evt.text}</span>
                                    <span className="activity-event__time">{timeAgo(evt.time)}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── LAYER 3A: Compact Services ─────────────────────────────
function CompactServicesCard({ healthData, loading, onRefresh, onServiceClick }) {
    const services = healthData?.services || {};
    const serviceList = Object.entries(services);
    const summary = healthData?.summary || {};

    const getStatus = (svc) => svc.healthy ? 'healthy' : svc.responding ? 'degraded' : 'down';

    return (
        <div className="dash-card dash-card--services">
            <div className="dash-card__header">
                <div className="dash-card__title">
                    <span className="dash-card__icon" style={{ color: summary.allHealthy ? '#30ff90' : '#f59e0b' }}>⬡</span>
                    <span>Services</span>
                    <span className="dash-card__count dash-card__count--subtle">
                        {summary.healthy || 0}/{summary.total || 0}
                    </span>
                </div>
                <button
                    className="dash-card__refresh"
                    onClick={onRefresh}
                    disabled={loading}
                    title="Refresh"
                >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255,255,255,0.5)', strokeWidth: 2.5, strokeLinecap: 'round', animation: loading ? 'spin 1s linear infinite' : 'none' }}>
                        <path d="M21 12a9 9 0 1 1-6.22-8.56" /><path d="M21 3v6h-6" />
                    </svg>
                </button>
            </div>
            <div className="dash-card__body dash-card__body--tight">
                {loading && serviceList.length === 0 ? (
                    <div className="dash-card__skeleton">
                        <div className="skeleton-line" /><div className="skeleton-line" />
                    </div>
                ) : (
                    <div className="compact-services">
                        {serviceList.map(([key, svc]) => {
                            const status = getStatus(svc);
                            const uptime = getServiceUptime(key, 24);
                            return (
                                <div
                                    key={key}
                                    className={`compact-svc compact-svc--${status}`}
                                    onClick={() => onServiceClick?.(key)}
                                    role="button"
                                    tabIndex={0}
                                    onKeyDown={(e) => e.key === 'Enter' && onServiceClick?.(key)}
                                >
                                    <span className="compact-svc__dot" />
                                    <span className="compact-svc__name">{svc.name}</span>
                                    <span className="compact-svc__spacer" />
                                    {svc.responseTime != null && (
                                        <span className="compact-svc__latency">{svc.responseTime}ms</span>
                                    )}
                                    {uptime != null && (
                                        <span className="compact-svc__uptime">{uptime}%</span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── LAYER 3B: Automation Card ──────────────────────────────
function AutomationCard({ workflows, libraryStats, pluginCount, enabledPluginCount }) {
    return (
        <div className="dash-card">
            <div className="dash-card__header">
                <div className="dash-card__title">
                    <span className="dash-card__icon" style={{ color: '#38bdf8' }}>⟳</span>
                    <span>Automation</span>
                </div>
                <Link to="/workflows" className="dash-card__action">Workflows →</Link>
            </div>
            <div className="dash-card__body">
                <div className="auto-grid">
                    <div className="auto-stat">
                        <span className="auto-stat__value">{workflows.drafts?.length || 0}</span>
                        <span className="auto-stat__label">Drafts</span>
                    </div>
                    <div className="auto-stat">
                        <span className="auto-stat__value">{workflows.deployed?.length || 0}</span>
                        <span className="auto-stat__label">Deployed</span>
                    </div>
                    <div className="auto-stat">
                        <span className="auto-stat__value">{libraryStats?.total || 0}</span>
                        <span className="auto-stat__label">Templates</span>
                    </div>
                </div>
                <div className="auto-divider" />
                <div className="auto-plugins">
                    <span className="auto-plugins__label">Plugins</span>
                    <span className="auto-plugins__value">{enabledPluginCount}/{pluginCount} active</span>
                </div>
            </div>
        </div>
    );
}

// ─── LAYER 3C: Fleet Summary Card ───────────────────────────
function FleetSummaryCard({ hostSummary }) {
    const total = hostSummary?.total || 0;
    const byCategory = hostSummary?.byCategory || {};
    const categories = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);

    return (
        <div className="dash-card">
            <div className="dash-card__header">
                <div className="dash-card__title">
                    <span className="dash-card__icon" style={{ color: '#f59e0b' }}>⬡</span>
                    <span>Fleet</span>
                    <span className="dash-card__count dash-card__count--subtle">{total}</span>
                </div>
                <Link to="/noc" className="dash-card__action">NOC →</Link>
            </div>
            <div className="dash-card__body">
                <div className="fleet-grid">
                    {categories.map(([cat, count]) => (
                        <div key={cat} className="fleet-item">
                            <span className="fleet-item__name">{cat}</span>
                            <span className="fleet-item__count">{count}</span>
                        </div>
                    ))}
                </div>
                {categories.length === 0 && (
                    <div className="dash-card__empty">
                        <span className="dash-card__empty-icon">⬡</span>
                        <span>No hosts discovered</span>
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── MAIN DASHBOARD VIEW ────────────────────────────────────
const MaintenanceIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
);

// System Maintenance card — surfaces backup health + update availability. Both
// were already fetched by DashboardView (useBackupStatus/useUpdateStatus) and
// then discarded; this renders that real data with graceful "unavailable" copy.
function MaintenanceSummaryCard({ backup, update }) {
    const b = backup?.status || null;
    const u = update?.status || null;
    const bHealth = b?.health || 'unknown';
    const backupDot = bHealth === 'healthy' ? '#10b981'
        : bHealth === 'warning' ? '#f59e0b'
        : bHealth === 'critical' ? '#ef4444' : '#64748b';
    const updateAvail = !!u?.update_available;
    const updateDot = !u ? '#64748b' : (updateAvail ? '#f59e0b' : '#10b981');

    return (
        <div className="dashboard-card">
            <div className="dashboard-card__header">
                <div className="dashboard-card__title">
                    <MaintenanceIcon />
                    <span>System Maintenance</span>
                </div>
                <Link to="/settings#maintenance" className="dashboard-card__link">Manage</Link>
            </div>
            <div className="dashboard-card__body">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: backupDot, flexShrink: 0 }} />
                        <span>Backup: {b ? (b.healthReason || 'No backups yet') : 'Unavailable'}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: updateDot, flexShrink: 0 }} />
                        <span>{u ? (updateAvail ? `Update available${u.available_version ? ` → ${u.available_version}` : ''}` : 'Up to date') : 'Update status unavailable'}</span>
                        {u?.current_version && (
                            <span style={{ marginLeft: 'auto', fontFamily: MONO, opacity: 0.6, fontSize: 11 }}>v{u.current_version}</span>
                        )}
                    </div>
                    {b?.totals?.count != null && (
                        <div style={{ fontSize: 11, opacity: 0.6 }}>
                            {b.totals.count} backup{b.totals.count === 1 ? '' : 's'} on record
                            {b?.lastSuccess?.completedAt ? ` · last ${timeAgo(b.lastSuccess.completedAt)}` : ''}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function DashboardView() {
    const navigate = useNavigate();
    const { authFetch } = useAuth();
    const { healthData, loading: healthLoading, refetch: refetchHealth,
        services: healthServices, overallStatus: healthOverall,
        downCount: healthDown, degradedCount: healthDegraded } = useHealth();
    const { layers: aoclLayers } = useAoclLayerStats();
    const { orgs, currentOrg } = useWorkspace();
    const workflows = useWorkflows();
    const backupStatus = useBackupStatus();
    const updateStatus = useUpdateStatus();

    const [selectedService, setSelectedService] = useState(null);
    const [analyticsData, setAnalyticsData] = useState(null);
    const [analyticsLoading, setAnalyticsLoading] = useState(true);
    const [serverStats, setServerStats] = useState(null);
    const [objectives, setObjectives] = useState(null);
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [selectedChatAgent, setSelectedChatAgent] = useState('quox');
    // Active dashboard tab. The view is split into tabs so each is a single
    // full-stretch, no-scroll region instead of cramming 13 cards into one
    // viewport (which collapsed to micro-scrollers on zoom). See DASH_TABS.
    const [activeTab, setActiveTab] = useState('overview');
    // Real VOLT + WARD counts for the radial's optional governance rim.
    const governance = useGovernancePulse();
    const lastRecordedTimestamp = useRef(null);

    const [hostSummary, setHostSummary] = useState(() => getHostSummary());

    // Sync data
    const allPlugins = getAllPluginManifests();
    const pluginCount = allPlugins.length;
    const libraryStats = getLibraryStats();

    // Licensed-plugin count from SERVER entitlements, not localStorage (which
    // read 0 on a fresh device and ignored real licence state). isPluginLicensed
    // reads the entitlements cache; make sure it's populated, then count.
    const [enabledPluginCount, setEnabledPluginCount] = useState(0);
    useEffect(() => {
        let cancelled = false;
        const recount = () => {
            if (cancelled) return;
            const licensed = getAllPluginManifests().filter(
                p => isPluginLicensed(p.id || p.pluginId || p.name)
            ).length;
            setEnabledPluginCount(licensed);
        };
        fetchEntitlements(authFetch).then(recount).catch(recount);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [authFetch]);

    // Fetch hosts from Bastion
    useEffect(() => {
        let cancelled = false;
        getHosts().then(() => {
            if (!cancelled) setHostSummary(getHostSummary());
        }).catch(() => {});
        return () => { cancelled = true; };
    }, []);

    // Fetch AEE analytics
    useEffect(() => {
        let cancelled = false;
        const fetchAnalytics = async () => {
            try {
                const data = await getDashboardStats({ timeRange: '24h' });
                if (!cancelled) { setAnalyticsData(data); setAnalyticsLoading(false); }
            } catch (err) {
                console.error('Analytics fetch failed:', err);
                if (!cancelled) setAnalyticsLoading(false);
            }
        };
        fetchAnalytics();
        const interval = setInterval(fetchAnalytics, 60000);
        return () => { cancelled = true; clearInterval(interval); };
    }, []);

    // Fetch server-source dashboard summary (24h KPIs + real activity feed).
    // Server is source of truth; the client IndexedDB analytics remain a fallback.
    useEffect(() => {
        if (!authFetch) return;
        let cancelled = false;
        const fetchSummary = async () => {
            try {
                const res = await authFetch('/collector/aee/dashboard-summary?window_hours=24');
                if (!res.ok) return;
                const data = await res.json();
                if (!cancelled) setServerStats(data);
            } catch { /* fall back to client analytics */ }
        };
        fetchSummary();
        const interval = setInterval(fetchSummary, 60000);
        return () => { cancelled = true; clearInterval(interval); };
    }, [authFetch]);

    // Fetch objectives for timeline
    useEffect(() => {
        if (!authFetch) return;
        let cancelled = false;
        const fetchObj = async () => {
            try {
                const data = await listObjectives(authFetch, { limit: 10 });
                if (!cancelled) setObjectives(data.objectives || []);
            } catch { /* already logged by client */ }
        };
        fetchObj();
        const interval = setInterval(fetchObj, 30000);
        return () => { cancelled = true; clearInterval(interval); };
    }, [authFetch]);

    // Record health checks to history and evaluate alerts
    useEffect(() => {
        if (healthData && healthData.timestamp !== lastRecordedTimestamp.current) {
            const changes = recordHealthCheck(healthData);
            lastRecordedTimestamp.current = healthData.timestamp;

            if (changes.length > 0) {
                console.log('Service status changes:', changes);
            }

            const alerts = evaluateAlerts(healthData);
            if (alerts.length > 0) {
                console.log('Alerts triggered:', alerts);
                bridgeAlertsToInbox(alerts, { authFetch, orgId: currentOrg?.id });
            }

            if (healthData.services && currentOrg?.id) {
                const healthyKeys = Object.entries(healthData.services)
                    .filter(([, svc]) => svc.healthy)
                    .map(([key]) => key);
                if (healthyKeys.length > 0) {
                    bridgeResolutionsToInbox(healthyKeys, { authFetch, orgId: currentOrg.id });
                }
            }
        }
    }, [healthData, authFetch, currentOrg?.id]);

    const [ui] = useUISettings();
    const DASH_TABS = useMemo(
        () => computeVisibleTabs(ALL_DASH_TABS, ui.dashboardTabs),
        [ui.dashboardTabs]
    );

    // If the active tab was removed/disabled (or on first render before
    // config is known), fall back to the first visible tab.
    useEffect(() => {
        if (DASH_TABS.length && !DASH_TABS.some(t => t.id === activeTab)) {
            setActiveTab(DASH_TABS[0].id);
        }
    }, [DASH_TABS, activeTab]);

    // Warm the heavy embed chunks on idle so the first switch to Brain /
    // Cognitive Core is instant rather than a cold chunk fetch.
    useEffect(() => {
        const warm = () => { importQuoxbrain(); importCognitiveTopology(); };
        const ric = typeof window !== 'undefined' && window.requestIdleCallback;
        const id = ric ? window.requestIdleCallback(warm, { timeout: 3000 }) : setTimeout(warm, 1500);
        return () => {
            if (ric && window.cancelIdleCallback) window.cancelIdleCallback(id);
            else clearTimeout(id);
        };
    }, []);

    // Publish the active tab so the app-shell breadcrumb can append its name
    // (owner ask: tab names in the top-row trail). Fire on change, and clear
    // on unmount so the crumb doesn't linger after leaving /dashboard.
    useEffect(() => {
        const tab = DASH_TABS.find(t => t.id === activeTab);
        if (!tab) return undefined;
        window.dispatchEvent(new CustomEvent('quox-dashboard-tab', {
            detail: { id: tab.id, label: tab.label },
        }));
        return () => {
            window.dispatchEvent(new CustomEvent('quox-dashboard-tab', { detail: null }));
        };
    }, [activeTab, DASH_TABS]);

    return (
        <div className="dashboard-v2-layout">
            {/* Main dashboard content — tabbed; each tab is ONE full-stretch,
                zoom-graceful region (no competing flex:1 rows, no fixed floors). */}
            <div className="dashboard-v2">
                {/* Persistent health banner (slim, above the tabs) */}
                <SystemHealthBanner healthData={healthData} loading={healthLoading} />

                {/* QUOXPERTICUS-REVISIT N1: first-touch resident announcement,
                    dismissible, renders null once dismissed or unlicensed. */}
                <MeetYourResidentCard />

                {/* Tab bar — house glass tabs + kiosk cycle control */}
                <div className="dash-tabs-row">
                    <div className="qx-tabs dash-tabs" role="tablist" aria-label="Dashboard sections">
                        {DASH_TABS.map(t => (
                            <button
                                key={t.id}
                                type="button"
                                role="tab"
                                aria-selected={activeTab === t.id}
                                className={`qx-tab dash-tab ${activeTab === t.id ? 'qx-tab--active' : ''}`}
                                onClick={() => setActiveTab(t.id)}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>
                    <CycleTabsControl tabs={DASH_TABS.filter(t => t.cyclable !== false)} activeTab={activeTab} setActiveTab={setActiveTab} />
                </div>

                {/* OVERVIEW — the "Shape of Quox" HUD: radial instrument left,
                    primary stat + mini-brain + attention right. */}
                {activeTab === 'overview' && (
                    <div className="dash-tabpanel" role="tabpanel">
                        <div className="dash-hud">
                            <div className="dash-hud__radial">
                                <div className="dash-hud__radial-head">
                                    <span className="dash-hud__title">The Shape of Quox</span>
                                    <span className="dash-hud__caption">services + dependencies · AOCL pipeline (24h · this browser) · VOLT/WARD governance</span>
                                </div>
                                <div className="dash-hud__radial-body">
                                    <QuoxShapeRadial
                                        services={healthServices || healthData?.services || {}}
                                        overallStatus={healthOverall}
                                        downCount={healthDown}
                                        degradedCount={healthDegraded}
                                        summary={healthData?.summary || {}}
                                        aoclLayers={aoclLayers}
                                        governance={governance}
                                        onSelectService={(k) => { setSelectedService(k); setActiveTab('operations'); }}
                                        onSelectLayer={() => setActiveTab('governance')}
                                    />
                                </div>
                                <div className="dash-hud__legend">
                                    <span className="qx-pill"><span className="qx-dot qx-dot--online" /> up</span>
                                    <span className="qx-pill"><span className="qx-dot" style={{ background: '#fbbf24' }} /> degraded</span>
                                    <span className="qx-pill"><span className="qx-dot" style={{ background: '#f87171' }} /> down</span>
                                    <span className="qx-pill">▨ at&nbsp;risk (dep)</span>
                                    <span className="qx-pill">○ unmonitored</span>
                                </div>
                            </div>
                            <div className="dash-hud__side">
                                <HudPrimaryStat
                                    healthData={healthData}
                                    analyticsData={analyticsData}
                                    workflows={workflows}
                                    analyticsLoading={analyticsLoading}
                                    serverStats={serverStats}
                                />
                                <MiniBrain onNavigate={setActiveTab} />
                                <AttentionNeededCard authFetch={authFetch} orgId={currentOrg?.id} />
                            </div>
                        </div>
                    </div>
                )}

                {/* OPERATIONS — objectives, automation, fleet, services, maintenance */}
                {activeTab === 'operations' && (
                    <div className="dash-tabpanel" role="tabpanel">
                        <div className="dash-tab-grid">
                            <LiveObjectivesCard authFetch={authFetch} />
                            <AutomationCard
                                workflows={workflows}
                                libraryStats={libraryStats}
                                pluginCount={pluginCount}
                                enabledPluginCount={enabledPluginCount}
                            />
                            <FleetSummaryCard hostSummary={hostSummary} />
                            <CompactServicesCard
                                healthData={healthData}
                                loading={healthLoading}
                                onRefresh={refetchHealth}
                                onServiceClick={setSelectedService}
                            />
                            <MaintenanceSummaryCard backup={backupStatus} update={updateStatus} />
                        </div>
                    </div>
                )}

                {/* GOVERNANCE — VOLT, WARD, compliance */}
                {activeTab === 'governance' && (
                    <div className="dash-tabpanel" role="tabpanel">
                        <div className="dash-tab-grid">
                            <VoltSummaryCard />
                            <WardSummaryCard />
                            <ComplianceSummaryCard />
                        </div>
                    </div>
                )}

                {/* INTELLIGENCE — agents, cognition, cost */}
                {activeTab === 'intelligence' && (
                    <div className="dash-tabpanel" role="tabpanel">
                        <div className="dash-tab-grid">
                            <AgentsSummaryCard />
                            <CognitiveSummaryCard />
                            <CostSummaryCard />
                        </div>
                    </div>
                )}

                {/* BRAIN — the real Qortex surface, embedded. */}
                {activeTab === 'brain' && (
                    <div className="dash-tabpanel dash-tabpanel--embed" role="tabpanel">
                        <TabErrorBoundary label="Qortex">
                            <Suspense fallback={<div className="dash-embed-loading">Loading Qortex…</div>}>
                                <QuoxbrainView />
                            </Suspense>
                        </TabErrorBoundary>
                    </div>
                )}

                {/* FLEET — agent fleet + GPU fleet. FleetHeatmap (prometheus) and
                    FleetConnectivityPanel (proxmox) are STRIPPED premium-plugin
                    modules (see stripRegistry.js) and must not be imported into
                    the free dashboard core, so this tab uses only the two
                    core/free fleet panels. */}
                {activeTab === 'fleet' && (
                    <div className="dash-tabpanel" role="tabpanel">
                        <div className="dash-tab-grid">
                            <AgentFleetPanel />
                            <GPUFleetPanel />
                            <FleetSummaryCard hostSummary={hostSummary} />
                        </div>
                    </div>
                )}

                {/* COGNITIVE CORE — the real 2D cognitive topology, embedded. */}
                {activeTab === 'cognitive' && (
                    <div className="dash-tabpanel dash-tabpanel--embed" role="tabpanel">
                        <TabErrorBoundary label="Cognitive Core">
                            <Suspense fallback={<div className="dash-embed-loading">Loading Cognitive Core…</div>}>
                                <CognitiveTopologyView />
                            </Suspense>
                        </TabErrorBoundary>
                    </div>
                )}

                {/* MEMORY — compact memory-lattice summary. */}
                {activeTab === 'memory' && (
                    <div className="dash-tabpanel" role="tabpanel">
                        <div className="dash-tab-grid">
                            <MemorySummaryCard />
                            <CognitiveSummaryCard />
                        </div>
                    </div>
                )}

                {/* Service Detail Modal */}
                {selectedService && (
                    <ServiceDetailModal
                        serviceKey={selectedService}
                        healthData={healthData}
                        onClose={() => setSelectedService(null)}
                    />
                )}
            </div>

            {/* Agent chat sidebar — Pattern B: always mounted, animated width
                collapse to a chevron rail (replaces the old snap-in/vanish one). */}
            <div className={`dashboard-sidebar ${sidebarOpen ? 'dashboard-sidebar--open' : 'dashboard-sidebar--collapsed'}`}>
                {sidebarOpen ? (
                    <DashboardChatSidebar
                        onClose={() => setSidebarOpen(false)}
                        healthData={healthData}
                        analyticsData={analyticsData}
                        objectives={objectives}
                        hostSummary={hostSummary}
                        selectedService={selectedService}
                        selectedAgent={selectedChatAgent}
                        onAgentChange={setSelectedChatAgent}
                    />
                ) : (
                    <button
                        className="dashboard-sidebar__rail"
                        onClick={() => setSidebarOpen(true)}
                        aria-label="Open command chat"
                        title="Open command chat"
                    >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
                        <span className="dashboard-sidebar__rail-label">Command chat</span>
                    </button>
                )}
            </div>
        </div>
    );
}

export default DashboardView;
