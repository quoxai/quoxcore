/**
 * AuditLogView - Enterprise Audit Log Viewer
 *
 * Displays organization audit events with:
 * - Searchable/filterable table
 * - Date range filtering
 * - Action type filtering
 * - Actor filtering
 * - Pagination
 * - CSV export
 * - AOCL layer visualization
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useAuth } from '../../contexts/AuthContext';
import { PageSection, PageCard } from '../../components/layout';
import Button from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { buildAuditExportRequest } from '../../services/auditExport';
import './views.css';

// Icons
const BackIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="19" y1="12" x2="5" y2="12"/>
        <polyline points="12 19 5 12 12 5"/>
    </svg>
);

const DownloadIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
);

const FilterIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
    </svg>
);

const ChevronLeftIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="15 18 9 12 15 6"/>
    </svg>
);

const ChevronRightIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="9 18 15 12 9 6"/>
    </svg>
);

// Action type badges
const ACTION_BADGES = {
    'auth.': { color: '#38bdf8', label: 'Auth' },
    'org.': { color: '#a78bfa', label: 'Org' },
    'team.': { color: '#34d399', label: 'Team' },
    'directory.': { color: '#f59e0b', label: 'Directory' },
    'runtime.': { color: '#ec4899', label: 'Runtime' },
    'hitl.': { color: '#06b6d4', label: 'HITL' },
    'integration.': { color: '#6366f1', label: 'Integration' },
    'secret.': { color: '#ef4444', label: 'Secret' },
    'division.': { color: '#8b5cf6', label: 'Division' },
    'backup.': { color: '#10b981', label: 'Backup' },
    'restore.': { color: '#f97316', label: 'Restore' }
};

// Get badge color for action
function getActionBadge(action) {
    for (const [prefix, badge] of Object.entries(ACTION_BADGES)) {
        if (action.startsWith(prefix)) {
            return badge;
        }
    }
    return { color: '#64748b', label: 'Other' };
}

// Format timestamp for display
function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString('en-AU', {
        day: 'numeric',
        month: 'short',
        year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
        hour: '2-digit',
        minute: '2-digit'
    });
}

// AOCL Layer colors
const AOCL_LAYER_COLORS = {
    'L0': '#ff6b6b',
    'L1': '#ffa06b',
    'L2': '#ffd06b',
    'L3': '#d9ff6b',
    'L4': '#6bff6b',
    'L5': '#6bffd9',
    'L6': '#6bfaff',
    'L7': '#6bb8ff',
    'L8': '#8b6bff',
    'L9': '#d96bff',
    'L10': '#ff6bdd'
};

function AuditLogView() {
    const { orgId } = useParams();
    const navigate = useNavigate();
    const { authFetch } = useAuth();
    const { currentOrg, orgs, isOrgAdmin } = useWorkspace();

    const [events, setEvents] = useState([]);
    const [loading, setLoading] = useState(true);
    const [exporting, setExporting] = useState(false);
    const [actionTypes, setActionTypes] = useState([]);
    const [pagination, setPagination] = useState({
        total: 0,
        limit: 50,
        offset: 0,
        has_more: false
    });

    // Filters
    const [filters, setFilters] = useState({
        action: '',
        actor_id: '',
        target_type: '',
        scope_id: '',
        from_date: '',
        to_date: '',
        status: ''
    });

    const org = orgs.find(o => o.id === orgId) || currentOrg;

    // Load audit events
    const loadEvents = useCallback(async (offset = 0) => {
        if (!orgId) return;

        setLoading(true);
        try {
            const params = new URLSearchParams({
                limit: pagination.limit.toString(),
                offset: offset.toString()
            });

            // Add filters
            if (filters.action) params.append('action', filters.action);
            if (filters.actor_id) params.append('actor_id', filters.actor_id);
            if (filters.target_type) params.append('target_type', filters.target_type);
            if (filters.scope_id) params.append('scope_id', filters.scope_id);
            if (filters.from_date) params.append('from_date', filters.from_date);
            if (filters.to_date) params.append('to_date', filters.to_date);
            if (filters.status) params.append('status', filters.status);

            const response = await authFetch(`/api/orgs/${orgId}/audit?${params}`);
            if (response.ok) {
                const data = await response.json();
                setEvents(data.events || []);
                setPagination(data.pagination || {
                    total: 0,
                    limit: 50,
                    offset: 0,
                    has_more: false
                });
            }
        } catch (err) {
            console.error('Failed to load audit events:', err);
        } finally {
            setLoading(false);
        }
    }, [orgId, authFetch, filters, pagination.limit]);

    // Load action types for filter dropdown
    const loadActionTypes = useCallback(async () => {
        if (!orgId) return;

        try {
            const response = await authFetch(`/api/orgs/${orgId}/audit/actions`);
            if (response.ok) {
                const data = await response.json();
                setActionTypes(data.actions || []);
            }
        } catch (err) {
            console.error('Failed to load action types:', err);
        }
    }, [orgId, authFetch]);

    useEffect(() => {
        loadEvents(0);
        loadActionTypes();
    }, [loadEvents, loadActionTypes]);

    // Handle filter change
    const handleFilterChange = (key, value) => {
        setFilters(prev => ({ ...prev, [key]: value }));
    };

    // Apply filters
    const handleApplyFilters = () => {
        loadEvents(0);
    };

    // Clear filters
    const handleClearFilters = () => {
        setFilters({
            action: '',
            actor_id: '',
            target_type: '',
            scope_id: '',
            from_date: '',
            to_date: '',
            status: ''
        });
    };

    // Pagination
    const handlePrevPage = () => {
        if (pagination.offset > 0) {
            loadEvents(Math.max(0, pagination.offset - pagination.limit));
        }
    };

    const handleNextPage = () => {
        if (pagination.has_more) {
            loadEvents(pagination.offset + pagination.limit);
        }
    };

    // Export audit log in CSV, JSON, or signed-bundle (zip) format.
    const handleExport = async (format = 'csv') => {
        setExporting(true);
        try {
            const { url, filename, accept } = buildAuditExportRequest(orgId, filters, format);
            const response = await authFetch(url, { headers: { Accept: accept } });
            if (response.ok) {
                const blob = await response.blob();
                const dl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = dl;
                a.download = filename;
                a.click();
                URL.revokeObjectURL(dl);
            } else {
                console.error('Export failed:', response.status);
                alert(`Failed to export audit log (${response.status})`);
            }
        } catch (err) {
            console.error('Failed to export audit log:', err);
            alert('Failed to export audit log');
        } finally {
            setExporting(false);
        }
    };

    const hasActiveFilters = Object.values(filters).some(v => v);
    const currentPage = Math.floor(pagination.offset / pagination.limit) + 1;
    const totalPages = Math.ceil(pagination.total / pagination.limit);

    return (
        <div className="audit-log-view view-page">
            {/* Filters + export toolbar. Was gated on `showFilters`, which nothing
                ever set to true, so the whole panel (filters AND the compliance
                CSV / JSON+receipt / Signed-Bundle export) was permanently hidden
                dead UI. Render it unconditionally so the advertised export and
                filtering actually work. */}
            <PageCard style={{ marginBottom: '24px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
                        <div>
                            <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: 'var(--ui-text-muted)' }}>
                                Action Type
                            </label>
                            <select
                                value={filters.action}
                                onChange={(e) => handleFilterChange('action', e.target.value)}
                                style={{
                                    width: '100%',
                                    padding: '8px 12px',
                                    background: 'var(--ui-bg-secondary)',
                                    border: '1px solid var(--ui-border)',
                                    borderRadius: '6px',
                                    color: 'var(--ui-text-primary)',
                                    fontSize: '13px'
                                }}
                            >
                                <option value="">All actions</option>
                                {actionTypes.map(({ action, count }) => (
                                    <option key={action} value={action}>
                                        {action} ({count})
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: 'var(--ui-text-muted)' }}>
                                Target Type
                            </label>
                            <select
                                value={filters.target_type}
                                onChange={(e) => handleFilterChange('target_type', e.target.value)}
                                style={{
                                    width: '100%',
                                    padding: '8px 12px',
                                    background: 'var(--ui-bg-secondary)',
                                    border: '1px solid var(--ui-border)',
                                    borderRadius: '6px',
                                    color: 'var(--ui-text-primary)',
                                    fontSize: '13px'
                                }}
                            >
                                <option value="">All targets</option>
                                <option value="user">User</option>
                                <option value="org">Organization</option>
                                <option value="team">Team</option>
                                <option value="division">Division</option>
                                <option value="agent">Agent</option>
                                <option value="tool">Tool</option>
                                <option value="workflow">Workflow</option>
                                <option value="integration">Integration</option>
                            </select>
                        </div>
                        <div>
                            <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: 'var(--ui-text-muted)' }}>
                                Status
                            </label>
                            <select
                                value={filters.status}
                                onChange={(e) => handleFilterChange('status', e.target.value)}
                                style={{
                                    width: '100%',
                                    padding: '8px 12px',
                                    background: 'var(--ui-bg-secondary)',
                                    border: '1px solid var(--ui-border)',
                                    borderRadius: '6px',
                                    color: 'var(--ui-text-primary)',
                                    fontSize: '13px'
                                }}
                            >
                                <option value="">All statuses</option>
                                <option value="success">Success</option>
                                <option value="failure">Failure</option>
                                <option value="denied">Denied</option>
                            </select>
                        </div>
                        <div>
                            <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: 'var(--ui-text-muted)' }}>
                                From Date
                            </label>
                            <Input
                                type="datetime-local"
                                value={filters.from_date}
                                onChange={(e) => handleFilterChange('from_date', e.target.value)}
                            />
                        </div>
                        <div>
                            <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: 'var(--ui-text-muted)' }}>
                                To Date
                            </label>
                            <Input
                                type="datetime-local"
                                value={filters.to_date}
                                onChange={(e) => handleFilterChange('to_date', e.target.value)}
                            />
                        </div>
                        <div>
                            <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: 'var(--ui-text-muted)' }}>
                                Scope ID
                            </label>
                            <Input
                                type="text"
                                placeholder="SCP_…"
                                value={filters.scope_id}
                                onChange={(e) => handleFilterChange('scope_id', e.target.value)}
                            />
                        </div>
                        <div>
                            <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: 'var(--ui-text-muted)' }}>
                                Actor ID
                            </label>
                            <Input
                                type="text"
                                placeholder="USR_…"
                                value={filters.actor_id}
                                onChange={(e) => handleFilterChange('actor_id', e.target.value)}
                            />
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', marginTop: '16px', flexWrap: 'wrap' }}>
                        <Button variant="primary" size="sm" onClick={handleApplyFilters}>
                            Apply Filters
                        </Button>
                        {hasActiveFilters && (
                            <Button variant="ghost" size="sm" onClick={handleClearFilters}>
                                Clear All
                            </Button>
                        )}
                        <div style={{ flex: 1 }} />
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={exporting}
                            onClick={() => handleExport('csv')}
                            title="Export filtered audit log as CSV"
                        >
                            <DownloadIcon />
                            <span>CSV</span>
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={exporting}
                            onClick={() => handleExport('json')}
                            title="Export with signed evidence receipt (JSON)"
                        >
                            <DownloadIcon />
                            <span>JSON + Receipt</span>
                        </Button>
                        <Button
                            variant="primary"
                            size="sm"
                            disabled={exporting}
                            onClick={() => handleExport('bundle')}
                            title="Signed evidence bundle (zip: csv + json + receipt + manifest)"
                        >
                            <DownloadIcon />
                            <span>Signed Bundle</span>
                        </Button>
                    </div>
                </PageCard>

            {/* Events Table */}
            <PageCard>
                {loading ? (
                    <div style={{ padding: '48px', textAlign: 'center', color: 'var(--ui-text-muted)' }}>
                        Loading audit events...
                    </div>
                ) : events.length === 0 ? (
                    <div style={{ padding: '48px', textAlign: 'center' }}>
                        <p style={{ color: 'var(--ui-text-muted)', margin: 0 }}>
                            {hasActiveFilters ? 'No events match your filters' : 'No audit events yet'}
                        </p>
                    </div>
                ) : (
                    <>
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{
                                width: '100%',
                                borderCollapse: 'collapse',
                                fontSize: '13px'
                            }}>
                                <thead>
                                    <tr style={{
                                        borderBottom: '1px solid var(--ui-border)',
                                        textAlign: 'left'
                                    }}>
                                        <th style={{ padding: '12px 16px', color: 'var(--ui-text-muted)', fontWeight: 500 }}>Time</th>
                                        <th style={{ padding: '12px 16px', color: 'var(--ui-text-muted)', fontWeight: 500 }}>Action</th>
                                        <th style={{ padding: '12px 16px', color: 'var(--ui-text-muted)', fontWeight: 500 }}>Actor</th>
                                        <th style={{ padding: '12px 16px', color: 'var(--ui-text-muted)', fontWeight: 500 }}>Target</th>
                                        <th style={{ padding: '12px 16px', color: 'var(--ui-text-muted)', fontWeight: 500 }}>Status</th>
                                        <th style={{ padding: '12px 16px', color: 'var(--ui-text-muted)', fontWeight: 500 }}>AOCL</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {events.map(event => {
                                        const badge = getActionBadge(event.action);
                                        return (
                                            <tr
                                                key={event.id}
                                                style={{
                                                    borderBottom: '1px solid var(--ui-border-light)',
                                                    transition: 'background 0.1s ease'
                                                }}
                                                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)'}
                                                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                            >
                                                <td style={{ padding: '12px 16px', color: 'var(--ui-text-secondary)', whiteSpace: 'nowrap' }}>
                                                    {formatTimestamp(event.created_at)}
                                                </td>
                                                <td style={{ padding: '12px 16px' }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                        <span style={{
                                                            padding: '2px 8px',
                                                            background: `${badge.color}20`,
                                                            color: badge.color,
                                                            borderRadius: '4px',
                                                            fontSize: '11px',
                                                            fontWeight: 500
                                                        }}>
                                                            {badge.label}
                                                        </span>
                                                        <code style={{ color: 'var(--ui-text-primary)', fontSize: '12px' }}>
                                                            {event.action}
                                                        </code>
                                                    </div>
                                                </td>
                                                <td style={{ padding: '12px 16px' }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                        <div style={{
                                                            width: '24px',
                                                            height: '24px',
                                                            borderRadius: '50%',
                                                            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            justifyContent: 'center',
                                                            fontSize: '11px',
                                                            fontWeight: 600,
                                                            color: 'white'
                                                        }}>
                                                            {event.actor_name?.[0]?.toUpperCase() || event.actor_type?.[0]?.toUpperCase() || '?'}
                                                        </div>
                                                        <div>
                                                            <div style={{ color: 'var(--ui-text-primary)', fontSize: '13px' }}>
                                                                {event.actor_name || event.actor_id}
                                                            </div>
                                                            <div style={{ color: 'var(--ui-text-muted)', fontSize: '11px' }}>
                                                                {event.actor_type}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </td>
                                                <td style={{ padding: '12px 16px', color: 'var(--ui-text-secondary)' }}>
                                                    {event.target_type && (
                                                        <span>
                                                            <span style={{ color: 'var(--ui-text-muted)' }}>{event.target_type}:</span>{' '}
                                                            <code style={{ fontSize: '11px' }}>{event.target_id?.slice(0, 8)}...</code>
                                                        </span>
                                                    )}
                                                </td>
                                                <td style={{ padding: '12px 16px' }}>
                                                    <span style={{
                                                        padding: '2px 8px',
                                                        borderRadius: '4px',
                                                        fontSize: '11px',
                                                        fontWeight: 500,
                                                        background: event.status === 'success'
                                                            ? 'rgba(52, 211, 153, 0.15)'
                                                            : event.status === 'failure'
                                                            ? 'rgba(239, 68, 68, 0.15)'
                                                            : 'rgba(251, 191, 36, 0.15)',
                                                        color: event.status === 'success'
                                                            ? '#34d399'
                                                            : event.status === 'failure'
                                                            ? '#ef4444'
                                                            : '#fbbf24'
                                                    }}>
                                                        {event.status}
                                                    </span>
                                                </td>
                                                <td style={{ padding: '12px 16px' }}>
                                                    {event.aocl_layers && event.aocl_layers.length > 0 && (
                                                        <div style={{ display: 'flex', gap: '2px' }}>
                                                            {event.aocl_layers.map((layer, i) => {
                                                                const layerNum = layer.split('_')[0];
                                                                return (
                                                                    <span
                                                                        key={i}
                                                                        title={layer}
                                                                        style={{
                                                                            width: '16px',
                                                                            height: '16px',
                                                                            borderRadius: '3px',
                                                                            background: AOCL_LAYER_COLORS[layerNum] || '#64748b',
                                                                            display: 'flex',
                                                                            alignItems: 'center',
                                                                            justifyContent: 'center',
                                                                            fontSize: '9px',
                                                                            fontWeight: 600,
                                                                            color: 'white'
                                                                        }}
                                                                    >
                                                                        {layerNum?.replace('L', '')}
                                                                    </span>
                                                                );
                                                            })}
                                                        </div>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>

                        {/* Pagination */}
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '16px',
                            borderTop: '1px solid var(--ui-border)'
                        }}>
                            <div style={{ color: 'var(--ui-text-muted)', fontSize: '13px' }}>
                                Showing {pagination.offset + 1} - {Math.min(pagination.offset + events.length, pagination.total)} of {pagination.total} events
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={handlePrevPage}
                                    disabled={pagination.offset === 0}
                                >
                                    <ChevronLeftIcon />
                                </Button>
                                <span style={{ color: 'var(--ui-text-secondary)', fontSize: '13px' }}>
                                    Page {currentPage} of {totalPages || 1}
                                </span>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={handleNextPage}
                                    disabled={!pagination.has_more}
                                >
                                    <ChevronRightIcon />
                                </Button>
                            </div>
                        </div>
                    </>
                )}
            </PageCard>
        </div>
    );
}

export default AuditLogView;
