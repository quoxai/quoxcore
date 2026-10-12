/**
 * VaultActivityView — QuoxVault Audit Log
 *
 * Full-page activity view at /vault/activity.
 * Shows all vault events with filtering (admin-only).
 */

import { useState, useMemo } from 'react';
import { useVaultActivity } from '../../hooks/useVaultHealth';
import '../../components/vault/vault.css';

const historyIcon = (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3v5h5"/>
        <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/>
        <path d="M12 7v5l4 2"/>
    </svg>
);

const ACTION_META = {
    'integration.create': { label: 'Created', color: '#4ade80' },
    'integration.update': { label: 'Updated', color: '#38bdf8' },
    'integration.delete': { label: 'Deleted', color: '#f87171' },
    'integration.test': { label: 'Tested', color: '#a78bfa' },
    'integration.access': { label: 'Accessed', color: '#fbbf24' },
    'integration.set_default': { label: 'Set default', color: '#38bdf8' },
    'integration.rotate': { label: 'Rotated', color: '#22d3ee' }
};

function formatTimeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
}

export default function VaultActivityView() {
    const { events, loading, refresh } = useVaultActivity({ limit: 100, autoPoll: true });
    const [actionFilter, setActionFilter] = useState('all');

    const filteredEvents = useMemo(() => {
        if (actionFilter === 'all') return events;
        return events.filter(e => e.action === actionFilter);
    }, [events, actionFilter]);

    const actionTypes = useMemo(() => {
        const types = new Set(events.map(e => e.action));
        return Array.from(types).sort();
    }, [events]);

    return (
        <div className="vault-page">
            <div className="vault-page__header">
                <div className="vault-page__title-row">
                    <span className="vault-page__icon">{historyIcon}</span>
                    <h1 className="vault-page__title">Vault Activity</h1>
                    <span className="vault-page__count">{filteredEvents.length} events</span>
                </div>
                <div className="vault-page__actions">
                    <select
                        className="vault-select"
                        value={actionFilter}
                        onChange={(e) => setActionFilter(e.target.value)}
                    >
                        <option value="all">All Actions</option>
                        {actionTypes.map(type => (
                            <option key={type} value={type}>
                                {ACTION_META[type]?.label || type}
                            </option>
                        ))}
                    </select>
                    <button className="vault-btn vault-btn--secondary" onClick={refresh}>
                        Refresh
                    </button>
                </div>
            </div>

            {loading && events.length === 0 ? (
                <div className="vault-page__loading">Loading activity...</div>
            ) : filteredEvents.length === 0 ? (
                <div className="vault-placeholder">
                    <h2 className="vault-placeholder__title">No Activity</h2>
                    <p className="vault-placeholder__text">
                        {actionFilter !== 'all'
                            ? 'No events match the selected filter.'
                            : 'No vault events recorded yet. Activity will appear here as credentials are used.'}
                    </p>
                </div>
            ) : (
                <div className="vault-activity-table">
                    <div className="vault-activity-table__header">
                        <span className="vault-activity-table__col vault-activity-table__col--action">Action</span>
                        <span className="vault-activity-table__col vault-activity-table__col--detail">Detail</span>
                        <span className="vault-activity-table__col vault-activity-table__col--actor">Actor</span>
                        <span className="vault-activity-table__col vault-activity-table__col--time">Time</span>
                        <span className="vault-activity-table__col vault-activity-table__col--status">Status</span>
                    </div>
                    {filteredEvents.map((event, i) => {
                        const meta = ACTION_META[event.action] || { label: event.action, color: '#6b7280' };
                        let metadata = {};
                        try { metadata = JSON.parse(event.metadata_json || '{}'); } catch { /* ignore */ }
                        const detail = metadata.integration_type || metadata.label || '';
                        return (
                            <div key={event.id || i} className="vault-activity-table__row">
                                <span className="vault-activity-table__col vault-activity-table__col--action" style={{ color: meta.color }}>
                                    {meta.label}
                                </span>
                                <span className="vault-activity-table__col vault-activity-table__col--detail">
                                    {detail}
                                </span>
                                <span className="vault-activity-table__col vault-activity-table__col--actor">
                                    {event.actor_type === 'service' ? 'service' : (event.actor_id?.slice(0, 8) || '—')}
                                </span>
                                <span className="vault-activity-table__col vault-activity-table__col--time">
                                    {formatTimeAgo(event.created_at)}
                                </span>
                                <span className="vault-activity-table__col vault-activity-table__col--status">
                                    {event.status === 'failure' ? (
                                        <span className="vault-badge vault-badge--error">failed</span>
                                    ) : (
                                        <span className="vault-badge vault-badge--success">ok</span>
                                    )}
                                </span>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
